// Pure board model: how 51 Linear projects become a readable tree, and what counts
// as needing a human. No network, no Herdr APIs, no Linear workflow changes.
//
// Three organising facts this file owns:
//   1. Projects named "A · B" belong under one synthetic group "A" with leaf "B".
//   2. A team is the top level; its projects sort needs-first, then alphabetically.
//   3. "Needs you" is a union of Linear state names and Linear label names, never
//      an inference from an agent having stopped running.

import { DEFAULT_ATTENTION_LABELS, DEFAULT_ATTENTION_STATES } from "./config.js";

export const GROUP_SEPARATOR = " · ";

/** Labels that mean a person has to look. Set by the completion contract, the review
 *  handoff and the stale sweeper on the Linear side; we only read them. */
export const ATTENTION_LABELS = new Set(DEFAULT_ATTENTION_LABELS);

/** Workflow state names that mean the same. Matched case-insensitively and exactly,
 *  so a project named "In Review Tooling" never trips it. */
export const ATTENTION_STATES = new Set(DEFAULT_ATTENTION_STATES);

/** Labels that are routing or bookkeeping rather than something to show as a chip. */
export const QUIET_LABEL = /^(?:agent:|repo:|closed-|parked-|QA — )/i;

/** The Linear label that pins an issue's space to the top of the sidebar (see tags.js).
 *  It is shown as the PINNED section, never as a chip. */
export const PIN_LABEL = "Pinned";
export const isPinLabel = name => String(name ?? "").trim().toLowerCase() === PIN_LABEL.toLowerCase();

/** "Homelab · Network & DNS" -> { group: "Homelab", leaf: "Network & DNS" }.
 *  A name without the separator is its own leaf under no group. Only the first
 *  separator splits, so "A · B · C" groups under "A" with leaf "B · C". */
export function splitName(name) {
  const text = String(name ?? "");
  const at = text.indexOf(GROUP_SEPARATOR);
  if (at <= 0) return { group: null, leaf: text };
  const group = text.slice(0, at).trim();
  const leaf = text.slice(at + GROUP_SEPARATOR.length).trim();
  if (!group || !leaf) return { group: null, leaf: text };
  return { group, leaf };
}

/** Does this enriched issue need a person? `mine` is not required: a bot's ticket
 *  that lands in Needs Human is still yours to clear. */
export function issueNeedsYou(issue, attention = {}) {
  if (!issue) return false;
  const states = attention.states ? new Set(attention.states.map(x => String(x).trim().toLowerCase())) : ATTENTION_STATES;
  const labels = attention.labels ? new Set(attention.labels.map(x => String(x).trim().toLowerCase())) : ATTENTION_LABELS;
  const state = String(issue.state?.name ?? "").trim().toLowerCase();
  if (states.has(state)) return true;
  return (issue.labels ?? []).some(l => labels.has(String(l).toLowerCase()));
}

/** The chips worth drawing on an issue row, routing labels dropped. */
export function visibleLabels(issue) {
  return (issue?.labels ?? []).filter(l => !QUIET_LABEL.test(String(l)) && !isPinLabel(l));
}

/** The agent a Linear issue is delegated to, or null. Assignee is deliberately not a
 *  fallback: every bot ticket here is assigned to the owner, so using it would label
 *  every row with the same person. */
export function delegateOf(issue) {
  const name = issue?.delegate?.name ?? issue?.delegate ?? null;
  return name ? String(name) : null;
}

/** Where a work record runs. null machine is the machine showing the window. */
export function machineOf(record) {
  const machine = record?.space?.machine ?? null;
  return machine ? String(machine) : null;
}

function compareProjects(a, b) {
  return Number(Boolean(b.needs)) - Number(Boolean(a.needs))
    || a.sortKey.localeCompare(b.sortKey);
}

/**
 * Builds the tree the sidebar draws.
 *
 * projects: [{ id, name, teamKey, ... }] as herdr-linear's `list` returns them.
 * issuesByProject: Map|object of project id -> enriched issues (may be empty until expanded).
 * records: workRecords() output, for "is something running on this issue".
 * teams: [{ key, name }] for the headers; a project whose team is unknown goes under its own key.
 * filter: { delegate?: string|null } narrows which issues count and which rows survive.
 *
 * Returns [{ kind:"team", key, name, needs, children }], children being
 * { kind:"group", name, needs, children:[project nodes] } or project nodes directly.
 */
export function boardTree({ projects = [], issuesByProject = {}, records = [], teams = [], filter = {}, attention = {} } = {}) {
  const issuesOf = id => {
    const found = issuesByProject instanceof Map ? issuesByProject.get(id) : issuesByProject?.[id];
    return Array.isArray(found) ? found : [];
  };
  const wanted = issue => !filter.delegate || delegateOf(issue) === filter.delegate;
  const runningOn = new Map();
  for (const record of records) {
    const key = record?.issue?.id;
    if (key) runningOn.set(key, [...(runningOn.get(key) ?? []), record]);
  }

  const nodes = projects.map(project => {
    const issues = issuesOf(project.id).filter(wanted);
    const teamKey = String(project.teamKey ?? project.teams?.[0]?.key ?? "");
    const { group, leaf } = splitName(project.name);
    return {
      kind: "project",
      project,
      team: teamKey,
      group,
      name: leaf,
      sortKey: leaf.toLowerCase(),
      issues: issues.map(issue => ({
        issue,
        delegate: delegateOf(issue),
        labels: visibleLabels(issue),
        needs: issueNeedsYou(issue, attention),
        records: runningOn.get(issue.id) ?? [],
      })),
      needs: issues.filter(issue => issueNeedsYou(issue, attention)).length,
      // A project with a filter applied and nothing left is hidden; unfiltered it stays,
      // because an empty project is still somewhere to file a ticket.
      empty: Boolean(filter.delegate) && issues.length === 0,
    };
  }).filter(node => !node.empty);

  const order = new Map(teams.map((t, i) => [String(t.key), i]));
  const byTeam = new Map();
  for (const node of nodes) {
    if (!byTeam.has(node.team)) byTeam.set(node.team, []);
    byTeam.get(node.team).push(node);
  }

  return [...byTeam.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99) || a[0].localeCompare(b[0]))
    .map(([key, members]) => {
      const groups = new Map();
      const loose = [];
      for (const node of members) {
        if (!node.group) { loose.push(node); continue; }
        if (!groups.has(node.group)) groups.set(node.group, []);
        groups.get(node.group).push(node);
      }
      const children = [
        ...[...groups.entries()].map(([name, inner]) => ({
          kind: "group",
          name,
          sortKey: name.toLowerCase(),
          children: inner.sort(compareProjects),
          needs: inner.reduce((sum, p) => sum + p.needs, 0),
        })),
        ...loose,
      ].sort(compareProjects);
      return {
        kind: "team",
        key,
        name: teams.find(t => String(t.key) === key)?.name ?? key,
        children,
        needs: children.reduce((sum, c) => sum + c.needs, 0),
      };
    });
}

/** Spaces and agents grouped by the machine they run on, for the live strip.
 *  `machines` comes from Herdr's machines(); an entry it doesn't list still gets a row,
 *  because a space on a machine Herdr has forgotten is exactly what you want to see. */
export function machineGroups(records = [], machines = []) {
  const known = machines.map(m => ({
    name: m.name ?? null,
    reachable: m.layout === "ready",
    state: m.layout ?? "unavailable",
  }));
  const seen = new Map(known.map(m => [m.name, { ...m, records: [] }]));
  if (!seen.has(null)) seen.set(null, { name: null, reachable: true, state: "ready", records: [] });
  for (const record of records) {
    const name = machineOf(record);
    if (!seen.has(name)) seen.set(name, { name, reachable: false, state: "unavailable", records: [] });
    seen.get(name).records.push(record);
  }
  return [...seen.values()].sort((a, b) =>
    b.records.length - a.records.length
    || String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

const stamps = (tabs, key) => (tabs ?? []).map(t => Number(t?.[key])).filter(n => Number.isFinite(n) && n > 0);

/** When a sidebar row entered its group, and where that time came from.
 *  Herdr's own clock wins: a working space counts from the earliest tab that has been
 *  working since (`working_since`), anything else from the tab that last changed state
 *  (`changed_at`). Herdr has neither for a space nothing has happened in since the app
 *  started, so then the ticket's last Linear update stands in. */
export function laneSince(record, lane) {
  const tabs = record?.space?.tabs;
  const working = lane === "working" ? stamps(tabs, "working_since") : [];
  if (working.length) return { at: Math.min(...working), source: "herdr" };
  const changed = stamps(tabs, "changed_at");
  if (changed.length) return { at: Math.max(...changed), source: "herdr" };
  const updated = Date.parse(record?.issue?.updatedAt ?? "");
  if (Number.isFinite(updated)) return { at: updated, source: "linear" };
  return { at: null, source: null };
}

/** "4m", "3h", "2d"; "<1m" under a minute; "" with no time. */
export function elapsed(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The Linear status worth printing next to a sidebar group, or "" when it says what the
 *  group already says. Working matches a started ticket; Done matches a completed ticket or
 *  one waiting for review; Needs you matches a started or needs-you ticket; Idle matches any
 *  ticket that is still open. Linear status stays separate from agent activity: a finished
 *  agent on a ticket that is still In Progress is shown, not hidden or "fixed". */
export function linearMismatch(lane, issue, attention = {}) {
  const name = issue?.state?.name;
  if (!name) return "";
  const type = String(issue.state.type ?? "").toLowerCase();
  const needs = issueNeedsYou(issue, attention);
  const matches = lane === "working" ? type === "started" && !needs
    : lane === "done" ? type === "completed" || needs
    : lane === "blocked" ? needs || type === "started"
    : type !== "completed" && type !== "canceled";
  if (matches) return "";
  return lane === "done" && type === "started" ? `still ${name}` : `Linear: ${name}`;
}

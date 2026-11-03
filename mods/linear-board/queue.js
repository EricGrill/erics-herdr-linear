// Pure Crew model: an agent's Linear issue queue, why each issue needs a person, the
// roster of agents, and the bookkeeping for a bulk reassignment. No network, no Herdr.
//
// Linear workflow state and delegation come from Linear; Herdr activity (a running
// space) is joined on separately and never changes how an issue is counted.

import { delegateOf } from "./board.js";
import { DEFAULT_ATTENTION_LABELS, DEFAULT_ATTENTION_STATES } from "./config.js";

/** Why this issue needs a person, by the configured attention rules, plus any open
 *  blockers as context. Blockers explain; they do not by themselves count as attention,
 *  so the needs-attention count matches the rules everywhere else on the board. */
export function attentionOf(issue, rules = {}) {
  const reasons = [];
  if (issue) {
    const states = new Set((rules.states ?? DEFAULT_ATTENTION_STATES).map(x => String(x).trim().toLowerCase()));
    const labels = new Set((rules.labels ?? DEFAULT_ATTENTION_LABELS).map(x => String(x).trim().toLowerCase()));
    const state = String(issue.state?.name ?? "").trim();
    if (state && states.has(state.toLowerCase())) reasons.push(`State is ${state}`);
    for (const label of issue.labels ?? []) {
      if (labels.has(String(label).trim().toLowerCase())) reasons.push(`Labelled ${label}`);
    }
  }
  const needs = reasons.length > 0;
  const blockers = (issue?.blockers ?? []).filter(b => !["completed", "canceled"].includes(b.state?.type));
  const blockedBy = blockers.length
    ? `Blocked by ${blockers.map(b => `${b.identifier}${b.state?.name ? ` (${b.state.name})` : ""}`).join(", ")}`
    : null;
  return { needs, reasons, blockers, blockedBy, reason: reasons.length ? reasons.join(" · ") : null };
}

// Linear priority: 1 urgent … 4 low, 0 none. None sorts after low.
const rankPriority = p => (Number(p) >= 1 && Number(p) <= 4 ? Number(p) : 5);
const time = v => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : 0; };

/** Queue rows with their attention worked out, needing-attention first, then priority,
 *  then most recently updated. */
export function sortQueue(rows = [], rules = {}) {
  return rows.map(row => ({ ...row, attention: attentionOf(row, rules) }))
    .sort((a, b) => Number(b.attention.needs) - Number(a.attention.needs)
      || rankPriority(a.priority) - rankPriority(b.priority)
      || time(b.updatedAt) - time(a.updatedAt)
      || a.identifier.localeCompare(b.identifier));
}

/** Total and needs-attention counts, kept separate on purpose: one issue needing
 *  attention does not make the whole queue red. */
export function queueCounts(rows = [], rules = {}) {
  const needs = rows.filter(r => (r.attention ?? attentionOf(r, rules)).needs).length;
  return { total: rows.length, needs };
}

/** The Crew list: every Linear agent identity, with its open work from the enrichment.
 *  Agents with nothing delegated still appear, so they can receive work. A delegate seen
 *  on an issue but missing from the agent list (it was read before the list arrived, or
 *  the list failed) still gets a row so its queue is reachable. */
export function crewRoster({ agents = [], rows = [], rules = {} } = {}) {
  const byKey = new Map();
  const keyOf = (id, name) => (id ? `id:${id}` : `name:${name}`);
  for (const a of agents) byKey.set(keyOf(a.id, a.name), { id: a.id, name: a.name, eligible: true, issues: [] });
  for (const row of rows) {
    const name = delegateOf(row);
    if (!name) continue;
    const id = row.delegate?.id ?? null;
    let entry = byKey.get(keyOf(id, name))
      ?? [...byKey.values()].find(e => e.name === name);
    if (!entry) {
      entry = { id, name, eligible: false, issues: [] };
      byKey.set(keyOf(id, name), entry);
    }
    if (!entry.id && id) entry.id = id;
    entry.issues.push(row);
  }
  return [...byKey.values()].map(e => ({
    ...e,
    total: e.issues.length,
    needs: e.issues.filter(r => attentionOf(r, rules).needs).length,
  })).sort((a, b) => b.needs - a.needs || b.total - a.total || a.name.localeCompare(b.name));
}

/** Where an issue is running in Herdr, if anywhere. `records` are workRecords(). No
 *  record is a normal state: the issue is delegated in Linear with nothing open here. */
export function herdrActivity(identifier, records = []) {
  const key = String(identifier ?? "").toUpperCase();
  const live = records.filter(r => String(r.issue?.identifier ?? "").toUpperCase() === key);
  return {
    records: live,
    running: live.some(r => r.status === "working" || r.status === "blocked"),
    summary: live.length
      ? live.map(r => `${r.status ?? "idle"} on ${r.space?.machine ?? "local"}`).join(", ")
      : "No Herdr space",
  };
}

/** "3m ago", "5h ago", "2d ago". */
export function age(value, now = Date.now()) {
  const t = time(value);
  if (!t) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The plain-language state of a queue read, so the UI never shows a partial or failed
 *  read as if it were the full queue. */
export function queueStatus(queue) {
  if (queue?.waiting) return { kind: "waiting", text: "Waiting for the Herdr sidebar to connect to Linear; the queue loads as soon as it does." };
  if (!queue || queue.loading && !queue.rows?.length) return { kind: "loading", text: "Reading this agent's queue from Linear…" };
  if (queue.loading) return { kind: "refreshing", text: `Refreshing from Linear; showing the previous ${queue.rows.length} until it finishes.` };
  if (queue.error) {
    return { kind: "error", text: queue.rows?.length
      ? `Incomplete: ${queue.error}. Showing the ${queue.rows.length} read before it failed.`
      : `Could not read the queue: ${queue.error}` };
  }
  if (!queue.complete) return { kind: "partial", text: `Incomplete: showing the first ${queue.rows?.length ?? 0}; Linear has more.` };
  if (!queue.rows?.length) return { kind: "empty", text: "No open issues are delegated to this agent." };
  return { kind: "complete", text: null };
}

/**
 * Runs a reassignment over several issues one at a time. `write(issue)` resolves to
 * { ok, error }; a throw is caught and recorded as that issue's failure. Every issue gets
 * its own result, and the batch is `ok` only when every write was verified.
 */
export async function reassignBatch(issues = [], write) {
  const results = [];
  for (const issue of issues) {
    let outcome;
    try { outcome = await write(issue); }
    catch (e) { outcome = { ok: false, error: String(e?.message ?? e) }; }
    results.push({ id: issue.id, identifier: issue.identifier, ok: outcome?.ok === true,
      error: outcome?.ok === true ? null : String(outcome?.error ?? "Unknown failure") });
  }
  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0 && results.length > 0, results, succeeded: results.length - failed.length, failed };
}

/** One line for the result of a batch. */
export function batchSummary(batch, destination) {
  if (!batch?.results?.length) return "Nothing was reassigned.";
  const n = batch.results.length;
  if (batch.ok) return `Moved ${n} issue${n === 1 ? "" : "s"} to ${destination}; Linear confirmed each one.`;
  if (!batch.succeeded) return `None of the ${n} moved to ${destination}. ${batch.failed.length} failed and stay selected for retry.`;
  return `${batch.succeeded} of ${n} moved to ${destination}; ${batch.failed.length} failed and stay selected for retry.`;
}

/** The Linear connection Crew reads through: the layout config and the machine the
 *  sidebar runs its Linear calls from. Both are published by the sidebar; until they
 *  are, this is null and Crew waits rather than reading with defaults from the wrong
 *  machine. The sidebar publishes `on` (null meaning this machine) with every enrichment
 *  result, so its presence, not its value, is the signal. */
export function crewContext(config, published) {
  if (!config || typeof config !== "object") return null;
  if (!published || typeof published !== "object" || !Object.prototype.hasOwnProperty.call(published, "on")) return null;
  return { on: published.on ?? null, config };
}

/** Who the picked issues can be moved to. Agents from Linear's agent list always; when
 *  that list could not be read, also the agents seen as delegates on open issues (a
 *  delegate is by definition a Linear agent identity, so its id is a valid target).
 *  Never the source agent, and never an entry without a Linear id. */
export function reassignChoices(roster = [], { sourceId = null, listFailed = false } = {}) {
  return roster.filter(e => e.id && e.id !== sourceId && (e.eligible || listFailed));
}

/** Last-request-wins bookkeeping. `begin(key)` returns a check that stays true only
 *  while no newer request for the same key has begun, so a slow, older read can never
 *  overwrite a newer one (for example the read issued after a reassignment). */
export function requestGate() {
  const seq = new Map();
  return {
    begin(key) {
      const n = (seq.get(key) ?? 0) + 1;
      seq.set(key, n);
      return () => seq.get(key) === n;
    },
  };
}

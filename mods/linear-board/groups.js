// How the sidebar groups its rows: by state (the default), or by one of the fields a
// ticket carries -- Linear project, delegate ("agent"), or Linear team ("company").
// Pinned spaces come first either way. Any group can be collapsed to its header. Pure.

import { delegateOf } from "./board.js";

export const GROUP_MODES = ["status", "project", "crew", "team"];

/** What the group-by dropdown calls each mode. "Agent" and "Company" are the words used
 *  for a ticket's delegate and its Linear team (CHA-4365). */
export const GROUP_LABELS = { status: "Status", project: "Project", crew: "Agent", team: "Company" };

/** Any stored or clicked value narrowed to a mode we can draw; anything else is status. */
export const normalizeGroupMode = mode => GROUP_MODES.includes(mode) ? mode : "status";

const PINNED = { key: "pinned", name: "PINNED", tone: "accent" };
const STATUS = [
  { key: "status:blocked", lane: "blocked", name: "NEEDS YOU", tone: "blocked" },
  { key: "status:done", lane: "done", name: "DONE", tone: "done" },
  { key: "status:working", lane: "working", name: "WORKING", tone: "working" },
  { key: "status:idle", lane: "idle", name: "IDLE", tone: "dim" },
];

/** The field each non-status mode buckets by. `of` returns { id, name } or null when the
 *  ticket does not have the field, which lands the row in that mode's "none" bucket. */
const BUCKETS = {
  project: {
    prefix: "project", none: "NO PROJECT",
    of: issue => {
      const project = issue?.project, name = project?.name?.trim();
      return name ? { id: String(project.id ?? name), name } : null;
    },
  },
  crew: {
    prefix: "crew", none: "NO AGENT",
    of: issue => {
      const name = delegateOf(issue)?.trim();
      return name ? { id: name, name } : null;
    },
  },
  team: {
    prefix: "team", none: "NO COMPANY",
    // Issues carry the team key, not its name, so the header reads "CHAINBYTES" only when
    // the team list has been loaded; until then it reads the key.
    of: (issue, names) => {
      const key = String(issue?.teamKey ?? issue?.team?.key ?? "").trim();
      return key ? { id: key, name: names.get(key) ?? key } : null;
    },
  },
};

const needsIn = group => group.records.filter(r => r.lane === "blocked").length;

/** One group per distinct value of the mode's field: groups that need you first, then by
 *  name, and the rows without the field last. */
function bucketGroups(records, spec, teams) {
  const names = new Map(teams.filter(t => t?.key).map(t => [String(t.key), String(t.name ?? t.key)]));
  const none = `${spec.prefix}:none`;
  const buckets = new Map();
  for (const record of records) {
    const found = spec.of(record.issue, names);
    const key = found ? `${spec.prefix}:${found.id}` : none;
    if (!buckets.has(key)) {
      buckets.set(key, { key, name: found ? found.name.toUpperCase() : spec.none, tone: "dim", records: [] });
    }
    buckets.get(key).records.push(record);
  }
  return [...buckets.values()].sort((a, b) =>
    Number(a.key === none) - Number(b.key === none)
    || Number(needsIn(b) > 0) - Number(needsIn(a) > 0)
    || a.name.localeCompare(b.name));
}

/** The sidebar's groups for `records` (already filtered and sorted): [{ key, name, tone,
 *  records, count, needs, collapsed }], empty groups left out. A collapsed group keeps
 *  its count but shows no rows. `teams` only names the groups in "team" mode.
 *  Group keys carry their mode, so each mode remembers its own collapsed groups. */
export function sidebarGroups(records, mode = "status", collapsed = {}, teams = []) {
  const pinned = { ...PINNED, records: records.filter(r => r.pinned) };
  const rest = records.filter(r => !r.pinned);
  const bucket = BUCKETS[normalizeGroupMode(mode)];
  const groups = [pinned, ...(bucket
    ? bucketGroups(rest, bucket, teams)
    : STATUS.map(({ lane, ...group }) => ({ ...group, records: rest.filter(r => r.lane === lane) })))];
  return groups.filter(g => g.records.length).map(g => ({
    ...g, count: g.records.length, needs: needsIn(g),
    collapsed: Boolean(collapsed[g.key]),
  }));
}

/** The collapsed map with `key` flipped; open groups are dropped, not stored as false. */
export function toggleCollapsed(collapsed = {}, key) {
  const next = { ...collapsed };
  if (next[key]) delete next[key]; else next[key] = true;
  return next;
}

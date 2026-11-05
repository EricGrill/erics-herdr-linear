// How the sidebar groups its rows: by state (the default) or by Linear project. Pinned
// spaces come first either way. Any group can be collapsed to its header. Pure.

export const GROUP_MODES = ["status", "project"];

const PINNED = { key: "pinned", name: "PINNED", tone: "accent" };
const STATUS = [
  { key: "status:blocked", lane: "blocked", name: "NEEDS YOU", tone: "blocked" },
  { key: "status:done", lane: "done", name: "DONE", tone: "done" },
  { key: "status:working", lane: "working", name: "WORKING", tone: "working" },
  { key: "status:idle", lane: "idle", name: "IDLE", tone: "dim" },
];
const NO_PROJECT = "project:none";

/** The sidebar's groups for `records` (already filtered and sorted): [{ key, name, tone,
 *  records, count, needs, collapsed }], empty groups left out. A collapsed group keeps
 *  its count but shows no rows. Projects that need you come first, then by name, and
 *  spaces without a project last. */
export function sidebarGroups(records, mode = "status", collapsed = {}) {
  const pinned = { ...PINNED, records: records.filter(r => r.pinned) };
  const rest = records.filter(r => !r.pinned);
  let groups;
  if (mode === "project") {
    const projects = new Map();
    for (const record of rest) {
      const project = record.issue?.project, name = project?.name?.trim();
      const key = name ? `project:${project.id ?? name}` : NO_PROJECT;
      if (!projects.has(key)) projects.set(key, { key, name: name ? name.toUpperCase() : "NO PROJECT", tone: "dim", records: [] });
      projects.get(key).records.push(record);
    }
    const needs = g => g.records.filter(r => r.lane === "blocked").length;
    groups = [pinned, ...[...projects.values()].sort((a, b) =>
      Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT)
      || Number(needs(b) > 0) - Number(needs(a) > 0)
      || a.name.localeCompare(b.name))];
  } else {
    groups = [pinned, ...STATUS.map(({ lane, ...group }) => ({ ...group, records: rest.filter(r => r.lane === lane) }))];
  }
  return groups.filter(g => g.records.length).map(g => ({
    ...g, count: g.records.length, needs: g.records.filter(r => r.lane === "blocked").length,
    collapsed: Boolean(collapsed[g.key]),
  }));
}

/** The collapsed map with `key` flipped; open groups are dropped, not stored as false. */
export function toggleCollapsed(collapsed = {}, key) {
  const next = { ...collapsed };
  if (next[key]) delete next[key]; else next[key] = true;
  return next;
}

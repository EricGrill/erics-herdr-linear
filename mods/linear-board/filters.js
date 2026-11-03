// Home-page filters only. Reports keep their complete, independently grouped data.
import { delegateOf } from "./board.js";

export const FILTER_FIELDS = ["team", "status", "project", "crew"];
export const NO_VALUE = "none:";
export const ACTIVITY_OPTIONS = [
  { value: "activity:blocked", label: "Needs you" },
  { value: "activity:done", label: "Done" },
  { value: "activity:working", label: "Working" },
  { value: "activity:idle", label: "Idle" },
];

export function normalizeFilters(value = {}) {
  return Object.fromEntries(FILTER_FIELDS.map(field => [field,
    [...new Set((Array.isArray(value?.[field]) ? value[field] : []).filter(x => typeof x === "string" && x))],
  ]));
}

export function toggleFilter(filters, field, value) {
  const next = normalizeFilters(filters);
  if (!FILTER_FIELDS.includes(field)) return next;
  next[field] = next[field].includes(value) ? next[field].filter(x => x !== value) : [...next[field], value];
  return next;
}

export function filterCount(filters) {
  return Object.values(normalizeFilters(filters)).reduce((sum, values) => sum + values.length, 0);
}

export function matchesFilters(record, filters) {
  const selected = normalizeFilters(filters), issue = record.issue;
  const values = {
    team: [issue?.teamKey || issue?.team?.key || NO_VALUE],
    project: [issue?.project?.id || NO_VALUE],
    crew: [delegateOf(issue) || NO_VALUE],
    // A finished agent never changes its ticket's Linear workflow status.
    status: [`activity:${record.lane}`, issue?.state?.name ? `linear:${issue.state.name}` : NO_VALUE],
  };
  return FILTER_FIELDS.every(field => !selected[field].length || selected[field].some(value => values[field].includes(value)));
}

/** Options come from unfiltered spaces plus known Linear data, never filtered results. */
export function filterOptions({ records = [], issues = [], teams = [], projects = [], filters = {} } = {}) {
  const maps = Object.fromEntries(FILTER_FIELDS.map(field => [field, new Map()]));
  const add = (field, value, label) => maps[field].set(value, { value, label });
  for (const team of teams) if (team.key) add("team", team.key, `${team.name || team.key} (${team.key})`);
  for (const project of projects) if (project.id) add("project", project.id, project.name || project.id);
  for (const issue of [...issues, ...records.map(record => record.issue)].filter(Boolean)) {
    const team = issue.teamKey || issue.team?.key;
    if (team && !maps.team.has(team)) add("team", team, team);
    if (issue.project?.id) add("project", issue.project.id, issue.project.name || issue.project.id);
    if (issue.state?.name) add("status", `linear:${issue.state.name}`, `Linear: ${issue.state.name}`);
    const crew = delegateOf(issue);
    if (crew) add("crew", crew, crew);
  }
  for (const [field, label] of [["team", "No team / unlinked"], ["status", "No Linear status / unlinked"],
    ["project", "No project / unlinked"], ["crew", "No delegate / unlinked"]]) add(field, NO_VALUE, label);
  // Keep stale selections visible and removable when data changes or refresh fails.
  const selected = normalizeFilters(filters);
  for (const field of FILTER_FIELDS) for (const value of selected[field]) {
    if (!maps[field].has(value) && !ACTIVITY_OPTIONS.some(option => field === "status" && option.value === value)) {
      add(field, value, value.startsWith("linear:") ? `Linear: ${value.slice(7)}` : value);
    }
  }
  return Object.fromEntries(FILTER_FIELDS.map(field => [field, [
    ...(field === "status" ? ACTIVITY_OPTIONS.map(option => ({ ...option, label: `Activity: ${option.label}` })) : []),
    ...[...maps[field].values()].sort((a, b) => a.label.localeCompare(b.label)),
  ]]));
}

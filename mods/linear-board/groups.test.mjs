import test from "node:test";
import assert from "node:assert/strict";
import { sidebarGroups, toggleCollapsed, GROUP_MODES, GROUP_LABELS, normalizeGroupMode } from "./groups.js";

const row = (id, lane, project = null, extra = {}) => ({
  space: { id }, lane, pinned: false, issue: project ? { project } : { project: null }, ...extra,
});
/** A row whose issue carries a delegate and a team, for the crew and team modes. */
const staffed = (id, lane, { delegate = null, teamKey = null, team = null, project = null } = {}) => ({
  space: { id }, lane, pinned: false, issue: { project, delegate, teamKey, team },
});
const herdr = { id: "p-herdr", name: "herdr" }, lab = { id: "p-lab", name: "Homelab" };

test("status mode keeps the lanes in their order, pinned first, and drops empty ones", () => {
  const groups = sidebarGroups([row("a", "idle"), row("b", "blocked"), row("c", "working", null, { pinned: true })]);
  assert.deepEqual(groups.map(g => [g.key, g.name, g.count]), [
    ["pinned", "PINNED", 1], ["status:blocked", "NEEDS YOU", 1], ["status:idle", "IDLE", 1]]);
  assert.equal(groups[1].tone, "blocked");
});

test("project mode groups by Linear project: needs-you first, then by name, no project last", () => {
  const records = [row("a", "idle", lab), row("b", "idle"), row("c", "working", herdr), row("d", "blocked", { id: "p-z", name: "Zed" }),
    row("e", "done", herdr), row("f", "idle", herdr, { pinned: true })];
  const groups = sidebarGroups(records, "project");
  assert.deepEqual(groups.map(g => [g.name, g.records.map(r => r.space.id)]), [
    ["PINNED", ["f"]], ["ZED", ["d"]], ["HERDR", ["c", "e"]], ["HOMELAB", ["a"]], ["NO PROJECT", ["b"]]]);
  assert.equal(groups[1].needs, 1);
  assert.equal(groups[2].needs, 0);
});

test("a project without an id is keyed by its name", () => {
  const [group] = sidebarGroups([row("a", "idle", { name: "Loose" })], "project");
  assert.equal(group.key, "project:Loose");
});

test("collapsed groups keep their count and are marked collapsed", () => {
  const collapsed = toggleCollapsed({}, "status:idle");
  assert.deepEqual(collapsed, { "status:idle": true });
  const [group] = sidebarGroups([row("a", "idle"), row("b", "idle")], "status", collapsed);
  assert.equal(group.collapsed, true);
  assert.equal(group.count, 2);
  assert.deepEqual(toggleCollapsed(collapsed, "status:idle"), {});
});

test("every group mode has a label, and an unknown mode falls back to status", () => {
  assert.deepEqual(GROUP_MODES, ["status", "project", "crew", "team"]);
  assert.deepEqual(GROUP_MODES.map(mode => GROUP_LABELS[mode]), ["Status", "Project", "Agent", "Company"]);
  for (const mode of GROUP_MODES) assert.equal(normalizeGroupMode(mode), mode);
  for (const bad of ["", "Project", "lane", null, undefined, 7]) assert.equal(normalizeGroupMode(bad), "status");
});

test("crew mode groups by delegate: needs-you first, then by name, no agent last", () => {
  const records = [
    staffed("a", "idle", { delegate: "Spock" }),
    staffed("b", "idle"),
    staffed("c", "working", { delegate: { name: "Data" } }),
    staffed("d", "blocked", { delegate: "Uhura" }),
    staffed("e", "done", { delegate: "Data" }),
    { ...staffed("f", "idle", { delegate: "Data" }), pinned: true },
  ];
  const groups = sidebarGroups(records, "crew");
  assert.deepEqual(groups.map(g => [g.key, g.name, g.records.map(r => r.space.id)]), [
    ["pinned", "PINNED", ["f"]],
    ["crew:Uhura", "UHURA", ["d"]],
    ["crew:Data", "DATA", ["c", "e"]],
    ["crew:Spock", "SPOCK", ["a"]],
    ["crew:none", "NO AGENT", ["b"]]]);
  assert.equal(groups[1].needs, 1);
  assert.equal(groups[2].needs, 0);
});

test("team mode groups by Linear team and names the group from the team list", () => {
  const records = [
    staffed("a", "idle", { teamKey: "CHA" }),
    staffed("b", "idle"),
    staffed("c", "working", { team: { key: "PKX" } }),
    staffed("d", "blocked", { teamKey: "STE" }),
    staffed("e", "idle", { teamKey: "CHA" }),
  ];
  const teams = [{ key: "CHA", name: "Chainbytes" }, { key: "PKX", name: "PointsKash" }];
  const groups = sidebarGroups(records, "team", {}, teams);
  assert.deepEqual(groups.map(g => [g.key, g.name, g.records.map(r => r.space.id)]), [
    ["team:STE", "STE", ["d"]],
    ["team:CHA", "CHAINBYTES", ["a", "e"]],
    ["team:PKX", "POINTSKASH", ["c"]],
    ["team:none", "NO COMPANY", ["b"]]]);
});

test("collapse state is keyed per group, so switching modes keeps each one's own state", () => {
  const records = [staffed("a", "idle", { delegate: "Data", teamKey: "CHA" })];
  const collapsed = toggleCollapsed(toggleCollapsed({}, "crew:Data"), "status:idle");
  assert.equal(sidebarGroups(records, "crew", collapsed)[0].collapsed, true);
  assert.equal(sidebarGroups(records, "team", collapsed)[0].collapsed, false);
  assert.equal(sidebarGroups(records, "status", collapsed)[0].collapsed, true);
});

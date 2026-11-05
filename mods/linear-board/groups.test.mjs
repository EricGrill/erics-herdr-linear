import test from "node:test";
import assert from "node:assert/strict";
import { sidebarGroups, toggleCollapsed } from "./groups.js";

const row = (id, lane, project = null, extra = {}) => ({
  space: { id }, lane, pinned: false, issue: project ? { project } : { project: null }, ...extra,
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

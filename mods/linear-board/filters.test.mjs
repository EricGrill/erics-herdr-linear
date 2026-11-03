import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFilters, toggleFilter, filterCount, matchesFilters, filterOptions, NO_VALUE } from "./filters.js";

const record = (extra = {}) => ({ space: { id: "local", machine: null }, lane: "done", issue: {
  teamKey: "CHA", project: { id: "p1", name: "Same name" }, state: { name: "In Progress", type: "started" },
  delegate: { name: "R2" }, assignee: "Eric", ...extra,
} });

test("empty filters retain linked, unlinked and remote spaces", () => {
  for (const row of [record(), { issue: null }, { ...record(), space: { machine: "remote" } }]) {
    assert.ok(matchesFilters(row, {}));
  }
});

test("each field matches its own identity and all selected dimensions combine", () => {
  const row = record();
  const filters = { team: ["CHA"], status: ["linear:In Progress"], project: ["p1"], crew: ["R2"] };
  assert.ok(matchesFilters(row, filters));
  for (const field of Object.keys(filters)) {
    assert.ok(matchesFilters(row, { [field]: filters[field] }));
    assert.equal(matchesFilters(row, { ...filters, [field]: ["mismatch"] }), false, field);
  }
  assert.equal(matchesFilters(record({ project: { id: "p2", name: "Same name" } }), filters), false);
  assert.equal(matchesFilters(record({ delegate: null }), { crew: ["Eric"] }), false);
  assert.ok(matchesFilters(record({ delegate: "R2", teamKey: null, team: { key: "CHA" } }), filters));
});

test("multi-selection is OR within each dimension", () => {
  assert.ok(matchesFilters(record(), { team: ["PKX", "CHA"], crew: ["R2", "Seven"] }));
  assert.equal(matchesFilters(record(), { team: ["PKX", "CHA"], crew: ["Seven"] }), false);
});

test("agent completion and Linear workflow status stay distinct", () => {
  assert.ok(matchesFilters(record(), { status: ["activity:done"] }));
  assert.ok(matchesFilters(record(), { status: ["linear:In Progress"] }));
  assert.equal(matchesFilters(record(), { status: ["linear:Done"] }), false);
  assert.ok(matchesFilters(record(), { status: ["linear:Done", "activity:done"] }));
});

test("missing metadata matches only explicit no-value selections", () => {
  for (const field of ["team", "status", "project", "crew"]) {
    assert.ok(matchesFilters({ issue: null, lane: "idle" }, { [field]: [NO_VALUE] }));
    assert.equal(matchesFilters(record(), { [field]: [NO_VALUE] }), false);
  }
});

test("toggle and normalization preserve unrelated fields without mutating input", () => {
  const filters = { team: ["CHA"], crew: ["R2"] };
  const before = structuredClone(filters);
  const next = toggleFilter(filters, "project", "p1");
  assert.equal(filterCount(next), 3);
  assert.deepEqual(toggleFilter(next, "project", "p1"), normalizeFilters(filters));
  assert.deepEqual(filters, before);
  assert.deepEqual(normalizeFilters({ team: ["CHA", null, "CHA"], crew: "R2" }), { team: ["CHA"], status: [], project: [], crew: [] });
  assert.equal(filterCount(null), 0);
});

test("options include completed linked issues, all known projects, and removable stale selections", () => {
  const options = filterOptions({ records: [record({ state: { name: "Done" } })],
    teams: [{ key: "CHA", name: "Chainbytes" }], projects: [{ id: "empty", name: "Empty" }],
    issues: [{ delegate: { name: "Seven" } }], filters: { crew: ["Missing"] } });
  assert.ok(options.team.some(x => x.label === "Chainbytes (CHA)"));
  assert.ok(options.status.some(x => x.value === "linear:Done"));
  assert.ok(options.project.some(x => x.value === "empty"));
  assert.deepEqual(options.crew.map(x => x.value), ["Missing", NO_VALUE, "R2", "Seven"]);
  assert.equal(options.status.filter(x => x.value.startsWith("activity:")).length, 4);
});

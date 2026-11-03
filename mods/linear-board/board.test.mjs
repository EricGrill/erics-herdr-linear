import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitName, issueNeedsYou, visibleLabels, delegateOf, machineOf,
  boardTree, machineGroups,
} from "./board.js";

const TEAMS = [{ key: "DEMO", name: "Chainbytes" }, { key: "PKX", name: "PointsKash" }, { key: "STE", name: "StencilWash" }];

const project = (id, name, teamKey = "DEMO") => ({ id, name, teamKey });
const issue = (id, over = {}) => ({
  id, identifier: id, title: id,
  state: { name: "Todo", type: "unstarted" },
  labels: [], delegate: null, ...over,
});

test("splitName folds the Home Workspace family and leaves plain names alone", () => {
  assert.deepEqual(splitName("Home Workspace · Network & DNS"), { group: "Home Workspace", leaf: "Network & DNS" });
  assert.deepEqual(splitName("Quality Demo"), { group: null, leaf: "Quality Demo" });
  // Only the first separator splits, so a three-part name keeps its tail intact.
  assert.deepEqual(splitName("Home Workspace · A · B"), { group: "Home Workspace", leaf: "A · B" });
  // A degenerate name is its own leaf rather than an empty group.
  assert.deepEqual(splitName(" · B"), { group: null, leaf: " · B" });
  assert.deepEqual(splitName("A · "), { group: null, leaf: "A · " });
});

test("issueNeedsYou reads Linear states and labels, never agent liveness", () => {
  assert.equal(issueNeedsYou(issue("A", { state: { name: "Needs Human" } })), true);
  assert.equal(issueNeedsYou(issue("B", { state: { name: "In Review" } })), true);
  assert.equal(issueNeedsYou(issue("C", { labels: ["agent:review-needed"] })), true);
  assert.equal(issueNeedsYou(issue("D", { labels: ["needs-human"] })), true);
  assert.equal(issueNeedsYou(issue("E", { labels: ["agent:stalled"] })), true);
  assert.equal(issueNeedsYou(issue("F")), false);
  // needs-others is somebody else's queue, deliberately not yours.
  assert.equal(issueNeedsYou(issue("G", { labels: ["needs-others"] })), false);
  // An exact state match only: a lookalike name must not trip it.
  assert.equal(issueNeedsYou(issue("H", { state: { name: "In Review Tooling" } })), false);
  assert.equal(issueNeedsYou(null), false);
});

test("personal attention labels and workflow names are configurable rather than public defaults", () => {
  const personal = issue("A", { labels: ["needs-eric"] });
  assert.equal(issueNeedsYou(personal), false);
  assert.equal(issueNeedsYou(personal, { labels: ["needs-eric"] }), true);
  assert.equal(issueNeedsYou(issue("B", { state: { name: "Approval" } }), { states: ["approval"] }), true);
  assert.equal(issueNeedsYou(issue("C", { state: { name: "Needs Human" } }), { states: [] }), false);
  const tree = boardTree({
    projects: [project("p1", "One")], issuesByProject: { p1: [personal] },
    attention: { states: [], labels: ["needs-eric"] },
  });
  assert.equal(tree[0].needs, 1);
  assert.equal(tree[0].children[0].issues[0].needs, true);
});

test("visibleLabels drops routing and bookkeeping chips", () => {
  const got = visibleLabels(issue("A", {
    labels: ["agent:spock", "repo:EricGrill/ClaimZero", "needs-eric", "Bug", "parked-2026-10-27", "QA — Command Center"],
  }));
  assert.deepEqual(got, ["needs-eric", "Bug"]);
});

test("delegateOf never falls back to the assignee", () => {
  assert.equal(delegateOf(issue("A", { delegate: { name: "Spock" }, assignee: "sample-user" })), "Spock");
  assert.equal(delegateOf(issue("B", { delegate: "Data" })), "Data");
  assert.equal(delegateOf(issue("C", { assignee: "sample-user" })), null);
});

test("machineOf reports null for the local machine", () => {
  assert.equal(machineOf({ space: { machine: "snoke" } }), "snoke");
  assert.equal(machineOf({ space: { machine: null } }), null);
  assert.equal(machineOf({}), null);
});

test("boardTree groups by team, folds namespaced projects, sorts needs first", () => {
  const projects = [
    project("p1", "Quality Demo"),
    project("p2", "Home Workspace · Network & DNS"),
    project("p3", "Home Workspace · Hosts & Proxmox"),
    project("p4", "Example Project"),
    project("p5", "PKX Services", "PKX"),
  ];
  const issuesByProject = {
    p4: [issue("DEMO-3816", { state: { name: "Needs Human" }, delegate: { name: "Spock" } })],
    p1: [issue("DEMO-3701")],
  };
  const tree = boardTree({ projects, issuesByProject, teams: TEAMS });

  assert.deepEqual(tree.map(t => t.key), ["DEMO", "PKX"]);
  const demo = tree[0];
  // The project that needs a human comes first, then alphabetical; Home Workspace is one row.
  assert.deepEqual(demo.children.map(c => c.name), ["Example Project", "Home Workspace", "Quality Demo"]);
  const sampleWorkspace = demo.children.find(c => c.kind === "group");
  assert.deepEqual(sampleWorkspace.children.map(c => c.name), ["Hosts & Proxmox", "Network & DNS"]);
  assert.equal(demo.needs, 1);
  assert.equal(demo.children[0].issues[0].delegate, "Spock");
  assert.equal(demo.children[0].issues[0].needs, true);
});

test("boardTree team order follows the teams list, unknown teams last", () => {
  const tree = boardTree({
    projects: [project("p1", "A", "STE"), project("p2", "B", "DEMO"), project("p3", "C", "ZZZ")],
    teams: TEAMS,
  });
  assert.deepEqual(tree.map(t => t.key), ["DEMO", "STE", "ZZZ"]);
  assert.equal(tree[2].name, "ZZZ");
});

test("a delegate filter hides projects with nothing left but keeps them unfiltered", () => {
  const projects = [project("p1", "Helper Project"), project("p2", "Quality Demo")];
  const issuesByProject = {
    p1: [issue("DEMO-3589", { delegate: { name: "Spock" } }), issue("DEMO-3373", { delegate: { name: "Data" } })],
    p2: [issue("DEMO-3701", { delegate: { name: "Seven" } })],
  };
  const all = boardTree({ projects, issuesByProject, teams: TEAMS });
  assert.deepEqual(all[0].children.map(c => c.name), ["Helper Project", "Quality Demo"]);

  const spock = boardTree({ projects, issuesByProject, teams: TEAMS, filter: { delegate: "Spock" } });
  assert.deepEqual(spock[0].children.map(c => c.name), ["Helper Project"]);
  assert.deepEqual(spock[0].children[0].issues.map(i => i.issue.identifier), ["DEMO-3589"]);
});

test("boardTree keeps empty projects when nothing is filtered", () => {
  const tree = boardTree({ projects: [project("p1", "Fresh")], teams: TEAMS });
  assert.equal(tree[0].children.length, 1);
  assert.deepEqual(tree[0].children[0].issues, []);
});

test("boardTree attaches running work records to their issue", () => {
  const record = { space: { id: "s1", name: "DEMO-3589", machine: "snoke" }, status: "working", issue: { id: "DEMO-3589" } };
  const tree = boardTree({
    projects: [project("p1", "Helper Project")],
    issuesByProject: { p1: [issue("DEMO-3589")] },
    records: [record],
    teams: TEAMS,
  });
  const row = tree[0].children[0].issues[0];
  assert.equal(row.records.length, 1);
  assert.equal(machineOf(row.records[0]), "snoke");
});

test("machineGroups keeps unreachable machines visible and busiest first", () => {
  const machines = [
    { name: "snoke", layout: "ready" },
    { name: "darth", layout: "unavailable" },
    { name: null, layout: "ready" },
  ];
  const records = [
    { space: { machine: "snoke" } }, { space: { machine: "snoke" } },
    { space: { machine: null } },
    { space: { machine: "omarchy2" } },
  ];
  const groups = machineGroups(records, machines);
  assert.deepEqual(groups.map(g => g.name), ["snoke", null, "omarchy2", "darth"]);
  assert.equal(groups.find(g => g.name === "darth").reachable, false);
  assert.equal(groups.find(g => g.name === "darth").records.length, 0);
  // A machine Herdr no longer lists still shows its work rather than dropping it.
  assert.equal(groups.find(g => g.name === "omarchy2").reachable, false);
  assert.equal(groups.find(g => g.name === "omarchy2").records.length, 1);
});

test("machineGroups always has a row for this machine", () => {
  assert.deepEqual(machineGroups([], []).map(g => g.name), [null]);
});

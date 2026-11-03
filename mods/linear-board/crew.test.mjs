import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  attentionOf, sortQueue, queueCounts, crewRoster, herdrActivity, age, queueStatus, reassignBatch, batchSummary,
} from "./queue.js";
import { normalizeConfig } from "./config.js";

// Crew's Linear reads and writes run through the real enrich.js with only Herdr's exec
// replaced. No process starts, no network connection opens, no credential is read.
const source = await readFile(new URL("./enrich.js", import.meta.url), "utf8");
const configSource = await readFile(new URL("./config.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

async function load(respond) {
  const calls = [];
  const exec = async (command, args, options) => {
    const body = JSON.parse(args[1].split("HERDR_BOARD_QUERY")[1].replace(/^'/, "").trim());
    calls.push({ body, options });
    return respond(body, calls.length);
  };
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, { context, identifier: "enrich.js" });
  await module.link(async specifier => {
    if (specifier === "./config.js") {
      const config = new vm.SourceTextModule(configSource, { context, identifier: "config.js" });
      await config.link(() => { throw new Error("config is pure"); });
      return config;
    }
    const stub = new vm.SyntheticModule(["exec"], function () { this.setExport("exec", exec); }, { context });
    await stub.link(() => { throw new Error("unreachable"); });
    return stub;
  });
  await module.evaluate();
  return { api: module.namespace, calls };
}

const ok = data => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
const issue = (n, over = {}) => ({
  id: `uuid-${n}`, identifier: `DEMO-${n}`, title: `Sample ${n}`, url: `https://linear.app/demo/issue/DEMO-${n}`,
  priority: 3, priorityLabel: "Medium", updatedAt: "2026-11-01T00:00:00.000Z",
  state: { id: "st-todo", name: "Todo", type: "unstarted" }, project: { id: "p1", name: "Sample Project" },
  team: { key: "DEMO" }, assignee: { id: "human-1", displayName: "sample-human" },
  delegate: { id: "agent-yoda", name: "Yoda", displayName: "yoda" },
  labels: { nodes: [] }, inverseRelations: { nodes: [] }, ...over,
});
const page = (nodes, hasNextPage = false, endCursor = null) => ok({ issues: { pageInfo: { hasNextPage, endCursor }, nodes } });
const rules = normalizeConfig().attention;

// ---- the queue read -------------------------------------------------------------------

test("an agent's queue is read by delegate id across projects, with no Herdr space needed", async () => {
  const six = [1, 2, 3, 4, 5, 6].map(n => issue(n, { project: { id: `p${n % 3}`, name: `Project ${n % 3}` } }));
  const { api, calls } = await load(() => page(six));
  const res = await api.fetchQueue({ delegateId: "agent-yoda", on: "snoke" });
  assert.equal(res.complete, true);
  assert.equal(res.error, null);
  assert.equal(res.rows.length, 6);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, "snoke");
  assert.deepEqual(plain(calls[0].body.variables), { delegate: "agent-yoda", after: null });
  assert.match(calls[0].body.query, /delegate: \{ id: \{ eq: \$delegate \} \}/);
  assert.match(calls[0].body.query, /nin: \["completed", "canceled"\]/);
  assert.equal(new Set(res.rows.map(r => r.project.id)).size, 3);
});

test("queue paging follows the cursor and only a final page is complete", async () => {
  const { api, calls } = await load((_body, n) => n === 1 ? page([issue(1)], true, "c1") : page([issue(2)]));
  const res = await api.fetchQueue({ delegateId: "agent-yoda" });
  assert.equal(res.complete, true);
  assert.deepEqual(plain(res.rows.map(r => r.identifier)), ["DEMO-1", "DEMO-2"]);
  assert.equal(calls[1].body.variables.after, "c1");
});

test("a page cap is reported as incomplete, never as the whole queue", async () => {
  const { api } = await load((_b, n) => page([issue(n)], true, `c${n}`));
  const res = await api.fetchQueue({ delegateId: "agent-yoda", pages: 2 });
  assert.equal(res.complete, false);
  assert.equal(res.error, null);
  assert.equal(res.rows.length, 2);
  assert.equal(queueStatus({ ...res, loading: false }).kind, "partial");
});

test("an error on a later page keeps the earlier rows but marks the read incomplete", async () => {
  const { api } = await load((_b, n) => n === 1 ? page([issue(1)], true, "c1") : { code: 0, stdout: JSON.stringify({ errors: [{ message: "rate limited" }] }), stderr: "" });
  const res = await api.fetchQueue({ delegateId: "agent-yoda" });
  assert.equal(res.complete, false);
  assert.equal(res.error, "rate limited");
  assert.equal(res.rows.length, 1);
  const status = queueStatus({ ...res, loading: false });
  assert.equal(status.kind, "error");
  assert.match(status.text, /Incomplete: rate limited/);
});

test("a failed shell or missing identity is an explicit error, not an empty queue", async () => {
  const { api } = await load(() => ({ code: 4, stdout: "", stderr: "no Linear API key available" }));
  const failed = await api.fetchQueue({ delegateId: "agent-yoda" });
  assert.equal(failed.complete, false);
  assert.match(failed.error, /no Linear API key/);
  assert.match(queueStatus(failed).text, /Could not read the queue/);
  const noId = await api.fetchQueue({ delegateId: null });
  assert.match(noId.error, /no Linear identity/);
});

test("an empty complete queue reads as empty, and a fresh one as loading", () => {
  assert.equal(queueStatus({ rows: [], complete: true, error: null, loading: false }).kind, "empty");
  assert.equal(queueStatus(undefined).kind, "loading");
  assert.equal(queueStatus({ rows: [], loading: true }).kind, "loading");
  assert.equal(queueStatus({ rows: [{}], loading: true, complete: false }).kind, "refreshing", "a refresh is not mislabelled as a partial read");
  assert.equal(queueStatus({ rows: [{}], complete: true, error: null, loading: false }).kind, "complete");
});

test("queue rows carry blockers from inverse 'blocks' relations only", async () => {
  const { api } = await load(() => page([issue(1, { inverseRelations: { nodes: [
    { type: "blocks", issue: { identifier: "DEMO-9", title: "Dependency", state: { name: "In Progress", type: "started" } } },
    { type: "related", issue: { identifier: "DEMO-8", title: "Nearby", state: null } },
  ] } })]));
  const [row] = (await api.fetchQueue({ delegateId: "agent-yoda" })).rows;
  assert.deepEqual(plain(row.blockers), [{ identifier: "DEMO-9", title: "Dependency", state: { id: null, name: "In Progress", type: "started" } }]);
  assert.deepEqual(plain(row.assignee), { id: "human-1", name: "sample-human" });
  assert.deepEqual(plain(row.delegate), { id: "agent-yoda", name: "Yoda" });
});

// ---- agents and detail ------------------------------------------------------------------

test("only active Linear app users are delegation targets, including ones with no work", async () => {
  const { api, calls } = await load(() => ok({ users: { pageInfo: { hasNextPage: false }, nodes: [
    { id: "agent-yoda", name: "Yoda", app: true, active: true },
    { id: "agent-idle", name: "Idle Bot", app: true, active: true },
    { id: "human-1", name: "sample-human", app: false, active: true },
    { id: "agent-old", name: "Retired", app: true, active: false },
  ] } }));
  const res = await api.fetchAgents();
  assert.equal(res.complete, true);
  assert.deepEqual(plain(res.agents), [{ id: "agent-yoda", name: "Yoda" }, { id: "agent-idle", name: "Idle Bot" }]);
  assert.match(calls[0].body.query, /app: \{ eq: true \}/);
});

test("issue detail returns description, blocking issues and linked PRs; a missing issue is an error", async () => {
  const { api } = await load((_b, n) => n === 1 ? ok({ issue: { ...issue(1), description: "Do the thing",
    relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "DEMO-5", title: "Waits", state: null } }] },
    attachments: { nodes: [
      { title: "PR #12", url: "https://github.com/x/y/pull/12", sourceType: "github" },
      { title: "Doc", url: "https://example.invalid/doc", sourceType: "unknown" },
    ] } } }) : ok({ issue: null }));
  const first = await api.fetchIssueDetail({ id: "uuid-1" });
  assert.equal(first.error, null);
  assert.equal(first.issue.description, "Do the thing");
  assert.deepEqual(plain(first.issue.blocking.map(b => b.identifier)), ["DEMO-5"]);
  assert.deepEqual(plain(first.issue.prs.map(p => p.url)), ["https://github.com/x/y/pull/12"]);
  const missing = await api.fetchIssueDetail({ id: "uuid-x" });
  assert.equal(missing.issue, null);
  assert.match(missing.error, /did not return/);
});

// ---- reassignment ------------------------------------------------------------------------

const snapshot = over => ok({ issue: {
  id: "uuid-1", identifier: "DEMO-1", priority: 2, state: { id: "st-review", name: "In Review" },
  project: { id: "p1", name: "Sample Project" }, assignee: { id: "human-1", displayName: "sample-human" },
  delegate: { id: "agent-yoda", name: "Yoda" }, ...over,
} });

test("reassigning sends only delegateId and verifies it, preserving assignee, state, project and priority", async () => {
  const { api, calls } = await load((body, n) => {
    if (n === 1) return snapshot();
    if (n === 2) return ok({ issueUpdate: { success: true } });
    return snapshot({ delegate: { id: "agent-data", name: "Data" } });
  });
  const res = await api.reassignIssue({ id: "uuid-1", delegateId: "agent-data" });
  assert.equal(res.ok, true, res.error);
  assert.equal(calls.length, 3);
  const mutation = calls[1].body;
  assert.match(mutation.query, /issueUpdate\(id: \$id, input: \{ delegateId: \$delegate \}\)/);
  assert.doesNotMatch(mutation.query, /assignee|stateId|projectId|priority/);
  assert.deepEqual(plain(mutation.variables), { id: "uuid-1", delegate: "agent-data" });
  assert.equal(res.after.assigneeId, "human-1");
  assert.equal(res.after.stateId, "st-review");
});

test("a readback that still shows the old delegate is a failure, not a success", async () => {
  const { api } = await load((_b, n) => n === 2 ? ok({ issueUpdate: { success: true } }) : snapshot());
  const res = await api.reassignIssue({ id: "uuid-1", delegateId: "agent-data" });
  assert.equal(res.ok, false);
  assert.match(res.error, /still shows Yoda/);
});

test("a write that disturbed the human assignee or state is reported", async () => {
  const { api } = await load((_b, n) => n === 1 ? snapshot() : n === 2 ? ok({ issueUpdate: { success: true } })
    : snapshot({ delegate: { id: "agent-data", name: "Data" }, assignee: null, state: { id: "st-ip", name: "In Progress" } }));
  const res = await api.reassignIssue({ id: "uuid-1", delegateId: "agent-data" });
  assert.equal(res.ok, false);
  assert.match(res.error, /assignee changed from sample-human to nobody/);
  assert.match(res.error, /state changed from In Review to In Progress/);
});

test("a rejected mutation fails without claiming success", async () => {
  const { api } = await load((_b, n) => n === 1 ? snapshot()
    : { code: 0, stdout: JSON.stringify({ errors: [{ message: "Delegate must be an app user" }] }), stderr: "" });
  const res = await api.reassignIssue({ id: "uuid-1", delegateId: "human-2" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "Delegate must be an app user");
});

test("an issue already delegated to the destination is verified without writing", async () => {
  const { api, calls } = await load(() => snapshot({ delegate: { id: "agent-data", name: "Data" } }));
  const res = await api.reassignIssue({ id: "uuid-1", delegateId: "agent-data" });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => !/mutation/.test(c.body.query)));
});

test("a bulk reassignment keeps going past failures and reports each one", async () => {
  const rows = [{ id: "a", identifier: "DEMO-1" }, { id: "b", identifier: "DEMO-2" }, { id: "c", identifier: "DEMO-3" }];
  const batch = await reassignBatch(rows, async row => {
    if (row.id === "b") return { ok: false, error: "state changed" };
    if (row.id === "c") throw new Error("network down");
    return { ok: true };
  });
  assert.equal(batch.ok, false);
  assert.equal(batch.succeeded, 1);
  assert.deepEqual(batch.failed.map(f => [f.identifier, f.error]), [["DEMO-2", "state changed"], ["DEMO-3", "network down"]]);
  assert.equal(batchSummary(batch, "Data"), "1 of 3 moved to Data; 2 failed and stay selected for retry.");
  const all = await reassignBatch(rows, async () => ({ ok: true }));
  assert.equal(all.ok, true);
  assert.match(batchSummary(all, "Data"), /Moved 3 issues to Data; Linear confirmed each one/);
  const none = await reassignBatch(rows.slice(0, 1), async () => ({ ok: false }));
  assert.match(batchSummary(none, "Data"), /None of the 1 moved/);
  assert.equal((await reassignBatch([], async () => ({ ok: true }))).ok, false);
});

// ---- attention, ordering and counts ------------------------------------------------------

const row = (n, over = {}) => ({
  id: `uuid-${n}`, identifier: `DEMO-${n}`, title: `Sample ${n}`, priority: 3, updatedAt: `2026-11-0${n}T00:00:00Z`,
  state: { name: "Todo", type: "unstarted" }, labels: [], blockers: [], delegate: { id: "agent-yoda", name: "Yoda" }, ...over,
});

test("six open issues with one needing attention: six total, one needs, that one first with its reason", () => {
  const rows = [1, 2, 3, 4, 5, 6].map(n => row(n, n === 4 ? { labels: ["agent:stalled"] } : {}));
  const sorted = sortQueue(rows, rules);
  assert.deepEqual(queueCounts(sorted), { total: 6, needs: 1 });
  assert.equal(sorted[0].identifier, "DEMO-4");
  assert.equal(sorted[0].attention.reason, "Labelled agent:stalled");
  assert.ok(sorted.slice(1).every(r => !r.attention.needs));
});

test("attention reasons come from the configured state and label rules", () => {
  const custom = normalizeConfig({ attention: { states: ["Waiting on Eric"], labels: ["help"] } }).attention;
  assert.equal(attentionOf(row(1, { state: { name: "Waiting on Eric" } }), custom).reason, "State is Waiting on Eric");
  assert.equal(attentionOf(row(1, { state: { name: "In Review" } }), custom).needs, false, "default states no longer apply");
  assert.equal(attentionOf(row(1, { state: { name: "In Review" }, labels: ["needs-human"] }), rules).reason,
    "State is In Review · Labelled needs-human");
});

test("an open blocker is explained but does not by itself count as attention", () => {
  const a = attentionOf(row(1, { blockers: [
    { identifier: "DEMO-9", state: { name: "In Progress", type: "started" } },
    { identifier: "DEMO-8", state: { name: "Done", type: "completed" } },
  ] }), rules);
  assert.equal(a.needs, false);
  assert.equal(a.blockedBy, "Blocked by DEMO-9 (In Progress)");
});

test("after attention, rows order by priority (none last) then most recently updated", () => {
  const sorted = sortQueue([row(1, { priority: 0 }), row(2, { priority: 4 }), row(3, { priority: 1 }), row(5, { priority: 4 })], rules);
  assert.deepEqual(sorted.map(r => r.identifier), ["DEMO-3", "DEMO-5", "DEMO-2", "DEMO-1"]);
});

test("the roster lists every Linear agent, idle ones included, with separate counts", () => {
  const roster = crewRoster({
    agents: [{ id: "agent-yoda", name: "Yoda" }, { id: "agent-idle", name: "Idle Bot" }],
    rows: [row(1), row(2, { labels: ["needs-human"] }), row(3, { delegate: { id: "agent-x", name: "Stray" } }), row(4, { delegate: null })],
    rules,
  });
  const by = Object.fromEntries(roster.map(e => [e.name, e]));
  assert.deepEqual([by.Yoda.total, by.Yoda.needs, by.Yoda.eligible], [2, 1, true]);
  assert.deepEqual([by["Idle Bot"].total, by["Idle Bot"].eligible], [0, true]);
  assert.deepEqual([by.Stray.total, by.Stray.id, by.Stray.eligible], [1, "agent-x", false], "a delegate missing from the agent list stays reachable");
  assert.equal(roster[0].name, "Yoda");
  assert.equal(roster.length, 3);
});

test("Herdr activity is separate from Linear: no space is a valid state", () => {
  const records = [{ issue: { identifier: "DEMO-1" }, status: "working", space: { machine: "snoke" } }];
  assert.deepEqual(plain(herdrActivity("demo-1", records)).summary, "working on snoke");
  assert.equal(herdrActivity("DEMO-1", records).running, true);
  const none = herdrActivity("DEMO-2", records);
  assert.equal(none.records.length, 0);
  assert.equal(none.summary, "No Herdr space");
});

test("ages read plainly", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(age("2026-11-03T11:59:30Z", now), "just now");
  assert.equal(age("2026-11-03T11:45:00Z", now), "15m ago");
  assert.equal(age("2026-11-03T07:00:00Z", now), "5h ago");
  assert.equal(age("2026-10-31T12:00:00Z", now), "3d ago");
  assert.equal(age(null, now), "");
});

// ---- the window never drives a terminal --------------------------------------------------

test("Crew's reassignment path sends no terminal commands and never filters Spaces", async () => {
  const main = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const start = main.indexOf("  crewInit(cx) {");
  const end = main.indexOf("  render(cx) {");
  assert.ok(start > 0 && end > start);
  const crew = main.slice(start, end);
  const apply = crew.slice(crew.indexOf("  crewApplyReassign("), crew.indexOf("  crewWindow() {"));
  assert.doesNotMatch(apply, /\brun\(|tab\.new|agent\.|exec\(/, "reassignment must not touch a terminal");
  const select = crew.slice(crew.indexOf("  crewSelectAgent("), crew.indexOf("  crewLoadQueue("));
  assert.doesNotMatch(select, /FILTER|applyFilter|setDelegateFilter/, "selecting an agent must leave Spaces alone");
  assert.match(main, /if \(this\.role === "crew"\) return this\.crewWindow\(\);/);
});

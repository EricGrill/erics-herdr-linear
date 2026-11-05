import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// Real controller, queue model and native tree builders. Only native widgets and
// external data boundaries are synthetic; no credentials, terminals or network.
function native(type) {
  const node = { type, nodes: [], attributes: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return child => { target.nodes.push(child); return proxy; };
    if (key === "children") return children => { target.nodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => { if (condition) callback(proxy); return proxy; };
    return (...args) => { target.attributes[key] = args; return proxy; };
  } });
  return proxy;
}
const nodes = node => node && typeof node === "object" ? [node, ...node.nodes.flatMap(nodes)] : [];
const text = node => typeof node === "string" ? node : (node?.nodes ?? []).map(text).join("|");
const byId = (tree, id) => nodes(tree).find(n => n.attributes.id?.[0] === id);
const yoda = { id: "yoda", name: "Yoda", eligible: true }, leia = { id: "leia", name: "Leia", eligible: true };
const issue = n => ({ id: `issue-${n}`, identifier: `DEMO-${n}`, title: `Issue ${n}`,
  delegate: yoda, assignee: { id: "human", name: "Human" }, project: { id: "p", name: "Project" },
  priority: 2, priorityLabel: "High", state: { name: "In Progress", type: "started" },
  labels: [], updatedAt: "2026-11-01T00:00:00Z", url: `https://example.test/DEMO-${n}` });
const complete = rows => ({ rows, complete: true, error: null, fetchedAt: 200 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness({ rows = [], queue = async () => complete(rows), detail = async ({ id }) => ({ issue: rows.find(r => r.id === id), error: null }), write = async () => ({ ok: true }), enrichment } = {}) {
  const effects = [], writes = [], tasks = [];
  const state = new Map([
    ["erics-linear.config", { attention: { states: ["Blocked"], labels: ["needs-human"] } }],
    ["linear-board.enrich", { rows, on: null, fetchedAt: 100, partial: false, error: null }],
    ["linear-workspace.workspace", "workspace-one"],
    ["linear-board.filters", { "workspace-one": { team: ["DEMO"], crew: ["Existing filter"] } }],
  ]);
  const context = vm.createContext({ console });
  const effect = name => (...args) => { effects.push({ name, args }); };
  const boundaries = {
    "gpui-kit": { div: () => native("div"), svg: () => native("svg"), image: () => native("image") },
    "gpui-base": { v_flex: () => native("column"), h_flex: () => native("row"), Input: {}, InputState: {}, Popup: {},
      TextView: { markdown: (id, body) => native("markdown").id(id).child(body) } },
    "./client.js": { default: class {
      rememberProject(id, workspace) { effects.push({ name: "rememberProject", id, workspace }); }
    } },
    "fs/promises": { readFile: async () => "{}" },
    "herdr": {
      spaces: () => [], panes: () => [], agents: () => [], machines: () => [], window: () => null, keys: () => [],
      shared: key => state.get(key), setShared: (key, value) => { effects.push({ name: "setShared", key }); state.set(key, value); },
      theme: () => new Proxy({}, { get: () => "#777777" }), props: () => ({ role: "crew" }),
      setAgentOrder: effect("setAgentOrder"), run: effect("run"), exec: effect("exec"),
      openOverlay: effect("openOverlay"), closeOverlay: effect("closeOverlay"), knownAgents: () => [], appHome: () => "/fake",
    },
    "./enrich.js": {
      indexEnrichment: values => ({ byId: new Map(values.map(r => [r.id, r])), byIdentifier: new Map(values.map(r => [r.identifier, r])) }),
      fetchAgents: async () => ({ agents: [yoda, leia], complete: true, error: null }),
      fetchQueue: queue, fetchIssueDetail: detail,
      fetchPullRequests: async () => ({ pulls: {}, error: null }), rowPullRequest: () => null,
      reassignIssue: args => { writes.push(args); return write(args); },
      // Deliberately stale: freshly fetched individual queues must own their counts.
      fetchEnrichment: enrichment ?? (async () => ({ rows, error: null, fetchedAt: 100, partial: false })),
    },
  };
  const cache = new Map();
  function load(specifier) {
    if (cache.has(specifier)) return cache.get(specifier);
    const values = boundaries[specifier];
    const mod = values ? new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context }) : new vm.SourceTextModule(readFileSync(new URL(specifier, import.meta.url), "utf8"), { context });
    cache.set(specifier, mod);
    return mod;
  }
  const mod = load("./main.js");
  await mod.link(load);
  await mod.evaluate();
  const board = new mod.namespace.default();
  const cx = { notify() {}, stop_propagation() {}, timer: { every() {} },
    open_url: effect("open_url"), spawn: fn => { tasks.push(Promise.resolve().then(() => fn(cx))); } };
  const flush = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  board.init({}, cx);
  await flush();
  const click = (tree, id) => { const node = byId(tree, id); assert.ok(node, `Missing ${id}`); node.attributes.on_click[0]({}, cx); };
  return { board, cx, flush, click, effects, writes, state };
}

test("Crew renders six zero-space issues, attention first, without changing the Spaces filter", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => issue(i + 1));
  rows[5].labels = ["needs-human"];
  const h = await harness({ rows });
  const before = h.board.crewWindow();
  const rosterRow = nodes(before).find(n => n.attributes.id?.[0]?.startsWith("crew-agent-") && text(n).includes("Yoda"));
  rosterRow.attributes.on_click[0]({}, h.cx);
  await h.flush();
  const tree = h.board.crewWindow(), queue = byId(tree, "crew-queue");
  assert.equal(queue.nodes.length, 6);
  assert.equal(queue.nodes[0].attributes.id[0], "crew-row-issue-6");
  assert.match(text(tree), /6 open/);
  assert.match(text(tree), /1 of 6 need attention/);
  assert.match(text(tree), /Labelled needs-human/);
  assert.equal((text(queue).match(/No Herdr space/g) ?? []).length, 6);
  assert.deepEqual(h.state.get("linear-board.filters"), { "workspace-one": { team: ["DEMO"], crew: ["Existing filter"] } });
  assert.equal(h.effects.filter(e => e.name === "setShared" && e.key === "linear-board.filters").length, 0);
  assert.ok(queue.attributes.overflow_y_scrollbar);
  assert.deepEqual(queue.attributes.min_h, [0]);
  assert.ok(byId(tree, "crew-agents").attributes.overflow_y_scrollbar);
});

test("issue inspection renders detail without a workspace and exposes an existing workspace", async () => {
  const row = issue(1), full = { ...row, description: "Detailed explanation", labels: ["needs-human"],
    blockers: [{ identifier: "DEMO-9", title: "Waiting for access", state: { name: "Todo" } }],
    prs: [{ title: "Fix PR", url: "https://example.test/pr/1" }] };
  const h = await harness({ rows: [row], detail: async () => ({ issue: full, error: null }) });
  h.board.crewSelectAgent(yoda, h.cx); await h.flush();
  h.click(h.board.crewWindow(), "crew-row-issue-1"); await h.flush();
  const tree = h.board.crewInspector([]);
  assert.match(text(tree), /Detailed explanation/);
  assert.match(text(tree), /Waiting for access/);
  assert.match(text(tree), /Fix PR/);
  assert.match(text(tree), /No Herdr space for this issue/);
  assert.equal(byId(tree, "crew-workspace"), undefined);
  h.click(tree, "crew-linear");
  assert.equal(h.effects.at(-1).args[0], row.url);
  const record = { issue: row, space: { id: "space-1", machine: null }, status: "working", agents: [] };
  const linked = h.board.crewInspector([record]);
  assert.match(text(linked), /working on local/);
  h.click(linked, "crew-workspace");
  assert.equal(h.effects.find(e => e.name === "rememberProject")?.id, row.project.id);
  assert.equal(h.effects.at(-1).args[0], "space.select");
  assert.equal(h.effects.at(-1).args[1].id, "space-1");
});

test("mixed bulk results keep failed rows retryable after refresh failure without terminal effects", async () => {
  const rows = [issue(1), issue(2)]; let moved = false;
  const h = await harness({ rows,
    queue: async ({ delegateId }) => moved && delegateId === yoda.id
      ? { rows: [], complete: false, error: "offline", fetchedAt: null }
      : complete(delegateId === yoda.id ? rows : moved ? [{ ...rows[0], delegate: leia }] : []),
    write: async ({ id }) => { moved = true; return id === rows[0].id ? { ok: true } : { ok: false, error: "permission denied" }; },
  });
  h.board.crewSelectAgent(yoda, h.cx); await h.flush();
  h.board.crewOpenReassign(rows.map(r => r.id), h.cx);
  const panel = h.board.crewWindow();
  const dest = nodes(panel).find(n => n.attributes.id?.[0]?.startsWith("crew-dest-") && text(n).includes("Leia"));
  assert.ok(dest, "An agent with no open issues is an eligible destination");
  dest.attributes.on_click[0]({}, h.cx);
  assert.match(text(h.board.crewWindow()), /Reassign 2 issues from Yoda to Leia/);
  const running = { issue: rows[0], status: "working", space: { id: "active", machine: null }, agents: [] };
  const runningPanel = h.board.crewReassignPanel(rows, [running], []);
  assert.match(text(runningPanel), /running sessions continue/);
  assert.match(text(runningPanel), /DEMO-1 \(working on local\)/);
  h.click(h.board.crewWindow(), "crew-apply"); await h.flush();
  const tree = h.board.crewWindow();
  assert.match(text(tree), /1 of 2 moved to Leia/);
  assert.match(text(tree), /permission denied/);
  assert.match(text(tree), /offline/);
  assert.equal(h.board.crew.result.ok, false);
  assert.deepEqual([...h.board.crew.picked], [rows[1].id]);
  assert.ok(byId(tree, "crew-row-issue-2"), "Failed row remains visible for retry");
  assert.ok(byId(tree, "crew-apply"), "Retry action remains available");
  assert.equal(running.status, "working");
  assert.equal(h.writes.length, 2);
  for (const write of h.writes) assert.deepEqual(Object.keys(write).sort(), ["config", "delegateId", "id", "on"]);
  assert.equal(h.effects.filter(e => ["run", "exec", "setAgentOrder"].includes(e.name)).length, 0);
});

test("source and destination roster counts use fresh queues over stale enrichment", async () => {
  const rows = [issue(1), issue(2)]; let moved = false;
  const h = await harness({ rows, queue: async ({ delegateId }) => complete(delegateId === yoda.id
    ? moved ? [rows[1]] : rows : moved ? [{ ...rows[0], delegate: leia }] : []),
  write: async () => { moved = true; return { ok: true }; } });
  h.board.crewSelectAgent(yoda, h.cx); await h.flush();
  h.board.crewOpenReassign([rows[0].id], h.cx);
  h.board.crew.reassign.target = leia;
  h.click(h.board.crewWindow(), "crew-apply"); await h.flush();
  const roster = byId(h.board.crewWindow(), "crew-agents");
  for (const name of ["Yoda", "Leia"]) {
    const row = nodes(roster).find(n => n.attributes.id?.[0]?.startsWith("crew-agent-") && text(n).includes(name));
    assert.match(text(row), /1 open/);
  }
});

test("late queue and inspector responses cannot overwrite newer responses", async () => {
  const oldQueue = deferred(), newQueue = deferred(), oldDetail = deferred(), newDetail = deferred();
  let queues = 0, details = 0;
  const row = issue(1);
  const h = await harness({ queue: () => (++queues === 1 ? oldQueue.promise : newQueue.promise),
    detail: () => (++details === 1 ? oldDetail.promise : newDetail.promise) });
  h.board.crewSelectAgent(yoda, h.cx); h.board.crewLoadQueue(yoda.id, h.cx);
  newQueue.resolve(complete([{ ...row, title: "Newest queue" }]));
  await new Promise(resolve => setImmediate(resolve));
  oldQueue.resolve(complete([{ ...row, title: "Old queue" }]));
  await h.flush();
  assert.equal(h.board.crew.queues.yoda.rows[0].title, "Newest queue");
  h.board.crewInspect(row, h.cx); h.board.crewInspect(row, h.cx);
  newDetail.resolve({ issue: { ...row, description: "Newest detail" }, error: null });
  await new Promise(resolve => setImmediate(resolve));
  oldDetail.resolve({ issue: { ...row, description: "Old detail" }, error: null });
  await h.flush();
  assert.equal(h.board.crew.details[row.id].issue.description, "Newest detail");
});

test("queue renders explicit loading, empty, partial and error states", async () => {
  const pending = deferred();
  const h = await harness({ queue: () => pending.promise });
  h.board.crewSelectAgent(yoda, h.cx);
  assert.match(text(h.board.crewWindow()), /Reading this agent's queue/);
  pending.resolve(complete([])); await h.flush();
  assert.match(text(h.board.crewWindow()), /No open issues are delegated/);
  h.board.crew.queues.yoda = { rows: [issue(1)], complete: false, error: null };
  assert.match(text(h.board.crewWindow()), /1 open so far/);
  assert.match(text(h.board.crewWindow()), /Incomplete: showing the first 1/);
  h.board.crew.queues.yoda = { rows: [], complete: false, error: "access denied" };
  assert.match(text(h.board.crewWindow()), /Could not read the queue: access denied/);
  assert.doesNotMatch(text(h.board.crewWindow()), /No open issues are delegated/);
});

test("roster freshness follows numeric snapshot time in both directions", async () => {
  const rows = [issue(1), issue(2)];
  const h = await harness({ rows, queue: async () => ({ ...complete([rows[0]]), fetchedAt: 200 }) });
  h.board.crewSelectAgent(yoda, h.cx); await h.flush();
  const yodaRow = () => nodes(byId(h.board.crewWindow(), "crew-agents"))
    .find(n => n.attributes.id?.[0]?.startsWith("crew-agent-") && text(n).includes("Yoda"));
  assert.match(text(yodaRow()), /1 open/, "Older enrichment cannot replace a freshly read queue");
  h.state.set("linear-board.enrich", { rows, on: null, fetchedAt: 300, error: null, partial: false });
  assert.match(text(yodaRow()), /2 open/, "Newer shared enrichment must supersede an older cached queue");
});

test("late sidebar enrichment cannot overwrite the post-reassignment shared snapshot", async () => {
  const rows = [issue(1)], old = deferred(), started = deferred();
  let reads = 0;
  const refreshed = [{ ...rows[0], delegate: leia }];
  const h = await harness({ rows, enrichment: async () => {
    reads++;
    if (reads === 1) { started.resolve(); return old.promise; }
    return { rows: refreshed, error: null, fetchedAt: 300, partial: false };
  } });
  Object.assign(h.board, { demo: false, signedOut: false, enrichmentReady: true, on: "" });
  h.board.startEnrich(h.cx);
  await started.promise;
  h.board.crewSelectAgent(yoda, h.cx);
  await new Promise(resolve => setImmediate(resolve));
  h.board.crewOpenReassign([rows[0].id], h.cx);
  h.board.crew.reassign.target = leia;
  h.board.crewApplyReassign(rows, h.cx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(h.state.get("linear-board.enrich").rows[0].delegate.id, leia.id);
  old.resolve({ rows, error: null, fetchedAt: 200, partial: false });
  await h.flush();
  assert.equal(h.state.get("linear-board.enrich").rows[0].delegate.id, leia.id);
  assert.equal(h.state.get("linear-board.enrich").fetchedAt, 300);
});

test("losing the Linear connection invalidates an in-flight queue read", async () => {
  const pending = deferred();
  const h = await harness({ queue: () => pending.promise });
  h.board.crewSelectAgent(yoda, h.cx);
  await new Promise(resolve => setImmediate(resolve));
  h.state.delete("erics-linear.config");
  h.board.crewLoadQueue(yoda.id, h.cx);
  pending.resolve(complete([issue(1)])); await h.flush();
  assert.equal(h.board.crew.queues.yoda.waiting, true);
  assert.match(text(h.board.crewWindow()), /Waiting for the Herdr sidebar/);
});

test("a queue response from the previous Linear connection is ignored", async () => {
  const pending = deferred();
  const h = await harness({ queue: () => pending.promise });
  h.board.crewSelectAgent(yoda, h.cx);
  await new Promise(resolve => setImmediate(resolve));
  h.state.set("linear-board.enrich", { rows: [], on: "other-machine", fetchedAt: 100, error: null, partial: false });
  pending.resolve(complete([issue(1)])); await h.flush();
  assert.equal(h.board.crew.queues.yoda.rows.length, 0);
  assert.equal(byId(h.board.crewWindow(), "crew-row-issue-1"), undefined);
});

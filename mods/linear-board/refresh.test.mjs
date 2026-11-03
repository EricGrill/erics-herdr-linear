import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function native() {
  const node = { nodes: [], attributes: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return child => { target.nodes.push(child); return proxy; };
    if (key === "children") return children => { target.nodes.push(...children); return proxy; };
    if (key === "when") return (condition, fn) => { if (condition) fn(proxy); return proxy; };
    return (...args) => { target.attributes[key] = args; return proxy; };
  } });
  return proxy;
}
const issue = (n, state = "Started") => ({ id: `id-${n}`, identifier: `TEST-${n}`, title: "Sample", state: { name: state, type: state === "Done" ? "completed" : "started" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const text = node => typeof node === "string" ? node : (node?.nodes ?? []).map(text).join("|");
const nodes = node => node && typeof node === "object" ? [node, ...node.nodes.flatMap(nodes)] : [];

async function harness(count = 1) {
  const jobs = [], calls = [], data = new Map(), context = vm.createContext({ console });
  const rows = Array.from({ length: count }, (_, i) => issue(i + 1));
  const spaces = rows.map(row => ({ id: row.id, name: row.identifier, status: "blocked" }));
  data.set("linear-workspace.data", { one: { issues: rows } });
  class Client {
    loadAll(cx) { for (const tab of ["mine", "recent", "projects"]) this.load(tab, cx); }
    keep() {}
    seedAll() {}
    workspace() { return { id: this.ws }; }
  }
  const dummy = () => {};
  const boundaries = {
    "gpui-kit": { div: native, svg: native, image: native },
    "gpui-base": { v_flex: native, h_flex: native, Input: { new: native }, Popup: {}, TextView: {} },
    "./client.js": { default: Client },
    "fs/promises": { readFile: async () => "{}" },
    "herdr": { spaces: () => spaces, panes: () => [], agents: () => [], machines: () => [],
      shared: key => data.get(key), setShared: (key, value) => data.set(key, value), theme: () => ({}),
      setAgentOrder: dummy, run: dummy, props: () => ({}), openOverlay: dummy, closeOverlay: dummy,
      knownAgents: dummy, appHome: () => "/fake", exec: dummy },
  };
  const cache = new Map();
  function load(specifier) {
    if (cache.has(specifier)) return cache.get(specifier);
    const values = boundaries[specifier];
    const module = values ? new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context }) : new vm.SourceTextModule(readFileSync(new URL(specifier, import.meta.url), "utf8"), { context });
    cache.set(specifier, module);
    return module;
  }
  const module = load("./main.js");
  await module.link(load); await module.evaluate();
  const view = new module.namespace.default();
  Object.assign(view, { role: "sidebar", ws: "one", on: "", lists: {}, expanded: {}, resolved: {}, readVersion: 0 });
  view.startEnrich = async () => {};
  view.linear = async req => { calls.push(req); return { issues: req.op === "find" ? [issue(Number(req.key.split("-")[1]), "Done")] : rows }; };
  const cx = { notify() {}, spawn(fn) { jobs.push(Promise.resolve().then(() => fn(cx))); } };
  const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  return { view, cx, settle, calls, data, spaces };
}

test("refresh reloads all linked tickets including completed ones beyond the background cap", async () => {
  const h = await harness(10);
  h.view.err = "Old connection error";
  h.view.refresh(h.cx); h.view.refresh(h.cx);
  assert.equal(h.view.refreshing, true);
  const busy = h.view.sidebar();
  assert.match(text(busy), /Refreshing/);
  assert.ok(nodes(busy).some(node => node.attributes.frames?.[1] === 120));
  await h.settle();
  assert.equal(h.calls.filter(req => req.op === "find").length, 10);
  assert.equal(h.calls.filter(req => req.op === "list").length, 3);
  assert.ok(h.view.allIssues().every(row => row.state.name === "Done"));
  assert.equal(h.view.refreshing, false);
  assert.equal(h.view.err, "");
  assert.match(text(h.view.sidebar()), /Needs input · Linear: Done · local/);
});

test("fresh periodic list responses replace shared ticket data and older responses cannot undo them", async () => {
  const h = await harness();
  const old = deferred();
  h.view.linear = req => req.tab === "mine" ? old.promise : Promise.resolve({ issues: [issue(1, "Done")] });
  h.view.load("mine", h.cx);
  h.view.load("recent", h.cx);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  old.resolve({ issues: [issue(1)] });
  await h.settle();
  assert.equal(h.view.allIssues()[0].state.name, "Done");
});

test("refresh retains cached issues and reports list and linked-ticket failures", async () => {
  const h = await harness();
  h.view.linear = async () => { throw new Error("Offline"); };
  h.view.reload(h.cx);
  await h.settle();
  assert.equal(h.view.allIssues()[0].state.name, "Started");
  assert.match(h.view.err, /Refresh incomplete:.*Offline/);
  assert.equal(h.view.refreshing, false);
});

test("refresh retries a missing connection once and retains cached tickets when sign-in is required", async () => {
  const h = await harness();
  h.view.signedOut = true;
  h.view.on = null;
  let attempts = 0;
  h.view.findLinear = async () => {
    attempts++;
    throw Object.assign(new Error("Sign in to Linear"), { signedOut: true });
  };
  h.view.refresh(h.cx);
  await h.settle();
  assert.equal(attempts, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.allIssues()[0].state.name, "Started");
  assert.match(h.view.err, /Refresh failed: Sign in to Linear/);
  assert.equal(h.view.refreshing, false);
});

test("connection recovery does not publish the previous workspace's lists into a new workspace", async () => {
  const h = await harness();
  h.view.on = null;
  h.view.lists = { mine: { items: [issue(1)] }, "project:old": { items: [issue(2)] } };
  h.view.expanded = { old: true };
  h.spaces.length = 0;
  h.view.findLinear = async () => { h.view.ws = "two"; h.view.on = ""; };
  h.view.linear = async req => {
    if (req.tab === "mine") throw new Error("Mine unavailable");
    return { issues: [issue(3, "Done")] };
  };
  h.view.refresh(h.cx);
  await h.settle();
  const published = h.data.get("linear-workspace.data");
  assert.deepEqual(Array.from(published.two.issues, row => row.id), ["id-3"]);
  assert.equal(published.one.issues[0].id, "id-1");
  assert.equal(h.view.lists["project:old"], undefined);
  assert.match(h.view.err, /Mine unavailable/);
});

test("workspace changes discard in-flight list and linked-ticket responses", async () => {
  for (const mode of ["list", "find"]) {
    const h = await harness(), pending = deferred();
    h.view.linear = () => pending.promise;
    if (mode === "list") h.view.load("mine", h.cx);
    else h.view.resolveSpaces(h.cx, true);
    await Promise.resolve();
    h.view.ws = "two"; h.view.lists = {};
    pending.resolve({ issues: [issue(1, "Done")] });
    await h.settle();
    assert.equal(h.data.get("linear-workspace.data").two, undefined);
    assert.equal(h.data.get("linear-workspace.data").one.issues[0].state.name, "Started");
  }
});

test("spinner remains active through enrichment and resets after rejection", async () => {
  const h = await harness(), pending = deferred();
  h.view.startEnrich = () => pending.promise;
  h.view.refresh(h.cx);
  for (let i = 0; i < 25; i++) await Promise.resolve();
  assert.equal(h.view.refreshing, true);
  pending.resolve();
  await h.settle();
  assert.equal(h.view.refreshing, false);
  h.view.startEnrich = async () => { throw new Error("Enrichment unavailable"); };
  h.view.refresh(h.cx); await h.settle();
  assert.match(h.view.err, /Enrichment unavailable/);
  assert.equal(h.view.refreshing, false);
});

test("automatic resolution cannot take the place of a forced refresh when lists finish", async () => {
  const h = await harness(2);
  h.data.set("linear-workspace.data", { one: { issues: [issue(1)] } });
  h.view.linear = async req => {
    h.calls.push(req);
    return { issues: req.op === "find" ? [issue(Number(req.key.split("-")[1]), "Done")] : [issue(1)] };
  };
  h.view.refresh(h.cx); await h.settle();
  assert.deepEqual(h.calls.filter(req => req.op === "find").map(req => req.key).sort(), ["TEST-1", "TEST-2"]);
  assert.ok(h.view.allIssues().every(row => row.state.type === "completed"));
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// host.js answers each Herdr read once per render frame. Herdr copies a value into the
// script on every call, so this is what keeps a busy sidebar under the script time limit.
const source = await readFile(new URL("./host.js", import.meta.url), "utf8");

async function load() {
  const calls = [];
  const store = new Map([["big", { rows: [1, 2, 3] }]]);
  const api = {
    spaces: () => { calls.push("spaces"); return [{ id: "s1" }]; },
    agents: () => { calls.push("agents"); return []; },
    panes: () => [], machines: () => [], theme: () => ({}), settings: () => ({}),
    window: () => ({}), keys: () => [], props: () => ({}),
    shared: key => { calls.push(`shared:${key}`); return store.get(key) ?? null; },
    setShared: (key, value) => { calls.push(`set:${key}`); store.set(key, value); },
  };
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => new vm.SyntheticModule(Object.keys(api), function () {
    for (const [name, value] of Object.entries(api)) this.setExport(name, value);
  }, { context }));
  await module.evaluate();
  return { host: module.namespace, calls };
}

test("a frame reads each Herdr value once", async () => {
  const { host, calls } = await load();
  host.inFrame(() => {
    for (let i = 0; i < 50; i++) { host.shared("big"); host.spaces(); }
    host.shared("other");
  });
  assert.deepEqual(calls, ["shared:big", "spaces", "shared:other"]);
});

test("outside a frame every call goes to Herdr", async () => {
  const { host, calls } = await load();
  host.shared("big"); host.shared("big"); host.spaces();
  assert.deepEqual(calls, ["shared:big", "shared:big", "spaces"]);
});

test("setShared inside a frame makes the next read fresh", async () => {
  const { host, calls } = await load();
  host.inFrame(() => {
    assert.deepEqual(host.shared("big"), { rows: [1, 2, 3] });
    host.setShared("big", { rows: [] });
    assert.deepEqual(host.shared("big"), { rows: [] });
  });
  assert.deepEqual(calls, ["shared:big", "set:big", "shared:big"]);
});

test("frames do not leak into the next render, and nested frames share one cache", async () => {
  const { host, calls } = await load();
  host.inFrame(() => { host.spaces(); host.inFrame(() => host.spaces()); host.spaces(); });
  host.inFrame(() => host.spaces());
  assert.deepEqual(calls, ["spaces", "spaces"]);
});

test("a render that throws still closes its frame", async () => {
  const { host, calls } = await load();
  assert.throws(() => host.inFrame(() => { host.spaces(); throw new Error("render failed"); }));
  host.spaces();
  assert.deepEqual(calls, ["spaces", "spaces"]);
});

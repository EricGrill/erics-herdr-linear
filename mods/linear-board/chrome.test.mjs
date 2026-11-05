import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// The window header (erics-linear-chrome) with synthetic native elements and app state.
function native(type) {
  const node = { type, nodes: [], attributes: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return child => { if (child != null) target.nodes.push(child); return proxy; };
    if (key === "children") return children => { target.nodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => { if (condition) callback(proxy); return proxy; };
    return (...args) => { target.attributes[key] = args; return proxy; };
  } });
  return proxy;
}
const state = { shared: new Map(), props: {}, platform: "macos", width: 300, machines: [] };
const boundaries = {
  "gpui-kit": { View: class {}, div: () => native("div"), svg: () => native("svg"), image: () => native("image") },
  "gpui-base": { h_flex: () => native("row"), v_flex: () => native("column") },
  "herdr": {
    theme: () => ({ foreground: "#111111", muted: "#666666", dim: "#888888", blocked: "#cc0000", background: "#ffffff", ansi4: "#0000ff", ansi5: "#ff00ff", ansi6: "#00ffff" }),
    run: () => {}, props: () => state.props, window: () => ({ platform: state.platform, fullscreen: false }),
    shared: key => state.shared.get(key), setShared: (key, value) => state.shared.set(key, value),
    updates: () => ({ app: { ready: null } }), layout: () => ({ id: "sidebar", size: { px: state.width } }),
    machines: () => state.machines,
  },
};
const context = vm.createContext({ console });
const cache = new Map();
function load(specifier) {
  if (cache.has(specifier)) return cache.get(specifier);
  const values = boundaries[specifier];
  const module = values
    ? new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context })
    : new vm.SourceTextModule(readFileSync(new URL(`../erics-linear-chrome/${specifier}`, import.meta.url), "utf8"), { context });
  cache.set(specifier, module);
  return module;
}
const module = load("./main.js");
await module.link(load);
await module.evaluate();
const Chrome = module.namespace.default;
const nodes = node => typeof node === "object" && node !== null ? [node, ...node.nodes.flatMap(nodes)] : [];
const text = node => typeof node === "string" ? node : (node?.nodes ?? []).map(text).join("|");
const badge = view => nodes(view).find(n => n.attributes.id?.[0] === "needs-you");

test("the header shows the needs-you count, open or collapsed, and hides it at zero", () => {
  const chrome = new Chrome();
  for (const [platform, width] of [["macos", 300], ["macos", 76], ["linux", 300], ["linux", 44]]) {
    Object.assign(state, { platform, width, props: {} });
    state.shared.set("erics-linear.needs-you", 3);
    const shown = badge(chrome.render());
    assert.ok(shown, `${platform} at ${width}px shows the count`);
    assert.equal(text(shown), "3");
    assert.deepEqual(shown.attributes.tooltip, ["3 spaces need you"]);
    state.shared.set("erics-linear.needs-you", 0);
    assert.equal(badge(chrome.render()), undefined, `${platform} at ${width}px hides zero`);
    state.shared.delete("erics-linear.needs-you");
    assert.equal(badge(chrome.render()), undefined);
  }
});

test("under Add machine, each remote machine shows its color and whether it is connected", () => {
  const chrome = new Chrome();
  Object.assign(state, { platform: "macos", width: 300, props: { footer: true, version: "0.0.0" },
    machines: [{ name: null, layout: "ready" }, { name: "snoke", layout: "ready" }, { name: "darth", layout: "unavailable" }, { name: "maul", layout: "loading" }] });
  try {
    const view = chrome.render();
    const list = nodes(view).find(n => n.attributes.id?.[0] === "machine-states");
    assert.match(text(list), /^\|snoke\|\|darth offline\|\|maul connecting…$/);
    const dots = nodes(list).filter(n => n.attributes.size?.[0] === 7);
    assert.ok(dots[0].attributes.bg && dots[1].attributes.border_1 && dots[2].attributes.opacity);
    state.width = 76;
    assert.equal(nodes(chrome.render()).find(n => n.attributes.id?.[0] === "machine-states"), undefined, "the rail has no room for names");
  } finally { Object.assign(state, { machines: [], props: {}, width: 300 }); }
});

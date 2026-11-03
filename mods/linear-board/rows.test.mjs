import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// Exercise the real row builders; only native elements and app boundaries are synthetic.
// No Linear calls, live commands, credentials or agents are used.
function native(type, asset) {
  const node = { type, asset, nodes: [], attributes: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return child => { target.nodes.push(child); return proxy; };
    if (key === "children") return children => { target.nodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => { if (condition) callback(proxy); return proxy; };
    return (...args) => { target.attributes[key] = args; return proxy; };
  } });
  return proxy;
}

const context = vm.createContext({ console });
const noop = () => {};
const boundaries = {
  "gpui-kit": { div: () => native("div"), svg: path => native("svg", path), image: path => native("image", path) },
  "gpui-base": { v_flex: () => native("column"), h_flex: () => native("row"), Input: {} },
  "./client.js": { default: class {} },
  "fs/promises": {},
  "herdr": {
    spaces: () => [], panes: () => [], agents: () => [], machines: () => [], shared: () => null,
    theme: () => ({ foreground: "#111111", muted: "#666666", dim: "#888888", blocked: "#cc0000" }),
    setShared: noop, setAgentOrder: noop, run: noop, props: () => ({}), openOverlay: noop,
    closeOverlay: noop, knownAgents: noop, pickFolder: noop, appHome: () => "/fake", exec: noop,
  },
};
const cache = new Map();
async function load(specifier) {
  if (cache.has(specifier)) return cache.get(specifier);
  let module;
  if (boundaries[specifier]) {
    const values = boundaries[specifier];
    module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  } else {
    module = new vm.SourceTextModule(await readFile(new URL(specifier, import.meta.url), "utf8"), { context });
  }
  cache.set(specifier, module);
  await module.link(load);
  return module;
}
const module = await load("./main.js");
await module.evaluate();
const Board = module.namespace.default;
const board = new Board();
const issue = { id: "one", identifier: "DEMO-42", title: "Fix a bug", project: { name: "Sample project" } };
const program = { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true };
const record = { issue, programs: [program], space: { name: "Example", machine: null }, status: "idle" };
board.records = () => [record];
const nodes = node => typeof node === "object" && node !== null ? [node, ...node.nodes.flatMap(nodes)] : [];
const text = node => typeof node === "string" ? node : (node?.nodes ?? []).map(text).join("|");

test("sidebar, compact and project rows show the project after the issue key and the actual harness", () => {
  for (const row of [board.workRow(record, "home"), board.spaceRow(record, "strip"), board.issueRow(issue, "search")]) {
    assert.match(text(row), /DEMO-42 \(Sample project\)/);
    const glyph = nodes(row).find(node => node.asset === program.icon);
    assert.equal(glyph.type, "svg");
    const wrapper = nodes(row).find(node => node.nodes.includes(glyph));
    assert.equal(wrapper.type, "div", "native tooltips need a div wrapper");
    assert.deepEqual(wrapper.attributes.tooltip, ["Codex"]);
    assert.deepEqual(wrapper.attributes.accessibility_label, ["Codex"]);
  }
  assert.ok(nodes(board.workRow(record, "home")).some(node => node.attributes.tooltip?.[0] === "DEMO-42 (Sample project) · Fix a bug"));
});

test("enrichment fills an absent project but preserves an explicitly unassigned project", () => {
  const index = { byIdentifier: new Map([["DEMO-42", { project: { name: "Enriched project" } }]]) };
  assert.equal(board.enrich({ identifier: "DEMO-42" }, index).project.name, "Enriched project");
  assert.equal(board.enrich({ identifier: "DEMO-42", project: null }, index).project, null);
  assert.equal(board.enrich(issue, index).project.name, "Sample project");
});

test("picture icons, missing icons, duplicate harnesses and unlinked spaces render safely", () => {
  const picture = { key: "picture", name: "Picture harness", icon: "icons/picture.png", tint: false };
  const unknown = { key: "custom", name: "Custom harness" };
  const glyphs = board.harnessIcons([{ programs: [picture, unknown] }, { programs: [picture] }]);
  assert.equal(glyphs.length, 2);
  assert.equal(glyphs[0].nodes[0].type, "image");
  assert.equal(glyphs[0].nodes[0].asset, picture.icon);
  assert.equal(glyphs[1].attributes.tooltip[0], "Custom harness");
  const unlinked = { ...record, issue: null, programs: [] };
  assert.match(text(board.workRow(unlinked, "unlinked")), /Example.*no ticket/);
  assert.doesNotMatch(text(board.spaceRow(unlinked, "unlinked-strip")), /undefined|null|\(\)/);
});

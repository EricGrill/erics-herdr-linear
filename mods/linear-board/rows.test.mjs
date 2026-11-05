import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

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
const overlays = [], closed = [], commands = [];
let currentProps = {};
const boundaries = {
  "gpui-kit": { div: () => native("div"), svg: path => native("svg", path), image: path => native("image", path) },
  "gpui-base": { v_flex: () => native("column"), h_flex: () => native("row"), Input: {}, Popup: {}, TextView: {} },
  "./client.js": { default: class {} },
  "fs/promises": {},
  "herdr": {
    spaces: () => [], panes: () => [], agents: () => [], machines: () => [], shared: () => null,
    theme: () => ({ foreground: "#111111", muted: "#666666", dim: "#888888", blocked: "#cc0000" }),
    setShared: noop, setAgentOrder: noop, run: (name, args) => { commands.push([name, args]); }, props: () => currentProps, openOverlay: options => { overlays.push(options); return "overlay"; },
    closeOverlay: id => { closed.push(id); }, knownAgents: noop, pickFolder: noop, appHome: () => "/fake", exec: noop,
  },
};
const cache = new Map();
function load(specifier) {
  if (cache.has(specifier)) return cache.get(specifier);
  let module;
  if (boundaries[specifier]) {
    const values = boundaries[specifier];
    module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  } else {
    module = new vm.SourceTextModule(readFileSync(new URL(specifier, import.meta.url), "utf8"), { context });
  }
  cache.set(specifier, module);
  return module;
}
const module = load("./main.js");
await module.link(load);
await module.evaluate();
const Board = module.namespace.default;
const board = new Board();
const issue = { id: "one", identifier: "DEMO-42", title: "Fix a bug", project: { name: "Sample project" } };
const program = { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true };
const record = { issue, programs: [program], space: { id: "space-7", name: "Example", machine: null }, status: "idle" };
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

test("right-clicking a space row opens Herdr's space menu for that space", () => {
  for (const row of [board.workRow(record, "home"), board.spaceRow(record, "strip")]) {
    overlays.length = 0;
    const [button, handler] = row.attributes.on_mouse_down;
    assert.equal(button, "right");
    let stopped = false;
    handler({}, { stop_propagation: () => { stopped = true; } });
    assert.ok(stopped, "the right-click must not also reach the row or window drag");
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].mod, "menu");
    assert.equal(overlays[0].kind, "popup");
    assert.equal(JSON.stringify(overlays[0].props), JSON.stringify({ tab: "space", target: { id: "space-7" } }));
  }
});

test("right-clicking an issue row, the issue panel or a Crew issue opens the issue menu for it", () => {
  const opened = [];
  board.issueMenu = (is, cx) => { cx.stop_propagation(); opened.push(is.identifier); return "issue-menu"; };
  board.activeRecord = () => record;
  board.enrichment = () => ({ byIdentifier: new Map(), rows: [] });
  board.attentionRules = () => ({});
  const right = row => {
    const [button, handler] = row.attributes.on_mouse_down.length === 2 && row.attributes.on_mouse_down[0] === "right"
      ? row.attributes.on_mouse_down : [];
    assert.equal(button, "right");
    let stopped = false;
    handler({}, { stop_propagation: () => { stopped = true; } });
    assert.ok(stopped);
  };
  right(board.issueRow(issue, "search"));
  right(board.issuePanel());
  board.crew = { picked: new Set(), retryRows: [], busy: false };
  right(board.crewQueueRow({ ...issue, url: "https://linear.app/example/issue/DEMO-42", attention: { needs: false } }, []));
  assert.deepEqual(opened, ["DEMO-42", "DEMO-42", "DEMO-42"]);
});

test("the issue menu opens the Linear app link, the web link, or copies it, and closes itself", () => {
  const url = "https://linear.app/example/issue/DEMO-42/fix-a-bug";
  currentProps = { role: "issue-menu", overlay: "menu-7", issue: { identifier: "DEMO-42", title: "Fix a bug", url } };
  try {
    const menu = new Board();
    menu.init({}, { focus_handle: () => ({ focus: noop }) });
    assert.equal(menu.role, "issue-menu");
    const view = menu.render({});
    assert.match(text(view), /DEMO-42.*Open in Linear app.*Open in browser.*Copy link/);
    const rows = nodes(view).filter(n => String(n.attributes.id?.[0] ?? "").startsWith("issue-menu-"));
    assert.equal(rows.length, 3);
    const effects = [];
    const cx = { open_url: u => effects.push(["open", u]), write_to_clipboard: u => effects.push(["copy", u]), stop_propagation: noop };
    closed.length = 0;
    for (const row of rows) row.attributes.on_click[0]({}, cx);
    assert.deepEqual(effects, [["open", "linear://example/issue/DEMO-42/fix-a-bug"], ["open", url], ["copy", url]]);
    assert.deepEqual(closed, ["menu-7", "menu-7", "menu-7"]);

    // Keyboard: down + enter picks the browser entry; Esc only closes.
    effects.length = 0; closed.length = 0;
    const key = view.attributes.on_key_down[0];
    key({ key: "down" }, { ...cx, notify: noop });
    key({ key: "enter" }, { ...cx, notify: noop });
    key({ key: "escape" }, { ...cx, notify: noop });
    assert.deepEqual(effects, [["open", url]]);
    assert.deepEqual(closed, ["menu-7", "menu-7"]);

    // Demo mode copies but never opens anything.
    currentProps = { ...currentProps, demo: true };
    effects.length = 0;
    menu.issueMenuChoose(0, cx);
    menu.issueMenuChoose(2, cx);
    assert.deepEqual(effects, [["copy", url]]);
  } finally { currentProps = {}; }
});

test("right-clicking a space with a ticket puts Open in Linear app in that space's menu", () => {
  const url = "https://linear.app/example/issue/DEMO-42";
  const ticketed = { ...record, issue: { ...issue, url }, folder: "/work/demo-42" };
  for (const row of [board.workRow(ticketed, "home-t"), board.spaceRow(ticketed, "strip-t")]) {
    overlays.length = 0;
    const [button, handler] = row.attributes.on_mouse_down;
    assert.equal(button, "right");
    handler({}, { stop_propagation: noop });
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].mod, "linear-board");
    assert.equal(overlays[0].kind, "popup");
    assert.equal(JSON.stringify(overlays[0].props), JSON.stringify({ role: "issue-menu",
      issue: { identifier: "DEMO-42", title: "Fix a bug", url }, space: { id: "space-7", folder: "/work/demo-42", machine: null } }));
  }

  currentProps = { role: "issue-menu", overlay: "menu-9", ...overlays[0].props };
  try {
    const menu = new Board();
    menu.init({}, { focus_handle: () => ({ focus: noop }), spawn: noop });
    menu.menuGit = "linked";
    const view = menu.render({});
    assert.match(text(view), /Open in Linear app.*Open in browser.*Copy link.*Rename.*New worktree.*Open worktree.*Remove worktree.*Close/);
    const effects = [];
    const cx = { open_url: u => effects.push(["open", u]), write_to_clipboard: noop };
    commands.length = 0; overlays.length = 0; closed.length = 0;
    menu.issueMenuChoose(0, cx);
    menu.issueMenuChoose(3, cx);
    menu.issueMenuChoose(4, cx);
    menu.issueMenuChoose(7, cx);
    assert.deepEqual(effects, [["open", "linear://example/issue/DEMO-42"]]);
    assert.equal(JSON.stringify(commands), JSON.stringify([["space.rename", { id: "space-7" }], ["space.close", { id: "space-7" }]]));
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].mod, "worktree");
    assert.equal(JSON.stringify(overlays[0].props), JSON.stringify({ space: "space-7", action: "new" }));
    assert.deepEqual(closed, ["menu-9", "menu-9", "menu-9", "menu-9"]);
  } finally { currentProps = {}; }
});

test("sidebar rows show time in state, hide a matching Linear status and list the most recent first", () => {
  const now = Date.now();
  const progress = { ...issue, state: { name: "In Progress", type: "started" }, labels: [] };
  const space = (id, name, tab) => ({ id, name, machine: null, tabs: [tab] });
  const working = { issue: progress, programs: [], agents: [], status: "working", space: { ...space("w", "Working one", { working_since: now - 4 * 60000, changed_at: now - 60000 }), machine: "snoke" } };
  const finished = { issue: progress, programs: [], agents: [], status: "done", space: space("d", "Finished one", { changed_at: now - 12 * 60000 }) };
  const todo = { issue: { ...progress, state: { name: "Todo", type: "unstarted" } }, programs: [], agents: [], status: "working", space: space("t", "Todo one", { working_since: now - 30000 }) };
  const idle = { issue: { ...progress, updatedAt: new Date(now - 3 * 86400000).toISOString() }, programs: [], agents: [], status: "idle", space: space("i", "Idle one", {}) };
  const line = (r, lane) => text(nodes(board.workRow(r, `age-${r.space.id}`, lane)).find(node => node.attributes.text_size?.[0] === 11));
  assert.equal(line(working, "working"), "Working 4m · snoke");
  assert.equal(line(finished, "done"), "Agent finished 12m ago · still In Progress · local");
  assert.equal(line(todo, "working"), "Working <1m · Linear: Todo · local");
  assert.equal(line(idle, "idle"), "Idle 3d · local");
  for (const row of [working, finished, idle].map((r, i) => board.workRow(r, `age-${i}`, ["working", "done", "idle"][i]))) {
    assert.doesNotMatch(text(row), /Linear: In Progress/);
  }
  const tips = nodes(board.workRow(idle, "tip", "idle")).map(node => node.attributes.tooltip?.[0]).filter(Boolean);
  assert.ok(tips.some(tip => /last Linear update/.test(tip)), "the label says when its age comes from Linear");

  const saved = board.records, savedEnrich = board.enrichment;
  board.records = () => [working, todo];
  board.enrichment = () => ({ byIdentifier: new Map() });
  try {
    assert.deepEqual(board.visibleSpaces().map(r => r.space.id), ["t", "w"], "the space that started working most recently comes first");
  } finally { board.records = saved; board.enrichment = savedEnrich; }
});

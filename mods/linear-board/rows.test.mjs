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
let knownMachines = [];
let liveSpaces = [];
const sharedState = {};
// Herdr's exec, answering GraphQL from a test's own function. Unset, nothing answers.
let execImpl = async () => ({ code: 1, stdout: "", stderr: "no Linear in tests" });
const inputs = [];
const boundaries = {
  "gpui-kit": { div: () => native("div"), svg: path => native("svg", path), image: path => native("image", path) },
  "gpui-base": { v_flex: () => native("column"), h_flex: () => native("row"), Input: { new: () => native("input") },
    InputState: { new: options => { const state = { options, text: "", handlers: {}, focused: false, on(name, fn) { state.handlers[name] = fn; },
      value: () => state.text, set_value(v) { state.text = v; }, focus() { state.focused = true; } }; inputs.push(state); return state; } },
    Popup: {}, TextView: {} },
  "./client.js": { default: class {} },
  "fs/promises": {},
  "herdr": {
    spaces: () => liveSpaces, panes: () => [], agents: () => [], machines: () => knownMachines, window: () => null, keys: () => [], shared: key => sharedState[key] ?? null,
    theme: () => ({ foreground: "#111111", muted: "#666666", dim: "#888888", blocked: "#cc0000", ansi4: "#0000ff", ansi5: "#ff00ff", ansi6: "#00ffff" }),
    setShared: (key, value) => { sharedState[key] = value; }, setAgentOrder: noop, run: (name, args) => { commands.push([name, args]); }, props: () => currentProps, openOverlay: options => { overlays.push(options); return "overlay"; },
    closeOverlay: id => { closed.push(id); }, knownAgents: noop, settings: () => ({ zoom: 1 }), pickFolder: noop, appHome: () => "/fake", exec: (...args) => execImpl(...args),
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

test("sidebar and compact space rows lead with the key and title, then the project", () => {
  for (const row of [board.workRow(record, "home"), board.spaceRow(record, "strip")]) {
    const shown = text(row);
    assert.ok(shown.includes("|DEMO-42 · Fix a bug|"), `title on line 1: ${shown}`);
    assert.ok(shown.indexOf("Sample project") > shown.indexOf("Fix a bug"), "project after the title");
    assert.doesNotMatch(shown, /DEMO-42 \(Sample project\)/);
    assert.ok(nodes(row).some(node => node.attributes.tooltip?.[0] === "DEMO-42 · Fix a bug (Sample project)"), "hover shows the full title and project");
  }
  const bare = { ...record, issue: { id: "two", identifier: "DEMO-7", title: "No home", project: null } };
  for (const row of [board.workRow(bare, "home"), board.spaceRow(bare, "strip")]) {
    assert.match(text(row), /DEMO-7 · No home/);
    assert.doesNotMatch(text(row), /\(\)|undefined|null/);
  }
});

test("sidebar, compact and project rows show the issue key, project and the actual harness", () => {
  for (const row of [board.workRow(record, "home"), board.spaceRow(record, "strip"), board.issueRow(issue, "search")]) {
    assert.match(text(row), /DEMO-42/);
    assert.match(text(row), /Sample project/);
    const glyph = nodes(row).find(node => node.asset === program.icon);
    assert.equal(glyph.type, "svg");
    const wrapper = nodes(row).find(node => node.nodes.includes(glyph));
    assert.equal(wrapper.type, "div", "native tooltips need a div wrapper");
    assert.deepEqual(wrapper.attributes.tooltip, ["Codex"]);
    assert.deepEqual(wrapper.attributes.accessibility_label, ["Codex"]);
  }
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
      issue: { id: "one", identifier: "DEMO-42", title: "Fix a bug", url, teamKey: null }, space: { id: "space-7", folder: "/work/demo-42", machine: null } }));
  }

  currentProps = { role: "issue-menu", overlay: "menu-9", ...overlays[0].props };
  try {
    const menu = new Board();
    menu.init({}, { focus_handle: () => ({ focus: noop }), spawn: noop });
    menu.menuGit = "linked";
    const view = menu.render({});
    assert.match(text(view), /Open in Linear app.*Open in browser.*Copy link.*Pin to top.*Tags….*Rename.*New worktree.*Open worktree.*Remove worktree.*Close/);
    const effects = [];
    const cx = { open_url: u => effects.push(["open", u]), write_to_clipboard: noop };
    commands.length = 0; overlays.length = 0; closed.length = 0;
    menu.issueMenuChoose(0, cx);
    menu.issueMenuChoose(5, cx);
    menu.issueMenuChoose(6, cx);
    menu.issueMenuChoose(9, cx);
    assert.deepEqual(effects, [["open", "linear://example/issue/DEMO-42"]]);
    assert.equal(JSON.stringify(commands), JSON.stringify([["space.rename", { id: "space-7" }], ["space.close", { id: "space-7" }]]));
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].mod, "worktree");
    assert.equal(JSON.stringify(overlays[0].props), JSON.stringify({ space: "space-7", action: "new" }));
    assert.deepEqual(closed, ["menu-9", "menu-9", "menu-9", "menu-9"]);
  } finally { currentProps = {}; }
});

test("a space row shows its machine's dot, and says when the machine is offline or reconnecting", () => {
  knownMachines = [{ name: null, layout: "ready" }, { name: "darth", layout: "unavailable" }, { name: "maul", layout: "loading" }];
  try {
    const on = name => ({ ...record, space: { ...record.space, machine: name } });
    const dot = row => nodes(row).find(n => n.attributes.size?.[0] === 7 && n.attributes.rounded?.[0] === 7);
    const local = board.workRow(on(null), "home-local");
    assert.ok(dot(local).attributes.bg, "an online machine is a filled dot");
    assert.match(text(local), /\|local$|\|local\|/);
    const offline = board.workRow(on("darth"), "home-darth");
    assert.match(text(offline), /darth · offline/);
    assert.ok(dot(offline).attributes.border_1 && !dot(offline).attributes.bg, "an offline machine is an outline");
    assert.match(text(board.workRow(on("maul"), "home-maul")), /maul · connecting…/);
    assert.notEqual(dot(local).attributes.bg[0], dot(board.workRow(on("maul"), "home-maul")).attributes.bg[0]);
  } finally { knownMachines = []; }
});

test("the sidebar pins the current group's header while scrolling and publishes the needs-you count", () => {
  const saved = { records: board.records, enrichment: board.enrichment, attentionRules: board.attentionRules, homeFilters: board.homeFilters };
  const make = (n, status) => Array.from({ length: n }, (_, i) => ({ ...record, agents: [], status,
    issue: { ...issue, id: `${status}-${i}`, identifier: `DEMO-${status}-${i}` }, space: { id: `${status}-${i}`, name: `${status} ${i}`, machine: null } }));
  board.records = () => [...make(2, "blocked"), ...make(6, "working")];
  board.enrichment = () => ({ byIdentifier: new Map(), rows: [] });
  board.attentionRules = () => ({});
  board.homeFilters = () => ({ team: [], status: [], project: [], crew: [] });
  try {
    delete sharedState["erics-linear.needs-you"];
    let view = board.sidebar();
    assert.equal(sharedState["erics-linear.needs-you"], 2);
    const list = () => nodes(view).find(n => n.attributes.id?.[0] === "spaces-by-status");
    const pinned = () => nodes(view).find(n => n.attributes.id?.[0] === "pinned-group");
    assert.equal(pinned(), undefined, "nothing pinned at the top");
    let notified = 0;
    const cx = { notify: () => { notified++; } };
    list().attributes.on_size_change[0]({ width: 280, height: 200 }, cx);
    view = board.sidebar();
    list().attributes.on_scroll_wheel[0]({ delta: { x: 0, y: -260 } }, cx);
    view = board.sidebar();
    assert.ok(notified >= 2);
    assert.equal(board.homeScroll, 260);
    assert.match(text(pinned()), /WORKING\|6/);
    // Linear search results below the groups are measured, and can be scrolled to.
    nodes(view).find(n => n.attributes.id?.[0] === "spaces-column").attributes.on_size_change[0]({ width: 280, height: 1000 }, cx);
    view = board.sidebar();
    list().attributes.on_scroll_wheel[0]({ delta: { x: 0, y: -10000 } }, cx);
    view = board.sidebar();
    assert.equal(board.homeScroll, 800);
    assert.equal(pinned(), undefined, "no group header covers the search results");
    list().attributes.on_scroll_wheel[0]({ delta: { x: 0, y: 10000 } }, cx);
    view = board.sidebar();
    assert.equal(board.homeScroll, 0);
    assert.equal(pinned(), undefined);
  } finally {
    Object.assign(board, saved);
    board.homeScroll = 0; board.homeViewport = 0; board.homeContent = 0;
  }
});

test("status bar shows machine, ahead/behind, uncommitted and running time, with the branch only in hover text", () => {
  const branch = "r2d2/CHA-4305-header-git-state";
  const space = { id: "remote/space-1", name: "Example", machine: "build-2", folder: "/home/build/code/repo", branch, active: true,
    tabs: [{ id: "tab-1", working_since: Date.now() - 12 * 60_000 }] };
  liveSpaces = [space];
  sharedState["linear-board.git"] = { key: `build-2\u0000remote/space-1\u0000/home/build/code/repo`,
    git: { branch, upstream: "origin/main", ahead: 2, behind: 1, changed: 3, added: 40, removed: 2 }, pr: { number: 36, state: "OPEN", checks: "passing" } };
  try {
    const bar = board.statusBar();
    const shown = text(bar);
    assert.match(shown, /build-2/);
    assert.match(shown, /↑2 ↓1/);
    assert.match(shown, /3 uncommitted/);
    assert.match(shown, /working 12m/);
    assert.doesNotMatch(shown, new RegExp(branch), "the branch is not repeated in the bar");
    assert.ok(nodes(bar).some(n => n.attributes.tooltip?.[0] === `${branch} (against origin/main)`));
    // A different folder's read is never shown for this space.
    sharedState["linear-board.git"] = { key: "elsewhere", git: { ahead: 9, behind: 9, changed: 9 } };
    const other = text(board.statusBar());
    assert.doesNotMatch(other, /↑9|9 uncommitted/);
    assert.doesNotMatch(other, /undefined|null/);
  } finally { liveSpaces = []; delete sharedState["linear-board.git"]; }
});

test("CHA-4304: sidebar rows hide the Claude icon but keep other agents and the … menu", () => {
  const claude = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: true };
  const row = board.workRow({ ...record, programs: [claude] }, "claude-row");
  assert.ok(!nodes(row).some(node => node.asset === claude.icon), "no repeated Claude icon");
  assert.ok(!nodes(row).some(node => node.attributes.id?.[0] === "claude-row-badges"), "no empty badge strip");
  assert.equal(nodes(row).find(node => node.attributes.id?.[0] === "claude-row-details").nodes[0], "…");
  const mixed = board.workRow({ ...record, programs: [claude, program] }, "mixed-row");
  assert.ok(nodes(mixed).some(node => node.asset === program.icon), "Codex still shows");
  assert.ok(!nodes(mixed).some(node => node.asset === claude.icon));
  // The compact strip is unchanged and still names every harness.
  assert.ok(nodes(board.spaceRow({ ...record, programs: [claude] }, "strip-claude")).some(node => node.asset === claude.icon));
});

test("CHA-4304: Urgent and High tickets are marked; Medium, Low and none are not", () => {
  const marked = p => nodes(board.workRow({ ...record, programs: [], issue: { ...issue, priority: p } }, `prio-${p}`))
    .find(node => node.attributes.id?.[0] === `prio-${p}-priority`);
  assert.deepEqual(marked(1).attributes.tooltip, ["Priority: Urgent"]);
  assert.deepEqual(marked(2).attributes.tooltip, ["Priority: High"]);
  for (const p of [0, 3, 4, undefined]) assert.equal(marked(p), undefined, `priority ${p}`);
  // Priority filled in from enrichment when the herdr-linear issue lacks it.
  const index = { byIdentifier: new Map([["DEMO-42", { priority: 1 }]]) };
  assert.equal(board.enrich({ identifier: "DEMO-42" }, index).priority, 1);
  assert.equal(board.enrich({ identifier: "DEMO-42", priority: 3 }, index).priority, 3);
});

test("CHA-4304: a linked pull request shows its state, explains it on hover and opens on click", () => {
  const pr = (state, extra = {}) => ({ url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7, title: "Fix a bug", state, checks: null, ...extra });
  const badge = (prs, id) => {
    sharedState["linear-board.pulls"] = { pulls: { "DEMO-42": prs } };
    try {
      return nodes(board.workRow({ ...record, programs: [] }, id)).find(node => node.attributes.id?.[0] === `${id}-pr`);
    } finally { delete sharedState["linear-board.pulls"]; }
  };
  const failing = badge([pr("open"), pr("failing", { number: 8 })], "pr-a");
  assert.match(text(failing), /failing/);
  assert.match(failing.attributes.tooltip[0], /^Pull request #8 checks failing: Fix a bug\. Click to open it\.$/);
  assert.match(badge([pr("ready", { checks: "passing" })], "pr-b").attributes.tooltip[0], /ready to merge/);
  assert.match(text(badge([pr("open")], "pr-c")), /open/);
  assert.match(text(badge([pr("merged")], "pr-d")), /merged/);
  assert.equal(badge([pr("closed")], "pr-e"), undefined, "closed pull requests are not shown");
  assert.equal(badge([], "pr-f"), undefined);

  const opened = [];
  let stopped = false;
  failing.attributes.on_click[0]({}, { stop_propagation: () => { stopped = true; }, open_url: url => opened.push(url) });
  assert.deepEqual(opened, ["https://github.com/acme/app/pull/7"]);
  assert.ok(stopped, "clicking the badge must not also select the row");
});

test("CHA-4304: badges sit in a fixed strip and the title truncates, so 300px rows cannot overflow", () => {
  sharedState["linear-board.pulls"] = { pulls: { "DEMO-42": [{ url: "https://github.com/acme/app/pull/7", number: 7, title: "x", state: "failing" }] } };
  try {
    const row = board.workRow({ ...record, issue: { ...issue, priority: 1, title: "A very long title ".repeat(10) } }, "wide");
    assert.ok(row.attributes.min_w, "row may shrink");
    const strip = nodes(row).find(node => node.attributes.id?.[0] === "wide-badges");
    assert.ok(strip.attributes.flex_none);
    assert.equal(strip.nodes.length, 3, "agent, priority and pull request");
    const title = row.nodes.find(node => node.type === "column");
    assert.ok(title.attributes.flex_1 && title.attributes.min_w, "the text column takes the remaining width");
    assert.ok(title.nodes[0].attributes.truncate, "and truncates the title");
  } finally { delete sharedState["linear-board.pulls"]; }
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
  // The machine is its own tag beside the line, with its colored dot (CHA-4306).
  const machineTag = (r, lane) => text(nodes(board.workRow(r, `age-${r.space.id}`, lane)).find(node => node.attributes.id?.[0] === `age-${r.space.id}-machine`));
  assert.equal(line(working, "working"), "Working 4m · Sample project");
  assert.match(machineTag(working, "working"), /snoke · offline$/, "a machine Herdr does not list is offline");
  assert.equal(line(finished, "done"), "Agent finished 12m ago · Sample project · still In Progress");
  assert.equal(line(todo, "working"), "Working <1m · Sample project · Linear: Todo");
  assert.equal(line(idle, "idle"), "Idle 3d · Sample project");
  assert.match(machineTag(idle, "idle"), /local$/);
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

// ---- CHA-4318: pins, tags and colors are Linear labels ---------------------------------

const TAGS = "linear-board.tags";
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const graphql = args => JSON.parse(String(args[1]).split("<<'HERDR_BOARD_QUERY'\n")[1].split("\nHERDR_BOARD_QUERY")[0]);
const reply = data => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
const pinned = { id: "pin", name: "Pinned", color: "#F2C94C" }, bug = { id: "bug", name: "Bug", color: "#EB5757" };

test("CHA-4318: a tagged row is drawn in its tag's Linear color with its tags as chips", () => {
  sharedState[TAGS] = { tags: { "DEMO-42": { labels: ["agent:claude", "Pinned", "Bug", "Frontend", "Backend"], colors: { Bug: "#EB5757" } } } };
  try {
    const row = board.workRow(record, "tagged");
    const stripe = nodes(row).find(node => node.attributes.id?.[0] === "tagged-color");
    assert.deepEqual(stripe.attributes.bg, ["#EB5757"]);
    assert.match(stripe.attributes.tooltip[0], /Linear tag “Bug”/);
    const chips = nodes(row).filter(node => /^tagged-tag-/.test(node.attributes.id?.[0] ?? ""));
    assert.deepEqual(chips.map(text), ["Bug", "Frontend", "+1"], "two tags and a count; no routing label or pin chip");
    assert.equal(chips[0].attributes.text_color[0], "#EB5757");
    assert.match(chips[0].attributes.tooltip[0], /Bug, Frontend, Backend/);
    delete sharedState[TAGS];
    const plainRow = board.workRow(record, "plain");
    const empty = nodes(plainRow).find(node => node.attributes.id?.[0] === "plain-color");
    assert.ok(empty && !empty.attributes.bg, "an untagged row keeps the gap so rows stay aligned");
  } finally { delete sharedState[TAGS]; }
});

test("CHA-4318: pinned spaces lead the sidebar and keep their own state line", () => {
  const space = (id, name) => ({ id, name, machine: null, tabs: [] });
  const one = { ...record, issue: { ...issue, id: "a", identifier: "DEMO-1" }, agents: [], status: "working", space: space("a", "Alpha") };
  const two = { ...record, issue: { ...issue, id: "b", identifier: "DEMO-2" }, agents: [], status: "idle", space: space("b", "Beta") };
  const saved = board.records, savedEnrich = board.enrichment;
  board.records = () => [one, two];
  board.enrichment = () => ({ byIdentifier: new Map() });
  board.input = {};
  sharedState[TAGS] = { tags: { "DEMO-2": { labels: ["Pinned"], colors: {} } } };
  try {
    const records = board.visibleSpaces();
    same(records.map(r => [r.space.id, r.pinned]), [["a", false], ["b", true]]);
    const body = text(board.sidebar());
    assert.match(body, /PINNED\|1.*DEMO-2.*Idle.*WORKING\|1.*DEMO-1/, "pinned first, still showing Idle");
    assert.doesNotMatch(body, /IDLE/, "a pinned space is not listed twice");
    board.filter = "pinned";
    same(board.visibleSpaces().map(r => r.space.id), [], "the pin is not a searchable tag");
    sharedState[TAGS] = { tags: { "DEMO-1": { labels: ["Frontend"], colors: {} } } };
    board.filter = "front";
    same(board.visibleSpaces().map(r => r.space.id), ["a"], "search finds a space by its tags");
  } finally { board.records = saved; board.enrichment = savedEnrich; board.filter = ""; delete sharedState[TAGS]; }
});

test("CHA-4306: a pinned space that needs you still counts in the header's Needs you badge", () => {
  const space = (id, name) => ({ id, name, machine: null, tabs: [] });
  const one = { ...record, issue: { ...issue, id: "a", identifier: "DEMO-1" }, agents: [], status: "blocked", space: space("a", "Alpha") };
  const two = { ...record, issue: { ...issue, id: "b", identifier: "DEMO-2" }, agents: [], status: "blocked", space: space("b", "Beta") };
  const saved = board.records, savedEnrich = board.enrichment;
  board.records = () => [one, two];
  board.enrichment = () => ({ byIdentifier: new Map() });
  board.input = {};
  sharedState[TAGS] = { tags: { "DEMO-2": { labels: ["Pinned"], colors: {} } } };
  try {
    const body = text(board.sidebar());
    assert.match(body, /PINNED\|1.*NEEDS YOU\|1/, "the pinned one is listed under PINNED");
    assert.equal(sharedState["erics-linear.needs-you"], 2, "but both still need you");
  } finally { board.records = saved; board.enrichment = savedEnrich; delete sharedState[TAGS]; delete sharedState["erics-linear.needs-you"]; }
});

test("CHA-4318: Pin to top writes the Linear label, waits for Linear and updates every copy", async () => {
  const url = "https://linear.app/example/issue/DEMO-42";
  let labels = [];
  const sent = [];
  execImpl = async (_cmd, args) => {
    const body = graphql(args);
    sent.push(body.query.match(/(issueLabels|issueLabelCreate|issueAddLabel|issueRemoveLabel|issue)\(/)[1]);
    if (/issueLabels\(/.test(body.query)) return reply({ issueLabels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pinned] } });
    if (/issueAddLabel/.test(body.query)) { labels = [pinned]; return reply({ issueAddLabel: { success: true } }); }
    return reply({ issue: { id: "one", identifier: "DEMO-42", labels: { nodes: labels } } });
  };
  currentProps = { role: "issue-menu", overlay: "menu-1", issue: { id: "one", identifier: "DEMO-42", title: "Fix a bug", url, teamKey: "DEMO" } };
  const pending = [];
  const cx = { focus_handle: () => ({ focus: noop }), spawn: fn => pending.push(fn(cx)), notify: noop, write_to_clipboard: noop, open_url: noop };
  try {
    closed.length = 0;
    const menu = new Board();
    menu.init({}, cx);
    const items = menu.issueMenuItems();
    same(items.map(i => i.label), ["Open in Linear app", "Open in browser", "Copy link", "Pin to top", "Tags…"]);
    menu.issueMenuChoose(3, cx);
    assert.match(text(menu.render({})), /Pinning…/);
    assert.deepEqual(closed, [], "the menu stays open until Linear answers");
    await Promise.all(pending);
    assert.deepEqual(sent, ["issueLabels", "issue", "issueAddLabel", "issue"]);
    assert.deepEqual(closed, ["menu-1"]);
    same(sharedState[TAGS].tags["DEMO-42"].labels, ["Pinned"], "every copy of the mod sees the pin at once");
    assert.deepEqual(menu.issueMenuItems().map(i => i.label)[3], "Unpin");

    // A refusal is shown in the menu, which stays open.
    execImpl = async (_cmd, args) => /issueRemoveLabel/.test(graphql(args).query)
      ? reply({ issueRemoveLabel: { success: false } }) : reply({ issue: { id: "one", identifier: "DEMO-42", labels: { nodes: [pinned] } } });
    closed.length = 0; pending.length = 0;
    menu.issueMenuChoose(3, cx);
    await Promise.all(pending);
    assert.deepEqual(closed, []);
    assert.match(text(menu.render({})), /Linear did not accept the change/);
  } finally { currentProps = {}; delete sharedState[TAGS]; delete sharedState["linear-board.enrich"]; execImpl = async () => ({ code: 1, stdout: "", stderr: "" }); }
});

test("CHA-4318: Tags… lists Linear labels, toggles one at a time and can create a tag", async () => {
  let labels = [bug];
  const writes = [];
  execImpl = async (_cmd, args) => {
    const body = graphql(args);
    if (/issueLabels\(/.test(body.query)) return reply({ issueLabels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      bug, { id: "fe", name: "Frontend", color: "#4CB782", team: { key: "DEMO" } }, { id: "r", name: "repo:demo" }, pinned] } });
    if (/issueLabelCreate/.test(body.query)) { writes.push(["create", body.variables.input.name]); return reply({ issueLabelCreate: { success: true, issueLabel: { id: "new", name: body.variables.input.name, color: body.variables.input.color } } }); }
    if (/issueAddLabel/.test(body.query)) { writes.push(["add", body.variables.label]); labels = [...labels, { id: body.variables.label, name: body.variables.label === "new" ? "Later" : "Frontend", color: null }]; return reply({ issueAddLabel: { success: true } }); }
    if (/issueRemoveLabel/.test(body.query)) { writes.push(["remove", body.variables.label]); labels = labels.filter(l => l.id !== body.variables.label); return reply({ issueRemoveLabel: { success: true } }); }
    return reply({ issue: { id: "one", identifier: "DEMO-42", labels: { nodes: labels } } });
  };
  const url = "https://linear.app/example/issue/DEMO-42";
  currentProps = { role: "issue-menu", overlay: "menu-2", issue: { id: "one", identifier: "DEMO-42", title: "Fix a bug", url, teamKey: "DEMO" } };
  const pending = [];
  const cx = { focus_handle: () => ({ focus: noop }), spawn: fn => pending.push(fn(cx)), notify: noop, write_to_clipboard: noop, open_url: noop };
  try {
    const menu = new Board();
    menu.init({}, cx);
    overlays.length = 0; closed.length = 0;
    menu.issueMenuChoose(4, cx);
    assert.equal(overlays[0].props.role, "issue-tags");
    assert.deepEqual(closed, ["menu-2"]);

    currentProps = { ...overlays[0].props, overlay: "tags-1" };
    const picker = new Board();
    picker.init({}, cx);
    assert.ok(inputs.at(-1).focused, "typing goes straight to the search field");
    await Promise.all(pending.splice(0));
    assert.match(text(picker.render({})), /✓.*Bug.*Frontend/, "the issue's own tag first, checked; no routing label or pin");
    assert.doesNotMatch(text(picker.render({})), /repo:demo|Pinned/);

    picker.tagToggle(picker.tagRows().find(l => l.name === "Frontend"), cx);
    await Promise.all(pending.splice(0));
    picker.tagToggle(picker.tagRows().find(l => l.name === "Bug"), cx);
    await Promise.all(pending.splice(0));
    assert.deepEqual(writes, [["add", "fe"], ["remove", "bug"]], "one label per write; nothing else is replaced");
    same(sharedState[TAGS].tags["DEMO-42"].labels, ["Frontend"]);

    const search = inputs.at(-1);
    search.text = "Later";
    search.handlers.change({}, cx);
    assert.match(text(picker.render({})), /Create tag “Later”/);
    search.handlers.submit({}, cx);
    await Promise.all(pending.splice(0));
    assert.deepEqual(writes.slice(2), [["create", "Later"], ["add", "new"]]);
    same(sharedState[TAGS].tags["DEMO-42"].labels, ["Frontend", "Later"]);
    assert.equal(search.text, "", "the field clears after creating");
    assert.equal(picker.tagError, "");
  } finally { currentProps = {}; delete sharedState[TAGS]; delete sharedState["linear-board.enrich"]; execImpl = async () => ({ code: 1, stdout: "", stderr: "" }); }
});

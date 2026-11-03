import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const ACTIVE = "linear-workspace.workspace", DATA = "linear-workspace.data";
const FILTER = "linear-board.filters", ENRICH = "linear-board.enrich";
const plain = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ team: [], status: [], project: [], crew: [] });

// Keep the real view's conditional children and event handlers. Native drawing is
// synthetic; these tests exercise view behavior without opening a Herdr window.
function element(kind = "div") {
  const node = { kind, items: [], attributes: {}, handlers: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "then") return undefined;
    if (key === "child") return child => { target.items.push(child); return proxy; };
    if (key === "children") return children => { target.items.push(...children); return proxy; };
    if (key === "when") return (condition, draw) => { if (condition) draw(proxy); return proxy; };
    if (key === "on_click") return handler => { target.handlers.click = handler; return proxy; };
    return (...args) => { target.attributes[key] = args.length === 1 ? args[0] : args; return proxy; };
  } });
  return proxy;
}

function nodes(root) {
  return root && typeof root === "object" && Array.isArray(root.items)
    ? [root, ...root.items.flatMap(nodes)] : [];
}
const find = (root, id) => nodes(root).find(node => node.attributes.id === id);
const text = root => root && typeof root === "object" && Array.isArray(root.items)
  ? root.items.map(text).join(" ") : String(root ?? "");

const ticket = (id, overrides = {}) => ({
  id, identifier: `DEMO-${id}`, title: `Task ${id}`, branch: `demo-${id}`,
  teamKey: "DEMO", project: { id: "alpha", name: "Alpha" },
  state: { name: "In Progress", type: "started" }, labels: [], ...overrides,
});
const workSpace = (id, issue, overrides = {}) => ({
  id, name: `Space ${id}`, branch: issue?.branch, tabs: [{ id: `${id}-tab` }],
  folder: `/sample/${id}`, status: "working", machine: null, ...overrides,
});

async function harness(options = {}) {
  const first = ticket("1"), second = ticket("2", {
    teamKey: "OTHER", project: { id: "beta", name: "Beta" },
    state: { name: "Todo", type: "unstarted" },
  });
  const issues = options.issues ?? [first, second];
  const allSpaces = options.spaces ?? [workSpace("one", issues[0]), workSpace("two", issues[1], { machine: "remote" }), workSpace("unlinked", null, { status: "idle" })];
  const allAgents = options.agents ?? [];
  const projects = options.projects ?? [{ id: "alpha", name: "Alpha", teamKey: "DEMO" }, { id: "beta", name: "Beta", teamKey: "OTHER" }];
  const rows = options.enrichment ?? issues.map((issue, i) => ({ ...issue, delegate: { name: i ? "Seven" : "Spock" } }));
  const state = new Map([
    [ACTIVE, "workspace-one"],
    [DATA, { "workspace-one": { issues, projects } }],
    [ENRICH, { rows, error: null, partial: false, fetchedAt: 1 }],
    ["linear-board.teams", [{ key: "DEMO", name: "Demo" }, { key: "OTHER", name: "Other" }]],
  ]);
  const writes = [], overlays = [], commands = [], closed = [], pending = [], orders = [];
  let properties = options.props ?? {};
  const forbidden = name => () => { throw new Error(`Unexpected native operation: ${name}`); };
  const cx = {
    notify() {}, stop_propagation() {},
    spawn(fn) { pending.push(fn); },
    timer: { every: forbidden("timer"), after: forbidden("timer") },
  };
  const context = vm.createContext({ console, localStorage: {
    getItem: () => null, setItem: forbidden("localStorage write"),
  } });
  class BaseClient {
    workspace() { return { name: "Demo workspace" }; }
    matches(issue) { return text(issue?.title ?? issue?.name).toLowerCase().includes((this.filter ?? "").toLowerCase()); }
  }
  const native = {
    "gpui-kit": { div: () => element(), svg: () => element("svg"), image: () => element("image") },
    "gpui-base": { v_flex: () => element("column"), h_flex: () => element("row"), Input: { new: () => element("input") } },
    "herdr": {
      spaces: () => allSpaces, panes: () => [], agents: () => allAgents, machines: () => [],
      theme: () => new Proxy({}, { get: () => "#123456" }),
      shared: key => state.get(key),
      setShared: (key, value) => { writes.push({ key, value }); state.set(key, value); },
      setAgentOrder: order => orders.push(order), props: () => properties,
      openOverlay: request => { overlays.push(request); return `overlay-${overlays.length}`; },
      closeOverlay: id => closed.push(id), run: (name, args) => commands.push({ name, args }),
      knownAgents: forbidden("knownAgents"), pickFolder: forbidden("pickFolder"), appHome: forbidden("appHome"), exec: forbidden("exec"),
    },
    "fs/promises": { readFile: forbidden("readFile"), writeFile: forbidden("writeFile") },
    "./client.js": { default: BaseClient },
    "./look.js": { tint: color => color, icon: () => element("icon"), stateIcon: () => "state", MONO: "mono" },
  };
  const modules = new Map();
  async function load(url) {
    if (!modules.has(url.href)) modules.set(url.href, readFile(url, "utf8")
      .then(source => new vm.SourceTextModule(source, { context, identifier: url.href })));
    return modules.get(url.href);
  }
  const module = await load(new URL("./main.js", import.meta.url));
  await module.link((specifier, referrer) => {
    if (native[specifier]) {
      const exports = native[specifier];
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    assert.ok(specifier.startsWith("./"), `Unexpected import: ${specifier}`);
    return load(new URL(specifier, referrer.identifier));
  });
  await module.evaluate();
  const view = new module.namespace.default();
  Object.assign(view, { ws: "workspace-one", role: "sidebar", lists: { projects: { items: projects } }, expanded: {}, openGroups: {}, filter: "" });
  return {
    view, cx, state, writes, overlays, commands, closed, orders,
    setProps(next) { properties = next; },
    click(root, id) { const node = find(root, id); assert.ok(node, `Missing control ${id}`); assert.equal(typeof node.handlers.click, "function"); node.handlers.click({}, cx); },
    async flush() { while (pending.length) await pending.shift()(cx); },
  };
}

test("home combines Team, Status, Project, Crew and text search while preserving input records", async () => {
  const h = await harness();
  const before = plain(h.view.records());
  assert.deepEqual(plain(h.view.visibleSpaces().map(record => record.space.id)), ["one", "two", "unlinked"]);
  h.view.applyFilter({ team: ["DEMO"], status: ["linear:In Progress"], project: ["alpha"], crew: ["Spock"] });
  assert.deepEqual(plain(h.view.visibleSpaces().map(record => record.space.id)), ["one"]);
  h.view.filter = "TASK 1";
  assert.equal(h.view.visibleSpaces().length, 1);
  h.view.filter = "remote";
  assert.equal(h.view.visibleSpaces().length, 0);
  assert.deepEqual(plain(h.view.records()), before);
});

test("home distinguishes finished agent activity from the issue's Linear workflow", async () => {
  const issue = ticket("1");
  const h = await harness({ issues: [issue], spaces: [workSpace("finished", issue, { status: "done" })] });
  h.view.applyFilter({ status: ["linear:Done"] });
  assert.equal(h.view.visibleSpaces().length, 0);
  h.view.applyFilter({ status: ["linear:In Progress"] });
  assert.equal(h.view.visibleSpaces().length, 1);
  h.view.applyFilter({ status: ["activity:done"] });
  assert.equal(h.view.visibleSpaces().length, 1);
  assert.equal(issue.state.name, "In Progress");
});

test("filter writes are deferred, isolated by workspace, and retain the originating workspace", async () => {
  const h = await harness();
  h.view.applyFilter({ team: ["DEMO"] }, h.cx);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(plain(h.view.homeFilters()), empty());
  h.view.ws = "workspace-two";
  await h.flush();
  assert.deepEqual(plain(h.view.homeFilters()), empty());
  h.view.applyFilter({ project: ["beta"] }, h.cx);
  await h.flush();
  assert.deepEqual(plain(h.state.get(FILTER)), {
    "workspace-one": { ...empty(), team: ["DEMO"] },
    "workspace-two": { ...empty(), project: ["beta"] },
  });
  h.setProps({ workspaceId: "workspace-one" });
  assert.deepEqual(plain(h.view.homeFilters()), { ...empty(), team: ["DEMO"] });
});

test("rapid filter clicks compose against the latest shared selection", async () => {
  const h = await harness();
  h.setProps({ role: "filters", overlay: "filters", workspaceId: "workspace-one" });
  h.view.role = "filters";
  let tree = h.view.render(h.cx);
  const demo = nodes(tree).find(node => node.attributes.id?.startsWith("filter-option-team-") && text(node).includes("Demo (DEMO)"));
  assert.ok(demo);
  h.click(tree, demo.attributes.id);
  h.click(tree, "filter-field-status");
  tree = h.view.render(h.cx);
  const working = nodes(tree).find(node => node.attributes.id?.startsWith("filter-option-status-") && text(node).includes("Activity: Working"));
  assert.ok(working);
  h.click(tree, working.attributes.id);
  assert.equal(h.writes.length, 0);
  await h.flush();
  assert.deepEqual(plain(h.view.homeFilters()), { ...empty(), team: ["DEMO"], status: ["activity:working"] });
  h.view.setDelegateFilter("Spock", h.cx);
  h.view.setDelegateFilter("Spock", h.cx);
  await h.flush();
  assert.deepEqual(plain(h.view.homeFilters()), { ...empty(), team: ["DEMO"], status: ["activity:working"] });
});

test("home Filters and Clear controls open the dialog and restore all spaces", async () => {
  const h = await harness();
  h.view.applyFilter({ crew: ["Spock"], project: ["alpha"] });
  let tree = h.view.render(h.cx);
  assert.match(text(find(tree, "home-filter-button")), /Filters \(2\)/);
  assert.ok(find(tree, "home-one"));
  assert.equal(find(tree, "home-two"), undefined);
  h.click(tree, "home-filter-button");
  assert.deepEqual(plain(h.overlays.at(-1).props), { role: "filters", workspaceId: "workspace-one" });
  h.click(tree, "clear-home-filters");
  assert.equal(h.view.visibleSpaces().length, 1);
  await h.flush();
  tree = h.view.render(h.cx);
  assert.deepEqual(plain(h.view.homeFilters()), empty());
  assert.equal(text(find(tree, "home-filter-button")), "Filters");
  assert.ok(find(tree, "home-two"));
  assert.ok(find(tree, "home-unlinked"));
});

test("filters dialog renders all four dimensions and can clear one dimension or all", async () => {
  const h = await harness();
  h.setProps({ role: "filters", overlay: "filters", workspaceId: "workspace-one" });
  h.view.init({}, h.cx);
  h.view.applyFilter({ team: ["DEMO"], crew: ["Spock"] });
  let tree = h.view.render(h.cx);
  for (const field of ["team", "status", "project", "crew"]) assert.ok(find(tree, `filter-field-${field}`));
  h.click(tree, "filter-clear-team");
  await h.flush();
  assert.deepEqual(plain(h.view.homeFilters()), { ...empty(), crew: ["Spock"] });
  tree = h.view.render(h.cx);
  h.click(tree, "filters-clear-all");
  await h.flush();
  assert.deepEqual(plain(h.view.homeFilters()), empty());
  h.click(tree, "filters-close");
  assert.deepEqual(h.closed, ["filters"]);
});

test("home explains an empty filter result and retains selected options for recovery", async () => {
  const h = await harness();
  h.view.applyFilter({ project: ["removed-project"] });
  const tree = h.view.render(h.cx);
  assert.match(text(tree), /No matching spaces/);
  assert.match(text(tree), /Project: removed-project/);
  assert.ok(find(tree, "clear-home-filters"));
  assert.ok(h.view.filterChoices().project.some(option => option.value === "removed-project"));
});

test("grouped report launchers preserve home filters and Projects includes every project", async () => {
  const h = await harness();
  h.view.applyFilter({ team: ["DEMO"], crew: ["Spock"] });
  const before = plain(h.state.get(FILTER));
  const home = h.view.render(h.cx);
  h.click(home, "open-projects");
  h.click(home, "crew");
  h.click(home, "live-agents");
  assert.equal(h.overlays[0].props.role, "projects");
  assert.equal(h.overlays[1].props.role, "crew");
  assert.deepEqual(plain(h.commands), [{ name: "mod.open", args: { name: "erics-linear-agents" } }]);
  assert.deepEqual(plain(h.state.get(FILTER)), before);
  const projects = h.view.tree(h.view.enrichment()).flatMap(team => team.children.map(project => project.project.id));
  assert.deepEqual(plain(projects).sort(), ["alpha", "beta"]);
  h.view.role = "projects";
  h.setProps({ role: "projects", overlay: "projects" });
  const report = h.view.render(h.cx);
  assert.ok(find(report, "project-alpha"));
  assert.ok(find(report, "project-beta"));
  assert.equal(find(report, "clear-home-filters"), undefined);
});

test("Crew expands delegated issue groups and drills into issues without changing home filters", async () => {
  const h = await harness();
  h.view.applyFilter({ team: ["DEMO"], crew: ["Spock"] });
  const before = plain(h.state.get(FILTER));
  h.setProps({ role: "crew", overlay: "crew" });
  h.view.role = "crew";
  let tree = h.view.render(h.cx);
  assert.ok(find(tree, "crew-Spock"));
  assert.ok(find(tree, "crew-Seven"));
  h.click(tree, "crew-Seven");
  tree = h.view.render(h.cx);
  assert.ok(find(tree, "crew-issue-DEMO-2"));
  assert.equal(find(tree, "crew-issue-DEMO-1"), undefined);
  h.click(tree, "crew-issue-DEMO-2");
  await h.flush();
  assert.equal(h.overlays.at(-1).props.issue.key, "DEMO-2");
  assert.deepEqual(plain(h.state.get(FILTER)), before);
  h.click(tree, "crew-Seven");
  assert.equal(find(h.view.render(h.cx), "crew-issue-DEMO-2"), undefined);
});

test("home matches missing Team and Project metadata supplied by enrichment", async () => {
  const raw = ticket("1", { teamKey: undefined, project: undefined });
  const enriched = { ...ticket("1"), delegate: { name: "Spock" } };
  const h = await harness({ issues: [raw], spaces: [workSpace("one", raw)], enrichment: [enriched] });
  h.view.applyFilter({ team: ["DEMO"], project: ["alpha"], crew: ["Spock"] });
  assert.equal(h.view.visibleSpaces().length, 1);
  assert.equal(raw.project, undefined);
  assert.equal(raw.teamKey, undefined);
});


test("an open filter dialog retains its workspace's option sources after switching workspaces", async () => {
  const h = await harness();
  h.setProps({ role: "filters", workspaceId: "workspace-one" });
  h.state.set(ACTIVE, "workspace-two");
  h.state.get(DATA)["workspace-two"] = { issues: [ticket("1", {
    teamKey: "FOREIGN", project: { id: "foreign", name: "Foreign" }, state: { name: "Foreign state" },
  })], projects: [] };
  const choices = h.view.filterChoices();
  assert.ok(choices.project.some(option => option.value === "alpha"));
  assert.equal(choices.project.some(option => option.value === "foreign"), false);
  assert.equal(choices.team.some(option => option.value === "FOREIGN"), false);
  assert.equal(choices.status.some(option => option.value === "linear:Foreign state"), false);
});

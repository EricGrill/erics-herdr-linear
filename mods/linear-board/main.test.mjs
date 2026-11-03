import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
const repositorySource = await readFile(new URL("./repository.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("./client.js", import.meta.url), "utf8");
const project = { id: "project-one", name: "one", teams: ["TEAM"] };

// Exercise real form, preferences and repository coordination. Only native
// boundaries, initial list loading and Linear replies are synthetic.
async function harness(options = {}) {
  const calls = [], jobs = [], initializations = [];
  const sourceSpace = options.focused ?? { id: "focused", active: true, machine: "remote", folder: "/focused/repo" };
  const machineRepos = options.repositories ?? { local: ["one", "two"], remote: ["one", "two"] };
  const sharedStore = options.sharedStore ?? new Map();
  const storage = new Map();
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  } });
  const dummy = new Proxy(function () {}, { get: () => dummy, apply: () => dummy });
  const api = {
    props: () => ({ role: "dialog", ...options.props }),
    spaces: () => [sourceSpace], panes: () => [], agents: () => [],
    machines: () => [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
    shared: key => key === "linear-workspace.agents" ? { "": "local-agent", remote: "remote-agent" } : sharedStore.get(key),
    setShared: (key, value) => sharedStore.set(key, value),
    appHome: () => "/fake/herdr-app",
    exec: async (command, args, config) => {
      calls.push({ command, args, config });
      if (args[1].includes('root="')) {
        const machine = config.on ?? "local", root = `/${machine}/code`;
        return { code: 0, stdout: [root, ...machineRepos[machine].map(name => `${root}/${name}`), ""].join("\0"), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    knownAgents: async ({ on }) => [{ key: on === "remote" ? "remote-agent" : "local-agent", installed: true }],
  };
  const modules = new Map();
  async function link(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    let module;
    if (specifier === "./repository.js") module = new vm.SourceTextModule(repositorySource, { context });
    else if (specifier === "./client.js") module = new vm.SourceTextModule(clientSource, { context });
    else {
      let exports;
      if (specifier === "gpui-kit") exports = { View: class {}, div: dummy, svg: dummy, image: dummy };
      else if (specifier === "herdr") {
        const names = [...(source + clientSource).matchAll(/import \{([^}]+)\} from "herdr"/g)].flatMap(m => m[1].split(",").map(n => n.trim()));
        exports = Object.fromEntries([...new Set([...names, "exec"])].map(name => [name, api[name] ?? dummy]));
      } else {
        const names = [...(source + clientSource).matchAll(/import \{([^}]+)\} from "([^\"]+)"/g)]
          .filter(m => m[2] === specifier).flatMap(m => m[1].split(",").map(n => n.trim()));
        exports = Object.fromEntries((names.length ? names : ["readFile"]).map(name => [name, name === "folderOf" ? space => space.folder : dummy]));
      }
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    modules.set(specifier, module);
    if (["./repository.js", "./client.js"].includes(specifier)) await module.link(link);
    return module;
  }
  const main = new vm.SourceTextModule(source, { context });
  await main.link(link);
  await main.evaluate();
  const base = modules.get("./client.js").namespace.default.prototype;
  base.init = function (p) {
    initializations.push(p);
    this.lists = { projects: { items: options.projects ?? [project, { id: "project-two", name: "two", teams: ["TEAM"] }] } };
    this.ws = "workspace-one";
    this.screen = "list";
    this.title = this.desc = this.projSearch = { set_value() {}, focus() {} };
  };
  base.linear = async request => {
    if (request.op === "teams") return { teams: [{ id: "team", key: "TEAM" }] };
    if (request.op === "states") return { states: [] };
    if (request.op === "project") return {};
    throw new Error(`Unexpected Linear request: ${request.op}`);
  };
  const view = new main.namespace.default();
  const cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); }, timer: { every() {}, after() {} } };
  async function settle() { while (jobs.length) await Promise.all(jobs.splice(0)); }
  return { view, cx, settle, calls, initializations, sharedStore };
}

test("explicit-local source discovers and preselects locally while a remote space is focused", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/local/code/one" } } });
  h.view.init({}, h.cx);
  assert.equal(h.view.launchTarget.machine, null);
  assert.equal(h.view.launchTarget.folder, "", "source is only a hint until target discovery validates existence");
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "/local/code/one");
  assert.equal(h.view.agentKey, "local-agent");
  assert.ok(h.calls.every(call => call.config.on === null));
});

test("initial focused remote source uses its target-side home and never expands locally", async () => {
  const h = await harness({ focused: { id: "remote-space", active: true, machine: "remote", folder: "/remote/code/two" } });
  h.view.init({}, h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.machine, "remote");
  assert.equal(h.view.repoRoot, "/remote/code");
  assert.equal(h.view.launchTarget.folder, "/remote/code/two");
  assert.equal(h.view.agentKey, "remote-agent");
  assert.ok(h.calls.every(call => call.config.on === "remote"));
});

test("new main-list task remembers a project visited earlier", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/not-an-existing-repo" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.openProject(project, h.cx);
  await h.settle();
  h.view.screen = "list";
  h.view.drilled = null;
  h.view.create(h.cx);
  await h.settle();
  assert.equal(h.view.form.project, project.id);
  assert.equal(h.view.launchTarget.folder, "/local/code/one");
});

test("project-specific creation preselects only the project's existing repository", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/not-an-existing-repo" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.curProject = project;
  h.view.screen = "project";
  h.view.create(h.cx);
  await h.settle();
  assert.equal(h.view.form.project, project.id);
  assert.equal(h.view.launchTarget.folder, "/local/code/one");
  h.view.form.project = "project-two";
  h.view.chooseComputer("remote", h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "/remote/code/two", "computer changes use the form's current project");
  assert.equal(h.view.agentKey, "remote-agent");
});

test("missing source repositories stay unselected and explicit retained targets are revalidated", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/local/code/missing" } } });
  h.view.init({}, h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "");
  const retained = { machine: "remote", folder: "/remote/code/two", name: "two" };
  h.view.chooseComputer("remote", h.cx, retained);
  assert.equal(h.view.launchTarget.folder, "");
  await h.settle();
  assert.equal(h.view.launchTarget.machine, "remote");
  assert.equal(h.view.launchTarget.folder, retained.folder);
  assert.ok(h.calls.some(call => call.config.on === "remote" && call.args.at(-1) === retained.folder), "retained folder is validated on its computer");
});

test("repository selection cannot apply while discovery is loading or work is busy", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/local/code/missing" } } });
  h.view.init({}, h.cx);
  h.view.selectRepository({ name: "one", folder: "/local/code/one" }, h.cx);
  assert.equal(h.view.launchTarget.folder, "");
  await h.settle();
  h.view.selectRepository({ name: "two", folder: "/local/code/two" }, h.cx);
  assert.equal(h.view.launchTarget.folder, "/local/code/two");
  h.view.busy = "Creating";
  h.view.selectRepository({ name: "one", folder: "/local/code/one" }, h.cx);
  assert.equal(h.view.launchTarget.folder, "/local/code/two");
});

test("new dialogs restore the last project and its explicit computer/repository after persistence", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/local/code/one" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.create(h.cx);
  h.view.pickProject(project.id, h.cx);
  await h.settle();
  h.view.chooseComputer("remote", h.cx);
  await h.settle();
  h.view.selectRepository({ name: "two", folder: "/remote/code/two" }, h.cx);
  const reopened = await harness({ sharedStore: new Map(JSON.parse(JSON.stringify([...h.sharedStore]))),
    props: { source: { machine: null, folder: "/local/code/one" } } });
  reopened.view.init({}, reopened.cx);
  await reopened.settle();
  reopened.view.create(reopened.cx);
  await reopened.settle();
  assert.equal(reopened.view.form.project, project.id);
  assert.equal(reopened.view.launchTarget.machine, "remote");
  assert.equal(reopened.view.launchTarget.folder, "/remote/code/two", "explicit mapping wins over both name and source guesses");
});

test("project and computer changes restore their own repository choices", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/missing" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.create(h.cx);
  h.view.pickProject(project.id, h.cx);
  await h.settle();
  h.view.selectRepository({ name: "two", folder: "/local/code/two" }, h.cx);
  h.view.chooseComputer("remote", h.cx);
  await h.settle();
  h.view.selectRepository({ name: "one", folder: "/remote/code/one" }, h.cx);
  h.view.pickProject("project-two", h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "/remote/code/two");
  h.view.pickProject(project.id, h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "/remote/code/one");
  h.view.chooseComputer(null, h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "/local/code/two");
  h.view.pickProject(null, h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "", "No project clears the preceding project's repository");
});

test("a missing mapped repository stays unselected and can be replaced explicitly", async () => {
  const sharedStore = new Map([["linear-workspace.task-defaults", {
    "workspace-one": { lastProject: project.id, projects: {
      [project.id]: { machine: null, repositories: { "": "/local/code/missing" } },
    } },
  }]]);
  const h = await harness({ sharedStore, props: { source: { machine: null, folder: "/local/code/one" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.create(h.cx);
  await h.settle();
  assert.equal(h.view.launchTarget.folder, "");
  assert.match(h.view.repositoryError, /saved repository.*unavailable/i);
  h.view.selectRepository({ name: "two", folder: "/local/code/two" }, h.cx);
  assert.equal(h.view.repositoryError, "");
  assert.equal(h.view.mappedRepository(null), "/local/code/two");
});

test("incompatible team changes clear the project and its repository", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/missing" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.create(h.cx);
  h.view.pickProject(project.id, h.cx);
  await h.settle();
  h.view.selectRepository({ name: "two", folder: "/local/code/two" }, h.cx);
  h.view.pickTeam({ id: "other-team", key: "OTHER" }, h.cx);
  await h.settle();
  assert.equal(h.view.form.project, null);
  assert.equal(h.view.launchTarget.folder, "");
});

test("passive space selection remembers the project in the currently active workspace", async () => {
  const h = await harness({ props: { role: "launcher" } });
  h.view.init({}, h.cx);
  assert.equal(h.view.ws, undefined);
  h.sharedStore.set("linear-workspace.workspace", "workspace-one");
  const record = { issue: { project }, space: { id: "space-one" }, agents: [] };
  h.view.selectWork(record);
  h.sharedStore.set("linear-workspace.workspace", "workspace-two");
  h.view.selectWork({ ...record, issue: { project: { id: "project-two" } } });
  const saved = h.sharedStore.get("linear-workspace.task-defaults");
  assert.equal(saved["workspace-one"].lastProject, project.id);
  assert.equal(saved["workspace-two"].lastProject, "project-two");
  h.view.selectWork({ space: { id: "unlinked" }, agents: [] });
  assert.equal(h.sharedStore.get("linear-workspace.task-defaults")["workspace-two"].lastProject, "project-two");
});

{
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
    "gpui-kit": { div: () => element(), svg: () => element(), image: () => element() },
    "gpui-base": { v_flex: () => element("column"), h_flex: () => element("row"), Input: { new: () => element("input") }, Popup: {}, TextView: {} },
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

test("Filters remains available while Linear is signed out", async () => {
  const h = await harness();
  h.view.signedOut = true;
  const tree = h.view.render(h.cx);
  assert.ok(find(tree, "sign-in"));
  assert.ok(find(tree, "new-task"));
  h.click(tree, "home-filter-button");
  assert.equal(h.overlays.at(-1).props.role, "filters");
});

test("filter enrichment preserves an explicitly removed project", async () => {
  const raw = ticket("1", { project: null });
  const h = await harness({ issues: [raw], spaces: [workSpace("one", raw)], enrichment: [ticket("1")] });
  h.view.applyFilter({ project: ["alpha"] });
  assert.equal(h.view.visibleSpaces().length, 0);
  assert.equal(h.view.enrich(raw).project, null);
});

}


test("agent selection persists ordinary preferences but demo selection stays isolated", async () => {
  for (const demo of [false, true]) {
    const h = await harness();
    h.view.init({}, h.cx);
    await h.settle();
    h.view.demo = demo;
    h.view.agentChoices = [{ key: "new-agent", name: "New agent" }];
    const callbacks = new Map();
    h.view.button = (id, _label, action) => { callbacks.set(id, action); return {}; };
    h.view.launchOptions();
    callbacks.get("agent-new-agent")(h.cx);
    assert.equal(h.view.agentKey, "new-agent");
    assert.equal(h.sharedStore.get("linear-workspace.agents")?.remote, demo ? undefined : "new-agent");
  }
});

test("Create & start reflects status readiness without starting anything", async () => {
  const h = await harness();
  h.view.launchTarget = { machine: null, folder: "/local/code/one" };
  h.view.agentsChecked = true;
  h.view.agentChoices = [{ key: "local-agent" }];
  h.view.button = (_id, _label, _action, options) => options;
  h.view.form = {};
  assert.equal(h.view.createStartButton().enabled, true);
  h.view.form.loadingStates = "team";
  assert.equal(h.view.createStartButton().enabled, false);
  h.view.form.loadingStates = null;
  h.view.form.statesError = "Offline";
  assert.equal(h.view.createStartButton().enabled, false);
});

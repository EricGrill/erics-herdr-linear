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

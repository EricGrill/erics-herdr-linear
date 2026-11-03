import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
const repositorySource = await readFile(new URL("./repository.js", import.meta.url), "utf8");
const project = { id: "project-one", name: "one" };

// Exercise the real launcher and repository coordinator. The base client is
// replaced only to keep Linear calls out of these view/controller tests; its
// persistence and creation behavior have separate client integration coverage.
async function harness(options = {}) {
  const calls = [], jobs = [], initializations = [];
  const sourceSpace = options.focused ?? { id: "focused", active: true, machine: "remote", folder: "/focused/repo" };
  const machineRepos = options.repositories ?? { local: ["one", "two"], remote: ["one", "two"] };
  class Client {
    init(p) {
      initializations.push(p);
      this.lists = { projects: { items: [project, { id: "project-two", name: "two" }] } };
      this.ws = "workspace-one";
      this.screen = "list";
    }
    create() {
      const selected = this.screen === "project" ? this.curProject : this.drilled;
      this.form = { project: selected?.id ?? null };
      this.screen = "create";
    }
  }
  const context = vm.createContext({ localStorage: { getItem: () => null } });
  const dummy = new Proxy(function () {}, { get: () => dummy, apply: () => dummy });
  const api = {
    props: () => ({ role: "dialog", ...options.props }),
    spaces: () => [sourceSpace], panes: () => [], agents: () => [],
    machines: () => [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
    shared: key => key === "linear-workspace.agents" ? { "": "local-agent", remote: "remote-agent" } : undefined,
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
    else {
      let exports;
      if (specifier === "./client.js") exports = { default: Client };
      else if (specifier === "herdr") {
        const names = [...source.matchAll(/import \{([^}]+)\} from "herdr"/g)].flatMap(m => m[1].split(",").map(n => n.trim()));
        exports = Object.fromEntries([...new Set([...names, "exec"])].map(name => [name, api[name] ?? dummy]));
      } else {
        const match = [...source.matchAll(/import \{([^}]+)\} from "([^\"]+)"/g)].find(m => m[2] === specifier);
        exports = Object.fromEntries((match?.[1].split(",").map(n => n.trim()) ?? ["readFile"]).map(name => [name, name === "folderOf" ? space => space.folder : dummy]));
      }
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    modules.set(specifier, module);
    if (specifier === "./repository.js") await module.link(link);
    return module;
  }
  const main = new vm.SourceTextModule(source, { context });
  await main.link(link);
  await main.evaluate();
  const view = new main.namespace.default();
  const cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); }, timer: { every() {} } };
  async function settle() { while (jobs.length) await Promise.all(jobs.splice(0)); }
  return { view, cx, settle, calls, initializations };
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

test("new main-list task ignores a project visited earlier", async () => {
  const h = await harness({ props: { source: { machine: null, folder: "/not-an-existing-repo" } } });
  h.view.init({}, h.cx);
  await h.settle();
  h.view.curProject = project;
  h.view.screen = "list";
  h.view.drilled = null;
  h.view.create(h.cx);
  await h.settle();
  assert.equal(h.view.form.project, null);
  assert.equal(h.view.launchTarget.folder, "", "stale curProject must not select its repository");
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

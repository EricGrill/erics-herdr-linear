import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { taskContext } from "./model.js";

const source = await readFile(new URL("./client.js", import.meta.url), "utf8");
const ticket = {
  id: "issue-one", identifier: "DEMO-3785", title: "Research newly starred repos",
  url: "https://linear.app/example/issue/DEMO-3785", branch: "sample-user/demo-3785-research",
  teamKey: "DEMO", teamId: "team-one", state: { name: "In Progress", type: "started" },
};
const selectedAgent = { key: "codex", name: "Codex", installed: true, run: ["codex"] };
const sourceSpace = { id: "source", active: true, folder: "/repos/sampleWorkspace", machine: null, tabs: [{ id: "source-tab" }] };

// Evaluate the real client unchanged. Only native boundaries are synthetic:
// commands, backend process replies, installed-agent discovery, and UI classes.
// No process, network connection, timer, or app command leaves this harness.
async function harness(options = {}) {
  const requests = [], commands = [], agentChecks = [], links = [], modes = [], validations = [], routingChecks = [];
  const sharedStore = options.sharedStore ?? new Map();
  const storage = new Map();
  const context = vm.createContext({
    console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  const allSpaces = options.spaces ?? [sourceSpace];
  let createCalls = 0;
  const exec = async (command, args, config) => {
    if (command === "sleep") return { code: 0, stdout: "", stderr: "" };
    assert.equal(command, "sh");
    if (args[1] !== 'exec "$0" app "$1"') {
      assert.ok(args[1].includes('dest="$HOME/.local/share/herdr-linear/app/$v"'), "only the existing provision boundary is stubbed");
      return { code: 0, stdout: "/fake/herdr-linear", stderr: "" };
    }
    const request = JSON.parse(args[3]);
    requests.push({ request, on: config?.on ?? null });
    let result;
    if (request.op === "check-start") result = { issue: ticket };
    else if (request.op === "create") {
      createCalls += 1;
      result = options.failCreateAt === createCalls ? { error: "Linear create failed" } : { issue: ticket, note: "Created ticket" };
    } else if (request.op === "worktree") result = { job: "job-one" };
    else if (request.op === "job") result = { done: true, result: {
      path: options.worktreePath ?? "/repos/worktrees/demo-3785", created: options.created ?? false,
      prompt: "Backend prompt", note: "Worktree ready",
    } };
    else if (request.op === "start") result = options.failStart ? { error: "Issue could not be started" } : { note: "Issue started" };
    else throw new Error(`Unexpected backend operation ${request.op}`);
    return { code: result.error ? 1 : 0, stdout: JSON.stringify(result), stderr: "" };
  };
  const noop = () => {};
  const dummy = new Proxy(function () {}, { get: () => dummy, apply: () => dummy, construct: () => dummy });
  const exportsByModule = {
    "gpui-kit": { View: class View {}, div: dummy },
    "gpui-base": Object.fromEntries(["v_flex", "h_flex", "InputState", "Input", "TextView", "Scrollbar", "v_virtual_list", "VirtualListScrollHandle", "Popup"].map(name => [name, dummy])),
    "fs/promises": { readFile: async () => "{}", writeFile: async () => {} },
    "./repository.js": { validateRepository: async target => {
      validations.push({ ...target });
      if (options.validationError) throw new Error(options.validationError);
      return target.folder;
    }, validateWorktreeRouting: async (target, workspaceKey) => {
      routingChecks.push({ target: { ...target }, workspaceKey });
      if (options.routingError) throw new Error(options.routingError);
    } },
    "herdr": {
      shared: key => sharedStore.get(key), setShared: (key, value) => sharedStore.set(key, value),
      agents: () => [], panes: () => options.panes ?? [], machines: () => [], spaces: () => allSpaces,
      run: (name, args) => { commands.push({ name, args }); return {}; }, exec, theme: () => ({}),
      appHome: () => "/fake/herdr-app", props: () => ({ overlay: "test-dialog", ...options.props }), closeOverlay: noop,
      openOverlay: noop, nextCommand: async () => new Promise(() => {}),
      knownAgents: async ({ on }) => {
        agentChecks.push(on ?? null);
        if (options.agentCheckFails) throw new Error("Agent machine unavailable");
        return options.agents ?? [selectedAgent];
      },
    },
    "./look.js": Object.fromEntries(["tones", "tint", "countPill", "stateIcon", "projectIcon", "PRIORITIES", "priorityIcon", "hue", "icon", "chip", "words", "key", "MONO"].map(name => [name, dummy])),
  };
  const module = new vm.SourceTextModule(source, { context, identifier: new URL("./client.js", import.meta.url).href });
  await module.link(specifier => {
    const exports = exportsByModule[specifier];
    assert.ok(exports, `unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const pending = [];
  const cx = {
    notify: noop,
    // Step timeouts are deliberately never fired; process responses settle each
    // real Promise.race. This exercises ordering without wall-clock delays.
    timer: { after: noop, every: noop },
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); },
  };
  const client = new module.namespace.default();
  Object.assign(client, {
    ws: "workspace-one", on: "", workspaces: [{ id: "workspace-one", name: "Workspace", urlKey: "example" }],
    demo: false, trees: {}, lists: {}, screen: "issue", cur: ticket, busy: "", err: "", flash: "",
    launchTarget: Object.hasOwn(options, "launchTarget") ? options.launchTarget : { folder: sourceSpace.folder, machine: null },
    agentKey: "codex", title: { value: () => options.title ?? "Investigate new stars" },
    desc: { value: () => "Reproduce the missing scheduled research." },
    form: { team: { id: "team-one" }, project: "project-one", state: "state-one", priority: 2, assignToMe: true },
    loadAll: noop,
    openIssue: function (issue) { this.cur = issue; },
    taskFor: issue => taskContext(issue, "Ticket description on a reopened worktree."),
    onWorktree: (issue, folder, machine, space) => links.push({ issue, folder, machine, space }),
    afterCreate: (_issue, _cx, start) => modes.push(start),
  });
  const flush = async () => {
    let read = 0;
    while (read < pending.length) { const batch = pending.slice(read); read = pending.length; await Promise.all(batch); }
  };
  return { client, cx, flush, requests, commands, agentChecks, links, modes, validations, routingChecks, sharedStore, openIssue: module.namespace.default.prototype.openIssue };
}

test("blank Create & start does not make a subsequent ordinary Create start work", async () => {
  const h = await harness({ title: "   " });
  h.client.submit(h.cx, true);
  await h.flush();
  assert.match(h.client.err, /Give it a title/);
  assert.equal(h.requests.length, 0);
  h.client.title = { value: () => "Valid title" };
  h.client.submit(h.cx);
  await h.flush();
  assert.deepEqual(h.modes, [false]);
  assert.equal(h.requests.filter(r => r.request.op === "create").length, 1);
  assert.equal(h.commands.length, 0);
});

test("failed Create & start does not make a subsequent ordinary Create start work", async () => {
  const h = await harness({ failCreateAt: 1 });
  h.client.submit(h.cx, true);
  await h.flush();
  assert.match(h.client.err, /Linear create failed/);
  assert.deepEqual(h.modes, []);
  assert.equal(h.client.busy, "");
  h.client.submit(h.cx);
  await h.flush();
  assert.deepEqual(h.modes, [false]);
  assert.equal(h.requests.filter(r => r.request.op === "create").length, 2);
});

test("successful Create & start carries only that request's launch intent", async () => {
  const h = await harness();
  h.client.submit(h.cx, true);
  await h.flush();
  h.client.submit(h.cx);
  await h.flush();
  assert.deepEqual(h.modes, [true, false]);
  const create = h.requests.find(r => r.request.op === "create").request.new;
  assert.equal(create.team, "team-one");
  assert.equal(create.project, "project-one");
  assert.equal(create.description, "Reproduce the missing scheduled research.");
  assert.equal(create.assignToMe, true);
});

test("submit without a loaded team makes no create request", async () => {
  const h = await harness();
  h.client.form.team = null;
  h.client.submit(h.cx, true);
  await h.flush();
  assert.match(h.client.err, /loading your teams/);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.modes, []);
});

test("reopened worktree starts the selected agent with its ticket context", async () => {
  const h = await harness({ created: false });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  const opened = h.commands.find(c => c.name === "space.new");
  assert.ok(opened, h.client.err);
  assert.deepEqual(JSON.parse(JSON.stringify(opened.args.argv)), ["codex"]);
  assert.equal(opened.args.folder, "/repos/worktrees/demo-3785");
  assert.match(opened.args.task, /Work on Linear issue DEMO-3785/);
  assert.ok(opened.args.task.includes(ticket.url));
  assert.match(opened.args.task, /Ticket description on a reopened worktree/);
  assert.deepEqual(h.requests.map(r => r.request.op), ["check-start", "worktree", "job", "start"]);
  assert.equal(h.links.length, 1);
  assert.equal(h.client.err, "");
});

test("existing space is selected without launching or prompting a duplicate agent", async () => {
  const existing = { id: "existing", machine: null, folder: "/repos/worktrees/demo-3785", tabs: [{ id: "existing-tab" }] };
  const h = await harness({ spaces: [sourceSpace, existing] });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.deepEqual(h.commands.map(c => c.name), ["space.select"]);
  assert.equal(h.commands[0].args.id, "existing");
  assert.match(h.client.flash, /no prompt was sent/);
  assert.equal(h.links[0].space.id, "existing");
});

test("missing selected agent does not fall back to another agent or plain shell", async () => {
  const h = await harness({ agents: [{ key: "claude", installed: true, run: ["claude"] }] });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.match(h.client.err, /selected agent is not installed/);
  assert.deepEqual(h.requests.map(r => r.request.op), ["check-start"]);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.links, []);
  assert.equal(h.client.busy, "");
});

test("failed installed-agent check does not change issue status, create worktree, or open shell", async () => {
  const h = await harness({ agentCheckFails: true });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.match(h.client.err, /Agent machine unavailable/);
  assert.deepEqual(h.requests.map(r => r.request.op), ["check-start"]);
  assert.deepEqual(h.commands, []);
});

test("failed issue transition does not launch an agent after preparing its worktree", async () => {
  const h = await harness({ failStart: true });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.match(h.client.err, /worktree is ready.*wasn't started/);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.links, []);
});

test("explicit local target checks local agents even when current space is remote", async () => {
  const h = await harness({
    spaces: [{ ...sourceSpace, machine: "remote" }],
    launchTarget: { folder: "/repos/local", machine: null },
  });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.deepEqual(h.agentChecks, [null]);
  const request = h.requests.find(r => r.request.op === "worktree");
  assert.equal(request.on, null);
  assert.deepEqual(request.request.dirs, ["/repos/local"]);
  assert.equal(h.commands.find(c => c.name === "space.new").args.machine, "");
  assert.equal(h.validations[0].machine, null);
});


test("remote target validates, discovers agents, prepares and launches on that computer", async () => {
  const h = await harness({
    launchTarget: { machine: "build-2", folder: "/home/build/code/Repos with 空間", id: "source" },
    spaces: [{ ...sourceSpace, machine: "focused-remote" }],
    panes: [{ tab: "source-tab", cwd: "/wrong/focused/repository" }],
  });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.equal(h.validations[0].folder, "/home/build/code/Repos with 空間");
  assert.equal(h.validations[0].machine, "build-2");
  assert.deepEqual(h.agentChecks, ["build-2"]);
  assert.equal(h.requests.find(r => r.request.op === "worktree").on, "build-2");
  assert.deepEqual(h.requests.find(r => r.request.op === "worktree").request.dirs, ["/home/build/code/Repos with 空間"]);
  assert.equal(h.commands.find(c => c.name === "space.new").args.machine, "build-2");
});

test("invalid base repository never creates an issue or worktree or starts elsewhere", async () => {
  for (const action of ["submit", "worktree"]) {
    const h = await harness({ validationError: "Selected repository is not a Git repository" });
    h.client[action](h.cx, true);
    await h.flush();
    assert.match(h.client.err, /not a Git repository/);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.commands, []);
    assert.deepEqual(h.agentChecks, []);
  }
});

test("missing target never inherits the focused computer or repository", async () => {
  for (const action of ["submit", "worktree"]) {
    const h = await harness({ launchTarget: null, spaces: [{ ...sourceSpace, machine: "focused-remote" }] });
    h.client[action](h.cx, true);
    await h.flush();
    assert.match(h.client.err, /Choose a computer and an existing repository/);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.commands, []);
  }
});

test("ordinary Create persists its computer and repository for a reopened ticket", async () => {
  const launchTarget = { machine: "build-2", folder: "/home/build/code/project", name: "project", root: "/home/build/code" };
  const created = await harness({ launchTarget });
  created.client.submit(created.cx);
  await created.flush();
  assert.deepEqual(created.modes, [false]);
  assert.equal(created.validations[0].machine, "build-2");
  const reopened = await harness({ sharedStore: created.sharedStore, launchTarget: { machine: null, folder: "/different" } });
  const restored = [];
  reopened.client.chooseComputer = (machine, _cx, target) => { restored.push({ machine, target }); reopened.client.launchTarget = target; };
  reopened.client.loadDetail = () => {};
  reopened.client.focusKeys = () => {};
  reopened.openIssue.call(reopened.client, ticket, reopened.cx);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].machine, "build-2");
  assert.equal(restored[0].target.folder, launchTarget.folder);
  assert.equal(restored[0].target.root, launchTarget.root);
  reopened.client.worktree(reopened.cx, true, { issue: ticket });
  await reopened.flush();
  assert.equal(reopened.commands.find(c => c.name === "space.new").args.machine, "build-2");
});

test("saved explicit-local target remains local on reopening under a remote space", async () => {
  const created = await harness({ launchTarget: { machine: null, folder: "/Users/local/code/project" } });
  created.client.submit(created.cx);
  await created.flush();
  const reopened = await harness({ sharedStore: created.sharedStore, launchTarget: { machine: "remote", folder: "/home/remote/code/project" } });
  reopened.client.loadDetail = () => {};
  reopened.client.focusKeys = () => {};
  reopened.openIssue.call(reopened.client, ticket, reopened.cx);
  assert.equal(reopened.client.launchTarget.machine, null);
  assert.equal(reopened.client.launchTarget.folder, "/Users/local/code/project");
});

test("execution snapshot stays on the originally selected computer during async work", async () => {
  const h = await harness({ launchTarget: { machine: "selected", folder: "/selected/repo" } });
  h.client.worktree(h.cx, true, { issue: ticket });
  h.client.launchTarget = { machine: "different", folder: "/different/repo" };
  h.client.agentKey = "claude";
  await h.flush();
  assert.equal(h.validations[0].machine, "selected");
  assert.deepEqual(h.agentChecks, ["selected"]);
  assert.equal(h.requests.find(r => r.request.op === "worktree").on, "selected");
  assert.equal(h.commands.find(c => c.name === "space.new").args.machine, "selected");
});


test("creating an attachment ticket does not require a new execution target", async () => {
  const h = await harness({ launchTarget: null, props: { attachSpace: { id: "existing-space", machine: "remote" } } });
  h.client.submit(h.cx);
  await h.flush();
  assert.deepEqual(h.validations, []);
  assert.equal(h.requests.filter(r => r.request.op === "create").length, 1);
  assert.equal(h.sharedStore.has("linear-workspace.launch-targets"), false);
  assert.deepEqual(h.commands, []);
});


test("worktree repository routing does not reuse the Linear team's configured checkout", async () => {
  const h = await harness({ launchTarget: { machine: "build-2", folder: "/home/build/code/selected" } });
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  const worktree = h.requests.find(r => r.request.op === "worktree").request;
  const start = h.requests.find(r => r.request.op === "start").request;
  assert.equal(worktree.target.teamKey, "");
  assert.equal(worktree.target.workspaceKey, "example");
  assert.deepEqual(worktree.dirs, ["/home/build/code/selected"]);
  assert.equal(start.teamKey, ticket.teamKey);
  assert.equal(start.issue, ticket.id);
  assert.match(h.commands.find(c => c.name === "space.new").args.task, /Work on Linear issue DEMO-3785/);
});


test("unsafe backend repository overrides stop before issue creation, worktrees, or launch", async () => {
  for (const action of ["submit", "worktree"]) {
    const h = await harness({
      launchTarget: { machine: "build-2", folder: "/home/build/code/selected" },
      routingError: "Remove the empty-team repository override before starting work",
    });
    h.client[action](h.cx, true);
    await h.flush();
    assert.match(h.client.err, /empty-team repository override/);
    assert.equal(h.routingChecks[0].target.machine, "build-2");
    assert.equal(h.routingChecks[0].workspaceKey, "example");
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.agentChecks, []);
    assert.deepEqual(h.commands, []);
  }
});

test("ordinary Create persists a target without invoking worktree-specific routing", async () => {
  const h = await harness({ routingError: "Empty-team override blocks worktrees" });
  h.client.submit(h.cx);
  await h.flush();
  assert.equal(h.requests.filter(r => r.request.op === "create").length, 1);
  assert.deepEqual(h.routingChecks, []);
  assert.equal(h.client.savedLaunchTarget(ticket).folder, sourceSpace.folder);
});

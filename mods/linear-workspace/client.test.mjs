import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { taskContext } from "./model.js";

const source = await readFile(new URL("./client.js", import.meta.url), "utf8");
const targetSource = await readFile(new URL("./execution-target.js", import.meta.url), "utf8");
const mainSource = await readFile(new URL("./main.js", import.meta.url), "utf8");
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
    if (command === "sh" && args[2] === "herdr-execution-target") {
      args = args.slice(3);
      if (args.join(" ") === "machine ls") return { code: 0, stdout: JSON.stringify({ machines: options.registry ?? [] }), stderr: "" };
      const on = config?.on ?? null;
      if (options.coreStatus) return options.coreStatus(on);
      const core = on === null ? (options.localCore ?? { id: "core-local", name: "origin" })
        : (options.remoteCores?.[on] ?? { id: `core-${on}`, name: on });
      if (options.identityError) return { code: 1, stdout: "", stderr: "Unavailable" };
      return { code: 0, stdout: JSON.stringify({ core }), stderr: "" };
    }
    assert.equal(command, "sh");
    if (args[1].includes("HERDR_BOARD_QUERY")) {
      const body = JSON.parse(args[1].split("<<'HERDR_BOARD_QUERY'\n")[1].split("\nHERDR_BOARD_QUERY")[0]);
      if (!options.apiReply) return { code: 4, stdout: "", stderr: "no Linear API key available" };
      return { code: 0, stdout: JSON.stringify(await options.apiReply(body)), stderr: "" };
    }
    if (args[1] !== 'exec "$0" app "$1"') {
      assert.ok(args[1].includes('dest="$HOME/.local/share/herdr-linear/app/$v"'), "only the existing provision boundary is stubbed");
      return { code: 0, stdout: "/fake/herdr-linear", stderr: "" };
    }
    const request = JSON.parse(args[3]);
    requests.push({ request, on: config?.on ?? null });
    let result;
    if (request.op === "status") result = options.statusReply ?? { workspaces: [] };
    else if (request.op === "teams") result = options.teamsReply ? await options.teamsReply() : { teams: options.teams ?? [] };
    else if (request.op === "states") result = { states: [] };
    else if (request.op === "check-start") result = { issue: ticket };
    else if (request.op === "create") {
      createCalls += 1;
      result = options.failCreateAt === createCalls ? { error: "Linear create failed" } : { issue: ticket, note: "Created ticket" };
    } else if (request.op === "worktree") result = { job: "job-one" };
    else if (request.op === "job") result = { done: true, result: {
      path: options.worktreePath ?? "/repos/worktrees/demo-3785", created: options.created ?? false,
      prompt: "Backend prompt", note: "Worktree ready",
    } };
    else if (request.op === "detail") result = options.detailReply ? await options.detailReply(request) : options.detailError ? { error: options.detailError } : { issue: ticket, description: options.description ?? "" };
    else if (request.op === "start") result = options.failStart ? { error: "Issue could not be started" } : { note: "Issue started" };
    else throw new Error(`Unexpected backend operation ${request.op}`);
    return { code: result.error ? 1 : 0, stdout: JSON.stringify(result), stderr: "" };
  };
  const noop = () => {};
  const dummy = new Proxy(function () {}, { get: () => dummy, apply: () => dummy, construct: () => dummy });
  const exportsByModule = {
    "gpui-kit": { View: class View {}, div: dummy, svg: dummy, image: dummy },
    "gpui-base": Object.fromEntries(["v_flex", "h_flex", "InputState", "Input", "TextView", "Scrollbar", "v_virtual_list", "VirtualListScrollHandle", "Popup"].map(name => [name, dummy])),
    "fs/promises": { readFile: async () => JSON.stringify(options.config ?? {}), writeFile: async () => {} },
    "./repository.js": { computers: () => [], loadTarget: () => {}, selectRepository: () => {}, validateRepository: async target => {
      validations.push({ ...target });
      if (options.validationError) throw new Error(options.validationError);
      return target.folder;
    }, validateWorktreeRouting: async (target, workspaceKey) => {
      routingChecks.push({ target: { ...target }, workspaceKey });
      if (options.routingError) throw new Error(options.routingError);
    } },
    "herdr": {
      shared: key => sharedStore.get(key), setShared: (key, value) => sharedStore.set(key, value), setAgentOrder: noop,
      agents: () => [], panes: () => options.panes ?? [], machines: () => options.machines ?? [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }, { name: "build-2", layout: "ready" }], spaces: () => allSpaces,
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
  const link = async specifier => {
    if (["./api.js", "./auth.js", "./config.js"].includes(specifier)) {
      const real = new vm.SourceTextModule(await readFile(new URL(specifier, import.meta.url), "utf8"), { context });
      await real.link(link);
      return real;
    }
    if (specifier === "./execution-target.js") {
      const targetModule = new vm.SourceTextModule(targetSource, { context });
      await targetModule.link(link);
      return targetModule;
    }
    const exports = exportsByModule[specifier];
    assert.ok(exports, `unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  };
  await module.link(link);
  await module.evaluate();
  const mainStubs = {
    "./model.js": Object.fromEntries(["issueKey", "issueLabel", "folderOf", "matchIssue", "workRecords", "projectGroups", "taskContext", "issueNeedsYou"].map(name => [name, noop])),
    "./board.js": Object.fromEntries(["boardTree", "machineGroups", "issueNeedsYou", "visibleLabels", "delegateOf"].map(name => [name, noop])),
    "./enrich.js": Object.fromEntries(["fetchEnrichment", "indexEnrichment", "delegateCounts"].map(name => [name, noop])),
    "./config.js": { normalizeConfig: noop },
  };
  const mainModule = new vm.SourceTextModule(mainSource, { context });
  await mainModule.link(async specifier => {
    if (specifier === "./client.js") return module;
    const exports = mainStubs[specifier];
    if (!exports) return link(specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await mainModule.evaluate();
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
    issueTargetState: { key: "workspace-one/issue-one", request: 0, status: "ready" },
    launchTarget: Object.hasOwn(options, "launchTarget") ? options.launchTarget : { folder: sourceSpace.folder, machine: null },
    agentKey: "codex", title: { value: () => options.title ?? "Investigate new stars", set_value: noop },
    projSearch: { set_value: noop },
    desc: { value: () => "Reproduce the missing scheduled research.", set_value: noop },
    form: { team: { id: "team-one" }, project: "project-one", state: "state-one", priority: 2, assignToMe: true },
    replaceRow: noop,
    records: () => [], publish: noop,
    keys: { focus: noop },
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
  return { client, cx, flush, requests, commands, agentChecks, links, modes, validations, routingChecks, sharedStore, openIssue: module.namespace.default.prototype.openIssue, main: mainModule.namespace.default.prototype };
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
  assert.ok(create.description.startsWith("Reproduce the missing scheduled research.\n\n"));
  assert.match(create.description, /"computerId":"core-local"/);
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


test("a ticket created locally on one host reopens on another host without transferring local state", async () => {
  const origin = await harness({ localCore: { id: "origin-core", name: "origin-computer" },
    launchTarget: { machine: null, folder: "/home/origin/code/project", name: "project", root: "/home/origin/code" } });
  origin.client.submit(origin.cx);
  await origin.flush();
  const description = origin.requests.find(r => r.request.op === "create").request.new.description;
  assert.ok(description.startsWith("Reproduce the missing scheduled research."));
  const reopened = await harness({
    description, localCore: { id: "second-core", name: "second-computer" },
    registry: [{ id: "origin-core", name: "origin-alias", state: "connected" }],
    remoteCores: { "origin-alias": { id: "origin-core", name: "origin-computer" } },
    machines: [{ name: null, layout: "ready" }, { name: "origin-alias", layout: "ready" }],
    launchTarget: { machine: null, folder: "/home/second/code/project" },
  });
  assert.equal(reopened.sharedStore.size, 0);
  reopened.client.chooseComputer = (machine, _cx, target) => {
    reopened.client.targetGeneration += 1;
    reopened.client.launchTarget = { ...target, machine };
    reopened.client.agentKey = "codex";
  };
  reopened.client.loadDetail(reopened.cx);
  await reopened.flush();
  assert.equal(reopened.client.launchTarget.machine, "origin-alias");
  assert.equal(reopened.client.launchTarget.folder, "/home/origin/code/project");
  assert.equal(reopened.client.launchTarget.computerId, "origin-core");
  reopened.client.worktree(reopened.cx, true, { issue: ticket });
  await reopened.flush();
  assert.equal(reopened.requests.find(r => r.request.op === "worktree").on, "origin-alias");
  assert.equal(reopened.commands.find(c => c.name === "space.new").args.machine, "origin-alias");
});

test("unresolved canonical placement clears default selection and blocks launch but keeps issue inspection", async () => {
  const description = 'Text\n\n<!-- erics-herdr-linear:execution-target\n' + JSON.stringify({ version: 1,
    computerId: "origin-core", computerName: "origin-computer", folder: "/origin/code/project" }) + '\n-->';
  const h = await harness({ description, localCore: { id: "second-core", name: "second-computer" }, registry: [],
    launchTarget: { machine: null, folder: "/wrong/default" } });
  h.client.loadDetail(h.cx);
  await h.flush();
  assert.equal(h.client.launchTarget.folder, "");
  assert.match(h.client.repositoryError, /Saved computer origin-computer is unavailable/);
  assert.equal(h.client.detail.issue.id, ticket.id);
  h.client.worktree(h.cx, true, { issue: ticket });
  await h.flush();
  assert.deepEqual(h.requests.map(r => r.request.op), ["detail"]);
  assert.deepEqual(h.commands, []);
});

test("malformed placement cannot leave an unrelated default launch target enabled", async () => {
  const h = await harness({ description: "<!-- erics-herdr-linear:execution-target\nnot JSON\n-->",
    launchTarget: { machine: null, folder: "/wrong/default" } });
  h.client.loadDetail(h.cx);
  await h.flush();
  assert.equal(h.client.launchTarget.folder, "");
  assert.equal(h.client.agentsChecked, false);
  assert.match(h.client.repositoryError, /invalid JSON/);
  assert.equal(h.client.detail.issue.id, ticket.id);
});

test("late canonical resolution does not overwrite a new explicit computer choice", async () => {
  let answer;
  const pending = new Promise(resolve => { answer = resolve; });
  const h = await harness({ coreStatus: async () => pending });
  const description = '<!-- erics-herdr-linear:execution-target\n' + JSON.stringify({ version: 1,
    computerId: "origin-core", computerName: "origin-computer", folder: "/origin/code/project" }) + '\n-->';
  const restore = h.client.restoreLaunchTarget(ticket, description, h.cx, 0);
  h.client.targetGeneration += 1;
  h.client.launchTarget = { machine: "explicit-new", folder: "/new/code/project" };
  answer({ code: 0, stdout: JSON.stringify({ core: { id: "origin-core", name: "origin-computer" } }), stderr: "" });
  await restore;
  assert.equal(h.client.launchTarget.machine, "explicit-new");
  assert.equal(h.client.launchTarget.folder, "/new/code/project");
});

test("failed canonical identification prevents issue creation", async () => {
  const h = await harness({ identityError: true });
  h.client.submit(h.cx);
  await h.flush();
  assert.match(h.client.err, /Cannot identify/);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.commands, []);
});


const delay = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const remoteDescription = () => '```json\n' + JSON.stringify({ ericsHerdrLinearExecutionTarget: { version: 1,
  computerId: "core-remote", computerName: "remote-origin", folder: "/remote/code/canonical" } }) + '\n```';

for (const key of ["s", "w"]) test(`keyboard ${key} and shared worktree boundary cannot launch while canonical placement is pending`, async () => {
  const detail = delay();
  const h = await harness({ detailReply: () => detail.promise,
    registry: [{ id: "core-remote", name: "remote" }], launchTarget: { machine: null, folder: "/wrong/local-default" } });
  h.client.openIssue = h.main.openIssue;
  h.client.worktree = h.main.worktree;
  h.client.chooseComputer = (machine, _cx, target) => {
    h.client.targetGeneration = (h.client.targetGeneration ?? 0) + 1;
    h.client.launchTarget = { ...target, machine }; h.client.agentKey = "codex";
    h.client.agentChoices = [selectedAgent]; h.client.agentsChecked = true;
  };
  h.client.openIssue(ticket, h.cx);
  h.client.issueKey(key, h.cx);
  const flushing = h.flush();
  await new Promise(setImmediate);
  assert.deepEqual(h.requests.map(r => r.request.op), ["detail"]);
  assert.deepEqual(h.validations, []);
  assert.deepEqual(h.commands, []);
  detail.resolve({ issue: ticket, description: remoteDescription() });
  await flushing;
  assert.equal(h.client.launchTarget.machine, "remote");
  assert.equal(h.client.launchTarget.folder, "/remote/code/canonical");
  h.client.issueKey(key, h.cx);
  await h.flush();
  assert.equal(h.requests.find(r => r.request.op === "worktree").on, "remote");
  assert.equal(h.commands.find(c => c.name === "space.new").args.machine, "remote");
});

test("failed issue detail cannot launch using a still-valid default computer", async () => {
  const h = await harness({ detailError: "Linear detail unavailable", launchTarget: { machine: null, folder: "/wrong/local-default" } });
  h.client.openIssue = h.main.openIssue; h.client.worktree = h.main.worktree;
  h.client.openIssue(ticket, h.cx);
  await h.flush();
  h.client.issueKey("s", h.cx);
  await h.flush();
  assert.match(h.client.err, /Cannot launch before issue details are loaded/);
  assert.deepEqual(h.requests.map(r => r.request.op), ["detail"]);
  assert.deepEqual(h.commands, []);
});

test("Create & start crosses the real subclass bridge using its validated request snapshot while detail is pending", async () => {
  const detail = delay();
  const h = await harness({ detailReply: () => detail.promise,
    launchTarget: { machine: "remote", folder: "/remote/code/selected" } });
  h.client.worktree = h.main.worktree;
  h.client.afterCreate = h.main.afterCreate;
  h.client.openIssue = function (issue, cx) {
    h.main.openIssue.call(this, issue, cx);
    // Model target restoration/UI state changing during the redundant detail read.
    this.launchTarget = { machine: null, folder: "/wrong/local-default" };
    this.agentKey = "wrong-agent"; this.agentsChecked = false;
  };
  h.client.submit(h.cx, true);
  const flushing = h.flush();
  await new Promise(setImmediate);
  const worktree = h.requests.find(r => r.request.op === "worktree");
  assert.ok(worktree);
  assert.equal(worktree.on, "remote");
  assert.deepEqual(worktree.request.dirs, ["/remote/code/selected"]);
  assert.equal(h.commands.find(c => c.name === "space.new").args.machine, "remote");
  assert.equal(h.commands.find(c => c.name === "space.new").args.argv[0], "codex");
  assert.equal(h.client.createdLaunch, null);
  const launches = h.commands.length;
  h.client.issueKey("s", h.cx);
  assert.equal(h.commands.length, launches);
  detail.resolve({ issue: ticket, description: "" });
  await flushing;
});

test("a late old-issue detail response cannot mark a newer issue placement ready", async () => {
  const old = delay(), next = { ...ticket, id: "issue-next", identifier: "DEMO-2" };
  const h = await harness({ detailReply: request => request.issue === ticket.id ? old.promise : { issue: next, description: "" } });
  h.client.openIssue = h.main.openIssue;
  h.client.openIssue(ticket, h.cx);
  h.client.openIssue(next, h.cx);
  const flushing = h.flush();
  await new Promise(setImmediate);
  assert.equal(h.client.issueTargetState.key, "workspace-one/issue-next");
  assert.equal(h.client.issueTargetState.status, "ready");
  old.resolve({ issue: ticket, description: remoteDescription() });
  await flushing;
  assert.equal(h.client.cur.id, next.id);
  assert.equal(h.client.issueTargetState.key, "workspace-one/issue-next");
  assert.equal(h.client.detail.issue.id, next.id);
});

const defaultsKey = "linear-workspace.task-defaults";
const projects = [
  { id: "project-one", name: "First", teams: ["ONE"] },
  { id: "project-two", name: "Second", teams: ["TWO"] },
];
const teams = [{ id: "team-one", key: "ONE" }, { id: "team-two", key: "TWO" }];
const setProjects = h => { h.client.lists.projects = { items: projects }; };
const serializedStore = h => new Map(JSON.parse(JSON.stringify([...h.sharedStore])));

test("new dialog restores the last project and its explicit computer repository from serialized shared preferences", async () => {
  const first = await harness();
  first.client.screen = "create";
  first.client.pickProject("project-two", first.cx);
  first.client.rememberRepository({ machine: "remote", folder: "/remote/project-two" });
  first.client.rememberRepository({ machine: null, folder: "/local/project-two" });
  const fresh = await harness({ sharedStore: serializedStore(first), teams });
  setProjects(fresh);
  fresh.client.create(fresh.cx);
  await fresh.flush();
  assert.equal(fresh.client.form.project, "project-two");
  assert.equal(fresh.client.form.team.id, "team-two");
  assert.equal(fresh.client.defaultTaskMachine(), null);
  assert.equal(fresh.client.mappedRepository(null), "/local/project-two");
  assert.equal(fresh.client.mappedRepository("remote"), "/remote/project-two");
});

test("task defaults isolate workspaces and preserve other project and computer mappings", async () => {
  const h = await harness();
  h.client.screen = "create";
  h.client.rememberRepository({ machine: null, folder: "/first" });
  h.client.pickProject("project-two", h.cx);
  h.client.rememberRepository({ machine: "remote", folder: "/second" });
  h.client.ws = "workspace-two";
  assert.equal(h.client.taskDefaults().lastProject, undefined);
  h.client.rememberRepository({ machine: null, folder: "/other-workspace" });
  h.client.ws = "workspace-one";
  assert.equal(h.client.taskDefaults().projects["project-one"].repositories[""], "/first");
  assert.equal(h.client.mappedRepository("remote"), "/second");
  h.client.ws = null;
  const before = JSON.stringify([...h.sharedStore]);
  h.client.rememberProject(null);
  h.client.rememberRepository({ folder: "/ignored" });
  assert.equal(JSON.stringify([...h.sharedStore]), before);
});

test("explicit project and drilled context override remembered project; missing remembered projects are ignored", async () => {
  for (const context of ["project", "drilled", "missing"]) {
    const h = await harness({ teams });
    setProjects(h);
    h.client.rememberProject(context === "missing" ? "removed" : "project-one");
    if (context === "project") { h.client.screen = "project"; h.client.curProject = projects[1]; }
    if (context === "drilled") h.client.drilled = projects[1];
    h.client.create(h.cx);
    await h.flush();
    assert.equal(h.client.form.project, context === "missing" ? null : "project-two");
    if (context !== "missing") assert.equal(h.client.form.team.id, "team-two");
  }
});

test("No project persists and team changes clear an incompatible project and refresh repository", async () => {
  const h = await harness({ teams });
  setProjects(h);
  h.client.screen = "create";
  h.client.form.states = {};
  const selections = [];
  h.client.chooseComputer = machine => selections.push(machine);
  h.client.rememberRepository({ machine: "remote", folder: "/remote/first" });
  h.client.pickProject("project-one", h.cx);
  assert.equal(selections[0], "remote");
  h.client.pickTeam(teams[1], h.cx);
  await h.flush();
  assert.equal(h.client.form.project, null);
  assert.equal(h.client.taskDefaults().lastProject, null);
  assert.equal(selections.length, 2);
  h.client.pickProject(null, h.cx);
  const fresh = await harness({ sharedStore: serializedStore(h), teams });
  setProjects(fresh);
  fresh.client.create(fresh.cx);
  await fresh.flush();
  assert.equal(fresh.client.form.project, null);
});

test("demo task defaults neither read nor write real preferences", async () => {
  const h = await harness({ teams });
  setProjects(h);
  h.client.rememberProject("project-two");
  const before = JSON.stringify([...h.sharedStore]);
  h.client.demo = true;
  assert.equal(h.client.taskDefaults().lastProject, undefined);
  h.client.screen = "create";
  h.client.rememberProject("project-one");
  h.client.rememberRepository({ folder: "/demo" });
  assert.equal(h.client.mappedRepository(null), undefined);
  assert.equal(JSON.stringify([...h.sharedStore]), before);
});

test("late teams use the current selected project and cannot overwrite a newer form", async () => {
  const response = delay();
  const h = await harness({ teamsReply: () => response.promise });
  setProjects(h);
  h.client.rememberProject("project-one");
  h.client.create(h.cx);
  h.client.pickProject("project-two", h.cx);
  response.resolve({ teams });
  await h.flush();
  assert.equal(h.client.form.project, "project-two");
  assert.equal(h.client.form.team.id, "team-two");

  const old = delay();
  let calls = 0;
  const newer = await harness({ teamsReply: () => ++calls === 1 ? old.promise : { teams } });
  setProjects(newer);
  newer.client.create(newer.cx);
  const flushing = newer.flush();
  await new Promise(setImmediate);
  newer.client.create(newer.cx);
  newer.client.pickProject("project-two", newer.cx);
  await new Promise(setImmediate);
  const form = newer.client.form;
  old.resolve({ teams: [teams[0]] });
  await flushing;
  assert.equal(newer.client.form, form);
  assert.equal(form.project, "project-two");
  assert.equal(form.team.id, "team-two");
});

test("busy project and team picks preserve the current task defaults", async () => {
  const h = await harness();
  h.client.busy = "Creating";
  h.client.pickProject("project-two", h.cx);
  h.client.pickTeam(teams[1], h.cx);
  assert.equal(h.client.form.project, "project-one");
  assert.equal(h.client.form.team.id, "team-one");
  assert.equal(h.sharedStore.has(defaultsKey), false);
});

test("visiting or drilling a project remembers it without creating a ticket", async () => {
  for (const action of ["openProject", "drill"]) {
    const h = await harness();
    h.client.linear = async () => ({});
    h.client.focusKeys = () => {};
    h.client.loadProject = () => {};
    h.client.input = { set_value: () => {} };
    h.client[action](projects[1], h.cx);
    await h.flush();
    assert.equal(h.client.taskDefaults().lastProject, "project-two");
    assert.equal(h.requests.length, 0);
  }
});

test("attachment project changes do not reset execution placement", async () => {
  const h = await harness({ props: { attachSpace: { id: "space" } } });
  setProjects(h);
  h.client.form.states = {};
  h.client.chooseComputer = () => assert.fail("attachment must retain its space placement");
  h.client.pickProject("project-two", h.cx);
  h.client.pickTeam(teams[0], h.cx);
  await h.flush();
  assert.equal(h.client.form.project, null);
});

test("configured key restores task access without an OAuth workspace or cached auth state", async () => {
  const identities = [];
  const config = { enrichment: { envKey: "TASK_LINEAR_KEY" } };
  const apiReply = ({ query }) => {
    if (query.includes("TaskIdentity")) { identities.push(true); return { data: { organization: { id: "api-workspace", name: "API Workspace", urlKey: "api-example" }, viewer: { id: "viewer" } } }; }
    assert.match(query, /TaskTeams/);
    return { data: { teams: { nodes: [{ id: "team", name: "Example" }], pageInfo: { hasNextPage: false } } } };
  };
  for (let restart = 0; restart < 2; restart++) {
    const h = await harness({ config, apiReply });
    h.client.on = null;
    h.client.preferredOn = "remote";
    const [teams] = await Promise.all([h.client.linear({ op: "teams" }), h.client.findLinear()]);
    assert.equal(teams.teams[0].id, "team");
    assert.equal(h.client.ws, "api-workspace");
    assert.equal(h.requests.length, 0, "no OAuth backend used");
  }
  assert.equal(identities.length, 2, "one config/identity discovery per instance, even during concurrent startup");
});

test("failed configured access and retries never enter OAuth or show a sign-in prompt", async () => {
  let ready = false;
  const h = await harness({ config: { enrichment: { envKey: "TASK_LINEAR_KEY" } }, apiReply: ({ query }) => {
    if (!ready) return { errors: [{ message: "API key revoked" }] };
    if (query.includes("TaskIdentity")) return { data: { organization: { id: "workspace-one", urlKey: "example" }, viewer: { id: "viewer" } } };
    return { data: { teams: { nodes: [], pageInfo: { hasNextPage: false } } } };
  } });
  await h.client.start(h.cx);
  assert.equal(h.client.signedOut, false);
  assert.match(h.client.err, /API key revoked/);
  assert.equal(h.client.on, null);
  await assert.rejects(h.client.linear({ op: "teams" }), /API key revoked/);
  assert.equal(h.requests.length, 0);
  ready = true;
  await h.client.reload(h.cx);
  assert.equal(h.client.err, "");
  assert.deepEqual(JSON.parse(JSON.stringify(await h.client.linear({ op: "teams" }))), { teams: [], priorities: ["No priority", "Urgent", "High", "Medium", "Low"] });
  assert.equal(h.requests.length, 0);
});

test("configured missing key is an access error while unconfigured users retain OAuth", async () => {
  const configured = await harness({ config: { enrichment: { envKey: "MISSING_KEY" } } });
  await configured.client.start(configured.cx);
  assert.equal(configured.client.signedOut, false);
  assert.match(configured.client.err, /Configured Linear access/);
  assert.equal(configured.requests.length, 0);
  const oauth = await harness({ statusReply: { workspaces: [{ id: "oauth-workspace", name: "OAuth" }] } });
  await oauth.client.findLinear();
  assert.equal(oauth.client.ws, "oauth-workspace");
  assert.equal(oauth.client.api, null);
  assert.equal(oauth.requests[0].request.op, "status");
});

test("API create transport failure is never retried through either authentication path", async () => {
  const h = await harness({ config: { enrichment: { envKey: "TASK_LINEAR_KEY" } }, apiReply: ({ query }) => {
    if (query.includes("TaskIdentity")) return { data: { organization: { id: "workspace-one" }, viewer: { id: "viewer" } } };
    throw new Error("response lost after write");
  } });
  await h.client.findLinear();
  await assert.rejects(h.client.linear({ op: "create", new: { title: "Task", team: "team-one" } }), /response lost after write/);
  assert.equal(h.requests.length, 0);
});

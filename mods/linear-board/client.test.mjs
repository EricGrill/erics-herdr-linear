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
  const requests = [], commands = [], agentChecks = [], links = [], modes = [];
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
    "herdr": {
      agents: () => [], panes: () => options.panes ?? [], machines: () => [], spaces: () => allSpaces,
      run: (name, args) => { commands.push({ name, args }); return {}; }, exec, theme: () => ({}),
      appHome: () => "/fake/herdr-app", props: () => ({ overlay: "test-dialog" }), closeOverlay: noop,
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
    launchTarget: options.launchTarget ?? { folder: sourceSpace.folder, machine: null },
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
  return { client, cx, flush, requests, commands, agentChecks, links, modes };
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
  assert.deepEqual(request.request.dirs, ["/repos/local", "/repos/local"]);
});

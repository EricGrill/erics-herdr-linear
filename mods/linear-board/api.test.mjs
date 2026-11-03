import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const plain = value => JSON.parse(JSON.stringify(value));
const page = (nodes, more = false, cursor = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const workspace = { id: "workspace-one", name: "Example", urlKey: "example" };
const issue = (changes = {}) => ({ id: "issue-one", identifier: "EX-1", title: "Example task", branchName: "example/ex-1", url: "https://linear.app/example/issue/EX-1", priority: 2,
  state: { id: "state-one", type: "unstarted", name: "Todo", position: 0 }, team: { id: "team-one", key: "EX" }, project: null, assignee: null, ...changes });

// The actual adapter and safe transport run with synthetic process responses.
// No API call, credentials, terminal or live issue is used by these tests.
async function harness(reply) {
  const calls = [], shellCalls = [];
  const context = vm.createContext({ console });
  const exec = async (command, args, options) => {
    assert.equal(command, "sh");
    shellCalls.push({ args, options });
    const body = JSON.parse(args[1].split("<<'HERDR_BOARD_QUERY'\n")[1].split("\nHERDR_BOARD_QUERY")[0]);
    calls.push(body);
    if (body.query.includes("TaskIdentity")) return { code: 0, stdout: JSON.stringify({ data: { organization: workspace, viewer: { id: "viewer-one" } } }) };
    const response = await reply(body);
    return { code: 0, stdout: JSON.stringify(response) };
  };
  const link = async name => {
    if (name === "herdr") return new vm.SyntheticModule(["exec"], function () { this.setExport("exec", exec); }, { context });
    const m = new vm.SourceTextModule(await readFile(new URL(name, import.meta.url), "utf8"), { context });
    await m.link(link);
    return m;
  };
  const m = await link("./api.js");
  await m.evaluate();
  return { api: new m.namespace.LinearAPI({ enrichment: { envKey: "EXAMPLE_KEY", doppler: { project: "example", config: "dev", keyNames: ["EXAMPLE_BACKUP"] } } }), calls, shellCalls };
}

test("configured key identity supplies a workspace without any OAuth process", async () => {
  const h = await harness(() => assert.fail("only identity should be read"));
  assert.deepEqual(plain(await h.api.ask({ op: "status" })), { workspaces: [workspace] });
  assert.deepEqual(plain(h.shellCalls[0].args.slice(2)), ["sh", "EXAMPLE_KEY", "example", "dev", "EXAMPLE_BACKUP"]);
  assert.equal(h.shellCalls[0].options.on, null);
});

test("New Task reads projects, teams and states then submits exact selected fields", async () => {
  const project = { id: "project-one", name: "Project", url: "https://linear.app/example/project/project-one", status: { name: "Planned", type: "planned" }, teams: page([{ id: "team-one", key: "EX" }]) };
  const h = await harness(({ query, variables }) => {
    if (query.includes("TaskProjects")) return { data: { projects: page([project]) } };
    if (query.includes("TaskTeams")) return { data: { teams: page([{ id: "team-one", key: "EX", name: "Example", defaultIssueState: { id: "todo" } }]) } };
    if (query.includes("TaskStates")) return { data: { team: { states: page([{ id: "started", name: "In Progress", type: "started", position: 0 }, { id: "todo", name: "Todo", type: "unstarted", position: 0 }]) } } };
    assert.match(query, /mutation TaskCreate/);
    assert.deepEqual(plain(variables.input), { teamId: "team-one", title: "New task", description: "task details", projectId: "project-one", stateId: "todo", priority: 2, assigneeId: "viewer-one" });
    return { data: { issueCreate: { success: true, issue: issue() } } };
  });
  const projects = await h.api.ask({ op: "list", tab: "projects" });
  assert.equal(projects.projects[0].teamKey, "EX");
  assert.equal(projects.projects[0].branch, "project/project-one");
  assert.equal((await h.api.ask({ op: "teams" })).teams[0].id, "team-one");
  assert.deepEqual(plain((await h.api.ask({ op: "states", team: "team-one" })).states.map(s => s.id)), ["todo", "started"]);
  assert.equal((await h.api.ask({ op: "create", new: { title: " New task ", team: "team-one", description: "task details", project: "project-one", state: "todo", priority: 2, assignToMe: true } })).issue.id, "issue-one");
  assert.equal(h.calls.filter(c => c.query.startsWith("mutation")).length, 1);
});

test("create validates required fields and omits empty optional fields", async () => {
  const h = await harness(({ variables }) => {
    assert.deepEqual(plain(variables.input), { teamId: "team-one", title: "Task" });
    return { data: { issueCreate: { success: true, issue: issue() } } };
  });
  await assert.rejects(h.api.ask({ op: "create", new: { title: " " } }), /title and team/);
  await h.api.ask({ op: "create", new: { title: "Task", team: "team-one", project: "", state: "", priority: 0, assignToMe: false } });
  assert.equal(h.calls.filter(c => c.query.startsWith("mutation")).length, 1);
});

test("failed creation reports the failure without retrying mutation", async () => {
  const h = await harness(() => ({ errors: [{ message: "Permission denied" }] }));
  await assert.rejects(h.api.ask({ op: "create", new: { title: "Task", team: "team-one" } }), /Permission denied/);
  assert.equal(h.calls.length, 2);
});

test("workspace mismatch blocks mutation even with a valid configured key", async () => {
  const h = await harness(() => assert.fail("no mutation"));
  await assert.rejects(h.api.ask({ op: "create", workspace: "other-workspace", new: { title: "Task", team: "team-one" } }), /different workspace/);
  assert.equal(h.calls.length, 1);
});

test("paginated issue lists keep each status together across teams", async () => {
  const h = await harness(({ variables }) => ({ data: { viewer: { assignedIssues: variables.after ? page([
    issue({ id: "b", state: { id: "progress-b", type: "started", name: "In Progress", position: 4 } }),
  ]) : page([
    issue({ id: "a", state: { id: "progress-a", type: "started", name: "In Progress", position: 1 } }),
    issue({ id: "review", state: { id: "review", type: "started", name: "In Review", position: 2 } }),
  ], true, "next") } } }));
  assert.deepEqual(plain((await h.api.ask({ op: "list", tab: "mine" })).issues.map(i => i.id)), ["review", "a", "b"]);
  assert.equal(h.calls[2].variables.after, "next");
});

test("incomplete or repeated list pagination is a visible error", async () => {
  const h = await harness(() => ({ data: { teams: page([], true, "repeat") } }));
  await assert.rejects(h.api.ask({ op: "teams" }), /pagination did not advance/);
  const missing = await harness(() => ({ data: { teams: { nodes: [] } } }));
  await assert.rejects(missing.api.ask({ op: "teams" }), /incomplete list/);
});

test("detail preserves execution metadata, status choices and pull request context", async () => {
  const h = await harness(({ query }) => query.includes("TaskStates") ? { data: { team: { states: page([]) } } } : { data: { issue: issue({ description: "<!-- execution target metadata -->", priorityLabel: "High", labels: { nodes: [{ name: "follow-up", color: "red" }] }, cycle: { number: 3, name: "" }, attachments: { nodes: [{ title: "PR", url: "https://github.com/example/repo/pull/7" }] } }) } });
  const detail = await h.api.ask({ op: "detail", issue: "issue-one" });
  assert.equal(detail.description, "<!-- execution target metadata -->");
  assert.equal(detail.workspaceKey, "example");
  assert.equal(detail.cycle, "Cycle 3");
  assert.equal(detail.prs[0].number, 7);
  assert.equal(detail.issue.branch, "example/ex-1");
});

for (const change of [
  { state: { id: "done", type: "completed", name: "Done", position: 0 } },
  { assignee: { id: "other-user", isMe: false, displayName: "Other user" } },
]) test("start rejects closed or someone else's issue before mutation", async () => {
  const h = await harness(({ query }) => { assert.match(query, /query TaskIssue/); return { data: { issue: issue(change) } }; });
  await assert.rejects(h.api.ask({ op: "start", issue: "issue-one" }), /wasn't started|own and unassigned/);
  assert.equal(h.calls.some(c => c.query.startsWith("mutation")), false);
});

test("start preserves an existing started status and claims only unassigned work", async () => {
  const started = issue({ state: { id: "review", name: "In Review", type: "started", position: 4 } });
  const h = await harness(({ query, variables }) => {
    if (query.startsWith("mutation")) {
      assert.deepEqual(plain(variables.input), { assigneeId: "viewer-one" });
      return { data: { issueUpdate: { success: true } } };
    }
    assert.match(query, /TaskIssue/);
    return { data: { issue: started } };
  });
  await h.api.ask({ op: "start", issue: "issue-one", branch: "example/ex-1", teamKey: "EX" });
  assert.equal(h.calls.filter(c => c.query.startsWith("mutation")).length, 1);
});

test("start checks current branch before updating and set-state only sends requested status", async () => {
  const h = await harness(({ query, variables }) => {
    if (query.startsWith("mutation")) {
      assert.deepEqual(plain(variables.input), { stateId: "requested-state" });
      return { data: { issueUpdate: { success: true } } };
    }
    return { data: { issue: issue() } };
  });
  await assert.rejects(h.api.ask({ op: "start", issue: "issue-one", branch: "stale-branch" }), /branch or team changed/);
  await h.api.ask({ op: "set-state", issue: "issue-one", state: "requested-state" });
  assert.equal(h.calls.filter(c => c.query.startsWith("mutation")).length, 1);
});

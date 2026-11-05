import test from "node:test";
import assert from "node:assert/strict";
import { issueKey, issueLabel, issueHeading, issueHover, folderOf, sameFolder, matchIssue, workRecords, issueNeedsYou, projectGroups, taskContext, linearAppUrl, issueMenuItems, spaceMenuItems } from "./model.js";

const issue = (id = "one", identifier = "DEMO-3785", extra = {}) => ({
  id, identifier, title: "Research new stars", url: `https://linear.app/example/issue/${identifier}`,
  branch: `sample-user/${identifier.toLowerCase()}-research`, state: { type: "started", name: "In Progress" },
  project: { id: "radar", name: "RepoRadar" }, ...extra,
});
const space = (id = "space-one", extra = {}) => ({
  id, name: "RepoRadar", folder: "/work/reporadar", machine: null, branch: null,
  tabs: [{ id: `${id}-tab` }], status: "idle", ...extra,
});
const linked = (s, ticket, extra = {}) => ({
  workspace: "workspace-one", machine: s.machine, space: s.id, folder: s.folder, issue: ticket, ...extra,
});

test("issue labels put the project immediately after the identifier without empty parentheses", () => {
  assert.equal(issueLabel(issue()), "DEMO-3785 (RepoRadar)");
  for (const project of [undefined, null, { name: "" }, { name: "  " }]) {
    assert.equal(issueLabel(issue("one", "DEMO-3785", { project })), "DEMO-3785");
  }
});

test("CHA-4302: row headings put the title right after the key; hover adds the project", () => {
  const is = { identifier: "DEMO-7", title: "Fix the thing", project: { name: "RepoRadar" } };
  assert.equal(issueHeading(is), "DEMO-7 · Fix the thing");
  assert.equal(issueHover(is), "DEMO-7 (RepoRadar) · Fix the thing");
  assert.equal(issueHeading({ identifier: "DEMO-7", title: "  " }), "DEMO-7");
  assert.equal(issueHover({ identifier: "DEMO-7", project: null }), "DEMO-7");
});

test("open harnesses come from this space's live agents and terminal panes only", () => {
  const s = space();
  const codex = { key: "codex", name: "Codex", agent: true, icon: "icons/codex.svg", tint: true };
  const claude = { key: "claude", name: "Claude Code", agent: true, icon: "icons/claude.png", tint: false };
  const other = { key: "other", name: "Other harness", agent: true };
  const [record] = workRecords({
    allSpaces: [s], issues: [], links: [], workspace: "workspace-one",
    allAgents: [{ space: s.id, program: codex }, { space: "remote-space", program: other }],
    allPanes: [
      { tab: s.tabs[0].id, terminal: "codex-terminal", program: codex },
      { tab: s.tabs[0].id, terminal: "no-status-report-yet", program: claude },
      { tab: s.tabs[0].id, terminal: "shell", program: { key: "shell", agent: false } },
      { tab: s.tabs[0].id, terminal: null, program: other },
      { tab: "remote-tab", terminal: "remote-terminal", program: other },
    ],
  });
  assert.deepEqual(record.programs, [codex, claude]);
  assert.equal(record.issue, null);
});

test("recognizes issue identifiers in worktree branches and full paths", () => {
  for (const value of ["demo-3785", "sample-user/demo-3785-research", "/Users/eric/.herdr/worktrees/sampleWorkspace/sample-user-demo-3785-reporadar"]) {
    assert.equal(issueKey(value), "DEMO-3785");
  }
  assert.equal(issueKey("/work/ABC_ENG-42/fix"), "ABC_ENG-42");
});

test("rejects partial keys and identifiers embedded in unrelated words", () => {
  for (const value of [undefined, null, "", "3785", "DEMO-", "DEMO-3785extra", "3CHA-3785"]) {
    assert.equal(issueKey(value), null, String(value));
  }
});

test("uses a space's live terminal directory before its starting folder", () => {
  const s = space();
  const panes = [
    { tab: "unrelated-tab", cwd: "/work/other" },
    { tab: "space-one-tab", cwd: "/work/reporadar/subdir" },
  ];
  assert.equal(folderOf(s, panes), "/work/reporadar/subdir");
  assert.equal(folderOf(s, []), "/work/reporadar");
});

test("folder matching normalizes slashes without accepting directory prefixes", () => {
  assert.equal(sameFolder("/work/repo/", "/work/repo"), true);
  assert.equal(sameFolder("C:\\work\\repo\\", "C:/work/repo"), true);
  assert.equal(sameFolder("/work/repo", "/work/repository"), false);
  assert.equal(sameFolder("/work/repo", "/work/repo/subdir"), false);
  assert.equal(sameFolder("", ""), false);
});

test("explicit attachment takes precedence over the branch without mutating it", () => {
  const one = issue();
  const two = issue("two", "DEMO-4000");
  const s = space("existing", { branch: two.branch });
  const before = structuredClone(s);
  assert.equal(matchIssue(s, [one, two], [linked(s, one)], "workspace-one"), one);
  assert.deepEqual(s, before);
});

test("refreshes attached ticket metadata from the current issue list", () => {
  const s = space();
  const old = issue();
  const current = issue("one", "DEMO-3785", { title: "Updated title" });
  assert.equal(matchIssue(s, [current], [linked(s, old)], "workspace-one"), current);
});

test("retains an explicit attachment when its issue is absent from assigned or recent lists", () => {
  const s = space();
  const ticket = issue();
  assert.equal(matchIssue(s, [], [linked(s, ticket)], "workspace-one"), ticket);
});

test("can recover a saved attachment by exact folder when its space ID changes", () => {
  const ticket = issue();
  const previous = space("old-space");
  const reopened = space("new-space");
  assert.equal(matchIssue(reopened, [], [linked(previous, ticket)], "workspace-one"), ticket);
  assert.equal(matchIssue(space("other", { folder: "/work/reporadar-extra" }), [], [linked(previous, ticket)], "workspace-one"), null);
});

test("does not attach a same-ID or same-folder space on another machine", () => {
  const s = space();
  const ticket = issue();
  assert.equal(matchIssue(s, [], [linked(s, ticket, { machine: "remote" })], "workspace-one"), null);
  assert.equal(matchIssue(space("space-one", { machine: "remote" }), [], [linked(s, ticket)], "workspace-one"), null);
});

test("does not reuse explicit attachments from another Linear workspace", () => {
  const s = space();
  assert.equal(matchIssue(s, [], [linked(s, issue(), { workspace: "different-workspace" })], "workspace-one"), null);
});

test("infers existing issue work from exact branch, a pane branch, or a worktree path", () => {
  const ticket = issue();
  assert.equal(matchIssue(space("one", { branch: ticket.branch }), [ticket], [], "workspace-one"), ticket);
  assert.equal(matchIssue(space("two"), [ticket], [], "workspace-one", [{ tab: "two-tab", branch: ticket.branch }]), ticket);
  assert.equal(matchIssue(space("three", { folder: "/work/sample-user-demo-3785-research" }), [ticket], [], "workspace-one"), ticket);
  assert.equal(matchIssue(space("four", { name: "DEMO-3785 · RepoRadar" }), [ticket], [], "workspace-one"), ticket);
});

test("unrelated work is left unlinked rather than assigned to the first issue", () => {
  assert.equal(matchIssue(space(), [issue()], [], "workspace-one"), null);
});

test("blocked subagents outrank finished and working agents in their own space", () => {
  const a = space("a", { status: "working" });
  const b = space("b", { status: "working" });
  const c = space("c", { status: "idle" });
  const records = workRecords({
    allSpaces: [b, c, a], allPanes: [], allAgents: [
      { space: "a", address: "parent", status: "working" },
      { space: "a", address: "child-without-pane", status: "blocked" },
      { space: "a", address: "other-child", status: "done" },
      { space: "c", address: "done-agent", status: "done" },
    ], issues: [], links: [], workspace: "workspace-one",
  });
  assert.deepEqual(records.map(r => [r.space.id, r.status, r.needs]), [
    ["a", "blocked", true], ["c", "done", true], ["b", "working", false],
  ]);
  assert.equal(records[0].agents.length, 3);
  assert.equal(records[2].agents.length, 0);
});

test("agent attention never rewrites or derives from the issue's workflow status", () => {
  const progress = issue();
  const finished = issue("finished", "DEMO-4001", { state: { type: "completed", name: "Done" } });
  const first = space("first", { branch: progress.branch, status: "done" });
  const second = space("second", { branch: finished.branch, status: "working" });
  const before = structuredClone([progress, finished]);
  const records = workRecords({
    allSpaces: [first, second], allPanes: [], allAgents: [], issues: [progress, finished], links: [], workspace: "workspace-one",
  });
  assert.deepEqual(records.map(r => [r.issue.id, r.status, r.needs]), [["one", "done", true], ["finished", "working", false]]);
  assert.deepEqual([progress, finished], before);
});

test("retains every project and sorts projects needing attention before the rest", () => {
  const projects = [{ id: "empty", name: "Empty project" }, { id: "radar", name: "RepoRadar" }, { id: "alpha", name: "Alpha" }];
  const before = structuredClone(projects);
  const groups = projectGroups(projects, [
    { issue: issue(), needs: true, status: "blocked" },
    { issue: issue("other", "DEMO-4000"), needs: false, status: "working" },
    { issue: null, needs: true, status: "blocked" },
    { issue: issue("outside", "DEMO-4001", { project: null }), needs: true, status: "done" },
  ]);
  assert.deepEqual(groups.map(g => [g.project.id, g.needs, g.work.length]), [["radar", 1, 2], ["alpha", 0, 0], ["empty", 0, 0]]);
  assert.deepEqual(projects, before);
});

test("counts all attention items in a project rather than only its first matching space", () => {
  const projects = [{ id: "radar", name: "RepoRadar" }];
  assert.equal(projectGroups(projects, [
    { issue: issue(), needs: true },
    { issue: issue("two", "DEMO-4000"), needs: true },
    { issue: issue("three", "DEMO-4001"), needs: false },
  ])[0].needs, 2);
});

test("assigned Needs Human and Needs Review tickets need attention without an open workspace", () => {
  const tickets = [
    issue("human", "DEMO-5000", { mine: true, state: { name: "Needs Human" } }),
    issue("review", "DEMO-5001", { mine: true, state: { name: "Needs Review" } }),
  ];
  assert.ok(tickets.every(issueNeedsYou));
  const groups = projectGroups([{ id: "radar", name: "RepoRadar" }], [], tickets.filter(issueNeedsYou));
  assert.equal(groups[0].needs, 2);
  assert.deepEqual(groups[0].work, []);
});

test("other people's or unassigned tickets do not request this user's attention", () => {
  for (const mine of [false, undefined, null]) {
    assert.equal(issueNeedsYou(issue("other", "DEMO-5002", { mine, state: { name: "Needs Human" } })), false);
    assert.equal(issueNeedsYou(issue("other", "DEMO-5002", { mine, state: { name: "Ready for review" } })), false);
  }
});

test("In Progress alone is not a request for attention", () => {
  assert.equal(issueNeedsYou(issue("progress", "DEMO-5003", { mine: true })), false);
  assert.equal(issueNeedsYou(issue("missing-state", "DEMO-5004", { mine: true, state: null })), false);
});

test("recognizes assigned review and blocked states regardless of capitalization", () => {
  for (const name of ["Ready for review", "Awaiting your review", "Needs You", "BLOCKED", "needs human approval"]) {
    assert.equal(issueNeedsYou(issue("attention", "DEMO-5005", { mine: true, state: { name } })), true, name);
  }
});

test("completed or explicitly unblocked states do not request attention", () => {
  for (const name of ["Done", "Canceled", "Review complete", "Unblocked"]) {
    assert.equal(issueNeedsYou(issue("resolved", "DEMO-5006", { mine: true, state: { name } })), false, name);
  }
});

test("a local attention item and its Linear ticket count once for the project", () => {
  const ticket = issue("review", "DEMO-5007", { mine: true, state: { name: "Needs Review" } });
  const groups = projectGroups([{ id: "radar", name: "RepoRadar" }], [
    { issue: ticket, needs: true, status: "done", space: space("local") },
    { issue: ticket, needs: true, status: "blocked", space: space("remote", { machine: "remote" }) },
  ], [ticket, ticket]);
  assert.equal(groups[0].needs, 1);
  assert.equal(groups[0].work.length, 2);
});

test("Linear-only attention highlights its project while preserving every other project", () => {
  const projects = [{ id: "alpha", name: "Alpha" }, { id: "empty", name: "Empty" }, { id: "radar", name: "RepoRadar" }];
  const tickets = [
    issue("mine", "DEMO-5008", { mine: true, state: { name: "Needs Human" } }),
    issue("coworker", "DEMO-5009", { mine: false, state: { name: "Needs Review" }, project: { id: "alpha" } }),
  ];
  const groups = projectGroups(projects, [], tickets.filter(issueNeedsYou));
  assert.deepEqual(groups.map(g => [g.project.id, g.needs]), [["radar", 1], ["alpha", 0], ["empty", 0]]);
});

test("a task prompt always carries the ticket identity, URL, scope, and supplied context", () => {
  const ticket = issue();
  const prompt = taskContext(ticket, "Investigate why new stars are skipped.");
  assert.match(prompt, /DEMO-3785: Research new stars/);
  assert.ok(prompt.includes(ticket.url));
  assert.ok(prompt.includes("Investigate why new stars are skipped."));
  assert.match(prompt, /Keep this work scoped to DEMO-3785/);
  assert.match(prompt, /Do not mark the issue Done just because the agent run finishes/);
  assert.ok(prompt.includes("\n"), "prompt should contain readable line breaks");
});

test("reopened worktrees receive the same ticket context as newly created ones", () => {
  const ticket = issue();
  const prompt = taskContext(ticket);
  assert.match(prompt, /Work on Linear issue DEMO-3785/);
  assert.ok(prompt.includes(ticket.title));
  assert.ok(prompt.includes(ticket.url));
  assert.equal(taskContext({ ...ticket, created: false }), taskContext({ ...ticket, created: true }));
});

test("a linear.app issue link becomes the Linear desktop app's linear:// link", () => {
  assert.equal(linearAppUrl("https://linear.app/example/issue/DEMO-3785/research-new-stars"), "linear://example/issue/DEMO-3785/research-new-stars");
  assert.equal(linearAppUrl("https://linear.app/example/issue/DEMO-3785/"), "linear://example/issue/DEMO-3785");
  assert.equal(linearAppUrl("https://linear.app/example/issue/DEMO-3785?foo=1#c"), "linear://example/issue/DEMO-3785");
  for (const other of ["https://example.com/issue/DEMO-1", "http://linear.app/example/issue/DEMO-1", "javascript:alert(1)", "", null, undefined]) {
    assert.equal(linearAppUrl(other), null);
  }
});

test("the issue menu offers the Linear app first, then the browser and the link", () => {
  const url = "https://linear.app/example/issue/DEMO-3785";
  assert.deepEqual(issueMenuItems(issue()).map(i => [i.label, i.action, i.url]), [
    ["Open in Linear app", "open", "linear://example/issue/DEMO-3785"],
    ["Open in browser", "open", url],
    ["Copy link", "copy", url],
  ]);
  // A link that is not Linear's has no app entry; an issue without a link offers nothing.
  assert.deepEqual(issueMenuItems(issue("x", "DEMO-1", { url: "https://example.com/x" })).map(i => i.label), ["Open in browser", "Copy link"]);
  assert.deepEqual(issueMenuItems(issue("y", "DEMO-2", { url: null })), []);
  assert.deepEqual(issueMenuItems(null), []);
});

test("a space's own menu entries match Herdr's space menu, worktree entries only in a repository", () => {
  const labels = git => spaceMenuItems({ id: "s1" }, git).map(i => i.label);
  assert.deepEqual(labels(null), ["Rename", "Close"]);
  assert.deepEqual(labels("main"), ["Rename", "New worktree", "Open worktree", "Close"]);
  assert.deepEqual(labels("linked"), ["Rename", "New worktree", "Open worktree", "Remove worktree", "Close"]);
  assert.deepEqual(spaceMenuItems(null), []);
  const close = spaceMenuItems({ id: "s1" }).at(-1);
  assert.equal(close.command, "space.close");
  assert.deepEqual(close.args, { id: "s1" });
});

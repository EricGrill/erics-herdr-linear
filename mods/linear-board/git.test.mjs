import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitState, parseShortstat, checksOf, parsePr, readGitState, readPr, headerParts,
  aheadBehind, uncommitted, workingSince, runningFor, branchHover, GIT_SCRIPT } from "./git.js";

const STATUS = `# branch.oid 0123456789abcdef
# branch.head r2d2/CHA-4305-header-git-state
# branch.upstream origin/r2d2/CHA-4305-header-git-state
# branch.ab +2 -1
1 .M N... 100644 100644 100644 aaa bbb mods/linear-board/main.js
2 R. N... 100644 100644 100644 aaa bbb R100 new.js\told.js
? notes.txt
--base
origin/main
--ab
5\t0
--diff
 3 files changed, 40 insertions(+), 2 deletions(-)
`;

test("git state parses branch, ahead/behind against main, uncommitted files and the diff since base", () => {
  assert.deepEqual(parseGitState(STATUS), {
    branch: "r2d2/CHA-4305-header-git-state", upstream: "origin/r2d2/CHA-4305-header-git-state", base: "origin/main",
    against: "origin/main", ahead: 5, behind: 0, changed: 3, added: 40, removed: 2,
  });
});

test("ahead/behind counts against main even when the branch has its own upstream", () => {
  const git = parseGitState(STATUS);
  assert.equal(aheadBehind(git), "↑5", "not the upstream's ↑2 ↓1");
  assert.equal(branchHover(git), "r2d2/CHA-4305-header-git-state (against origin/main)");
  const noUpstream = parseGitState(STATUS.replace(/# branch.upstream .*\n# branch.ab .*\n/, ""));
  assert.equal(noUpstream.upstream, null);
  assert.equal(branchHover(noUpstream), "r2d2/CHA-4305-header-git-state (against origin/main)");
});

test("a deleted remote branch is never named in the hover", () => {
  // git still prints the upstream's name, but no ahead/behind for it, once it is gone.
  const gone = parseGitState(STATUS.replace(/# branch.ab .*\n/, ""));
  assert.equal(gone.upstream, "origin/r2d2/CHA-4305-header-git-state");
  assert.equal(gone.against, "origin/main");
  assert.equal(branchHover(gone), "r2d2/CHA-4305-header-git-state (against origin/main)");
  // Gone and no default branch either: nothing was counted, so the hover names nothing.
  const nothing = parseGitState(STATUS.replace(/# branch.ab .*\n/, "").replace(/--base[\s\S]*$/, ""));
  assert.equal(nothing.ahead, null);
  assert.equal(nothing.against, null);
  assert.equal(branchHover(nothing), "r2d2/CHA-4305-header-git-state");
});

test("without a default branch, ahead/behind falls back to the upstream", () => {
  const git = parseGitState(STATUS.replace(/--base[\s\S]*$/, ""));
  assert.equal(git.base, null);
  assert.deepEqual([git.ahead, git.behind, git.against], [2, 1, "origin/r2d2/CHA-4305-header-git-state"]);
  assert.equal(branchHover(git), "r2d2/CHA-4305-header-git-state (against origin/r2d2/CHA-4305-header-git-state)");
});

test("detached heads, missing bases and non-git output degrade to nulls", () => {
  const detached = parseGitState("# branch.oid abc\n# branch.head (detached)\n");
  assert.equal(detached.branch, null);
  assert.equal(detached.ahead, null);
  assert.equal(detached.added, null);
  assert.equal(aheadBehind(detached), null);
  assert.equal(uncommitted(detached), null);
  assert.equal(parseGitState("fatal: not a git repository"), null);
  assert.equal(parseGitState(""), null);
  assert.equal(parseShortstat(""), null);
  assert.deepEqual(parseShortstat(" 1 file changed, 1 insertion(+)"), { added: 1, removed: 0 });
  assert.deepEqual(parseShortstat(" 1 file changed, 4 deletions(-)"), { added: 0, removed: 4 });
});

test("pull request checks: failing beats pending beats passing; none is null", () => {
  assert.equal(checksOf([]), null);
  assert.equal(checksOf(null), null);
  assert.equal(checksOf([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "passing");
  assert.equal(checksOf([{ status: "COMPLETED", conclusion: "SKIPPED" }, { status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(checksOf([{ state: "PENDING" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
  assert.equal(checksOf([{ state: "ERROR" }]), "failing");
});

test("gh pr view output becomes a compact pull request, and junk becomes null", () => {
  assert.deepEqual(parsePr(JSON.stringify({ number: 36, url: "https://github.com/o/r/pull/36", state: "OPEN", isDraft: false,
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] })),
  { number: 36, url: "https://github.com/o/r/pull/36", state: "OPEN", draft: false, checks: "passing" });
  assert.equal(parsePr("no pull requests found for branch"), null);
  assert.equal(parsePr(JSON.stringify({ number: 0 })), null);
});

test("the header shows status, priority, delegate before assignee, PR and checks, and lines; empty fields are left out", () => {
  const issue = { state: { name: "In Progress" }, priority: 2, assignee: "Eric", delegate: { name: "R2-D2" } };
  const pr = { number: 36, state: "OPEN", draft: false, checks: "failing" };
  assert.deepEqual(headerParts(issue, { added: 40, removed: 2 }, pr),
    ["In Progress", "High", "R2-D2", "PR #36 checks failing", "+40 −2"]);
  assert.deepEqual(headerParts({ state: { name: "Todo" }, priority: 0, assignee: "" }, null, null), ["Todo"]);
  assert.deepEqual(headerParts({ state: { name: "Todo" }, assignee: "Eric" }, { added: 0, removed: 0 }, null), ["Todo", "Eric"]);
  assert.deepEqual(headerParts({ state: { name: "Done" } }, null, { number: 9, state: "MERGED", checks: "passing" }), ["Done", "PR #9 merged"]);
  assert.deepEqual(headerParts({ state: { name: "In Review" } }, null, { number: 9, state: "OPEN", draft: true, checks: null }), ["In Review", "PR #9 draft"]);
  assert.deepEqual(headerParts(null), []);
});

test("status bar fields: ahead/behind, uncommitted, running time and branch hover", () => {
  assert.equal(aheadBehind({ ahead: 2, behind: 1 }), "↑2 ↓1");
  assert.equal(aheadBehind({ ahead: 0, behind: 3 }), "↓3");
  assert.equal(aheadBehind({ ahead: 0, behind: 0 }), null);
  assert.equal(uncommitted({ changed: 3 }), "3 uncommitted");
  assert.equal(uncommitted({ changed: 0 }), null);
  const now = 10_000_000;
  assert.equal(workingSince({ tabs: [{ working_since: null }, { working_since: now - 90_000 }, { working_since: now - 30_000 }] }), now - 90_000);
  assert.equal(workingSince({ tabs: [{ working_since: null }] }), null);
  assert.equal(runningFor(null, now), null);
  assert.equal(runningFor(now - 30_000, now), "<1m");
  assert.equal(runningFor(now - 12 * 60_000, now), "12m");
  assert.equal(runningFor(now - 125 * 60_000, now), "2h 5m");
  assert.equal(runningFor(now - 26 * 3_600_000, now), "1d 2h");
  assert.equal(branchHover(null, "main"), "main");
  assert.equal(branchHover(null, null), null);
});

test("reads go to the space's machine and never throw", async () => {
  const calls = [];
  const exec = async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: STATUS, stderr: "" }; };
  const git = await readGitState(exec, "/home/build/code/repo", "build-2");
  assert.equal(git.ahead, 5);
  assert.deepEqual(calls[0].options, { cwd: "/home/build/code/repo", on: "build-2" });
  assert.equal(calls[0].command, "sh");
  assert.equal(await readGitState(exec, ""), null);
  const failing = async () => { throw new Error("machine unreachable"); };
  assert.equal(await readGitState(failing, "/repo", "remote"), null);
  assert.equal(await readPr(failing, "/repo", "remote"), null);
  assert.equal(await readPr(async () => ({ code: 1, stdout: "", stderr: "no pull requests found" }), "/repo"), null);
  const prCalls = [];
  await readPr(async (command, args, options) => { prCalls.push({ command, args, options }); return { code: 0, stdout: "{}", stderr: "" }; }, "/repo", "remote");
  assert.equal(prCalls[0].command, "gh");
  assert.deepEqual(prCalls[0].options, { cwd: "/repo", on: "remote" });
});

test("a read that never answers times out as null, so the next cycle can try again", async () => {
  const hung = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await readGitState(hung, "/repo", "remote", 30), null);
  assert.equal(await readPr(hung, "/repo", "remote", 30), null);
  assert.ok(Date.now() - started < 2000);
  // A read that answers in time is unaffected by the limit.
  const quick = async () => ({ code: 0, stdout: STATUS, stderr: "" });
  assert.equal((await readGitState(quick, "/repo", null, 1000)).ahead, 5);
});

const hasGit = spawnSync("git", ["--version"]).status === 0;
test("the git script reads a real worktree: ahead/behind main, uncommitted and lines since base", { skip: !hasGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), "board-git-"));
  try {
    const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    const origin = join(dir, "origin.git"), work = join(dir, "work");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, work);
    git(work, "checkout", "-q", "-b", "main");
    writeFileSync(join(work, "a.txt"), "one\n");
    git(work, "add", "a.txt");
    git(work, "commit", "-q", "-m", "base");
    git(work, "push", "-q", "-u", "origin", "main");
    git(work, "checkout", "-q", "-b", "feature");
    writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
    git(work, "commit", "-q", "-am", "work");
    // Pushed, so level with its own upstream; main then moves on without it.
    git(work, "push", "-q", "-u", "origin", "feature");
    git(work, "checkout", "-q", "main");
    writeFileSync(join(work, "c.txt"), "main\n");
    git(work, "add", "c.txt");
    git(work, "commit", "-q", "-m", "main moves");
    git(work, "push", "-q", "origin", "main");
    git(work, "checkout", "-q", "feature");
    writeFileSync(join(work, "a.txt"), "one\ntwo\n");
    writeFileSync(join(work, "b.txt"), "new\n");
    const out = execFileSync("sh", ["-c", GIT_SCRIPT], { cwd: work, encoding: "utf8" });
    const state = parseGitState(out);
    assert.equal(state.branch, "feature");
    assert.equal(state.upstream, "origin/feature");
    assert.equal(state.base, "origin/main");
    assert.equal(state.against, "origin/main");
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 1, "behind main, though level with its own upstream");
    assert.equal(state.changed, 2, "one modified file and one untracked file");
    assert.deepEqual({ added: state.added, removed: state.removed }, { added: 1, removed: 0 });
    const outside = spawnSync("sh", ["-c", GIT_SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.notEqual(outside.status, 0, "a folder outside git reports failure, not an empty state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

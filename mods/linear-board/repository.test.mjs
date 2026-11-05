import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath, stat, symlink, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const source = await readFile(new URL("./repository.js", import.meta.url), "utf8");
async function harness(options = {}) {
  const calls = [];
  const context = vm.createContext({ console: options.console ?? console });
  const api = {
    machines: () => options.machines ?? [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
    knownAgents: options.agents ?? (async () => [{ key: "codex", installed: true }]),
    exec: async (command, args, config) => {
      calls.push({ command, args, config });
      if (options.exec) return options.exec(command, args, config);
      // Do not inherit the runner's XDG/plugin paths into the target-home fixture.
      const result = await run(command, args, { env: { PATH: options.path ?? process.env.PATH, HOME: options.home, ...options.env } }).then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
      return result;
    },
  };
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => new vm.SyntheticModule(Object.keys(api), function () { for (const [key, value] of Object.entries(api)) this.setExport(key, value); }, { context }));
  await module.evaluate();
  return { ...module.namespace, calls };
}
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdr-repository-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("discovers only existing Git repos in target HOME/code, preserves spaces and Unicode and .git files", async t => {
  const home = await fixture(t), root = join(home, "code");
  await mkdir(root);
  const repo = join(root, "café repo ' $literal");
  await run("git", ["init", repo]);
  await run("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test"]);
  const worktree = join(root, "工作 tree");
  await run("git", ["-C", repo, "worktree", "add", "-b", "fixture", worktree]);
  await mkdir(join(root, "not git"));
  await mkdir(join(root, "broken"));
  await writeFile(join(root, "broken", ".git"), "gitdir: /nonexistent/herdr-fixture");
  const h = await harness({ home });
  const result = await h.discoverRepositories("remote");
  assert.equal(result.root, root);
  assert.deepEqual(Array.from(result.repositories, r => r.name).sort(), ["café repo ' $literal", "工作 tree"].sort());
  for (const folder of [repo, worktree]) assert.equal(await h.validateRepository({ machine: "remote", folder }), folder);
  assert.ok(h.calls.every(c => c.config.on === "remote"));
  await assert.rejects(h.validateRepository({ machine: "remote", folder: join(root, "not git") }), /Not a Git repository/);
  await assert.rejects(h.validateRepository({ machine: "remote", folder: join(root, "broken") }), /Invalid Git repository/);
  await assert.rejects(h.validateRepository({ machine: "remote", folder: join(root, "missing") }), /does not exist/);
});

test("discovery marks blank repositories that Start made, not real ones (CHA-4309)", async t => {
  const home = await fixture(t), root = join(home, "code");
  await mkdir(root);
  const git = (repo, ...args) => run("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]);
  const blank = join(root, "blank-ticket"), files = join(root, "with-files"), remote = join(root, "with-remote"), history = join(root, "with-history");
  for (const repo of [blank, files, remote, history]) { await run("git", ["init", "-q", repo]); }
  await git(blank, "commit", "-q", "--allow-empty", "-m", "Initial commit");
  await git(blank, "branch", "work/ticket");
  await writeFile(join(files, "README.md"), "real\n");
  await git(files, "add", "README.md"); await git(files, "commit", "-q", "-m", "readme");
  await git(remote, "commit", "-q", "--allow-empty", "-m", "Initial commit");
  await git(remote, "remote", "add", "origin", "https://example.invalid/repo.git");
  await git(history, "commit", "-q", "--allow-empty", "-m", "one"); await git(history, "commit", "-q", "--allow-empty", "-m", "two");
  const h = await harness({ home });
  const found = Object.fromEntries((await h.discoverRepositories(null)).repositories.map(r => [r.name, r]));
  assert.deepEqual({ ...found["blank-ticket"] }, { folder: blank, name: "blank-ticket", blank: true });
  for (const name of ["with-files", "with-remote", "with-history"]) assert.equal(found[name].blank, undefined, name);
});

test("a blank repository is never inferred, even when the project or a sibling points at it (CHA-4309)", async () => {
  const h = await harness();
  const real = { name: "erics-herdr-linear", folder: "/c/erics-herdr-linear" };
  const blank = { name: "barnyard-decide-and-authorize-gps-metadata-remed", folder: "/c/barnyard-decide-and-authorize-gps-metadata-remed", blank: true };
  assert.equal(h.inferRepository([real, blank], { projectFolder: blank.folder, siblings: [{ folder: blank.folder, title: "Search Linear too" }], projectName: "Eric's Herdr Linear" }), real);
  assert.equal(h.inferRepository([blank], { projectFolder: blank.folder, text: "`barnyard-decide-and-authorize-gps-metadata-remed`" }), null);
});

test("missing code root and empty root are distinct, neither creates directories", async t => {
  const home = await fixture(t), h = await harness({ home });
  await assert.rejects(h.discoverRepositories(null), /Repository root is missing/);
  await assert.rejects(readFile(join(home, "code")), /ENOENT/);
  await mkdir(join(home, "code"));
  assert.equal((await h.discoverRepositories(null)).repositories.length, 0);
  assert.ok(h.calls.every(c => c.config.on === null));
});

test("an existing ticket's repository is inferred from its project, siblings or text, never guessed (CHA-4309)", async () => {
  const h = await harness();
  const real = { name: "erics-herdr-linear", folder: "/Users/me/code/erics-herdr-linear" };
  const blank = { name: "sidebar-rows-show-the-ticket-title-first-project", folder: "/Users/me/code/sidebar-rows-show-the-ticket-title-first-project" };
  const other = { name: "holonet", folder: "/Users/me/code/holonet" };
  const repos = [real, blank, other];
  // 1. The project's remembered repository wins, when it is on this computer.
  assert.equal(h.inferRepository(repos, { projectFolder: other.folder, projectName: "Eric's Herdr Linear" }), other);
  assert.equal(h.inferRepository(repos, { projectFolder: "/gone", projectName: "Eric's Herdr Linear" }), real);
  // 2. Sibling tickets vote; a blank repository Start made for a sibling is no evidence.
  const sibling = (folder, title = "Another ticket") => ({ folder, title });
  assert.equal(h.inferRepository(repos, { siblings: [sibling(real.folder), sibling(real.folder), sibling(other.folder)] }), real);
  assert.equal(h.inferRepository(repos, { siblings: [sibling(blank.folder, "Sidebar rows: show the ticket title first, project second")] }), null);
  assert.equal(h.inferRepository(repos, { siblings: [sibling(`${blank.folder}`, "Sidebar rows: show the ticket title first, project second"), sibling(other.folder)] }), other);
  assert.equal(h.inferRepository(repos, { siblings: [sibling(real.folder), sibling(other.folder)] }), null, "a tie is not a choice");
  assert.equal(h.inferRepository(repos, { siblings: [sibling("/elsewhere/repo")] }), null);
  // 3. The ticket's text names one repository: a ~/code path, a GitHub link or a code span.
  assert.equal(h.inferRepository(repos, { text: "The real code lives in `~/code/erics-herdr-linear`." }), real);
  assert.equal(h.inferRepository(repos, { text: "Repo: [https://github.com/EricGrill/erics-herdr-linear](<https://github.com/EricGrill/erics-herdr-linear>)" }), real);
  assert.equal(h.inferRepository(repos, { text: "See /Users/me/code/holonet/docs." }), other);
  assert.equal(h.inferRepository(repos, { text: "Touches `holonet` and `erics-herdr-linear`." }), null, "two named repositories are ambiguous");
  assert.equal(h.inferRepository(repos, { text: "holonet is a word here, not a repository reference" }), null);
  // 4. The project's name, ignoring case and punctuation.
  assert.equal(h.inferRepository(repos, { projectName: "Eric's Herdr Linear" }), real);
  assert.equal(h.inferRepository(repos, { projectName: "Pawgress" }), null);
  // Nothing to go on: Start makes a new repository (CHA-4245).
  assert.equal(h.inferRepository(repos, {}), null);
  assert.equal(h.inferRepository([], { projectName: "Eric's Herdr Linear", text: "~/code/erics-herdr-linear" }), null);
});

test("a repository Start made for a ticket is recognised by its title slug", async () => {
  const h = await harness();
  assert.equal(h.madeForTicket("/Users/me/code/research-newly-starred-repos", "Research newly starred repos"), true);
  assert.equal(h.madeForTicket("/Users/me/code/research-newly-starred-repos-2", "Research newly starred repos"), true);
  assert.equal(h.madeForTicket("/Users/me/code/erics-herdr-linear", "Research newly starred repos"), false);
});

test("unavailable/unknown computers never run local commands", async () => {
  const h = await harness({ machines: [{ name: "remote", layout: "unavailable" }] });
  await assert.rejects(h.discoverRepositories("remote"), /unavailable/);
  await assert.rejects(h.validateRepository({ machine: "unknown", folder: "/repo" }), /unavailable/);
  assert.equal(h.calls.length, 0);
});

test("preselection requires one existing match, does not guess from a path basename", async () => {
  const h = await harness(), repos = [{ name: "one", folder: "/home/code/one" }, { name: "two", folder: "/home/code/two" }];
  assert.equal(h.matchingRepository(repos, ["ONE"]), repos[0]);
  assert.equal(h.matchingRepository(repos, ["missing"]), null);
  assert.equal(h.matchingRepository(repos, ["one", "two"]), null);
  assert.equal(h.matchingRepository(repos, ["/worktrees/one"]), null);
});

const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
for (const lateFailure of [false, true]) test(`computer changes discard stale repository AND agent ${lateFailure ? "errors" : "results"}`, async () => {
  const oldRepos = deferred(), oldAgents = deferred();
  const h = await harness({
    exec: async (_command, _args, { on }) => on === "remote" ? oldRepos.promise : { code: 0, stdout: "/local/code\0/local/code/local repo\0", stderr: "" },
    agents: async ({ on }) => on === "remote" ? oldAgents.promise : [{ key: "local-agent", installed: true }],
  });
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } }, view = {};
  h.loadTarget(view, cx, "remote", { hints: ["remote repo"] });
  h.loadTarget(view, cx, null, { hints: ["local repo"] });
  assert.equal(view.launchTarget.folder, "");
  assert.equal(view.agentKey, "");
  assert.equal(view.agentsChecked, false);
  await jobs[1];
  if (lateFailure) { oldRepos.reject(new Error("offline")); oldAgents.reject(new Error("offline")); }
  else { oldRepos.resolve({ code: 0, stdout: "/remote/code\0/remote/code/remote repo\0", stderr: "" }); oldAgents.resolve([{ key: "remote-agent", installed: true }]); }
  await jobs[0];
  assert.equal(view.launchTarget.machine, null);
  assert.equal(view.launchTarget.folder, "/local/code/local repo");
  assert.equal(view.agentKey, "local-agent");
  assert.equal(view.repositoryError, "");
  assert.equal(view.launchError, "");
});

test("persisted target is revalidated and missing target stays unselected", async () => {
  const h = await harness({ exec: async (_cmd, args) => args.length === 3 ? { code: 0, stdout: "/remote/code\0/remote/code/one\0", stderr: "" } : { code: 1, stdout: "", stderr: "Repository does not exist" } });
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } }, view = {};
  h.loadTarget(view, cx, "remote", { retain: { folder: "/remote/code/missing" } });
  await jobs[0];
  assert.equal(view.launchTarget.folder, "");
  assert.match(view.repositoryError, /does not exist/);
});

for (const folder of ["/local/code/two", "/local/code/missing"]) test(`project mapping takes precedence over name and source hints: ${folder}`, async () => {
  const h = await harness({ exec: async () => ({ code: 0, stdout: "/local/code\0/local/code/one\0/local/code/two\0", stderr: "" }) });
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } }, view = {};
  h.loadTarget(view, cx, null, { preferredFolder: folder, hints: ["one"] });
  await jobs[0];
  assert.equal(view.launchTarget.folder, folder.endsWith("missing") ? "" : folder);
  if (folder.endsWith("missing")) {
    assert.match(view.repositoryError, /saved repository.*unavailable/i);
    assert.equal(view.repositories.length, 2, "another repository can still be chosen");
  }
});

test("an explicit ticket target takes precedence over a project mapping", async () => {
  const h = await harness({ exec: async () => ({ code: 0, stdout: "/local/code\0/local/code/one\0/local/code/two\0", stderr: "" }) });
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } }, view = {};
  h.loadTarget(view, cx, null, { preferredFolder: "/local/code/two", retain: { folder: "/local/code/one" } });
  await jobs[0];
  assert.equal(view.launchTarget.folder, "/local/code/one");
});

test("changing projects discards an earlier discovery on the same computer", async () => {
  const old = deferred();
  let calls = 0;
  const reply = { code: 0, stdout: "/local/code\0/local/code/one\0/local/code/two\0", stderr: "" };
  const h = await harness({ exec: async () => ++calls === 1 ? old.promise : reply });
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } }, view = {};
  h.loadTarget(view, cx, null, { preferredFolder: "/local/code/one" });
  h.loadTarget(view, cx, null, { preferredFolder: "/local/code/two" });
  await jobs[1];
  old.resolve(reply);
  await jobs[0];
  assert.equal(view.launchTarget.folder, "/local/code/two");
});

for (const [repos, workspace, blocked] of [
  [{ CHA: "/other/repo" }, "example", false],
  [{ "": "/other/repo" }, "example", true],
  [{ "EXAMPLE/": "/other/repo" }, "example", true],
  [{ "different/": "/other/repo" }, "example", false],
  [{ "": "/other/repo", "example/": "" }, "example", false],
]) test(`worktree routing guard checks effective empty-team mapping ${JSON.stringify(repos)}`, async () => {
  const h = await harness({ exec: async () => ({ code: 0, stdout: JSON.stringify({ repos }), stderr: "" }) });
  const result = h.validateWorktreeRouting({ machine: "remote", folder: "/selected/repo" }, workspace);
  if (blocked) await assert.rejects(result, /Cannot honor the selected repository/);
  else await result;
  assert.equal(h.calls[0].config.on, "remote");
});

test("worktree configuration is read from target environment and malformed config fails closed", async t => {
  const home = await fixture(t), config = join(home, ".config/herdr/plugins/config/herdr-linear");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "config.json"), JSON.stringify({ repos: { "": "/unexpected" } }));
  const h = await harness({ home });
  await assert.rejects(h.validateWorktreeRouting({ machine: null, folder: "/selected" }, "example"), /Cannot honor/);
  await writeFile(join(config, "config.json"), "{");
  await assert.rejects(h.validateWorktreeRouting({ machine: null, folder: "/selected" }, "example"), /invalid JSON/);
});


test("explicit repository choice cancels pending ticket restoration without dropping same-computer agents", async () => {
  const h = await harness();
  const view = { targetGeneration: 7, launchTarget: { machine: "remote", folder: "/remote/code/old" },
    repoRoot: "/remote/code", agentChoices: [{ key: "codex", installed: true }], agentKey: "codex", agentsChecked: true };
  let notified = false;
  h.selectRepository(view, { folder: "/remote/code/explicit", name: "explicit" }, { notify() { notified = true; } });
  assert.equal(view.targetGeneration, 8);
  assert.equal(view.launchTarget.machine, "remote");
  assert.equal(view.launchTarget.folder, "/remote/code/explicit");
  assert.equal(view.agentKey, "codex");
  assert.equal(view.agentChoices.length, 1);
  assert.equal(view.agentsChecked, true);
  assert.equal(notified, true);
});


test("ambiguous repository paths are rejected before the trimming backend can select a sibling", async t => {
  const home = await fixture(t), root = join(home, "code");
  await mkdir(root);
  const h = await harness({ home });
  for (const name of ["trailing ", "line\nbreak"]) {
    const folder = join(root, name);
    await run("git", ["init", folder]);
    await assert.rejects(h.validateRepository({ machine: null, folder }), /unambiguous path/);
  }
});

async function identity(home) {
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
}

test("new repository names are lowercase ASCII words and never empty", async () => {
  const { repositorySlug } = await harness();
  assert.equal(repositorySlug("Café: Fix the  Login/Logout flow!"), "cafe-fix-the-login-logout-flow");
  assert.equal(repositorySlug("../../etc"), "etc");
  assert.equal(repositorySlug("空間"), "new-repository");
  assert.equal(repositorySlug("a".repeat(60)).length, 48);
});

test("creates a committed repository in target HOME/code, making the root, and never reuses a path", async t => {
  const home = await fixture(t);
  await identity(home);
  const { createRepository, validateRepository } = await harness({ home });
  const first = await createRepository({ machine: null, folder: "" }, "Build the thing");
  assert.equal(first.folder, join(home, "code", "build-the-thing"));
  assert.equal(first.name, "build-the-thing");
  assert.equal(first.root, join(home, "code"));
  assert.equal(await validateRepository(first), first.folder);
  const log = await run("git", ["-C", first.folder, "log", "--format=%s"]);
  assert.equal(log.stdout.trim(), "Initial commit");
  await writeFile(join(home, "code", "build-the-thing-2"), "taken");
  const second = await createRepository({ machine: null, folder: "" }, "Build the thing");
  assert.equal(second.folder, join(home, "code", "build-the-thing-3"));
});

test("a failed new repository removes only the folder it made", async t => {
  const home = await fixture(t), bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\necho 'Author identity unknown' >&2\nexit 1\n", { mode: 0o755 });
  await mkdir(join(home, "code", "keep"), { recursive: true });
  const { createRepository } = await harness({ home, path: `${bin}:${process.env.PATH}` });
  await assert.rejects(createRepository({ machine: null, folder: "" }, "keep"), /Could not create a new Git repository in .*keep-2: Author identity unknown/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(home, "code")), ["keep"]);
});

test("new repositories are never made on an unavailable computer", async () => {
  const { createRepository, calls } = await harness({ machines: [{ name: null, layout: "ready" }, { name: "remote", layout: "connecting" }] });
  await assert.rejects(createRepository({ machine: "remote", folder: "" }, "x"), /remote is connecting/);
  assert.deepEqual(calls, []);
});


async function freshBranchFixture(t) {
  const home = await fixture(t), folder = join(home, "new repo café ' literal");
  await run("git", ["-c", "init.defaultBranch=main", "init", folder]);
  await run("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial commit"]);
  const h = await harness({ home });
  return { h, home, target: { machine: "remote", folder } };
}

for (const base of [undefined, null, "", "release/stable"]) test(`CHA-4248: routing exposes configured base ${JSON.stringify(base)}`, async () => {
  const h = await harness({ exec: async () => ({ code: 0, stdout: JSON.stringify({ base }), stderr: "" }) });
  assert.equal(await h.validateWorktreeRouting({ machine: "remote", folder: "/selected" }, "example"), base ?? "");
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

for (const base of [42, false, [], {}]) test(`CHA-4248: malformed configured base ${JSON.stringify(base)} fails closed`, async () => {
  const h = await harness({ exec: async () => ({ code: 0, stdout: JSON.stringify({ base }), stderr: "" }) });
  await assert.rejects(h.validateWorktreeRouting({ machine: "remote", folder: "/selected" }, "example"), /base|string|configuration/i);
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

test("CHA-4248: a main-only repository with no origin can open its prepared issue worktree", async t => {
  const { h, home, target } = await freshBranchFixture(t), branch = "fixture/cha-4248";
  const initial = (await run("git", ["-C", target.folder, "rev-parse", "HEAD"])).stdout.trim();
  await h.prepareWorktreeBranch(target, branch);
  assert.equal((await run("git", ["-C", target.folder, "rev-parse", branch])).stdout.trim(), initial);
  assert.equal((await run("git", ["-C", target.folder, "branch", "--show-current"])).stdout.trim(), "main");
  assert.equal((await run("git", ["-C", target.folder, "remote"])).stdout.trim(), "");
  await assert.rejects(run("git", ["-C", target.folder, "config", "--get", `branch.${branch}.remote`]));
  const worktree = join(home, "opened worktree");
  await run("git", ["-C", target.folder, "worktree", "add", worktree, branch]);
  assert.equal((await run("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim(), branch);
  assert.ok(h.calls.every(c => c.config.on === "remote"), "all preparation executes on the selected target");
});

test("CHA-4248: repositories with origin retain upstream base selection", async t => {
  const { h, home, target } = await freshBranchFixture(t), branch = "fixture/cha-4248";
  await run("git", ["-C", target.folder, "remote", "add", "origin", join(home, "not-contacted.git")]);
  await h.prepareWorktreeBranch(target, branch);
  await assert.rejects(run("git", ["-C", target.folder, "show-ref", "--verify", `refs/heads/${branch}`]));
  assert.equal((await run("git", ["-C", target.folder, "branch", "--show-current"])).stdout.trim(), "main");
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

test("CHA-4248: explicit configured base is respected without creating a local issue branch", async t => {
  const { h, target } = await freshBranchFixture(t), branch = "fixture/cha-4248";
  await h.prepareWorktreeBranch(target, branch, "custom/base");
  assert.deepEqual(h.calls, [], "configured-base handling needs no fallback command");
  await assert.rejects(run("git", ["-C", target.folder, "show-ref", "--verify", `refs/heads/${branch}`]));
});

test("CHA-4248: an existing issue branch is never reset to the newer HEAD", async t => {
  const { h, target } = await freshBranchFixture(t), branch = "fixture/cha-4248";
  await run("git", ["-C", target.folder, "branch", branch]);
  const saved = (await run("git", ["-C", target.folder, "rev-parse", branch])).stdout.trim();
  await run("git", ["-C", target.folder, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "new main commit"]);
  assert.notEqual((await run("git", ["-C", target.folder, "rev-parse", "HEAD"])).stdout.trim(), saved);
  await h.prepareWorktreeBranch(target, branch);
  assert.equal((await run("git", ["-C", target.folder, "rev-parse", branch])).stdout.trim(), saved);
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

test("CHA-4248: unavailable branch targets never fall back to local execution", async () => {
  const h = await harness({ machines: [{ name: null, layout: "ready" }, { name: "remote", layout: "unavailable" }] });
  await assert.rejects(h.prepareWorktreeBranch({ machine: "remote", folder: "/remote/repo" }, "fixture/cha-4248"), /unavailable/);
  assert.deepEqual(h.calls, []);
});

for (const branch of ["bad..branch", "--all"]) test(`CHA-4248: invalid issue branch ${branch} cannot mutate refs`, async t => {
  const { h, target } = await freshBranchFixture(t);
  const before = (await run("git", ["-C", target.folder, "show-ref"])).stdout;
  await assert.rejects(h.prepareWorktreeBranch(target, branch), /branch|ref/i);
  assert.equal((await run("git", ["-C", target.folder, "show-ref"])).stdout, before);
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

test("CHA-4248: a repository without HEAD reports an actionable branch-preparation error", async t => {
  const home = await fixture(t), folder = join(home, "unborn");
  await run("git", ["init", folder]);
  const h = await harness({ home });
  await assert.rejects(h.prepareWorktreeBranch({ machine: "remote", folder }, "fixture/cha-4248"), /HEAD|commit|branch/i);
  await assert.rejects(run("git", ["-C", folder, "show-ref", "--verify", "refs/heads/fixture/cha-4248"]));
  assert.ok(h.calls.every(c => c.config.on === "remote"));
});

// Claude Code trust for repositories Start makes (CHA-4293).
function logs() { const lines = []; return { lines, console: { log: (...a) => lines.push(a.join(" ")) } }; }
const CLAUDE_DEFAULT_KEYS = ["allowedTools", "mcpContextUris", "mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "hasTrustDialogAccepted"];

test("a new repository is marked trusted in the target's Claude Code config, keeping everything else", async t => {
  const home = await fixture(t);
  await identity(home);
  const config = join(home, ".claude.json");
  const before = { numStartups: 7, oauthAccount: { emailAddress: "fixture@example.invalid" }, projects: { "/elsewhere": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] } } };
  await writeFile(config, JSON.stringify(before), { mode: 0o600 });
  const log = logs();
  const { createRepository, calls } = await harness({ home, console: log.console });
  const repo = await createRepository({ machine: "remote", folder: "" }, "Trust me");
  assert.equal(repo.claudeTrust, "trusted");
  assert.ok(calls.every(c => c.config.on === "remote"));
  const after = JSON.parse(await readFile(config, "utf8"));
  assert.deepEqual(after.projects[repo.folder], { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true });
  assert.deepEqual(Object.keys(after.projects[repo.folder]), CLAUDE_DEFAULT_KEYS);
  assert.deepEqual({ ...after, projects: { "/elsewhere": after.projects["/elsewhere"] } }, before);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(home)).filter(n => n.startsWith(".claude.json.")), []);
  assert.deepEqual(log.lines, []);
});

test("trusting keeps an existing project entry's fields and is a no-op when already trusted", async t => {
  const home = await fixture(t), folder = join(home, "code", "x");
  const config = join(home, ".claude.json");
  await writeFile(config, JSON.stringify({ projects: { [folder]: { allowedTools: ["Read"], hasTrustDialogAccepted: false, lastCost: 1.5 } } }));
  const { trustForClaude } = await harness({ home });
  assert.equal(await trustForClaude(null, folder), "trusted");
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).projects[folder], { allowedTools: ["Read"], hasTrustDialogAccepted: true, lastCost: 1.5 });
  const { mtimeMs } = await stat(config);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await trustForClaude(null, folder), "trusted");
  assert.equal((await stat(config)).mtimeMs, mtimeMs);
});

test("trusting follows a symlinked config and honors CLAUDE_CONFIG_DIR like Claude Code", async t => {
  const home = await fixture(t), folder = join(home, "code", "x");
  await mkdir(join(home, "dotfiles"));
  await writeFile(join(home, "dotfiles", "claude.json"), "{}");
  await symlink(join(home, "dotfiles", "claude.json"), join(home, ".claude.json"));
  const { trustForClaude } = await harness({ home });
  assert.equal(await trustForClaude(null, folder), "trusted");
  assert.ok((await lstat(join(home, ".claude.json"))).isSymbolicLink());
  assert.equal(JSON.parse(await readFile(join(home, "dotfiles", "claude.json"), "utf8")).projects[folder].hasTrustDialogAccepted, true);

  const dir = join(home, "custom-claude");
  await mkdir(dir);
  await writeFile(join(dir, ".claude.json"), "{}");
  const custom = await harness({ home, env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(await custom.trustForClaude(null, folder + "2"), "trusted");
  assert.equal(JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")).projects[folder + "2"].hasTrustDialogAccepted, true);
  assert.equal(JSON.parse(await readFile(join(home, "dotfiles", "claude.json"), "utf8")).projects[folder + "2"], undefined);
});

test("a missing, invalid or odd Claude config is left alone and never fails the new repository", async t => {
  const home = await fixture(t);
  await identity(home);
  const log = logs();
  const { createRepository } = await harness({ home, console: log.console });
  const repo = await createRepository({ machine: null, folder: "" }, "No claude");
  assert.equal(repo.claudeTrust, "skipped");
  assert.equal(repo.folder, join(home, "code", "no-claude"));
  await assert.rejects(stat(join(home, ".claude.json")));
  assert.match(log.lines.join("\n"), /Skipped marking .*no-claude trusted for Claude Code on this computer: no Claude Code config/);

  const { trustForClaude } = await harness({ home, console: log.console });
  for (const text of ["{ not json", "[]", JSON.stringify({ projects: [] })]) {
    await writeFile(join(home, ".claude.json"), text);
    assert.equal(await trustForClaude(null, repo.folder), "skipped");
    assert.equal(await readFile(join(home, ".claude.json"), "utf8"), text);
  }
});

test("a computer without python3 still gets its new repository", async t => {
  const home = await fixture(t);
  await identity(home);
  const log = logs();
  const { createRepository } = await harness({ home, console: log.console, exec: async (command, args) => {
    if (command === "python3") throw new Error("spawn python3 ENOENT");
    return run(command, args, { env: { PATH: process.env.PATH, HOME: home } }).then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
  } });
  const repo = await createRepository({ machine: null, folder: "" }, "No python");
  assert.equal(repo.claudeTrust, "skipped");
  assert.match(log.lines.join("\n"), /ENOENT/);
});

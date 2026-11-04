import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const source = await readFile(new URL("./repository.js", import.meta.url), "utf8");
async function harness(options = {}) {
  const calls = [];
  const context = vm.createContext({ console });
  const api = {
    machines: () => options.machines ?? [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
    knownAgents: options.agents ?? (async () => [{ key: "codex", installed: true }]),
    exec: async (command, args, config) => {
      calls.push({ command, args, config });
      if (options.exec) return options.exec(command, args, config);
      // Do not inherit the runner's XDG/plugin paths into the target-home fixture.
      const result = await run(command, args, { env: { PATH: process.env.PATH, HOME: options.home } }).then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
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

test("missing code root and empty root are distinct, neither creates directories", async t => {
  const home = await fixture(t), h = await harness({ home });
  await assert.rejects(h.discoverRepositories(null), /Repository root is missing/);
  await assert.rejects(readFile(join(home, "code")), /ENOENT/);
  await mkdir(join(home, "code"));
  assert.equal((await h.discoverRepositories(null)).repositories.length, 0);
  assert.ok(h.calls.every(c => c.config.on === null));
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

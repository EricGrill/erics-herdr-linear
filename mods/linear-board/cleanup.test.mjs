import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishedReason, ticketFinished, cleanupCandidates, keepOpenReason, autoCloseDue, gitSummary, removable, REMOVE_WORKTREE } from "./cleanup.js";

const issue = (type, extra = {}) => ({ id: `i-${type}`, identifier: "DEMO-1", state: { type, name: type }, ...extra });
const record = (id, is, extra = {}) => ({ space: { id, active: false }, issue: is, status: "idle", pinned: false, folder: `/work/${id}`, ...extra });
const clean = { changed: 0 };

test("a space is finished when its ticket is Done or Canceled, or its pull request merged", () => {
  assert.equal(finishedReason(issue("completed")), "Done in Linear");
  assert.equal(finishedReason(issue("canceled")), "Canceled in Linear");
  assert.equal(finishedReason(issue("started"), { state: "merged" }), "PR merged");
  assert.equal(finishedReason(issue("started"), { state: "open" }), null);
  assert.equal(finishedReason(issue("started")), null);
  assert.equal(finishedReason(null), null);
});

test("only a finished ticket counts for auto-close, not a merged pull request alone", () => {
  assert.equal(ticketFinished("Done in Linear"), true);
  assert.equal(ticketFinished("Canceled in Linear"), true);
  assert.equal(ticketFinished("PR merged"), false);
});

test("candidates are the finished spaces with a ticket, in order", () => {
  const records = [record("a", issue("completed")), record("b", issue("started")), record("c", null),
    record("d", issue("started", { identifier: "DEMO-9" }))];
  const prOf = is => is.identifier === "DEMO-9" ? { state: "merged" } : null;
  assert.deepEqual(cleanupCandidates(records, prOf).map(c => [c.record.space.id, c.reason]),
    [["a", "Done in Linear"], ["d", "PR merged"]]);
});

test("a finished space stays open while it is shown, pinned, busy, unread or dirty", () => {
  const is = issue("completed");
  assert.equal(keepOpenReason(record("a", is, { space: { id: "a", active: true } }), clean), "open now");
  assert.equal(keepOpenReason(record("a", is, { pinned: true }), clean), "pinned");
  assert.equal(keepOpenReason(record("a", is, { status: "working" }), clean), "agent working");
  assert.equal(keepOpenReason(record("a", is, { status: "blocked" }), clean), "agent needs you");
  assert.equal(keepOpenReason(record("a", is), undefined), "checking git");
  assert.equal(keepOpenReason(record("a", is), { changed: 3 }), "3 uncommitted");
  assert.equal(keepOpenReason(record("a", is), clean), null);
  // Not a repository: closing the space loses nothing.
  assert.equal(keepOpenReason(record("a", is), null), null);
  // An agent that finished its run does not hold the space open.
  assert.equal(keepOpenReason(record("a", is, { status: "done" }), clean), null);
});

test("auto-close waits out the grace period from when the sidebar first saw it finished", () => {
  const done = { record: record("a", issue("completed")), reason: "Done in Linear" };
  const merged = { record: record("b", issue("started")), reason: "PR merged" };
  let r = autoCloseDue([done, merged], {}, 1000, 600000);
  assert.deepEqual(r.due, []);
  assert.deepEqual(r.seen, { a: 1000 });
  r = autoCloseDue([done, merged], r.seen, 1000 + 599999, 600000);
  assert.deepEqual(r.due, []);
  r = autoCloseDue([done, merged], r.seen, 1000 + 600000, 600000);
  assert.deepEqual(r.due.map(c => c.record.space.id), ["a"]);
  // A space that is no longer finished (reopened, closed) is forgotten.
  assert.deepEqual(autoCloseDue([], r.seen, 5000, 600000).seen, {});
});

test("a Clean up row says what its checkout holds", () => {
  assert.equal(gitSummary(undefined), "checking…");
  assert.equal(gitSummary(null), "not a git checkout");
  assert.equal(gitSummary(clean, "main"), "clean");
  assert.equal(gitSummary({ changed: 2 }, "linked"), "2 uncommitted · worktree");
});

test("only a clean linked worktree is removable", () => {
  assert.equal(removable(clean, "linked"), true);
  assert.equal(removable({ changed: 1 }, "linked"), false);
  assert.equal(removable(clean, "main"), false);
  assert.equal(removable(null, "linked"), false);
});

test("the remove script removes a clean worktree, keeps its branch, and refuses a dirty one", () => {
  const root = mkdtempSync(join(tmpdir(), "cleanup-test-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const tidy = join(root, "tidy"), messy = join(root, "messy");
    git(repo, "worktree", "add", "-q", "-b", "tidy", tidy);
    git(repo, "worktree", "add", "-q", "-b", "messy", messy);
    writeFileSync(join(messy, "edit.txt"), "unsaved");
    const remove = folder => { try { execFileSync("sh", ["-c", REMOVE_WORKTREE, "sh", folder], { stdio: "pipe" }); return true; } catch { return false; } };
    assert.equal(remove(tidy), true);
    assert.equal(existsSync(tidy), false);
    assert.match(git(repo, "branch", "--list", "tidy"), /tidy/);
    assert.equal(remove(messy), false);
    assert.equal(existsSync(join(messy, "edit.txt")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

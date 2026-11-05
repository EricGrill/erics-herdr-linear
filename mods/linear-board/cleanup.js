// Which open spaces are finished, which of those may close, and when the sidebar closes
// them by itself. Closing a space never touches its Linear ticket or its files; removing
// a worktree is plain `git worktree remove`, which refuses a checkout with uncommitted
// edits and keeps the branch, so no commit is lost. Pure, apart from the shell script.

const FINISHED = { completed: "Done in Linear", canceled: "Canceled in Linear" };

/** Why a space's work is finished: its ticket is Done or Canceled in Linear, or its pull
 *  request merged. Null while it isn't. */
export function finishedReason(issue, pr = null) {
  const type = String(issue?.state?.type ?? "").toLowerCase();
  if (FINISHED[type]) return FINISHED[type];
  if (pr?.state === "merged") return "PR merged";
  return null;
}

/** Whether the finished state comes from the ticket itself, which is what auto-close
 *  waits for. A merged pull request alone is only offered in Clean up. */
export function ticketFinished(reason) {
  return reason === FINISHED.completed || reason === FINISHED.canceled;
}

/** Every finished space, in the order given: [{ record, reason }]. `prOf(issue)` is the
 *  row's pull request, or null. */
export function cleanupCandidates(records, prOf = () => null) {
  return records.flatMap(record => {
    const reason = record.issue ? finishedReason(record.issue, prOf(record.issue)) : null;
    return reason ? [{ record, reason }] : [];
  });
}

/** Why a finished space should stay open for now, or null when it may close. `git` is
 *  its folder's state: undefined while unread, null when it isn't a repository. */
export function keepOpenReason(record, git) {
  if (record.space?.active) return "open now";
  if (record.pinned) return "pinned";
  if (record.status === "working") return "agent working";
  if (record.status === "blocked") return "agent needs you";
  if (git === undefined) return "checking git";
  if (git?.changed > 0) return `${git.changed} uncommitted`;
  return null;
}

/** The candidates auto-close may close now: ticket finished for at least `graceMs` since
 *  the sidebar first saw it finished. `seen` maps space ids to that first time; the
 *  returned `seen` keeps only spaces that are still finished. */
export function autoCloseDue(candidates, seen = {}, now = Date.now(), graceMs = 600000) {
  const next = {}, due = [];
  for (const candidate of candidates) {
    if (!ticketFinished(candidate.reason)) continue;
    const id = candidate.record.space.id;
    next[id] = seen[id] ?? now;
    if (now - next[id] >= graceMs) due.push(candidate);
  }
  return { due, seen: next };
}

/** What a Clean up row says about its checkout. */
export function gitSummary(git, kind = null) {
  if (git === undefined) return "checking…";
  if (git === null) return "not a git checkout";
  const parts = [git.changed ? `${git.changed} uncommitted` : "clean"];
  if (kind === "linked") parts.push("worktree");
  return parts.join(" · ");
}

/** Whether Clean up may remove this checkout after closing its space: a clean linked
 *  worktree only, never a repository's own checkout. */
export function removable(git, kind) {
  return kind === "linked" && Boolean(git) && !(git.changed > 0);
}

/** `sh -c REMOVE_WORKTREE sh <folder>`: removes the worktree at <folder> from its main
 *  repository. No --force, so git itself refuses a checkout with uncommitted edits. */
export const REMOVE_WORKTREE = `common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir) || exit 3
cd "$common/.." && git worktree remove "$1"`;

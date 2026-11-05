// Git and pull-request state for the active workspace's folder, for the issue header and
// the status bar. Reads go through Herdr's `exec`, which runs them on the space's own
// machine (herdr-core) when it lives elsewhere, so remote worktrees report the same way.
// Everything here is read-only: no fetch, no index refresh, no optional locks, so an
// agent's own git commands never wait on the board.

const READ = "git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false";

// One shell, one round-trip to a remote machine. Sections are split by marker lines:
// status (porcelain v2 with branch headers), the base the branch grew from, the
// ahead/behind against that base (used when the branch has no upstream) and the diff
// size since the base, uncommitted edits included.
export const GIT_SCRIPT = `${READ} status --porcelain=v2 --branch || exit 3
echo "--base"
base=$(${READ} symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
if [ -z "$base" ]; then for b in origin/main origin/master; do
  if ${READ} rev-parse -q --verify "$b" >/dev/null 2>&1; then base=$b; break; fi
done; fi
[ -n "$base" ] || exit 0
echo "$base"
echo "--ab"
${READ} rev-list --left-right --count "HEAD...$base" 2>/dev/null
echo "--diff"
mb=$(${READ} merge-base HEAD "$base" 2>/dev/null) && ${READ} diff --shortstat "$mb" 2>/dev/null
exit 0`;

const PR_FIELDS = "number,url,state,isDraft,statusCheckRollup";

const count = text => { const n = Number(text); return Number.isFinite(n) ? n : 0; };

/** Splits GIT_SCRIPT's output into its sections. */
function sections(stdout) {
  const out = { status: [], base: [], ab: [], diff: [] };
  let at = "status";
  for (const line of String(stdout ?? "").split("\n")) {
    const marker = /^--(base|ab|diff)$/.exec(line);
    if (marker) { at = marker[1]; continue; }
    if (line.trim()) out[at].push(line);
  }
  return out;
}

/** "3 files changed, 40 insertions(+), 2 deletions(-)" → { added: 40, removed: 2 }. */
export function parseShortstat(text) {
  const s = String(text ?? "");
  const added = /(\d+) insertions?\(\+\)/.exec(s), removed = /(\d+) deletions?\(-\)/.exec(s);
  if (!added && !removed) return null;
  return { added: count(added?.[1] ?? 0), removed: count(removed?.[1] ?? 0) };
}

/** GIT_SCRIPT's output → { branch, upstream, base, ahead, behind, changed, added, removed }.
 *  Pure, so it is tested without a repository. Null when it isn't a git status at all. */
export function parseGitState(stdout) {
  const s = sections(stdout);
  if (!s.status.some(l => l.startsWith("# branch."))) return null;
  let branch = null, upstream = null, ahead = null, behind = null, changed = 0;
  for (const line of s.status) {
    if (line.startsWith("# branch.head ")) { const h = line.slice(14).trim(); branch = h === "(detached)" ? null : h; }
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = count(m[1]); behind = count(m[2]); }
    } else if (/^[12u?] /.test(line)) changed++;
  }
  const base = s.base[0]?.trim() || null;
  // Without an upstream, count against the branch it grew from instead.
  if (ahead === null && base) {
    const m = /^(\d+)\s+(\d+)$/.exec(s.ab[0]?.trim() ?? "");
    if (m) { ahead = count(m[1]); behind = count(m[2]); }
  }
  const diff = parseShortstat(s.diff.join(" "));
  return { branch, upstream, base, ahead, behind, changed,
    added: diff?.added ?? null, removed: diff?.removed ?? null };
}

/** A pull request's checks in one word: "failing" beats "pending" beats "passing".
 *  Null when it has none. Accepts GitHub's check runs and commit statuses alike. */
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false, passing = 0;
  for (const c of rollup) {
    const status = String(c?.status ?? "").toUpperCase();
    const result = String(c?.conclusion ?? c?.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) return "failing";
    if ((status && status !== "COMPLETED") || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(result)) pending = true;
    else passing++;
  }
  return pending ? "pending" : passing ? "passing" : null;
}

/** `gh pr view --json` output → { number, url, state, draft, checks }, or null. */
export function parsePr(text) {
  let json;
  try { json = JSON.parse(String(text ?? "")); } catch { return null; }
  const number = Number(json?.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { number, url: json.url ? String(json.url) : null, state: String(json.state ?? "OPEN").toUpperCase(),
    draft: json.isDraft === true, checks: checksOf(json.statusCheckRollup) };
}

/** Reads the git state of `folder` on machine `on`. Never throws: null when it can't. */
export async function readGitState(exec, folder, on = null) {
  if (!folder) return null;
  try {
    const r = await exec("sh", ["-c", GIT_SCRIPT], { cwd: folder, on: on ?? null });
    return r.code === 0 ? parseGitState(r.stdout) : null;
  } catch { return null; }
}

/** The pull request for the folder's branch, via GitHub's CLI there. Null when there is
 *  none, or gh is missing or signed out on that machine. */
export async function readPr(exec, folder, on = null) {
  if (!folder) return null;
  try {
    const r = await exec("gh", ["pr", "view", "--json", PR_FIELDS], { cwd: folder, on: on ?? null });
    return r.code === 0 ? parsePr(r.stdout) : null;
  } catch { return null; }
}

// ---- What the header and status bar say -------------------------------------------------

const PRIORITY_NAMES = ["", "Urgent", "High", "Medium", "Low"];

/** The header's second line: status · priority · delegate or assignee · PR and checks ·
 *  lines added/removed. Fields with no value are left out. */
export function headerParts(issue, git = null, pr = null) {
  if (!issue) return [];
  const who = issue.delegate?.name || (typeof issue.delegate === "string" ? issue.delegate : "") || issue.assignee || "";
  const parts = [issue.state?.name, PRIORITY_NAMES[issue.priority] || "", who];
  if (pr) {
    const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "";
    const checks = pr.state === "OPEN" && pr.checks ? `checks ${pr.checks}` : "";
    parts.push([`PR #${pr.number}`, state, checks].filter(Boolean).join(" "));
  }
  if (git && (git.added || git.removed)) parts.push(`+${git.added ?? 0} −${git.removed ?? 0}`);
  return parts.filter(Boolean);
}

/** Ahead/behind as "↑2 ↓1"; null when level or unknown. */
export function aheadBehind(git) {
  if (!git || (git.ahead == null && git.behind == null)) return null;
  const parts = [git.ahead ? `↑${git.ahead}` : "", git.behind ? `↓${git.behind}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** "3 uncommitted"; null when the tree is clean or unknown. */
export function uncommitted(git) {
  return git?.changed ? `${git.changed} uncommitted` : null;
}

/** When the agent in a space started its current run: the earliest `working_since` among
 *  its tabs, or null when nothing in it is working. */
export function workingSince(space) {
  const times = (space?.tabs ?? []).map(t => t?.working_since).filter(t => typeof t === "number" && t > 0);
  return times.length ? Math.min(...times) : null;
}

/** "12m", "3h", "<1m"; matches the board's other durations. */
export function runningFor(since, now = Date.now()) {
  if (!since) return null;
  const m = Math.floor(Math.max(0, now - since) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The status bar's hover text: the full branch and what ahead/behind is counted against. */
export function branchHover(git, fallbackBranch = null) {
  const branch = git?.branch ?? fallbackBranch;
  if (!branch) return null;
  const against = git?.upstream ?? git?.base;
  return against ? `${branch} (against ${against})` : branch;
}

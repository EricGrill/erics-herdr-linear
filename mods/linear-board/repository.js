// Target-side filesystem operations. Never use local home()/pickFolder() for a remote target.
import { exec, knownAgents, machines } from "herdr";

export function computers() {
  const configured = machines().filter(m => !m.temporary);
  const local = configured.find(m => m.name == null);
  return [{ name: null, layout: local?.layout ?? "ready" }, ...configured.filter(m => m.name != null)];
}

function available(machine) {
  const computer = computers().find(m => m.name === (machine ?? null));
  if (!computer || computer.layout !== "ready") throw new Error(`${machine ?? "This computer"} is ${computer?.layout ?? "unavailable"}. Choose an available computer or reconnect it.`);
}

const LIST = `
[ -n "$HOME" ] && [ -d "$HOME" ] || { printf '%s' 'Cannot resolve this computer’s home directory.' >&2; exit 1; }
root="$(cd "$HOME" && pwd -P)/code"
[ -d "$root" ] || { printf 'Repository root is missing: %s. Choose a computer with an existing ~/code directory.' "$root" >&2; exit 1; }
printf '%s\\0' "$root"
for folder in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -d "$folder" ] || continue
  { [ -d "$folder/.git" ] || [ -f "$folder/.git" ]; } || continue
  git -C "$folder" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
  # Blank: what "New repository" makes (no remote, one commit, no files). A
  # leading "*" marks it; real paths always start with "/".
  mark=""
  if [ -z "$(git -C "$folder" remote 2>/dev/null)" ] && [ "$(git -C "$folder" rev-list --count --all 2>/dev/null)" = 1 ] \\
    && [ -z "$(git -C "$folder" ls-tree HEAD 2>/dev/null)" ]; then mark="*"; fi
  printf '%s%s\\0' "$mark" "$folder"
done`;

export async function discoverRepositories(machine) {
  available(machine);
  const result = await exec("sh", ["-c", LIST], { on: machine ?? null });
  if (result.code !== 0) throw new Error(result.stderr || `Could not read ~/code on ${machine ?? "This computer"}.`);
  const [root, ...paths] = result.stdout.split("\0").filter(Boolean);
  if (!root?.startsWith("/")) throw new Error("This computer did not return an absolute ~/code directory.");
  return { root, repositories: paths.map(path => {
    const blank = path.startsWith("*"), folder = blank ? path.slice(1) : path;
    return { folder, name: folder.slice(folder.lastIndexOf("/") + 1), ...(blank ? { blank: true } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name)) };
}

const VALIDATE = `
[ -d "$1" ] || { printf 'Repository does not exist: %s' "$1" >&2; exit 1; }
{ [ -d "$1/.git" ] || [ -f "$1/.git" ]; } || { printf 'Not a Git repository: %s' "$1" >&2; exit 1; }
git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf 'Invalid Git repository: %s' "$1" >&2; exit 1; }
git -C "$1" rev-parse --show-toplevel`;

export async function validateRepository(target) {
  if (!target?.folder?.startsWith("/")) throw new Error("Choose an existing repository on the selected computer first.");
  available(target.machine);
  const result = await exec("sh", ["-c", VALIDATE, "herdr-repository", target.folder], { on: target.machine ?? null });
  if (result.code !== 0) throw new Error(result.stderr || `Invalid repository: ${target.folder}`);
  // The pinned worktree backend trims Git output. Reject an ambiguous path
  // rather than let it open a different sibling repository after trimming.
  const top = result.stdout.replace(/\n$/, "");
  if (top.trim() !== top || /[\r\n]/.test(top)) throw new Error("The worktree backend cannot safely handle a repository path ending in whitespace or containing a newline. Choose a repository with an unambiguous path.");
  return target.folder;
}

// A folder name for a new repository: lowercase ASCII words joined by dashes.
export function repositorySlug(text) {
  const slug = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug || "new-repository";
}

// Never reuses an existing path: a taken name gets -2, -3, …. The folder is
// removed again only when this script made it and could not finish the repo.
// The empty first commit gives the worktree backend a base to branch from.
const CREATE = `
[ -n "$HOME" ] && [ -d "$HOME" ] || { printf '%s' 'Cannot resolve this computer’s home directory.' >&2; exit 1; }
root="$(cd "$HOME" && pwd -P)/code"
mkdir -p "$root" || { printf 'Cannot create the repository root: %s' "$root" >&2; exit 1; }
folder="$root/$1"; n=2
while [ -e "$folder" ] || [ -L "$folder" ]; do folder="$root/$1-$n"; n=$((n + 1)); done
mkdir "$folder" || { printf 'Cannot create %s' "$folder" >&2; exit 1; }
if ! out="$(git -C "$folder" init -q 2>&1 && git -C "$folder" commit -q --allow-empty -m "Initial commit" 2>&1)"; then
  rm -rf "$folder"
  printf 'Could not create a new Git repository in %s: %s' "$folder" "$out" >&2; exit 1
fi
printf '%s\\0%s' "$root" "$folder"`;

export async function createRepository(target, title) {
  available(target?.machine);
  const result = await exec("sh", ["-c", CREATE, "herdr-new-repository", repositorySlug(title)], { on: target.machine ?? null });
  if (result.code !== 0) throw new Error(result.stderr || `Could not create a new repository on ${target.machine ?? "This computer"}.`);
  const [root, folder] = result.stdout.split("\0");
  if (!root?.startsWith("/") || !folder?.startsWith(`${root}/`)) throw new Error("This computer did not return the new repository's path.");
  const claudeTrust = await trustForClaude(target.machine, folder);
  return { ...target, folder, name: folder.slice(folder.lastIndexOf("/") + 1), root, claudeTrust };
}

// Claude Code's folder trust stops at a Git repository's root, so a new repo
// under a trusted ~/code still asks on its first session. Start made this repo,
// so it marks only this path trusted (its worktrees inherit it). The target's
// own config is edited (same lookup as Claude: $CLAUDE_CONFIG_DIR or HOME),
// through a symlink, keeping every other field and the file mode, by atomic
// replace. Exit 3 means "skipped" (no Claude config, unreadable or invalid).
const TRUST = String.raw`
import json, os, sys, tempfile
folder = sys.argv[1]
path = os.path.realpath(os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~"), ".claude.json"))
try:
    with open(path, encoding="utf-8") as f: config = json.load(f)
except FileNotFoundError: print("no Claude Code config at " + path, file=sys.stderr); sys.exit(3)
except (OSError, ValueError) as e: print("cannot read " + path + ": " + str(e), file=sys.stderr); sys.exit(3)
if not isinstance(config, dict): print(path + " is not a JSON object", file=sys.stderr); sys.exit(3)
projects = config.get("projects")
if projects is None: projects = config["projects"] = {}
if not isinstance(projects, dict): print(path + " has an invalid projects entry", file=sys.stderr); sys.exit(3)
entry = projects.get(folder)
if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True: sys.exit(0)
if not isinstance(entry, dict):
    entry = {"allowedTools": [], "mcpContextUris": [], "mcpServers": {}, "enabledMcpjsonServers": [], "disabledMcpjsonServers": [], "hasTrustDialogAccepted": False}
entry["hasTrustDialogAccepted"] = True
projects[folder] = entry
mode = os.stat(path).st_mode & 0o7777
fd, tmp = tempfile.mkstemp(prefix=".claude.json.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, mode); os.replace(tmp, path)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
`;

// Never fails Start: an untrusted repo only means Claude asks once.
export async function trustForClaude(machine, folder) {
  try {
    const result = await exec("python3", ["-c", TRUST, folder], { on: machine ?? null });
    if (result.code === 0) return "trusted";
    const reason = String(result.stderr || `python3 exited ${result.code}`).trim().split("\n").pop();
    console.log(`Skipped marking ${folder} trusted for Claude Code on ${machine ?? "this computer"}: ${reason}`);
    return "skipped";
  } catch (e) {
    console.log(`Skipped marking ${folder} trusted for Claude Code on ${machine ?? "this computer"}: ${e?.message ?? e}`);
    return "skipped";
  }
}

export function matchingRepository(repositories, hints = []) {
  const matches = repositories.filter(r => hints.some(h => h && (r.folder === h || r.name.toLowerCase() === h.toLowerCase())));
  return matches.length === 1 ? matches[0] : null;
}

const compact = text => String(text ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

// A folder Start made for one ticket ("New repository", named for its title).
// It says nothing about where that ticket's project lives.
export function madeForTicket(folder, title) {
  const name = String(folder ?? "").slice(String(folder ?? "").lastIndexOf("/") + 1);
  const slug = repositorySlug(title);
  return name === slug || new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(name);
}

// Repositories a ticket's text points at: a path under code/ (~/code/x,
// /Users/me/code/x), a GitHub link (github.com/owner/x) or a `x` code span.
function mentioned(repositories, text) {
  const body = String(text ?? "");
  const names = new Set();
  for (const m of body.matchAll(/(?:^|[\s(`'"<\[])(?:~|\/[^\s`'"<>()]*)\/code\/([A-Za-z0-9._-]+)/g)) names.add(m[1].toLowerCase());
  for (const m of body.matchAll(/github\.com\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[\s/)>#?`'"\]]|$)/g)) names.add(m[1].toLowerCase());
  for (const m of body.matchAll(/`([A-Za-z0-9._-]+)`/g)) names.add(m[1].toLowerCase());
  return repositories.filter(r => names.has(r.name.toLowerCase()));
}

/**
 * The repository an existing ticket belongs in, or null when none can be told.
 * Start makes a new repository only for null (CHA-4245), so every rule here
 * must name exactly one non-blank repository on the chosen computer:
 *  1. the repository this computer last used for the ticket's project;
 *  2. the repository most of the project's other tickets were started in;
 *  3. exactly one repository the ticket's own text names;
 *  4. exactly one repository whose name is the project's name.
 */
export function inferRepository(repositories = [], { projectFolder = "", projectName = "", siblings = [], text = "" } = {}) {
  // A blank repository is never evidence: Start made it for one ticket, and
  // others were then started in it by mistake (CHA-4309).
  repositories = repositories.filter(r => !r.blank);
  const known = folder => repositories.find(r => r.folder === folder) ?? null;
  if (projectFolder && known(projectFolder)) return known(projectFolder);
  const votes = new Map();
  for (const s of siblings) {
    if (!s?.folder || madeForTicket(s.folder, s.title) || !known(s.folder)) continue;
    votes.set(s.folder, (votes.get(s.folder) ?? 0) + 1);
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return known(ranked[0][0]);
  const named = mentioned(repositories, text);
  if (named.length === 1) return named[0];
  const project = compact(projectName);
  const byProject = project ? repositories.filter(r => compact(r.name) === project) : [];
  return byProject.length === 1 ? byProject[0] : null;
}

// An explicit repository choice also supersedes pending ticket-target restoration.
// Completed agent discovery stays valid because the selected computer did not change.
export function selectRepository(view, repo, cx) {
  if (view.busy || view.repositoriesLoading || view.launchTarget?.blocked) return false;
  view.targetGeneration = (view.targetGeneration ?? 0) + 1;
  view.targetPicker = null;
  view.launchTarget = { machine: view.launchTarget.machine, folder: repo.folder, name: repo.name, root: view.repoRoot };
  view.repositoryError = "";
  cx.notify();
  return true;
}

// One generation covers repository AND agent discovery, including failed/late requests.
export function loadTarget(view, cx, machine, { retain = null, preferredFolder = "", hints = [], preferredAgent = "" } = {}) {
  if (view.busy) return;
  const generation = view.targetGeneration = (view.targetGeneration ?? 0) + 1;
  view.agentGeneration = (view.agentGeneration ?? 0) + 1;
  view.launchTarget = { machine: machine ?? null, folder: "" };
  view.repoRoot = ""; view.repositories = []; view.repositoryError = "";
  view.repositoriesLoading = true; view.agentChoices = []; view.agentKey = "";
  view.agentsChecked = false; view.launchError = "";
  cx.notify();
  cx.spawn(async cx => {
    const [repos, agents] = await Promise.allSettled([
      (async () => {
        const data = await discoverRepositories(machine);
        if (retain?.folder) {
          await validateRepository({ ...retain, machine });
          if (!data.repositories.some(r => r.folder === retain.folder)) data.repositories.push({ folder: retain.folder, name: retain.name || retain.folder.slice(retain.folder.lastIndexOf("/") + 1) });
        }
        return data;
      })(),
      (async () => { available(machine); return (await knownAgents({ on: machine ?? null })).filter(a => a.installed); })(),
    ]);
    if (generation !== view.targetGeneration) return;
    view.repositoriesLoading = false;
    if (repos.status === "fulfilled") {
      view.repoRoot = repos.value.root; view.repositories = repos.value.repositories;
      const folder = retain?.folder || preferredFolder;
      const selected = folder ? view.repositories.find(r => r.folder === folder) : matchingRepository(view.repositories, hints);
      view.launchTarget = { machine: machine ?? null, folder: selected?.folder ?? "", name: selected?.name ?? "", root: view.repoRoot, ...(retain?.computerId ? { computerId: retain.computerId, computerName: retain.computerName } : {}) };
      if (preferredFolder && !selected) view.repositoryError = "The project's saved repository is unavailable on this computer. Choose a repository, or Start makes a new one.";
    } else view.repositoryError = `Could not discover repositories on ${machine ?? "This computer"}: ${repos.reason?.message ?? repos.reason}`;
    view.agentsChecked = true;
    if (agents.status === "fulfilled") {
      view.agentChoices = agents.value;
      view.agentKey = agents.value.find(a => a.key === preferredAgent)?.key ?? agents.value[0]?.key ?? "";
    } else view.launchError = `Could not check agents: ${agents.reason?.message ?? agents.reason}`;
    if (view.screen === "create" && view.form?.capture && !view.form.draft?.uncertain) view.saveCapture?.(cx);
    if (repos.status === "fulfilled" && !view.launchTarget.folder) view.repositoriesLoaded?.(cx);
    cx.notify();
  });
}

// herdr-linear v0.14.2 resolves config repos before request dirs (app.go:468).
// Worktree requests use an empty team key; reject even an empty-team override
// so this compatibility path cannot substitute a different base repository.
const WORKTREE_CONFIG = `
config="\u0024{HERDR_PLUGIN_CONFIG_DIR:-\u0024{XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/\u0024{HERDR_PLUGIN_ID:-herdr-linear}}/config.json"
if [ -e "$config" ]; then cat "$config"; else printf '{}'; fi`;

export async function validateWorktreeRouting(target, workspaceKey) {
  available(target.machine);
  const result = await exec("sh", ["-c", WORKTREE_CONFIG], { on: target.machine ?? null });
  if (result.code !== 0) throw new Error("Cannot read this computer’s herdr-linear repository configuration.");
  let config;
  try { config = JSON.parse(result.stdout || "{}"); }
  catch { throw new Error("This computer’s herdr-linear config.json is invalid JSON."); }
  if (config?.base != null && typeof config.base !== "string") throw new Error("This computer’s herdr-linear base configuration is invalid.");
  const repos = config?.repos ?? {};
  if (typeof repos !== "object" || Array.isArray(repos) || Object.values(repos).some(v => v !== null && typeof v !== "string")) throw new Error("This computer’s herdr-linear repository configuration is invalid.");
  let override = repos[""];
  for (const [key, value] of Object.entries(repos)) {
    const slash = key.indexOf("/");
    if (slash >= 0 && key.slice(0, slash).toLowerCase() === (workspaceKey ?? "").toLowerCase() && key.slice(slash + 1) === "") override = value;
  }
  if (override) throw new Error("Cannot honor the selected repository: this computer’s herdr-linear config.json contains an empty-team repository override. Remove that override before starting this task.");
  return config?.base ?? "";
}

// The pinned backend defaults to origin/main even for a new, local-only repo.
// An existing issue branch avoids that missing ref without inventing an origin.
const LOCAL_WORK_BRANCH = `
set -eu
git -C "$1" check-ref-format --branch "$2" >/dev/null
if git -C "$1" remote get-url origin >/dev/null 2>&1; then exit 0; fi
if git -C "$1" show-ref --verify --quiet "refs/heads/$2"; then exit 0; fi
git -C "$1" branch --no-track -- "$2" HEAD`;

export async function prepareWorktreeBranch(target, branch, base = "") {
  available(target.machine);
  if (base) return; // Preserve the user's explicit backend base selection.
  if (typeof branch !== "string" || !branch) throw new Error("Choose a valid work branch before preparing the worktree.");
  const result = await exec("sh", ["-c", LOCAL_WORK_BRANCH, "herdr-local-work-branch", target.folder, branch], { on: target.machine ?? null });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || "Could not prepare the local work branch on the selected computer.");
}

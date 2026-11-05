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
  printf '%s\\0' "$folder"
done`;

export async function discoverRepositories(machine) {
  available(machine);
  const result = await exec("sh", ["-c", LIST], { on: machine ?? null });
  if (result.code !== 0) throw new Error(result.stderr || `Could not read ~/code on ${machine ?? "This computer"}.`);
  const [root, ...paths] = result.stdout.split("\0").filter(Boolean);
  if (!root?.startsWith("/")) throw new Error("This computer did not return an absolute ~/code directory.");
  return { root, repositories: paths.map(folder => ({ folder, name: folder.slice(folder.lastIndexOf("/") + 1) })).sort((a, b) => a.name.localeCompare(b.name)) };
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

export function repositoryName(folder) {
  if (typeof folder !== "string") return "";
  // Herdr's worktree layout includes a repository segment before the branch.
  return folder.match(/\/\.herdr\/worktrees\/([^/]+)(?:\/|$)/)?.[1]
    ?? folder.replace(/\/+$/, "").split("/").pop();
}

export function matchingRepository(repositories, hints = []) {
  for (const hint of hints.filter(Boolean)) {
    const matches = repositories.filter(r => r.folder === hint || r.name.toLowerCase() === hint.toLowerCase());
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

// An explicit repository choice also supersedes pending ticket-target restoration.
// Completed agent discovery stays valid because the selected computer did not change.
export function selectRepository(view, repo, cx) {
  if (view.busy || view.repositoriesLoading) return false;
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
      if (!view.repositories.length) view.repositoryError = `No existing Git repositories found in ${view.repoRoot}.`;
      else if (preferredFolder && !selected) view.repositoryError = "The project's saved repository is unavailable on this computer. Choose an existing repository.";
    } else view.repositoryError = `Could not discover repositories on ${machine ?? "This computer"}: ${repos.reason?.message ?? repos.reason}`;
    view.agentsChecked = true;
    if (agents.status === "fulfilled") {
      view.agentChoices = agents.value;
      view.agentKey = agents.value.find(a => a.key === preferredAgent)?.key ?? agents.value[0]?.key ?? "";
    } else view.launchError = `Could not check agents: ${agents.reason?.message ?? agents.reason}`;
    if (view.screen === "create" && view.form?.capture && !view.form.draft?.uncertain) view.saveCapture?.(cx);
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

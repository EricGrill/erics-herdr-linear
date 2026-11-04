// Adapted from herdr-linear v0.14.2 (MIT), copyright 2026 Hjortur Stefan Olafsson.
// Modified for Eric's Herdr Linear; see THIRD_PARTY_NOTICES.md.
// Your Linear issues and projects in a popup: yours grouped by status, the
// workspace's projects, and what you filed lately. Open one for its status,
// priority, labels and description; change its status, and one key to a
// worktree for it in a space of its own, or start it: In Progress, yours,
// and an agent in the worktree told to work on it. File a new issue without
// leaving the window.
//
// The work is herdr-linear's (`app`), the TUI plugin's own code: Linear's
// side on the machine you're signed in on, a worktree's on the machine of
// the space you're in. The mod fetches the herdr-linear release it needs onto
// each machine it asks, the first time.

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popup } from "gpui-base";
import { agents, panes, machines, spaces, run, exec, theme, appHome, props, closeOverlay, openOverlay, nextCommand, knownAgents, shared, setShared } from "herdr";
import { draftStorage, loadDraft, saveDraft, discardDraft, shapeIdea, shapeWithAI } from "./capture.js";
import { LinearAPI } from "./api.js";
import { normalizeConfig } from "./config.js";
import { validateRepository, validateWorktreeRouting } from "./repository.js";
import { identifyExecutionTarget, descriptionWithExecutionTarget, readExecutionTarget, resolveExecutionTarget } from "./execution-target.js";
import { tones, tint, countPill, stateIcon, projectIcon, PRIORITIES, priorityIcon, hue, icon, chip, words, key, MONO } from "./look.js";

// The herdr-linear this mod is part of (its release; the repo's tests hold it
// to herdr-plugin.toml's version).
export const LINEAR_VERSION = "0.14.2";

// Puts that release on a machine, once: into a folder of its own version, so
// it never touches a herdr-linear installed for the TUI (it shares its
// sign-in). The archive is checked against the release's checksums before
// it's used. Prints the binary's path.
const PROVISION = String.raw`
v=$1
dest="$HOME/.local/share/herdr-linear/app/$v"
bin="$dest/herdr-linear"
[ -x "$bin" ] && { printf '%s' "$bin"; exit 0; }
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "no herdr-linear for $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "no herdr-linear for $(uname -m)" >&2; exit 1 ;; esac
name="herdr-linear_$v""_$os""_$arch.tar.gz"
url="https://github.com/mrolafsson/herdr-linear/releases/download/v$v"
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url/$name" -o "$tmp/$name" && curl -fsSL "$url/checksums.txt" -o "$tmp/sums" || { echo "couldn't download herdr-linear $v" >&2; exit 1; }
want=$(grep " $name\$" "$tmp/sums" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "herdr-linear $v didn't match its checksum" >&2; exit 1; }
tar -xzf "$tmp/$name" -C "$tmp" herdr-linear || exit 1
mkdir -p "$dest" && mv "$tmp/herdr-linear" "$bin.new" && chmod 755 "$bin.new" && mv "$bin.new" "$bin" || exit 1
printf '%s' "$bin"
`;

const binaries = new Map();
function binary(machine) {
  const k = machine ?? "";
  if (!binaries.has(k)) {
    const p = exec("sh", ["-c", PROVISION, "sh", LINEAR_VERSION], { on: machine }).then((r) => {
      if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim().split("\n").pop() || `herdr-linear: exit ${r.code}`);
      return r.stdout.trim();
    });
    p.catch(() => binaries.delete(k));
    binaries.set(k, p);
  }
  return binaries.get(k);
}

class AppError extends Error {
  constructor(res) {
    super(res.error);
    this.signedOut = Boolean(res.signedOut);
    this.noRepo = Boolean(res.noRepo);
  }
}

// One request to herdr-linear on a machine (null: this one).
async function ask(req, machine) {
  const bin = await binary(machine);
  const r = await exec("sh", ["-c", 'exec "$0" app "$1"', bin, JSON.stringify(req)], { on: machine });
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw new Error(r.stderr.trim().split("\n").pop() || `herdr-linear: exit ${r.code}`);
  }
  if (res?.error) throw new AppError(res);
  return res;
}

// A request that can outlast a command (a worktree's fetch): run as a job
// there, and asked after until it's done.
async function job(req, machine, limitMs = 5 * 60000) {
  const { job: id } = await ask({ ...req, bg: true }, machine);
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    await exec("sleep", ["1"]).catch(() => {});
    const res = await ask({ op: "job", job: id }, machine);
    if (res.done) {
      if (res.result?.error) throw new AppError(res.result);
      return res.result;
    }
  }
  throw new Error("it's taking too long; it carries on in the background");
}

const TABS = [
  { id: "mine", label: "My issues", short: "Mine", icon: "person" },
  { id: "projects", label: "Projects", icon: "project" },
  { id: "recent", label: "Recent", icon: "calendar" },
];

// An issue's key typed in the filter ("HAL-212", or just 212): looked up in
// the whole workspace, not only your issues.
const ISSUE_KEY = /^(?:[A-Za-z][A-Za-z0-9_]*-)?\d{1,9}$/;
// Where the lists are kept between openings.
const CACHE = `${appHome()}/linear-workspace-cache.json`;
const LAUNCH_TARGETS = "linear-workspace.launch-targets";

// The list's heights: a heading's, a row's (34 and a gap), and the most it
// takes before it scrolls.
const HEADING_H = 30;
const ROW_H = 36;
const LIST_H = 560;

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

export default class Linear extends View {
  agentArgv(agent) {
    let argv = [...agent.run];
    // Pi, PiG and current Amp run without built-in tool approval prompts.
    // Unknown/custom agents keep their discovered command unchanged.
    if (agent.key === "opencode") {
      return ["env", 'OPENCODE_PERMISSION={"*":"allow"}', ...argv];
    }
    const policies = {
      codex: { flag: "--yolo", aliases: ["--dangerously-bypass-approvals-and-sandbox"] },
      claude: { flag: "--dangerously-skip-permissions" },
      cursor: { flag: "--force", aliases: ["-f", "--yolo"], remove: ["--auto-review"] },
      kimi: { flag: "--auto", remove: ["--yolo", "-y", "--yes", "--auto-approve"] },
      gemini: { flag: "--approval-mode=yolo", remove: ["--yolo", "-y"], values: ["--approval-mode"] },
      copilot: { flag: "--allow-all", aliases: ["--yolo"] },
      grok: { flag: "--always-approve", values: ["--permission-mode"] },
      antigravity: { flag: "--dangerously-skip-permissions" },
      hermes: { flag: "--yolo" },
      qoder: { flag: "--yolo", aliases: ["--dangerously-skip-permissions"] },
      crush: { flag: "--yolo", aliases: ["-y"] },
      kiro: { flag: "--trust-all-tools" },
    };
    const policy = Object.hasOwn(policies, agent.key) ? policies[agent.key] : null;
    if (!policy) return argv;
    // Kimi prompt mode already runs unattended and rejects --auto.
    if (agent.key === "kimi" && argv.some(a => a === "-p" || a === "--prompt" || a.startsWith("--prompt="))) return argv;
    // Drop conflicting approval modes before applying the unattended policy.
    const cleaned = [argv[0]];
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") { cleaned.push(...argv.slice(i)); break; }
      if (policy.remove?.includes(arg)) continue;
      if (policy.values?.includes(arg)) { i++; continue; }
      if (policy.values?.some(option => arg.startsWith(`${option}=`))) continue;
      cleaned.push(arg);
    }
    argv = cleaned;
    const options = argv.slice(1, argv.includes("--") ? argv.indexOf("--") : argv.length);
    if ([policy.flag, ...(policy.aliases ?? [])].some(flag => options.includes(flag))) return argv;
    // Kiro's approval option belongs to its chat subcommand.
    if (agent.key === "kiro") {
      const chat = argv.indexOf("chat");
      return chat >= 0 ? [...argv.slice(0, chat + 1), policy.flag, ...argv.slice(chat + 1)]
        : [argv[0], "chat", policy.flag, ...argv.slice(1)];
    }
    return [argv[0], policy.flag, ...argv.slice(1)];
  }

  init(_props, cx) {
    const p = props() ?? {};
    this.demo = Boolean(p.demo);
    this.from = p.back ?? null;
    // Where esc goes back to, when another mod opened it on an issue: that
    // mod, on what it showed (GitHub, on the pull request).
    this.backTo = p.backTo ?? null;
    // With herdr-github's mod installed, an issue's pull requests open there.
    this.github = false;
    cx.spawn(async (cx) => {
      this.github = (await fs.readFile(`${appHome()}/mods/github/main.js`, "utf8").catch(() => null)) !== null;
      cx.notify();
    });
    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "mine";
    this.lists = {};
    this.drilled = null; // a project whose issues are listed
    this.found = null; // { query, issues } for an issue key in the filter
    this.filter = "";
    this.at = 0;
    this.cur = null;
    this.detail = null;
    this.menu = null;
    this.flash = this.err = this.busy = "";
    this.workspaces = [];
    this.ws = localStorage.getItem("workspace") ?? "";
    this.preferredOn = localStorage.getItem("on");
    this.on = null;
    this.trees = JSON.parse(localStorage.getItem("trees") ?? "{}");
    this.width = 900;

    this.keys = cx.focus_handle();
    // The list's scroll position, so the chosen row is kept in sight.
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: this.role === "sidebar" ? "Search spaces or tickets…" : this.docked ? "Search projects or issue ID…" : "Type to filter, or an issue's key…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.lookUp(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (!this.docked && this.screen === "list" && !this.signedOut && !this.closing) this.input.focus();
      });
    });
    this.title = InputState.new({ placeholder: "Title" });
    this.title.on("focus", () => (this.formField = "title"));
    this.title.on("submit", (_e, cx) => this.form?.capture ? this.captureDescription.focus() : this.submit(cx));
    this.desc = TextareaState.new({ placeholder: "What needs doing?", rows: 4 });
    this.desc.on("focus", () => (this.formField = "desc"));
    this.idea = TextareaState.new({ placeholder: "What would you like to improve?", rows: 4 });
    this.captureDescription = TextareaState.new({ placeholder: "What needs doing?", rows: 4 });
    for (const field of [this.idea, this.title, this.captureDescription]) {
      field.on("change", (_e, cx) => {
        if (this.screen === "create" && this.form?.capture && !this.form.restoring && this.form.draft && !this.form.draft.uncertain) {
          this.saveCapture(cx);
          cx.notify();
        }
      });
    }
    this.captureDescription.on("focus", () => (this.formField = "desc"));
    // The new issue's project: a dropdown with a search field.
    this.projSearch = InputState.new({ placeholder: "Search projects…" });
    this.projSearch.on("change", (_e, cx) => cx.notify());
    this.projSearch.on("submit", (_e, cx) => {
      const first = this.projectMatches()[0];
      if (first) this.pickProject(first.id, cx);
    });
    this.desc.on("submit", (_e, cx) => this.submit(cx));
    if (!this.docked) {
      this.input.focus();
      cx.timer.after(400, () => this.screen === "list" && this.input.focus());
    }

    cx.spawn(async (cx) => {
      await this.readCache(cx);
      await this.start(cx);
      if (p.issue) await this.openByKey(p.issue, cx);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => this.screen === "list" && !this.busy && this.loadAll(cx));

    // Key bindings and `herdr-app do`: linear.escape, linear.demo,
    // linear.next, linear.prev, linear.reload.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        // Tab (keys.json binds it here, over the app's own): on the new
        // issue form, keep focus on its request (or the capture review fields).
        else if ((c === "tab" || c === "backtab") && this.screen === "create" && !this.projOpen) {
          const next = this.form?.capture
            ? (this.form.review ? (this.idea.value() && this.formField !== "title" ? this.title : this.captureDescription) : this.idea)
            : this.desc;
          cx.timer.after(0, () => next.focus());
        }
        else if (c === "demo") {
          this.demo = !this.demo;
          this.lists = {};
          this.drilled = this.found = null;
          this.screen = "list";
          this.trees = this.demo ? {} : JSON.parse(localStorage.getItem("trees") ?? "{}");
          await this.start(cx);
        } else if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (c === "reload") this.reload(cx);
        else this.onCommand?.(c, cx);
        cx.notify();
      }
    });
  }

  // ── where things run ───────────────────────────────────────────────────

  // The machine you're signed in to Linear on: the one that answered last,
  // else this one, else each connected one in turn.
  findLinear() {
    if (!this.discovery) {
      this.discovery = this.discoverLinear();
      const clear = () => { this.discovery = null; };
      this.discovery.then(clear, clear);
    }
    return this.discovery;
  }

  async discoverLinear() {
    const previousOn = this.on ?? this.preferredOn;
    this.on = null;
    this.api = null;
    // The layout's configured key is also the task client's identity. The
    // upstream backend only knows OAuth, so an API key cannot sign it in.
    const text = await fs.readFile(`${appHome()}/erics-linear.config.json`, "utf8").catch(error => {
      if (error?.code === "ENOENT" || /no such file|not found|ENOENT/i.test(String(error?.message ?? error))) return "{}";
      throw error;
    });
    const supplied = JSON.parse(text);
    const config = normalizeConfig(supplied);
    const configured = Boolean(supplied.enrichment?.envKey || supplied.enrichment?.doppler);
    const api = new LinearAPI(config);
    this.api = null;
    try {
      const status = await api.status();
      this.api = api;
      this.on = "";
      this.workspaces = status.workspaces;
      if (!this.workspaces.some(w => w.id === this.ws)) this.ws = this.workspaces[0].id;
      localStorage.setItem("on", "");
      localStorage.setItem("workspace", this.ws);
      return;
    } catch (error) {
      if (configured || !error.unavailable) throw new Error(`Configured Linear access: ${error.message}`);
    }
    const order = [previousOn, "", ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name)];
    const tried = new Set();
    let last;
    for (const m of order) {
      if (m == null || tried.has(m)) continue;
      tried.add(m);
      try {
        const s = await ask({ op: "status" }, m || null);
        if (!s.workspaces.length) continue;
        this.on = m;
        this.workspaces = s.workspaces;
        if (!this.workspaces.some((w) => w.id === this.ws)) this.ws = this.workspaces[0].id;
        localStorage.setItem("on", m);
        return;
      } catch (e) {
        last = e;
      }
    }
    this.on = null;
    if (last) throw last;
    const e = new Error("Not signed in to Linear on any machine.");
    e.signedOut = true;
    throw e;
  }

  async linear(req, expectedWorkspace = null) {
    if (this.demo) return ask({ ...req, demo: true }, null);
    if (this.on == null) await this.findLinear();
    if (expectedWorkspace && expectedWorkspace !== this.ws) throw new Error("The Linear workspace changed. Reopen capture in the original workspace.");
    // API writes must never be retried automatically: a lost response may
    // follow a successful create or update.
    if (this.api) return this.api.ask({ ...req, workspace: this.ws });
    try {
      return await ask({ ...req, workspace: this.ws }, this.on || null);
    } catch (e) {
      if (e instanceof AppError || req.op === "create" || expectedWorkspace) throw e;
      await this.findLinear();
      if (this.api) return this.api.ask({ ...req, workspace: this.ws });
      return ask({ ...req, workspace: this.ws }, this.on || null);
    }
  }

  workspace() {
    return this.workspaces.find((w) => w.id === this.ws) ?? this.workspaces[0] ?? null;
  }

  async start(cx) {
    this.err = "";
    this.signedOut = false;
    try {
      if (this.demo) this.workspaces = [{ id: "w-halcyon", name: "Halcyon", urlKey: "halcyon" }];
      else await this.findLinear();
    } catch (e) {
      this.signedOut = Boolean(e?.signedOut);
      this.err = this.signedOut ? "" : String(e?.message ?? e);
      if (this.signedOut) this.keys.focus();
      return cx.notify();
    }
    this.loadAll(cx);
  }

  // Signs in in a terminal of its own, on this computer, where the browser
  // is: herdr-linear's own sign-in, which keeps the tokens where the TUI's
  // are.
  signIn(cx) {
    cx.spawn(async (cx) => {
      try {
        const bin = await binary(null);
        this.dismiss();
        run("space.new", { name: "Linear sign-in", argv: [bin, "login"] });
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  switchWorkspace(cx) {
    if (this.demo || this.workspaces.length < 2) return;
    const i = this.workspaces.findIndex((w) => w.id === this.ws);
    this.ws = this.workspaces[(i + 1) % this.workspaces.length].id;
    localStorage.setItem("workspace", this.ws);
    this.lists = {};
    this.drilled = this.found = null;
    this.at = 0;
    this.seedAll();
    this.loadAll(cx);
    cx.notify();
  }

  // ── lists ──────────────────────────────────────────────────────────────

  loadAll(cx) {
    for (const t of TABS) this.load(t.id, cx);
    if (this.drilled) this.loadProject(this.drilled, cx);
  }

  // The lists as they were last time, for the workspace shown, at once on
  // opening while fresh ones are asked for: a file in the app's folder.
  // Never the demo's.
  async readCache(cx) {
    if (this.demo) return;
    this.cache = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
    if (!this.workspaces.length && this.cache.workspaces) this.workspaces = this.cache.workspaces;
    this.seedAll();
    cx.notify();
  }

  seedAll() {
    const kept = this.cache?.lists?.[this.ws];
    if (!kept || this.demo) return;
    for (const t of TABS) {
      const l = this.lists[t.id];
      if (kept[t.id] && !(l?.loaded && !l.cached)) this.lists[t.id] = { ...l, items: kept[t.id], loaded: true, cached: true, loading: l?.loading };
    }
  }

  keep(tab, items) {
    if (this.demo || tab === "project") return;
    const c = (this.cache ??= {});
    c.workspaces = this.workspaces;
    ((c.lists ??= {})[this.ws] ??= {})[tab] = items;
    fs.writeFile(CACHE, JSON.stringify(c)).catch(() => {});
  }

  load(tab, cx, req = { op: "list", tab }) {
    const l = (this.lists[tab] ??= { items: [], loaded: false });
    if (l.loading) return;
    l.loading = true;
    cx.notify();
    const ws = this.ws;
    cx.spawn(async (cx) => {
      try {
        const res = await this.linear(req);
        if (ws !== this.ws) return;
        l.items = res.issues ?? res.projects ?? [];
        l.warning = res.warning ?? "";
        l.error = "";
        l.cached = false;
        this.keep(tab, l.items);
      } catch (e) {
        l.error = e?.signedOut ? "Signed out of this workspace: sign in again." : String(e?.message ?? e);
      }
      l.loading = false;
      l.loaded = true;
      this.didLoad?.(tab, cx);
      cx.notify();
    });
  }

  loadProject(p, cx) {
    this.lists.project = null;
    this.load("project", cx, { op: "list", tab: "project", project: p.id });
  }

  reload(cx) {
    if (this.signedOut || this.on == null) return this.start(cx);
    if (this.screen === "issue") return this.loadDetail(cx);
    this.loadAll(cx);
  }

  // An issue's key in the filter: looked up across the workspace, shortly
  // after you stop typing.
  lookUp(cx) {
    const q = this.filter.trim();
    if (this.tab !== "mine" || this.drilled || !ISSUE_KEY.test(q)) {
      this.found = null;
      return;
    }
    cx.timer.after(300, (cx) => {
      if (this.filter.trim() !== q) return;
      cx.spawn(async (cx) => {
        try {
          const res = await this.linear({ op: "find", key: q });
          if (this.filter.trim() === q) this.found = { query: q, issues: res.issues };
        } catch {}
        cx.notify();
      });
    });
  }

  step(d, cx) {
    if (this.drilled) return;
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
    localStorage.setItem("tab", this.tab);
    this.at = 0;
    this.found = null;
    cx.notify();
  }

  matches(x) {
    const hay = [x.identifier, x.title, x.name, x.state?.name, x.status?.name, x.project?.name, x.assignee, x.lead, ...(x.teams ?? [])]
      .filter(Boolean).join(" ").toLowerCase();
    return this.filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // The rows shown: issues or projects, each with the heading it goes under.
  shownRows() {
    const key = this.drilled ? "project" : this.tab;
    const l = this.lists[key];
    const rows = [];
    const keyed = this.found && ISSUE_KEY.test(this.filter.trim());
    for (const x of (l?.items ?? []).filter((x) => this.matches(x))) {
      if (key === "projects") rows.push({ project: x, group: x.status.name, color: x.status.color });
      else rows.push({ issue: x, group: x.group, color: x.state.color });
    }
    if (keyed) {
      const listed = new Set(rows.map((r) => r.issue?.id));
      for (const is of this.found.issues) if (!listed.has(is.id)) rows.push({ issue: is, group: "Not in your issues", color: null });
    }
    return rows;
  }

  enter(cx) {
    const r = this.shown?.[this.at];
    if (r?.issue) this.openIssue(r.issue, cx);
    else if (r?.project) this.openProject(r.project, cx);
  }

  // ── an issue ───────────────────────────────────────────────────────────

  focusKeys(cx) {
    cx.timer.after(30, () => this.keys.focus());
  }

  savedLaunchTarget(is) {
    return shared(LAUNCH_TARGETS)?.[`${this.ws}/${is.id}`] ?? null;
  }

  rememberLaunchTarget(is, target) {
    if (this.demo || !target?.folder) return;
    const { folder, name, root, computerId, computerName } = target;
    setShared(LAUNCH_TARGETS, { ...shared(LAUNCH_TARGETS),
      [`${this.ws}/${is.id}`]: { folder, name, root, computerId, computerName, machine: target.machine ?? null } });
  }

  async restoreLaunchTarget(is, description, cx, expectedGeneration) {
    if (this.demo || (this.targetGeneration ?? 0) !== expectedGeneration || this.cur?.id !== is.id) return;
    let saved;
    try { saved = readExecutionTarget(description); }
    catch (error) { this.blockLaunchTarget(error.message, cx); return; }
    if (!saved) return;
    const generation = this.blockLaunchTarget("Resolving the ticket's saved computer…", cx, saved.computerName);
    try {
      const resolved = await resolveExecutionTarget(saved);
      if (this.cur?.id !== is.id || this.targetGeneration !== generation) return;
      this.repositoryError = "";
      if (this.chooseComputer) this.chooseComputer(resolved.machine, cx, resolved);
      else this.launchTarget = resolved;
    } catch (error) {
      if (this.cur?.id === is.id && this.targetGeneration === generation) this.repositoryError = String(error?.message ?? error);
    }
    cx.notify();
  }

  blockLaunchTarget(message, cx, computerName = null) {
    const generation = this.targetGeneration = (this.targetGeneration ?? 0) + 1;
    this.agentGeneration = (this.agentGeneration ?? 0) + 1;
    this.launchTarget = { machine: computerName, folder: "" };
    this.repositories = []; this.repoRoot = ""; this.repositoriesLoading = false;
    this.agentChoices = []; this.agentKey = ""; this.agentsChecked = false;
    this.repositoryError = message;
    cx.notify();
    return generation;
  }

  openIssue(is, cx, direct = false) {
    const saved = this.savedLaunchTarget(is);
    if (saved && (saved.folder !== this.launchTarget?.folder || (saved.machine ?? null) !== (this.launchTarget?.machine ?? null))) {
      if (this.chooseComputer) this.chooseComputer(saved.machine ?? null, cx, saved);
      else this.launchTarget = { ...saved };
    }
    this.screen = "issue";
    this.cur = is;
    this.detail = null;
    this.menu = null;
    this.err = this.flash = "";
    this.direct = direct;
    this.loadDetail(cx);
    this.focusKeys(cx);
    cx.notify();
  }

  // From another mod: an issue by its key, in the workspace its link names.
  async openByKey({ key, workspaceKey }, cx) {
    if (!this.demo && workspaceKey) {
      const w = this.workspaces.find((w) => w.urlKey === workspaceKey);
      if (w) this.ws = w.id;
    }
    try {
      const res = await this.linear({ op: "find", key });
      const is = res.issues.find((i) => i.identifier === key.toUpperCase()) ?? res.issues[0];
      if (is) return this.openIssue(is, cx, true);
      this.say(`${key} isn't in ${this.workspace()?.name ?? "this workspace"}.`, cx, true);
    } catch (e) {
      this.say(String(e?.message ?? e), cx, true);
    }
  }

  loadDetail(cx) {
    const is = this.cur;
    const targetGeneration = this.targetGeneration ?? 0;
    const request = this.detailGeneration = (this.detailGeneration ?? 0) + 1;
    const key = `${this.ws}/${is.id}`;
    this.issueTargetState = { key, request, status: "pending" };
    cx.spawn(async (cx) => {
      const current = () => this.cur?.id === is.id && this.issueTargetState?.key === key && this.issueTargetState.request === request;
      try {
        const d = await this.linear({ op: "detail", issue: is.id });
        if (!current()) return;
        await this.restoreLaunchTarget(is, d.description, cx, targetGeneration);
        if (!current()) return;
        this.detail = d;
        this.cur = d.issue;
        this.replaceRow(d.issue);
        this.issueTargetState = { key, request, status: "ready" };
      } catch (e) {
        if (current()) {
          this.err = String(e?.message ?? e);
          this.issueTargetState = { key, request, status: "failed", error: this.err };
        }
      }
      if (current() && this.flash === this.launchWaitNotice) this.flash = "";
      cx.notify();
    });
  }

  createdLaunchFor(is, start) {
    const launch = this.createdLaunch;
    return start && launch?.key === `${this.ws}/${is?.id}` ? launch : null;
  }

  launchIssueReady(is, start) {
    if (this.demo || this.createdLaunchFor(is, start)) return true;
    const state = this.issueTargetState;
    return state?.key === `${this.ws}/${is?.id}` && state.status === "ready" && !this.repositoriesLoading;
  }

  replaceRow(is) {
    for (const l of Object.values(this.lists)) {
      const i = l?.items.findIndex((x) => x.id === is.id) ?? -1;
      if (i >= 0) l.items[i] = { ...is, group: l.items[i].group === "" ? "" : is.group };
    }
  }

  // ── a project ──────────────────────────────────────────────────────────

  openProject(p, cx) {
    this.rememberProject(p.id);
    this.screen = "project";
    this.curProject = p;
    this.projDetail = null;
    this.menu = null;
    this.err = this.flash = "";
    cx.spawn(async (cx) => {
      try {
        this.projDetail = await this.linear({ op: "project", project: p.id });
      } catch (e) {
        this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
    this.focusKeys(cx);
    cx.notify();
  }

  // A project's issues, in the list, with ← or esc back to the projects.
  drill(p, cx) {
    this.rememberProject(p.id);
    // From the project's screen, esc goes back there; from the list, to it.
    this.drillFrom = this.screen === "project";
    this.drilled = p;
    this.screen = "list";
    this.at = 0;
    this.input.set_value("");
    this.filter = "";
    this.loadProject(p, cx);
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  // ── leaving ────────────────────────────────────────────────────────────

  back(cx) {
    if (this.direct && this.from) {
      this.dismiss();
      if (this.backTo) return openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
      if (this.demo) return openOverlay({ mod: this.from, kind: "dialog", width: 0.8, height: 0.8, props: { demo: true } });
      return run("mod.open", { name: this.from });
    }
    if (this.screen === "create" && this.form?.capture) {
      if (!this.form.leaving) return this.closeCapture(cx);
      if (["capture", "new"].includes(props()?.action)) return this.dismiss();
    }
    this.direct = false;
    const id = this.screen === "project" ? this.curProject?.id : this.cur?.id;
    this.screen = "list";
    this.menu = null;
    this.err = this.flash = "";
    const i = this.shownRows().findIndex((r) => (r.issue ?? r.project).id === id);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  escape(cx) {
    if (this.projOpen) {
      this.projOpen = false;
      return cx.notify();
    }
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    if (this.screen !== "list") return this.back(cx);
    if (this.drilled) return this.undrill(cx);
    this.dismiss();
  }

  // Out of a project's issues: back to its screen when that's where they
  // were opened from, else to the projects, on it.
  undrill(cx) {
    const p = this.drilled;
    this.drilled = null;
    this.input.set_value("");
    this.filter = "";
    if (this.drillFrom) {
      this.drillFrom = false;
      return this.openProject(p, cx);
    }
    this.at = Math.max(0, this.shownRows().findIndex((r) => r.project?.id === p.id));
    cx.notify();
  }

  dismiss() {
    if (props()?.overlay) {
      this.closing = true;
      closeOverlay(props().overlay);
    }
  }

  open(url, cx) {
    if (!url) return;
    if (this.demo) return this.say(`Demo: would open ${url}`, cx);
    cx.open_url(url);
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.say(`Copied ${text}`, cx);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // ── changing it ────────────────────────────────────────────────────────

  // The status menu: the team's statuses in Linear's order, the current one
  // chosen.
  statusMenu(cx) {
    const d = this.detail;
    if (!d) return this.say("Still loading…", cx);
    const items = d.states.map((s) => ({
      label: s.name,
      icon: stateIcon(s),
      color: s.color,
      run: (cx) => {
        if (s.id === d.issue.state.id) return;
        this.busy = `Moving ${d.issue.identifier} to ${s.name}…`;
        cx.notify();
        cx.spawn(async (cx) => {
          try {
            const res = await this.linear({ op: "set-state", issue: d.issue.id, state: s.id });
            this.say(res.note, cx);
          } catch (e) {
            this.say(String(e?.message ?? e), cx, true);
          }
          this.busy = "";
          this.loadDetail(cx);
          this.loadAll(cx);
        });
      },
    }));
    this.menu = { title: `Move ${d.issue.identifier} to`, items, at: Math.max(0, d.states.findIndex((s) => s.id === d.issue.state.id)) };
    cx.notify();
  }

  // An issue's pull request (Linear's GitHub integration links them): on
  // its screen in the GitHub mod, esc there coming back to this issue; else
  // in the browser. With several, which.
  openPR(pr, cx) {
    if (!pr) {
      const prs = this.detail?.prs ?? [];
      if (!prs.length) return this.say("No pull request is linked to it in Linear.", cx);
      if (prs.length > 1) {
        this.menu = { title: `${this.cur.identifier}'s pull requests`, items: prs.map((p) => ({ label: `#${p.number} ${p.title}`, run: (cx) => this.openPR(p, cx) })), at: 0 };
        return cx.notify();
      }
      pr = prs[0];
    }
    if (!this.github) return this.open(pr.url, cx);
    const is = this.cur;
    this.dismiss();
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.8, props: {
      pr: { host: pr.host, repo: pr.repo, number: pr.number }, demo: this.demo || undefined,
      backTo: { mod: "linear-board", label: is.identifier, props: { issue: { key: is.identifier, workspaceKey: this.workspace()?.urlKey }, demo: this.demo || undefined, backTo: this.backTo ?? undefined, back: this.from ?? undefined } },
    } });
  }

  // ── worktrees ──────────────────────────────────────────────────────────

  spaceAt(path, machine) {
    const inside = (p) => p === path || p?.startsWith(path + "/");
    return spaces().find((s) => (s.machine ?? null) === (machine ?? null) && inside(place(s)));
  }

  treeOf(branch) {
    if (!branch) return null;
    if (this.trees[branch]) return this.trees[branch];
    if (this.demo) return null;
    const s = spaces().find((s) => s.branch === branch);
    return s ? { path: place(s), machine: s.machine ?? null } : null;
  }

  // Opens the worktree for an issue (or a project), made if there's none, in
  // the repo of the space you're in (or the team's, from config.json), on
  // that space's machine. start: an issue is checked first (never a closed
  // one, or a coworker's), the worktree made, then the issue moved to In
  // Progress and made yours, and an agent started in it with /ticket (only
  // in a new worktree: an existing one's agent may be busy).
  worktree(cx, start, what = this.screen === "project" ? { project: this.curProject } : { issue: this.cur }) {
    const is = what.issue;
    const pr = what.project;
    if (!is && !pr) return;
    if (this.busy) return;
    if (is && !this.launchIssueReady(is, start)) {
      const key = `${this.ws}/${is.id}`;
      const state = this.issueTargetState;
      if (state?.key !== key) this.openIssue(is, cx);
      if (state?.key === key && state.status === "failed") return this.say(`Cannot launch before issue details are loaded: ${state.error}. Reload the issue and try again.`, cx, true);
      this.launchWaitNotice = "Loading the issue's computer and repository. Wait for its details, then launch again.";
      return this.say(this.launchWaitNotice, cx);
    }
    // Only Create & start may skip the redundant detail reload: its exact
    // request-scoped placement was already validated and identified before create.
    const created = this.createdLaunchFor(is, start);
    const execution = created ? { ...created.execution } : this.launchTarget ? { ...this.launchTarget, machine: this.launchTarget.machine ?? null } : null;
    const agentKey = created ? created.agentKey : this.agentKey;
    if (created) this.createdLaunch = null;
    const name = is ? is.identifier : pr.name;
    this.busy = start ? `Starting ${name}…` : `Opening ${name}'s worktree…`;
    this.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let fresh = is;
        // Each step says what it's doing, and gives up with why if it stalls.
        const step = (label, p, ms = 45000) => {
          this.busy = label;
          cx.notify();
          return Promise.race([p, new Promise((_, no) => cx.timer.after(ms, () => no(new Error(`${label.replace(/…$/, "")} took too long`))))]);
        };
        const workspaceKey = this.workspace()?.urlKey ?? "";
        if (!this.demo) {
          if (!execution?.folder) throw new Error("Choose a computer and an existing repository first.");
          execution.folder = await step("Validating the selected repository…", validateRepository(execution));
          await step("Checking repository routing…", validateWorktreeRouting(execution, workspaceKey));
          if (is) this.rememberLaunchTarget(is, execution);
        }
        if (start && is) fresh = (await step(`Checking ${is.identifier} in Linear…`, this.linear({ op: "check-start", issue: is.id }))).issue;
        // Choose before changing the ticket or creating its worktree. A missing
        // selected agent must never silently turn Start into a plain shell.
        const machineForAgent = execution?.machine ?? null;
        let selectedAgent = null;
        if (start) {
          const known = await step("Checking the selected agent…", knownAgents({ on: machineForAgent }));
          selectedAgent = known.find((a) => a.installed && a.key === agentKey);
          if (!selectedAgent) throw new Error("The selected agent is not installed on this machine. Choose another agent.");
        }
        const target = is
          ? { branch: fresh.branch, label: `${fresh.identifier} ${fresh.title}`, teamKey: fresh.teamKey, workspaceKey, identifier: fresh.identifier, title: fresh.title, url: fresh.url }
          : { branch: pr.branch, label: pr.name, teamKey: pr.teamKey, workspaceKey, project: pr.name, url: pr.url };
        if (this.demo) {
          const res = await ask({ op: "worktree", demo: true, target }, null);
          let note = res.note;
          if (start && is) {
            const s = await this.linear({ op: "start", issue: is.id, branch: target.branch, teamKey: target.teamKey });
            note += `; ${s.note}, and an agent would be asked: ${res.prompt}`;
            this.loadAll(cx);
            if (this.screen === "issue") this.loadDetail(cx);
          }
          this.trees[target.branch] = { path: res.path, machine: "build-1" };
          this.busy = "";
          return this.say(note, cx);
        }
        const machine = execution.machine;
        // https://github.com/mrolafsson/herdr-linear/blob/v0.14.2/app.go#L468
        // Configured team repos precede dirs. The guard excludes empty-team
        // overrides; only Git routing clears the team, never Linear check/start.
        const repositoryTarget = { ...target, teamKey: "" };
        const res = await step(`Making its worktree on ${machine ?? "this computer"}…`,
          job({ op: "worktree", target: repositoryTarget, dirs: [execution.folder] }, machine), 4 * 60000);
        this.trees[target.branch] = { path: res.path, machine };
        localStorage.setItem("trees", JSON.stringify(this.trees));
        let note = "";
        if (start && is) {
          try {
            note = (await step(`Starting ${is.identifier} in Linear…`, this.linear({ op: "start", issue: is.id, branch: target.branch, teamKey: target.teamKey }))).note;
          } catch (e) {
            this.busy = "";
            return this.say(`The worktree is ready, but ${is.identifier} wasn't started: ${e?.message ?? e}`, cx, true);
          }
        }
        this.busy = "";
        const s = this.spaceAt(res.path, machine);
        if (s) {
          this.onWorktree?.(fresh, res.path, machine, s);
          run("space.select", { id: s.id });
          if (start) return this.say(`${note ? note + ". " : ""}Its worktree already had a space, so no prompt was sent: its agent may be busy.`, cx);
          return this.dismiss();
        }
        // Empty explicitly means this computer; omission inherits focused space.
        const spec = { folder: res.path, machine: machine ?? "" };
        if (start) {
          spec.argv = this.agentArgv(selectedAgent);
          spec.task = this.taskFor?.(fresh, created?.description) ?? res.prompt;
        }
        this.busy = "Opening its space…";
        cx.notify();
        this.onWorktree?.(fresh, res.path, machine);
        run("space.new", spec);
        this.busy = "";
        this.dismiss();
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // The agents working on an issue: those in a pane on its branch.
  agentsOf(is) {
    if (!is?.branch || this.demo) return [];
    const ps = new Map(panes().map((p) => [p.pane, p]));
    return agents().filter((a) => ps.get(a.pane)?.branch === is.branch)
      .map((a) => ({ name: a.title || a.tab_name, status: a.status, machine: machineOf(a.address), address: a.address }));
  }

  // ── a new issue ────────────────────────────────────────────────────────

  taskDefaults() {
    return this.demo || !this.ws ? {} : shared("linear-workspace.task-defaults")?.[this.ws] ?? {};
  }

  rememberProject(id, workspace = this.ws) {
    if (this.demo || !workspace) return;
    const key = "linear-workspace.task-defaults", defaults = shared(key)?.[workspace] ?? {};
    if (defaults.lastProject === id) return;
    setShared(key, { ...shared(key), [workspace]: { ...defaults, lastProject: id } });
  }

  rememberTaskOptions() {
    const f = this.form;
    if (this.demo || !this.ws || !f) return;
    const key = "linear-workspace.task-defaults", defaults = this.taskDefaults();
    const previous = defaults.issue ?? {};
    const issue = { team: f.team?.id ?? previous.team, priority: f.priority, assignToMe: f.assignToMe,
      states: { ...previous.states, ...(f.team && f.state ? { [f.team.id]: f.state } : {}) } };
    setShared(key, { ...shared(key), [this.ws]: { ...defaults, issue } });
  }

  rememberRepository(target) {
    if (this.demo || !this.ws || this.screen !== "create" || !this.form ||
      typeof target?.folder !== "string" || !target.folder.startsWith("/")) return;
    const key = "linear-workspace.task-defaults", defaults = this.taskDefaults();
    const id = this.form.project ?? "", machine = target.machine ?? null;
    const project = defaults.projects?.[id] ?? {};
    setShared(key, { ...shared(key), [this.ws]: { ...defaults, lastProject: this.form.project, lastRepository: { ...target, machine, project: this.form.project },
      projects: { ...defaults.projects, [id]: { ...project, machine,
        repositories: { ...project.repositories, [machine ?? ""]: target.folder } } } } });
  }

  restoreTaskRepository(issue, f, cx) {
    if (!issue?.id || (issue.project?.id ?? null) !== f.project || this.demo) return;
    const generation = this.targetGeneration;
    cx.spawn(async cx => {
      try {
        const result = await this.linear({ op: "detail", issue: issue.id }, f.workspace);
        const saved = readExecutionTarget(result.description ?? "");
        if (!saved) return;
        const target = await resolveExecutionTarget(saved);
        if (this.form !== f || this.screen !== "create" || this.busy || f.draft?.uncertain ||
          this.targetGeneration !== generation || f.project !== (issue.project?.id ?? null)) return;
        this.chooseComputer(target.machine, cx, target);
      } catch { /* An unavailable previous target must not prevent capturing a task. */ }
    });
  }

  defaultTaskMachine() {
    const project = this.taskDefaults().projects?.[this.form?.project ?? ""];
    return project && Object.hasOwn(project, "machine") ? project.machine : this.launchTarget?.machine ?? null;
  }

  mappedRepository(machine) {
    return this.screen === "create" && this.form
      ? this.taskDefaults().projects?.[this.form.project ?? ""]?.repositories?.[machine ?? ""] : undefined;
  }

  rememberTaskContext(f) {
    this.rememberTaskOptions();
    if (this.demo || !this.ws) return;
    const key = "linear-workspace.task-defaults", defaults = this.taskDefaults();
    setShared(key, { ...shared(key), [this.ws]: { ...defaults, lastProject: f.project,
      context: { team: f.team?.id, project: f.project, state: f.state, priority: f.priority, assignToMe: f.assignToMe } } });
  }

  // The form: a request, team, status, priority, project, and
  // whether it's yours. In a project (listed, or open), the issue goes in it.
  create(cx, capture = false, projectId = null) {
    const context = this.screen === "project" ? this.curProject : (this.screen === "issue" ? this.cur?.project : props()?.taskIssue?.project) ?? this.drilled;
    const project = context ?? this.projectsFor(null).find((p) => p.id === this.taskDefaults().lastProject);
    const options = this.taskDefaults().issue ?? {};
    const form = { team: null, state: null, priority: options.priority ?? 0, project: projectId ?? project?.id ?? (capture ? this.taskDefaults().lastProject : null) ?? null, assignToMe: options.assignToMe ?? true, teams: null, states: {}, capture };
    if (capture) {
      if (!this.ws && !this.demo) return this.say("Select a Linear workspace to save an idea.", cx, true);
      form.workspace = this.ws;
      form.storageKey = this.demo ? "demo/w-halcyon" : this.ws;
      this.draftStore ??= draftStorage(localStorage, shared, setShared);
      try { form.draft = loadDraft(this.draftStore, form.storageKey) ?? { revision: 0 }; }
      catch (error) {
        form.unreadable = error.message;
        form.unreadableRaw = error.unreadableRaw;
        this.form = form;
        this.screen = "create";
        this.say(error.message, cx, true);
        return;
      }
      const d = form.draft;
      const remembered = this.taskDefaults().context;
      const previous = Object.keys(options).length ? { ...options, project: form.project, state: options.states?.[options.team] } : remembered?.project === form.project ? remembered : null;
      if (!d.revision && previous?.project === form.project) {
        Object.assign(form, { priority: previous.priority ?? 0, assignToMe: previous.assignToMe ?? true });
        form.preferredContext = previous;
      }
      if (d.revision) Object.assign(form, { project: d.project, priority: d.priority, assignToMe: d.assignToMe });
      form.review = true;
      if (d.execution?.folder) this.launchTarget = { ...d.execution };
    } else this.rememberProject(form.project);
    form.restoring = true;
    this.form = form;
    this.screen = "create";
    this.menu = null;
    this.err = this.flash = "";
    this.title.set_value(form.draft?.title || (!form.draft?.review && form.draft?.idea ? shapeIdea(form.draft.idea).title : ""));
    this.desc.set_value("");
    if (capture) {
      this.idea.set_value(form.draft.idea ?? "");
      this.captureDescription.set_value(form.draft.description || (!form.draft.review ? form.draft.idea : "") || (!form.draft.idea ? form.draft.title : "") || "");
    }
    form.restoring = false;
    form.waitingProjects = capture && form.project && !this.lists.projects?.loaded;
    if (!form.waitingProjects) this.loadFormTeams(cx, project);
    cx.timer.after(30, () => (capture ? (form.review ? this.captureDescription : this.idea) : this.desc).focus());
    cx.notify();
  }

  loadFormTeams(cx, project = null) {
    const form = this.form;
    cx.spawn(async (cx) => {
      try {
        const res = await this.linear({ op: "teams" }, form.workspace);
        if (this.form !== form || this.screen !== "create") return;
        form.teams = res.teams;
        const selected = this.projectsFor(null).find((p) => p.id === form.project) ?? (project?.id === form.project ? project : null);
        const key = selected?.teams?.[0];
        const savedTeam = form.preferredContext?.team ?? this.taskDefaults().issue?.team;
        const t = res.teams.find(t => t.id === form.draft?.team)
          ?? res.teams.find(t => t.id === savedTeam && (!selected || selected.teams.includes(t.key)))
          ?? res.teams.find(t => t.key === key) ?? res.teams.find(t => form.capture && t.key === localStorage.getItem("team")) ?? res.teams[0];
        if (t) this.pickTeam(t, cx, true);
      } catch (e) {
        if (this.form !== form || this.screen !== "create") return;
        this.say(String(e?.message ?? e), cx, true);
      }
      cx.notify();
    });
  }

  pickTeam(t, cx, restoring = false) {
    if (this.busy) return;
    const f = this.form;
    const preferred = f.draft?.revision ? f.draft : f.preferredContext;
    const savedState = f.capture ? (restoring && preferred?.team === t.id ? preferred.state : null)
      : this.taskDefaults().issue?.states?.[t.id];
    f.team = t;
    f.state = f.capture ? savedState ?? t.defaultIssueState?.id ?? null : null;
    const initialState = f.state;
    f.statesError = "";
    localStorage.setItem("team", t.key);
    if (f.project && (!f.capture || this.lists.projects?.loaded) && !this.projectsFor(t).some((p) => p.id === f.project)) {
      f.project = null;
      this.rememberProject(null);
      if (this.chooseComputer && !props()?.attachSpace) this.chooseComputer(this.defaultTaskMachine(), cx);
      if (f.capture) this.say("The saved project is unavailable for this team. Choose a project or continue without one.", cx);
    }
    const applyStates = () => {
      if (this.form !== f || f.team?.id !== t.id || f.draft?.uncertain || this.screen !== "create" || f.state !== initialState) return;
      const states = f.states[t.id] ?? [];
      const defaultState = states.find(x => x.id === t.defaultIssueState?.id && !["completed", "canceled"].includes(x.type));
      if (savedState && states.some(x => x.id === savedState && !["completed", "canceled"].includes(x.type))) f.state = savedState;
      else f.state = ((f.capture ? null : defaultState) ?? states.find(x => x.type === "backlog") ?? states.find(x => x.type === "triage") ?? defaultState ?? states.find(x => x.type === "unstarted"))?.id ?? null;
      if (f.capture) this.saveCapture(cx);
    };
    if (!restoring && !f.capture) this.rememberTaskOptions();
    if (!f.states[t.id]) {
      f.loadingStates = t.id;
      cx.spawn(async (cx) => {
        try {
          f.states[t.id] = (await this.linear({ op: "states", team: t.id }, f.workspace)).states;
          applyStates();
        } catch (error) {
          if (this.form === f && f.team?.id === t.id) {
            f.statesError = "Could not load team statuses. Choose the team again to retry.";
            this.say(f.statesError, cx, true);
          }
        }
        if (f.loadingStates === t.id) f.loadingStates = null;
        cx.notify();
      });
    } else { f.loadingStates = null; applyStates(); }
    if (f.capture && !f.draft.uncertain) this.saveCapture(cx);
    cx.notify();
  }

  saveCapture(cx, changes = {}) {
    const f = this.form;
    if (!f?.capture || f.restoring || this.screen !== "create") return false;
    try {
      const draft = { ...f.draft, idea: this.idea.value(), title: this.title.value(), description: this.captureDescription.value(),
        review: f.review, team: f.team?.id ?? f.draft.team ?? null, project: f.project, state: f.state ?? f.draft.state ?? null,
        priority: f.priority, assignToMe: f.assignToMe, execution: f.draft.uncertain ? f.draft.execution : this.launchTarget?.folder ? { ...this.launchTarget } : f.restoringExecution ?? null, ...changes };
      if (!draft.idea && !draft.title && !draft.description && !f.draft.revision) return true;
      if (Object.keys(draft).some(key => draft[key] !== f.draft[key])) f.draft = saveDraft(this.draftStore, f.storageKey, draft);
      f.saveError = "";
      return true;
    } catch (error) {
      f.saveError = error.message;
      this.say(f.saveError, cx, true);
      return false;
    }
  }

  reviewCapture(cx) {
    const f = this.form;
    if (this.busy || !f?.capture || f.draft.uncertain) return;
    if (!this.idea.value().trim()) return this.say("Write an idea first.", cx, true);
    if (!this.saveCapture(cx)) return;
    const idea = this.idea.value();
    const previous = f.draft.generated;
    let generated = previous;
    let preservedEdits = false;
    if (previous?.idea !== idea) {
      generated = { idea, ...shapeIdea(idea) };
      f.restoring = true;
      for (const [key, field] of [["title", this.title], ["description", this.captureDescription]]) {
        const generatedField = previous ? field.value() === previous[key] : !field.value();
        if (generatedField) field.set_value(generated[key]);
        else preservedEdits = true;
      }
      f.restoring = false;
    }
    f.review = true;
    if (this.saveCapture(cx, { generated }) && preservedEdits)
      this.say("The source idea changed. Review the custom ticket text kept from your earlier draft.", cx);
    cx.timer.after(0, () => this.title.focus());
    cx.notify();
  }

  improveCapture(cx) {
    const f = this.form;
    if (!f?.capture || !f.review || f.shaping || f.draft.uncertain || this.busy) return;
    const idea = this.idea.value() || [this.title.value(), this.captureDescription.value()].filter(Boolean).join("\n\n");
    if (!idea.trim()) return this.say("Add a title or description first.", cx, true);
    if (!this.saveCapture(cx)) return;
    const { id, revision } = f.draft;
    f.shaping = true;
    cx.spawn(async cx => {
      try {
        const result = await shapeWithAI(idea);
        if (this.form !== f || this.screen !== "create" || this.closing || !f.review || this.busy || f.draft.uncertain) return;
        const stored = loadDraft(this.draftStore, f.storageKey);
        if (f.saveError || stored?.id !== id || f.draft.revision !== revision || stored?.revision !== revision)
          return this.say("The draft changed while shaping. Your edits were kept.", cx);
        f.restoring = true;
        if (!this.idea.value()) this.idea.set_value(idea);
        this.title.set_value(result.title);
        this.captureDescription.set_value(result.description);
        f.restoring = false;
        if (this.saveCapture(cx, { generated: { idea, ...result } })) this.say("Suggestions are ready to edit.", cx);
      } catch (error) {
        if (this.form === f && this.screen === "create" && !this.closing && !this.busy && !f.draft.uncertain)
          this.say(`AI shaping unavailable: ${error.message}. Your draft is ready to edit.`, cx, true);
      } finally { f.shaping = false; cx.notify(); }
    });
    cx.notify();
  }

  closeCapture(cx, discard = false) {
    const f = this.form;
    if (this.busy || f.leaving) return;
    try {
      if (discard && (f.unreadable || f.draft.revision)) discardDraft(this.draftStore, f.storageKey, f.unreadable ? f.unreadableRaw : f.draft);
      else if (!f.unreadable && !f.draft.uncertain && !this.saveCapture(cx)) return;
    } catch (error) { return this.say(error.message, cx, true); }
    f.leaving = true;
    this.back(cx);
  }

  async completeCapture(issue, f, cx, start = false) {
    f.confirmedIssue = issue;
    try {
      if (!f.draft.confirmedIssue) {
        if (!this.saveCapture(cx, { uncertain: true, confirmedIssue: issue })) throw new Error(f.saveError);
      }
      this.lists.recent = null;
      this.loadAll(cx);
      const execution = f.draft.execution;
      if (execution?.folder) this.rememberLaunchTarget(issue, execution);
      else this.blockLaunchTarget("Choose a computer and repository when you are ready to start work.", cx);
      this.openIssue(issue, cx);
      if (!f.clearedConfirmed) {
        discardDraft(this.draftStore, f.storageKey, f.draft);
        f.clearedConfirmed = true;
      }
      this.say(`Task ${issue.identifier} is ready. Start work when ready.`, cx);
      this.createdLaunch = start && execution?.folder
        ? { key: `${this.ws}/${issue.id}`, execution: { ...execution }, agentKey: f.creationAgentKey, description: f.draft.submittedDescription ?? f.draft.description } : null;
      this.busy = "";
      try { if (start) this.afterCreate?.(issue, cx, true); }
      finally { this.createdLaunch = null; }
    } catch (error) {
      this.busy = "";
      this.screen = "create";
      this.say(`Linear created ${issue.identifier}${issue.url ? " " + issue.url : ""}. Could not finish opening or clearing the draft: ${error.message}`, cx, true);
    }
  }

  openConfirmedCapture(issue, f, cx) {
    if (this.busy) return;
    this.busy = "Opening ticket…";
    cx.spawn(async cx => { await this.completeCapture(issue, f, cx); this.busy = ""; cx.notify(); });
    cx.notify();
  }

  submitCapture(cx, startAfterCreate = false) {
    const f = this.form;
    if (!f?.capture || !f.review || this.busy || f.unreadable || f.draft.uncertain) return;
    if (this.ws !== f.workspace) return this.say("Reopen capture in the original workspace.", cx, true);
    const request = this.captureDescription.value().trim() || this.title.value().trim();
    const firstLine = Array.from(request.split(/\r?\n/)[0].replace(/\s+/g, " "));
    const suggestedTitle = firstLine.length > 100 ? firstLine.slice(0, 97).join("") + "..." : firstLine.join("");
    const title = this.idea.value().trim() ? this.title.value().trim() : suggestedTitle;
    if (!title) return this.say("Write a request first.", cx, true);
    this.title.set_value(title);
    if (f.loadingStates || f.statesError) return this.say(f.statesError || "Still loading team statuses; try again in a moment.", cx, true);
    if (!f.team || !f.states[f.team.id]?.some(s => s.id === f.state && !["completed", "canceled"].includes(s.type)))
      return this.say("Choose an available open status for this team before creating.", cx, true);
    if (f.project && !this.projectsFor(f.team).some(p => p.id === f.project)) return this.say("Choose a project that belongs to this team, or select No project.", cx, true);
    const preview = this.captureDescription.value();
    const source = this.idea.value().trim() ? `## Source idea\n\n${this.idea.value()}` : "";
    const description = source && !preview.includes(source) ? [preview, source].filter(Boolean).join("\n\n") : preview;
    try {
      if (readExecutionTarget(description)) throw new Error("Reserved placement");
    } catch {
      return this.say("Remove the copied Herdr execution target from the idea or description before creating. Your draft is kept.", cx, true);
    }
    const execution = this.launchTarget?.folder ? { ...this.launchTarget, machine: this.launchTarget.machine ?? null } : null;
    if (startAfterCreate && (!execution || !this.agentsChecked || !this.agentChoices?.some(a => a.key === this.agentKey)))
      return this.say("Choose an existing repository and an installed agent before starting.", cx, true);
    if (!this.saveCapture(cx)) return;
    const revision = f.draft.revision;
    f.creationAgentKey = this.agentKey;
    this.busy = "Creating task…";
    cx.notify();
    cx.spawn(async cx => {
      let savedDescription = description;
      try {
        if (execution && !this.demo) {
          execution.folder = await validateRepository(execution);
          if (startAfterCreate) await validateWorktreeRouting(execution, this.workspace()?.urlKey ?? "");
          Object.assign(execution, await identifyExecutionTarget(execution));
          savedDescription = descriptionWithExecutionTarget(description, execution);
        }
        if (this.form !== f || this.ws !== f.workspace || f.draft.revision !== revision)
          throw new Error("The task changed while checking its repository. Review it and create again.");
        if (!this.saveCapture(cx, { uncertain: true, execution, submittedDescription: savedDescription })) throw new Error(f.saveError);
        } catch (error) {
        this.busy = "";
        this.saveCapture(cx, { uncertain: false });
        this.say(`Could not prepare the task: ${error.message}. No ticket request was sent.`, cx, true);
        return;
      }
      const d = f.draft;
      let issue;
      try {
        const res = await this.linear({ op: "create", new: { team: d.team, title: d.title.trim(), description: savedDescription,
          project: d.project ?? "", state: d.state ?? "", priority: d.priority, assignToMe: d.assignToMe } }, f.workspace);
        if (!res.issue?.id || !res.issue.identifier) throw new Error("Missing issue identifier");
        issue = res.issue;
      } catch (error) {
        this.busy = "";
        this.say("Creation not confirmed. Check recent issues before retrying.", cx, true);
        return;
      }
      this.rememberTaskContext(f);
      if (execution) this.rememberRepository(execution);
      await this.completeCapture(issue, f, cx, startAfterCreate);
      cx.notify();
    });
  }

  checkCaptureResult(cx) {
    const f = this.form;
    if (!f?.draft.uncertain || this.busy) return;
    this.busy = "Checking recent issues…";
    cx.spawn(async cx => {
      try {
        const { issues } = await this.linear({ op: "list", tab: "recent" }, f.workspace);
        if (!Array.isArray(issues)) throw new Error("Recent issues could not be verified.");
        f.matches = issues.filter(is => is.title === f.draft.title.trim() && (!is.teamId || is.teamId === f.draft.team));
        this.say(f.matches.length ? "Open a match in Linear to verify its source idea." : "No matching title in recent issues. Check Linear before allowing a retry.", cx);
      } catch (error) { f.matches = null; this.say(error.message, cx, true); }
      finally { this.busy = ""; cx.notify(); }
    });
    cx.notify();
  }

  projectsFor(t) {
    return (this.lists.projects?.items ?? []).filter((p) => !t || p.teams.includes(t.key));
  }

  projectMatches() {
    const q = this.projSearch.value().trim().toLowerCase();
    return this.projectsFor(this.form?.team).filter((p) => !q || p.name.toLowerCase().includes(q));
  }

  pickProject(id, cx) {
    if (this.busy) return;
    this.form.project = id;
    if (this.form.capture) this.saveCapture(cx);
    this.rememberProject(id);
    if (this.chooseComputer && !props()?.attachSpace) this.chooseComputer(this.defaultTaskMachine(), cx);
    this.projOpen = false;
    this.projSearch.set_value("");
    cx.timer.after(30, () => (this.form.capture ? (this.form.review ? this.captureDescription : this.idea) : this.desc).focus());
    cx.notify();
  }

  // The project field: what's chosen, and a click lists them all, with a
  // search field on top.
  projectField(o) {
    const f = this.form;
    const cur = f.project ? this.projectsFor(null).find((p) => p.id === f.project) : null;
    const trigger = h_flex().id("proj-pick").flex_none().h(26).pl(8).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(this.projOpen ? o.accent : o.line).hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => {
        this.projOpen = !this.projOpen;
        if (this.projOpen) cx.timer.after(30, () => this.projSearch.focus());
        cx.notify();
      })
      .when(Boolean(cur), (el) => el.child(icon(projectIcon(cur.status.type), hue(o, cur.status.color), 12)))
      .child(div().text_size(12).text_color(cur ? o.fg : o.muted).child(cur ? cur.name : f.capture && f.project ? "Project unavailable" : "No project"))
      .child(icon("chevron", o.dim, 11));
    const matches = this.projOpen ? this.projectMatches() : [];
    const row = (id, label, lead, on) => h_flex().id(`pj-opt-${id ?? "none"}`).h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .when(on, (el) => el.bg(tint(o.accent, 0.16)))
      .when(!on, (el) => el.hover((s) => s.bg(o.raised)))
      .on_click((_e, cx) => this.pickProject(id, cx))
      .child(lead ?? div().w(12))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(o.fg).child(label));
    const list = v_flex().w(320).p(6).gap(2).rounded(8).border_1().border_color(o.line).bg(o.surface).shadow_md()
      .on_mouse_down_out((_e, cx) => {
        this.projOpen = false;
        cx.notify();
      })
      .child(h_flex().h(30).px(8).gap(6).items_center().rounded(6).bg(o.sunk).border_1().border_color(o.line)
        .child(icon("search", o.dim, 12))
        .child(Input.new(this.projSearch).flex_1().h_full().text_size(12.5).text_color(o.fg)))
      .when(!this.projSearch.value().trim(), (el) => el.child(row(null, "No project", null, !f.project)))
      .children(matches.slice(0, 8).map((p) => row(p.id, p.name, icon(projectIcon(p.status.type), hue(o, p.status.color), 12), p.id === f.project)))
      .when(matches.length > 8, (el) => el.child(div().px(8).py(4).text_size(11.5).text_color(o.dim).child(`${matches.length - 8} more: type to narrow them`)))
      .when(matches.length === 0 && Boolean(this.projSearch.value().trim()), (el) => el.child(div().px(8).py(4).text_size(12).text_color(o.dim).child("No project matches.")));
    return Popup.new("proj-popup", trigger).anchor("top_left").when(Boolean(this.projOpen), (el) => el.content(list));
  }

  submit(cx, startAfterCreate = false) {
    const f = this.form;
    if (!f || this.busy) return;
    if (f.capture) return this.submitCapture(cx, startAfterCreate);
    const description = this.desc.value();
    const firstLine = Array.from(description.trim().split(/\r?\n/)[0].replace(/\s+/g, " "));
    const title = firstLine.length > 100 ? firstLine.slice(0, 97).join("") + "..." : firstLine.join("");
    if (!title) return this.say("Write a request first.", cx, true);
    if (!f.team) return this.say("Still loading your teams; try again in a moment.", cx, true);
    if (f.loadingStates || f.statesError) return this.say(f.statesError || "Still loading team statuses; try again in a moment.", cx, true);
    const creationAgentKey = this.agentKey;
    const attaching = Boolean(props()?.attachSpace);
    const execution = this.launchTarget ? { ...this.launchTarget, machine: this.launchTarget.machine ?? null } : null;
    if (!this.demo && !attaching && !execution?.folder) return this.say("Choose a computer and an existing repository first.", cx, true);
    this.busy = `Creating ${title}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.demo && !attaching) {
          execution.folder = await validateRepository(execution);
          if (startAfterCreate) await validateWorktreeRouting(execution, this.workspace()?.urlKey ?? "");
        }
        let savedDescription = description;
        if (!this.demo && !attaching) {
          Object.assign(execution, await identifyExecutionTarget(execution));
          savedDescription = descriptionWithExecutionTarget(description, execution);
        }
        const res = await this.linear({ op: "create", new: { team: f.team.id, title, description: savedDescription, project: f.project ?? "", state: f.state ?? "", priority: f.priority, assignToMe: f.assignToMe } });
        this.rememberTaskOptions();
        if (!attaching) this.rememberLaunchTarget(res.issue, execution);
        this.busy = "";
        this.lists.recent = null;
        this.loadAll(cx);
        this.createdLaunch = startAfterCreate && !attaching && execution
          ? { key: `${this.ws}/${res.issue.id}`, execution: { ...execution }, agentKey: creationAgentKey } : null;
        this.openIssue(res.issue, cx);
        this.say(res.note, cx);
        this.afterCreate?.(res.issue, cx, startAfterCreate);
        // A handler that did not start work must not leave a future bypass behind.
        this.createdLaunch = null;
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // ── keys ───────────────────────────────────────────────────────────────

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (/^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  choose(item, cx) {
    this.menu = null;
    item.run(cx);
    cx.notify();
  }

  issueKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    const is = this.cur;
    switch (k) {
      case "left":
      case "backspace":
        this.back(cx);
        break;
      case "w":
        this.worktree(cx, false);
        break;
      case "s":
        this.worktree(cx, true);
        break;
      case "c":
        this.statusMenu(cx);
        break;
      case "n":
        this.create(cx);
        break;
      case "o":
        this.open(is.url, cx);
        break;
      case "y":
        this.copy(is.identifier, cx);
        break;
      case "b":
        this.copy(is.branch, cx);
        break;
      case "g":
        this.openPR(null, cx);
        break;
      case "r":
        this.loadDetail(cx);
        break;
      default:
        return false;
    }
    return true;
  }

  projectKey(k, cx) {
    const p = this.curProject;
    switch (k) {
      case "left":
      case "backspace":
        this.back(cx);
        break;
      case "enter":
      case "i":
        this.drill(p, cx);
        break;
      case "w":
        this.worktree(cx, false, { project: p });
        break;
      case "s":
        this.worktree(cx, true, { project: p });
        break;
      case "n":
        this.create(cx);
        break;
      case "i":
        if (!props()?.attachSpace) this.create(cx, true);
        break;
      case "o":
        this.open(p.url, cx);
        break;
      default:
        return false;
    }
    return true;
  }

  listKey(k, cx) {
    if (this.signedOut) return false;
    const n = this.shown?.length ?? 0;
    const r = this.shown?.[this.at];
    if (k === "down" && n) (this.at = Math.min(n - 1, this.at + 1)), this.follow();
    else if (k === "up" && n) (this.at = Math.max(0, this.at - 1)), this.follow();
    else if (k === "pagedown" && n) (this.at = Math.min(n - 1, this.at + 12)), this.follow();
    else if (k === "pageup" && n) (this.at = Math.max(0, this.at - 12)), this.follow();
    else if (k === "right" && !this.filter) this.step(1, cx);
    else if (k === "left" && !this.filter) this.drilled ? this.escape(cx) : this.step(-1, cx);
    else if (k === "ctrl-s" && r) this.worktree(cx, true, r);
    else if (k === "ctrl-o" && r) this.open((r.issue ?? r.project).url, cx);
    else if (k === "ctrl-n") this.create(cx);
    else if (k === "ctrl-i" && !props()?.attachSpace) this.create(cx, true);
    else if (k === "ctrl-t") this.switchWorkspace(cx);
    else return false;
    return true;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  // An issue's row, one line: its status icon in Linear's colour, key and
  // title; then, quietly, its project, who has it (when not you), its
  // worktree and agents, and its priority at the end. The chosen one lifts,
  // with an edge in its status's colour.
  issueCard(o, is, on, i) {
    const color = hue(o, is.state.color);
    const prio = priorityIcon(is.priority);
    const ag = this.agentsOf(is);
    const busy = ag.find((a) => a.status === "working");
    const meta = (text, ic, c) => h_flex().flex_none().gap(4).items_center().text_size(12).text_color(c ?? o.dim)
      .when(Boolean(ic), (el) => el.child(icon(ic, c ?? o.dim, 12))).child(div().child(text));
    return h_flex()
      .id(`is-${is.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(color)))
      .child(icon(stateIcon(is.state), color, 14))
      .child(div().flex_none().w(64).font_family(MONO).text_size(11.5).text_color(o.muted).truncate().child(is.identifier))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(is.title))
      .when(ag.length > 0, (el) => el.child(busy
        ? h_flex().flex_none().gap(4).items_center().child(icon("work", o.work, 12).spin(1100)).child(div().text_size(12).text_color(o.work).child(ag.length === 1 ? "agent" : `${ag.length} agents`))
        : meta(ag.length === 1 ? "agent" : `${ag.length} agents`, "person")))
      .when(Boolean(this.treeOf(is.branch)), (el) => el.child(icon("worktree", o.accent, 13)))
      // The project and who has it, in columns of their own so the rows line
      // up: the project not in a project's own list, where it's the same on
      // every row.
      .when(this.width >= 760 && !this.drilled, (el) => el.child(div().flex_none().w(150).truncate().text_size(12).text_color(o.dim).child(is.project?.name ?? "")))
      .child(h_flex().flex_none().w(this.width >= 700 ? 130 : 96).justify_end().overflow_hidden()
        .when(Boolean(is.assignee && !is.mine), (el) => el.child(meta(is.assignee ?? "", "person")))
        .when(!is.assignee, (el) => el.child(meta("unassigned"))))
      .child(div().flex_none().w(14).child(prio ? icon(prio, is.priority === 1 ? o.fix : o.muted, 13) : div()));
  }

  // A project's row, one line, as an issue's: its status icon, name and
  // teams; then a bar of how far along it is, its lead and target date, in
  // columns so the rows line up.
  projectCard(o, p, on, i) {
    const color = hue(o, p.status.color);
    const pct = Math.round((p.progress ?? 0) * 100);
    const wide = this.width >= 760;
    return h_flex()
      .id(`pj-${p.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(color)))
      .child(icon(projectIcon(p.status.type), color, 14))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(p.name))
      .when(Boolean(this.treeOf(p.branch)), (el) => el.child(icon("worktree", o.accent, 13)))
      .child(div().flex_none().w(64).truncate().font_family(MONO).text_size(11.5).text_color(o.dim).child(p.teams.join(" ")))
      .child(h_flex().flex_none().w(96).gap(6).items_center()
        .child(div().flex_none().w(52).h(4).rounded(2).bg(o.line).overflow_hidden().child(div().h_full().w(Math.round(0.52 * pct)).bg(color)))
        .child(div().text_size(12).text_color(o.muted).child(`${pct}%`)))
      .when(wide, (el) => el.child(div().flex_none().w(120).truncate().text_size(12).text_color(o.dim).child(p.lead ?? "")))
      .when(wide, (el) => el.child(div().flex_none().w(80).text_size(12).text_color(o.dim).child(p.targetDate ?? "")));
  }

  heading(o, label, color, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(color ?? o.dim).child(label.toUpperCase()))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    const w = this.workspace();
    let bar = h_flex().flex_none().gap(4).items_center();
    if (this.drilled) {
      bar = bar
        .child(h_flex().id("undrill").flex_none().h(28).px(8).gap(6).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.undrill(cx))
          .child(icon("back", o.muted, 13)).child(div().text_size(12.5).text_color(o.muted).child(this.drillFrom ? "Project" : "Projects")))
        .child(h_flex().flex_none().h(28).px(10).gap(7).items_center().rounded(7).bg(o.raised).shadow_sm()
          .child(icon(projectIcon(this.drilled.status.type), hue(o, this.drilled.status.color), 12))
          .child(div().text_size(12.5).font_semibold().text_color(o.fg).child(this.drilled.name))
          .child(countPill(o, this.lists.project?.loaded ? this.lists.project.items.length : null, true)));
    } else {
      bar = bar.children(TABS.map((tb) => {
        const on = tb.id === this.tab;
        const l = this.lists[tb.id];
        return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
          .when(on, (el) => el.bg(o.raised).shadow_sm())
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => {
            this.tab = tb.id;
            localStorage.setItem("tab", tb.id);
            this.at = 0;
            cx.notify();
          })
          // Its icon, the spinner in its place while it loads: the same
          // size, so the tabs never move.
          .child(l?.loading ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
          .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(this.width < 700 ? tb.short ?? tb.label : tb.label))
          .child(countPill(o, l?.loaded ? l.items.length : null, on));
      }));
    }
    bar = bar.child(div().flex_1());
    // The workspace: with several, a click (or ctrl+t) goes to the next.
    if (w) {
      const many = this.workspaces.length > 1 && !this.demo;
      bar = bar.child(h_flex().id("ws").flex_none().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(o.line)
        .when(many, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.switchWorkspace(cx)))
        .child(div().text_size(12).text_color(o.muted).child(w.name))
        .when(many, (el) => el.child(div().font_family(MONO).text_size(11).text_color(o.dim).child(`${this.workspaces.findIndex((x) => x.id === w.id) + 1}/${this.workspaces.length}`))));
    }
    return bar;
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  // The list: notes about it (an error, empty, loading), and its entries,
  // headings and rows, each of a fixed height, for the virtual list that
  // keeps the chosen row in sight.
  listBody(o) {
    const notes = [];
    const entries = [];
    this.entryOf = [];
    const l = this.lists[this.drilled ? "project" : this.tab];
    const rows = this.shown;
    if (l?.error) notes.push(this.note(o, l.error, o.fix));
    else if (!rows.length) {
      const empty = this.err ? "" : !l?.loaded || l.loading ? "Loading…"
        : this.filter ? "Nothing matches. An issue's key (HAL-212, or 212) looks in the whole workspace."
        : this.tab === "recent" ? "Nothing you filed lately." : this.tab === "projects" && !this.drilled ? "No projects." : "No open issues.";
      if (empty) notes.push(this.note(o, empty));
    }
    let last;
    rows.forEach((r, i) => {
      if (r.group && r.group !== last) {
        entries.push({ key: `h-${r.group}`, h: HEADING_H, el: () => this.heading(o, r.group, r.color ? hue(o, r.color) : null, rows.filter((x) => x.group === r.group).length) });
      }
      last = r.group;
      this.entryOf[i] = entries.length;
      const x = r.issue ?? r.project;
      entries.push({ key: `r-${x.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(r.issue ? this.issueCard(o, r.issue, i === this.at, i) : this.projectCard(o, r.project, i === this.at, i)) });
    });
    const after = l?.warning ? div().px(14).py(6).text_size(11.5).text_color(o.dim).child(l.warning) : null;
    return { notes, entries, after };
  }

  listView(o) {
    const { notes, entries, after } = this.listBody(o);
    return v_flex().flex_1().min_h(0).gap(2)
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("ln-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            // A click chooses a row; on the chosen one, opens it.
            .on_item_click((key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            }))
          .child(Scrollbar.vertical("ln-rows").absolute().inset_0())))
      .when(Boolean(after), (el) => el.child(after));
  }

  // Keeps the chosen row in sight: the first, with its heading.
  follow() {
    const e = this.entryOf?.[this.at];
    if (e == null) return;
    this.scroll.scroll_to_item(this.at === 0 ? 0 : e);
  }

  field(o, label, kids) {
    return h_flex().gap(10).items_center().min_h(24)
      .child(div().flex_none().w(72).text_size(12).text_color(o.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().items_center().children([kids].flat().filter(Boolean)));
  }

  backButton(o, label) {
    return h_flex().id("back").flex_none().h(24).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => this.back(cx))
      .child(icon("back", o.muted, 13))
      .child(div().text_size(12).text_color(o.muted).child(label));
  }

  fromLabel() {
    if (this.direct && this.backTo?.label) return this.backTo.label;
    if (this.direct && this.from) return { recap: "Recap", github: "GitHub" }[this.from] ?? this.from;
    if (this.drilled) return this.drilled.name;
    const tb = TABS.find((x) => x.id === this.tab);
    return tb.short ?? tb.label;
  }

  // An issue's screen.
  issueView(o) {
    const is = this.cur;
    const d = this.detail;
    const color = hue(o, is.state?.color);
    const tree = this.treeOf(is.branch);
    const ag = this.agentsOf(is);
    const prio = priorityIcon(is.priority);
    const canStart = d && !d.startWhy && is.state?.type !== "started";
    return v_flex().flex_1().min_h(0).gap(10)
      .child(
        h_flex().flex_none().gap(10).items_center()
          .child(this.backButton(o, this.fromLabel()))
          .when(Boolean(is.state), (el) => el.child(chip(o, "state", [icon(stateIcon(is.state), color, 12), is.state.name], { color, click: (cx) => this.statusMenu(cx) })))
          .child(div().font_family(MONO).text_size(12.5).text_color(o.muted).child(is.identifier))
          .child(div().text_size(12.5).text_color(o.dim).child(this.workspace()?.name ?? ""))
          .child(div().flex_1()),
      )
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).line_height(1.35).child(is.title ?? ""))
      .when(Boolean(d), (el) => el
        .child(this.field(o, "Assignee", is.assignee ? [icon("person", o.dim, 13), div().text_color(o.fg).child(is.mine ? `${is.assignee} (you)` : is.assignee)] : div().text_color(o.dim).child("unassigned")))
        .child(this.field(o, "Priority", [prio ? icon(prio, is.priority === 1 ? o.fix : o.muted, 13) : null, div().text_color(is.priority ? o.fg : o.dim).child(d.priorityLabel || PRIORITIES[is.priority])]))
        .when(Boolean(is.project), (el) => el.child(this.field(o, "Project", chip(o, "proj", [icon("project", o.dim, 12), is.project?.name ?? ""]))))
        .when(Boolean(d.cycle), (el) => el.child(this.field(o, "Cycle", div().text_color(o.fg).child(d.cycle ?? ""))))
        .when(Boolean(d.dueDate), (el) => el.child(this.field(o, "Due", [icon("calendar", o.dim, 13), div().text_color(o.fg).child(d.dueDate ?? "")])))
        .when(d.labels.length > 0, (el) => el.child(this.field(o, "Labels", d.labels.map((l) => chip(o, `lb-${l.name}`, [div().w(7).h(7).rounded_full().bg(hue(o, l.color)), l.name])))))
        .when((d.prs ?? []).length > 0, (el) => el.child(this.field(o, "Pull requests", (d.prs ?? []).map((p, i) =>
          chip(o, `pr-${i}`, [icon("pr", o.accent, 12), `#${p.number}`, div().text_color(o.muted).child(p.title.length > 48 ? p.title.slice(0, 47) + "…" : p.title)], { color: o.accent, click: (cx) => this.openPR(p, cx) })))))
        .child(this.field(o, "Branch", [chip(o, "branch", [icon("branch", o.dim, 13), is.branch], { mono: true, click: (cx) => this.copy(is.branch, cx) }),
          tree ? chip(o, "tree", [icon("worktree", o.accent, 12), "worktree"], { color: o.accent }) : div().text_size(12).text_color(o.dim).child("no worktree yet")]))
        // Why it can't be started; or what starting it does, and the way to.
        .when(Boolean(d.startWhy), (el) => el.child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.work, 0.12))
          .child(icon("need", o.work, 15))
          .child(div().flex_1().min_w(0).text_color(o.fg).child((d.startWhy ?? "").replace(/ \(w opens.*\)$/, ": w opens its worktree without starting it")))))
        .when(Boolean(canStart), (el) => el.child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.accent, 0.1))
          .child(icon("play", o.accent, 15))
          .child(div().flex_1().min_w(0).text_color(o.fg).child(`Start: ${is.assignee ? "" : "yours, "}In Progress, and an agent in its worktree working on it`))
          .child(h_flex().id("start-btn").flex_none().h(26).px(10).items_center().rounded(6).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.worktree(cx, true))
            .child(div().text_size(12).font_semibold().text_color(o.surface).child("Start"))))))
      .when(ag.length > 0, (el) => el.child(
        v_flex().flex_none().gap(1)
          .child(div().px(2).pb(2).text_size(10.5).font_semibold().text_color(o.dim).child(`AGENTS ${ag.length}`))
          .children(ag.slice(0, 4).map((a, i) => h_flex().id(`ag-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
            .on_click(() => {
              this.dismiss();
              run("agent.focus", { terminal: a.address });
            })
            .child(a.status === "working" ? icon("work", o.work, 14).spin(1100) : a.status === "blocked" ? icon("need", o.need, 14) : icon("idle", o.dim, 14))
            .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(o.fg).child(a.name))
            .child(h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).border_1().border_color(o.line).bg(o.sunk).font_family(MONO).text_size(10.5).text_color(o.fg)
              .child(icon(a.machine ? "server" : "laptop", o.muted, 11)).child(div().child(a.machine ?? "this computer")))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11.5).text_color(o.dim).child(a.status ?? ""))))))
      .child(div().flex_none().h(1).bg(o.line))
      .child(v_flex().id("is-body").h(360).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6)
        .child(d
          ? TextView.markdown(`md-${is.id}`, d.description || "*No description.*").selectable(true).text_size(13).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))
          : div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…")));
  }

  // A project's screen.
  projectView(o) {
    const p = this.curProject;
    const d = this.projDetail;
    const color = hue(o, p.status.color);
    const pct = Math.round((p.progress ?? 0) * 100);
    const tree = this.treeOf(p.branch);
    return v_flex().flex_1().min_h(0).gap(10)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.backButton(o, "Projects"))
        .child(chip(o, "pstate", [icon(projectIcon(p.status.type), color, 12), p.status.name], { color }))
        .child(div().font_family(MONO).text_size(12.5).text_color(o.dim).child(p.teams.join(" "))))
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).child(p.name))
      .when(Boolean(d?.description), (el) => el.child(div().text_size(13).text_color(o.muted).child(d?.description ?? "")))
      .child(this.field(o, "Progress", [div().flex_none().w(140).h(6).rounded(3).bg(o.line).overflow_hidden().child(div().h_full().w(Math.round(1.4 * pct)).bg(color)), div().text_color(o.fg).child(`${pct}%`)]))
      .when(Boolean(p.lead), (el) => el.child(this.field(o, "Lead", [icon("person", o.dim, 13), div().text_color(o.fg).child(p.lead ?? "")])))
      .when(Boolean(d?.startDate || p.targetDate), (el) => el.child(this.field(o, "Dates", [icon("calendar", o.dim, 13), div().text_color(o.fg).child(`${d?.startDate || "?"} → ${p.targetDate || "?"}`)])))
      .child(this.field(o, "Branch", [chip(o, "pbranch", [icon("branch", o.dim, 13), p.branch], { mono: true }), tree ? chip(o, "ptree", [icon("worktree", o.accent, 12), "worktree"], { color: o.accent }) : null]))
      .child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.accent, 0.1))
        .child(icon("project", o.accent, 15)).child(div().flex_1().text_color(o.fg).child("Its open issues, as a list"))
        .child(h_flex().id("drill-btn").flex_none().h(26).px(10).items_center().rounded(6).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => this.drill(p, cx))
          .child(div().text_size(12).font_semibold().text_color(o.surface).child("Its issues"))))
      .child(div().flex_none().h(1).bg(o.line))
      .child(v_flex().id("pj-body").h(300).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6)
        .child(d ? TextView.markdown(`pmd-${p.id}`, d.content || "*No overview.*").selectable(true).text_size(13).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))
          : div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…")));
  }

  // The new issue's form.
  createView(o) {
    const f = this.form;
    const canCreate = !this.busy && !f.loadingStates && !f.statesError && (Boolean(props()?.attachSpace) || Boolean(this.launchTarget?.folder));
    const states = f.team ? f.states[f.team.id] ?? [] : [];
    if (f.unreadable) return v_flex().gap(8).child(div().text_color(o.fix).child(f.unreadable))
      .child(this.button("capture-corrupt-close", "Close", cx => this.back(cx)))
      .when(typeof f.unreadableRaw === "string", el => el.child(this.button("capture-corrupt-discard", f.confirmDiscard ? "Confirm delete unreadable draft" : "Discard unreadable draft", cx => {
        if (f.confirmDiscard) this.closeCapture(cx, true); else { f.confirmDiscard = true; cx.notify(); }
      })));
    if (f.capture && f.draft.uncertain) return this.uncertainCaptureView(o, f);
    const pick = (id, items, isOn, onPick) => h_flex().gap(6).flex_wrap().items_center().children(items.map((x, i) => {
      const on = isOn(x);
      return h_flex().id(`${id}-${i}`).flex_none().h(24).px(8).gap(5).items_center().rounded(6).cursor_pointer()
        .border_1().border_color(on ? o.accent : o.line).when(on, (el) => el.bg(tint(o.accent, 0.14))).when(!on, (el) => el.hover((s) => s.bg(o.raised)))
        .on_click((_e, cx) => {
          if (this.busy) return;
          onPick(x, cx);
          if (f.capture) this.saveCapture(cx);
          else this.rememberTaskOptions();
          cx.notify();
        })
        .children(x.parts.filter(Boolean).map((p) => (typeof p === "string" ? div().text_size(12).text_color(on ? o.fg : o.muted).child(p) : p)));
    }));
    const input = (state) => h_flex().h(36).flex_none().px(12).items_center().rounded(8).border_1().border_color(o.line).bg(o.sunk)
      .child(Input.new(state).flex_1().h_full().text_size(13).text_color(o.fg));
    const textarea = state => v_flex().flex_none().p(10).rounded(8).border_1().border_color(o.line).bg(o.sunk)
      .child(Textarea.new(state).w_full().text_size(13).text_color(o.fg));
    const details = f.details;
    return v_flex().id("create-form").flex_1().min_h(0).overflow_y_scrollbar().gap(12)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.backButton(o, this.fromLabel()))
        .child(div().text_size(14).font_semibold().text_color(o.fg).child(f.capture ? "New task" : `New issue in ${this.workspace()?.name ?? "Linear"}`)))
      .when(f.capture && !f.review, el => el
        .child(div().text_size(13).text_color(o.fg).child("What would you like to improve?"))
        .child(textarea(this.idea)))
      .when(f.capture && f.review, el => el
        .when(Boolean(this.idea.value()), el => el.child(input(this.title)))
        .child(textarea(this.captureDescription))
        .when(Boolean(this.idea.value()), el => el
          .child(this.button("source-toggle", f.editIdea ? "Hide source idea" : "Edit source idea", cx => { f.editIdea = !f.editIdea; cx.notify(); }))
          .when(f.editIdea, el => el.child(textarea(this.idea))
            .child(this.button("source-shape", "Shape ticket", cx => this.reviewCapture(cx))))))
      .when(!f.capture, el => el.child(textarea(this.desc)))
      .child(this.field(o, "Team", f.teams
        ? pick("tm", f.teams.map((t) => ({ ...t, parts: [div().font_family(MONO).text_size(11.5).text_color(o.muted).child(t.key), t.name] })), (t) => t.id === f.team?.id, (t, cx) => this.pickTeam(t, cx))
        : div().text_color(o.dim).child("Loading…")))
      .when(f.capture, el => el.child(this.field(o, "Project", this.projectField(o))))
      .child(h_flex().flex_wrap().gap(6).child(this.button("capture-details", f.details ? "Hide ticket details" : "Ticket details", cx => { f.details = !f.details; cx.notify(); }))
        .child(div().text_size(11.5).text_color(o.muted).child([states.find(s => s.id === f.state)?.name, PRIORITIES[f.priority], f.assignToMe ? "Me" : "Nobody"].filter(Boolean).join(" · "))))
      .when(details, el => el.child(this.field(o, "Status", states.length
        ? pick("st", states.filter((s) => s.type !== "completed" && s.type !== "canceled").map((s) => ({ ...s, parts: [icon(stateIcon(s), hue(o, s.color), 12), s.name] })), (s) => s.id === f.state, (s) => (f.state = s.id))
        : div().text_color(o.dim).child("…"))))
      .when(details, el => el.child(this.field(o, "Priority", pick("pr", PRIORITIES.map((n, i) => ({ i, parts: [priorityIcon(i) ? icon(priorityIcon(i), i === 1 ? o.fix : o.muted, 12) : null, n] })), (x) => x.i === f.priority, (x) => (f.priority = x.i)))))
      .when(!f.capture, el => el.child(this.field(o, "Project", this.projectField(o))))
      .when(details, el => el.child(this.field(o, "Assignee", pick("me", [{ me: true, parts: [icon("person", o.muted, 12), "Me"] }, { me: false, parts: ["Nobody"] }], (x) => x.me === f.assignToMe, (x) => (f.assignToMe = x.me)))))
      .when(!props()?.attachSpace && Boolean(this.launchOptions), el => el.child(this.launchOptions()))
      .when(f.capture, el => el.child(this.captureActions(o, f)))
      .when(!f.capture, el => el.child(h_flex().flex_none().gap(10).items_center()
        .child(div().flex_1().text_size(11).text_color(o.muted).child(props()?.attachSpace ? `Creating also attaches to ${props().attachSpace.name}` : "Create a ticket, or start work in its own worktree"))
        .child(h_flex().id("create-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).opacity(canCreate ? 1 : 0.5).when(canCreate, el => el.cursor_pointer().hover(s => s.opacity(0.85)))
          .on_click((_e, cx) => { if (canCreate) this.submit(cx); })
          .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Create issue")))
        .when(!props()?.attachSpace && Boolean(this.createStartButton), el => el.child(this.createStartButton()))));
  }

  captureActions(o, f) {
    const ready = !!(f.team && f.states[f.team.id]?.some(s => s.id === f.state && !["completed", "canceled"].includes(s.type)) && (this.captureDescription.value().trim() || this.title.value().trim()) && !this.busy);
    return v_flex().flex_none().gap(7)
      .when(f.saveError, el => el.child(div().text_size(12).text_color(o.fix).child(f.saveError))
        .child(h_flex().gap(7).flex_wrap().child(this.button("capture-copy", "Copy my idea", cx => this.copy(this.idea.value(), cx)))
          .child(this.button("capture-reopen", "Reload saved draft", cx => this.create(cx, true, f.project)))))
      .when(f.draft.revision && !f.saveError, el => el.child(div().text_size(11).text_color(o.muted).child("Draft saved on this computer")))
      .child(h_flex().gap(7).flex_wrap().items_center()
        .when(!f.review, el => el.child(this.button("capture-review", "Shape ticket", cx => this.reviewCapture(cx), { primary: true, enabled: !!this.idea.value().trim() })))
        .when(f.review, el => el.child(this.button("capture-create", "Create task", cx => this.submitCapture(cx), { primary: true, enabled: ready && !f.saveError }))
          .when(!props()?.attachSpace && Boolean(this.createStartButton), el => el.child(this.createStartButton())))
        .when(!f.teams || (f.team && !f.states[f.team.id]), el => el.child(this.button("capture-reload", "Reload ticket details", cx => this.loadFormTeams(cx))))
        .child(this.button("capture-close", "Save and close", cx => this.back(cx)))
        .child(this.button("capture-discard", "Discard draft", cx => { f.confirmDiscard = true; cx.notify(); })))
      .when(f.confirmDiscard, el => el.child(h_flex().gap(7).flex_wrap().child(this.button("capture-confirm-discard", "Delete this draft", cx => this.closeCapture(cx, true)))
        .child(this.button("capture-keep", "Keep draft", cx => { f.confirmDiscard = false; cx.notify(); }))))
      .when(f.review, el => el.child(h_flex().gap(7).flex_wrap().items_center()
        .child(this.button("capture-ai", f.shaping ? "Improving…" : "Improve with AI", cx => this.improveCapture(cx), { enabled: !f.shaping && !this.busy }))
        .child(div().text_size(11.5).text_color(o.muted).child("Optional: sends task text to OpenAI to suggest a title and description."))));
  }

  uncertainCaptureView(o, f) {
    const confirmed = f.confirmedIssue ?? f.draft.confirmedIssue;
    if (confirmed) return v_flex().gap(8)
      .child(div().text_color(o.fg).child(`Linear created ${confirmed.identifier}.`))
      .when(confirmed.url, el => el.child(this.button("capture-confirmed-link", "Open in Linear", cx => this.open(confirmed.url, cx))))
      .child(this.button("capture-confirmed-open", "Open ticket and clear draft", cx => this.openConfirmedCapture(confirmed, f, cx), { enabled: !this.busy }))
      .child(this.button("capture-confirmed-close", "Close", cx => this.back(cx), { enabled: !this.busy }));
    return v_flex().id("capture-recovery").flex_1().min_h(0).overflow_y_scrollbar().gap(10)
      .child(div().text_size(15).font_semibold().text_color(o.fg).child(this.busy ? "Checking ticket creation" : "Creation not confirmed"))
      .child(div().text_size(13).text_color(o.fg).child(f.draft.title))
      .child(div().text_size(12).text_color(o.muted).child("Your draft is saved. Check recent issues for an existing ticket before trying again."))
      .child(h_flex().flex_wrap().gap(7).child(this.button("capture-check", "Check recent issues", cx => this.checkCaptureResult(cx), { primary: true, enabled: !this.busy }))
        .child(this.button("capture-later", "Close", cx => this.back(cx), { enabled: !this.busy })))
      .children((f.matches ?? []).map(is => h_flex().gap(6).flex_wrap()
        .child(this.button(`capture-open-${is.id}`, `Open ${is.identifier} in Linear`, cx => this.open(is.url, cx)))
        .child(this.button(`capture-use-${is.id}`, `Use ${is.identifier}`, cx => this.openConfirmedCapture(is, f, cx), { enabled: !this.busy }))))
      .when(Array.isArray(f.matches) && !this.busy, el => el.child(h_flex().flex_wrap().child(this.button("capture-allow-retry", "I checked Linear. Allow another attempt", cx => {
        if (this.saveCapture(cx, { uncertain: false })) { f.matches = null; this.say("Review the draft before creating another ticket.", cx); }
      }))));
  }

  menuView(o) {
    const m = this.menu;
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(m.title))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click((_e, cx) => this.choose(it, cx))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1)))
          .when(Boolean(it.icon), (el) => el.child(icon(it.icon, hue(o, it.color), 13)))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, fn, id);
    if (this.menu) {
      return [k(["↑", "↓"], "choose", () => {}, "f-ch"), k(["enter"], "do it", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "issue") {
      return [
        k(["w"], "worktree", (cx) => this.worktree(cx, false), "f-w"),
        k(["s"], "start", (cx) => this.worktree(cx, true), "f-s"),
        k(["c"], "status", (cx) => this.statusMenu(cx), "f-c"),
        k(["n"], "new task", (cx) => this.create(cx), "f-n"),
        k(["o"], "Linear", (cx) => this.open(this.cur.url, cx), "f-o"),
        k(["y"], "copy key", (cx) => this.copy(this.cur.identifier, cx), "f-y"),
        k(["b"], "copy branch", (cx) => this.copy(this.cur.branch, cx), "f-b"),
        ...((this.detail?.prs ?? []).length ? [k(["g"], "pull request", (cx) => this.openPR(null, cx), "f-g")] : []),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.screen === "project") {
      return [
        k(["enter"], "its issues", (cx) => this.drill(this.curProject, cx), "f-i"),
        k(["w"], "worktree", (cx) => this.worktree(cx, false, { project: this.curProject }), "f-w"),
        k(["s"], "start", (cx) => this.worktree(cx, true, { project: this.curProject }), "f-s"),
        k(["n"], "new task", (cx) => this.create(cx), "f-n"),
        k(["o"], "Linear", (cx) => this.open(this.curProject.url, cx), "f-o"),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.screen === "create") {
      if (this.form?.capture) return [k(["esc"], "close draft", cx => this.escape(cx), "f-esc")];
      return [k(["tab"], "next field", () => {}, "f-tab"), k(["enter"], "create", (cx) => this.submit(cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.signedOut) return [k(["esc"], "close", (cx) => this.escape(cx), "f-esc")];
    const sel = this.shown?.[this.at];
    const out = [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["^s"], "start", (cx) => sel && this.worktree(cx, true, sel), "f-s"),
      k(["^n"], "new task", (cx) => this.create(cx), "f-n"),
      k(["^o"], "Linear", (cx) => sel && this.open((sel.issue ?? sel.project).url, cx), "f-o"),
    ];
    if (this.workspaces.length > 1 && !this.demo) out.push(k(["^t"], "workspace", (cx) => this.switchWorkspace(cx), "f-t"));
    out.push(k(["←", "→"], this.drilled ? "back" : "tabs", (cx) => (this.drilled ? this.escape(cx) : this.step(1, cx)), "f-tab"));
    out.push(k(["esc"], "close", (cx) => this.escape(cx), "f-esc"));
    return out;
  }

  signInView(o) {
    return v_flex().flex_none().gap(12).px(14).py(18).items_start()
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Sign in to Linear"))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5).child("You're not signed in to Linear on any machine. Signing in opens a terminal here running herdr-linear's sign-in, which opens Linear in your browser; then open this again. The TUI plugin, if you use it, shares the sign-in."))
      .child(h_flex().id("signin-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => this.signIn(cx))
        .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Sign in")))
      .child(words(o, [[["or try the demo", o.accent, (cx) => {
        this.demo = true;
        this.signedOut = false;
        this.start(cx);
      }]]], "demo-link"));
  }

  render() {
    const t = theme();
    const o = tones(t);
    this.shown = this.shownRows();
    if (this.screen === "list") this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    const scr = this.screen;
    return v_flex()
      .id("linear")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      // The keyboard: the filter's, in the list (as Recap's), so ↑ ↓ reach the
      // list through it; on a screen without one, the popup's own.
      .when((scr !== "list" && scr !== "create") || this.signedOut, (el) => el.track_focus(this.keys))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.escape(cx);
        else if (scr === "create") return;
        else if (!(scr === "issue" ? this.issueKey(k, cx) : scr === "project" ? this.projectKey(k, cx) : this.menu ? this.menuKey(k, cx) : this.listKey(k, cx))) return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(scr === "list" && !this.signedOut, (el) => el
        .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
          .child(div().flex_none().text_size(12).text_color(o.muted).child(this.demo ? "Demo · made-up workspace" : "")))
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(scr === "list" && Boolean(this.signedOut), (el) => el.child(this.signInView(o)))
      .when(scr === "issue", (el) => el.child(this.issueView(o)))
      .when(scr === "project", (el) => el.child(this.projectView(o)))
      .when(scr === "create", (el) => el.child(this.createView(o)))
      .when(Boolean(this.menu), (el) => el.child(this.menuView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}

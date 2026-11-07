// Derived from the MIT-licensed herdr-linear app mod v0.14.2.
// Modified for Eric's Herdr Linear: spaces-first layout, configurable enrichment and attention rules.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popup, TextView } from "gpui-base";
import { setAgentOrder, run, openOverlay, closeOverlay, knownAgents, appHome, exec } from "herdr";
import { spaces, panes, agents, machines, theme, settings, shared, setShared, props, window, keys, inFrame } from "./host.js";
import * as fs from "fs/promises";
import LinearClient from "./client.js";
import { computers, loadTarget, repositoryName, selectRepository as selectTargetRepository } from "./repository.js";
import { tint, icon, stateIcon, priorityIcon, MONO } from "./look.js";
import { issueKey, issueLabel, issueHeadline, issueHover, folderOf, matchIssue, workRecords, taskContext, issueMenuItems, spaceMenuItems } from "./model.js";
import { boardTree, machineGroups, issueNeedsYou, visibleLabels, delegateOf, laneSince, elapsed, linearMismatch } from "./board.js";
import { fetchEnrichment, indexEnrichment, fetchQueue, fetchAgents, fetchIssueDetail, reassignIssue, fetchPullRequests, rowPullRequest } from "./enrich.js";
import { attentionOf, sortQueue, queueCounts, crewRoster, herdrActivity, age, queueStatus, reassignBatch, batchSummary,
  crewContext, reassignChoices, requestGate, undelegatedEntry, undelegatedStatus, handoffWords, UNDELEGATED_NAME } from "./queue.js";
import { normalizeConfig } from "./config.js";
import { machineColor, machineLabel, machineState, stateWord } from "./machines.js";
import { stackLayout, clampScroll, pinnedHeader, thumb } from "./sticky.js";
import { readGitState, readPr, headerParts, aheadBehind, uncommitted, workingSince, runningFor, branchHover } from "./git.js";
import { finishedReason, ticketFinished, cleanupCandidates, keepOpenReason, autoCloseDue, gitSummary, removable, REMOVE_WORKTREE } from "./cleanup.js";
import { sidebarGroups, toggleCollapsed, GROUP_MODES, GROUP_LABELS, normalizeGroupMode } from "./groups.js";
import { isPinned, rowTags, rowColor, tagMenuItems, fetchIssueTags, fetchCatalog, pickable, canCreate, tagName,
  setTag, setPinned, createTag, labelState, withLabels, fetchIssueLabels } from "./tags.js";
import { FILTER_FIELDS, normalizeFilters, toggleFilter, filterCount, matchesFilters, filterOptions } from "./filters.js";

// Shared with the linear-workspace layout on purpose: an issue/space link made in one
// must not vanish when you switch to the other.
const DATA = "linear-workspace.data", LINKS = "linear-workspace.links";
const PREFS = "linear-workspace.agents", ACTIVE = "linear-workspace.workspace";
// This layout's own state. Enrichment is published by the sidebar copy and read by every
// other copy, so only one of them talks to Linear.
const ENRICH = "linear-board.enrich", FILTER = "linear-board.filters", TEAMS = "linear-board.teams";
const ENRICH_REQUEST = "linear-board.enrich-request";
// Pull requests linked to the issues open in spaces, by issue key. Kept apart from ENRICH
// so a Crew re-read of the enrichment never wipes them.
const PULLS = "linear-board.pulls";
// Labels of the issues open in spaces, in any workflow state, by issue key. Pins, tags and
// row colors are these Linear labels, so they are the same on every machine (CHA-4318).
const TAGS = "linear-board.tags";
const CONFIG = "erics-linear.config";
// How many open spaces need you, for the window header to show while the sidebar is a rail.
const NEEDS = "erics-linear.needs-you";
// The sidebar's fixed row heights, which its pinned group headers are placed by.
const HOME_ROWS = { header: 28, row: 49, gap: 3 };
const ENRICH_MS = 60000;
const AGE_TICK_MS = 30000;
// Crew checks this often whether the sidebar has published its Linear connection, and
// retries a failed agent list no sooner than CREW_RETRY_MS after the last attempt.
const CREW_TICK_MS = 2000, CREW_RETRY_MS = 30000;
// The status bar reads the active workspace's git state and publishes it for the header.
// It looks every GIT_TICK_MS; a re-read is due after GIT_MS (PR_MS for GitHub), or at once
// when the active workspace or its folder changes.
const GIT = "linear-board.git";
const GIT_TICK_MS = 5000, GIT_MS = 15000, PR_MS = 60000;

// Roles that render from shared state alone and never load a Linear list themselves.
const PASSIVE = ["header", "launcher", "spaces", "issue", "agent", "crew", "filters"];

const activeWorkspace = () => shared(ACTIVE) ?? "";
const sharedIssues = () => shared(DATA)?.[activeWorkspace()]?.issues ?? [];
const sharedEnrich = () => shared(ENRICH) ?? { rows: [], error: null, fetchedAt: null, partial: false };
const sharedPulls = () => shared(PULLS)?.pulls ?? {};
const sharedTags = () => shared(TAGS)?.tags ?? {};

/** One issue's labels as the sidebar has them now: the per-space read, else the bulk one. */
function liveLabels(identifier) {
  const key = String(identifier ?? "").toUpperCase();
  const fresh = sharedTags()[key];
  if (fresh) return fresh.labels;
  return sharedEnrich().rows.find(row => String(row.identifier).toUpperCase() === key)?.labels ?? [];
}

/** Publishes labels Linear just returned for one issue, so every copy of the mod redraws
 *  at once. In-flight reads started before the write are dropped rather than published. */
function publishLabels(identifier, labels) {
  const key = String(identifier ?? "").toUpperCase();
  if (!key || !Array.isArray(labels)) return;
  enrichmentRequest();
  setShared(ENRICH, withLabels(sharedEnrich(), key, labels));
  const tags = shared(TAGS) ?? {};
  setShared(TAGS, { ...tags, tags: { ...(tags.tags ?? {}), [key]: labelState(labels) } });
}

// Sidebar and Crew share one publication order, including reads started before a move.
function enrichmentRequest() {
  const version = (shared(ENRICH_REQUEST) ?? 0) + 1;
  setShared(ENRICH_REQUEST, version);
  return () => shared(ENRICH_REQUEST) === version;
}

const isClaude = program => /claude/i.test(`${program?.key ?? ""} ${program?.name ?? ""}`);

/** Records for a copy of the mod that has no lists of its own. */
function sharedRecords(extraIssues = []) {
  return workRecords({
    allSpaces: spaces(), allPanes: panes(), allAgents: agents(),
    issues: [...new Map([...extraIssues, ...sharedIssues()].map(i => [i.identifier, i])).values()],
    links: shared(LINKS) ?? [], workspace: activeWorkspace(),
  });
}

/** The command palette's key as actually bound (as Herdr's own status bar shows it). */
function paletteHint() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = (keys() ?? []).find(k => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  const key = parts && parts.map(p => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
  return key ? `${key}  commands` : "commands";
}

/** Which workspace a git read belongs to: its id, machine and folder. */
function gitKey(space, folder) {
  return space && folder ? `${space.machine ?? ""}\u0000${space.id}\u0000${folder}` : "";
}
/** The published git state, if it is for this space's current folder. */
function gitFor(space) {
  const saved = shared(GIT);
  return space && saved?.key === gitKey(space, folderOf(space, panes())) ? saved : null;
}

function currentSource() {
  const s = spaces().find(s => s.active);
  return s ? { id: s.id, name: s.name, branch: s.branch, tabs: s.tabs, folder: folderOf(s, panes()), machine: s.machine ?? null } : null;
}
function dialog(extra = {}) {
  const source = currentSource(), workspace = shared(ACTIVE);
  const taskIssue = source ? matchIssue(source, shared(DATA)?.[workspace]?.issues ?? [], shared(LINKS) ?? [], workspace, panes()) : null;
  return openOverlay({ mod: "linear-board", kind: "dialog", width: 0.85, height: 0.85,
    props: { role: "dialog", source, taskIssue, workspaceId: workspace, ...extra } });
}

/** An issue's web link; built from the workspace's URL key when a stored link lacks one. */
function issueWithUrl(is) {
  if (!is || is.url) return is;
  const key = shared(DATA)?.[activeWorkspace()]?.workspace?.urlKey;
  return key && is.identifier ? { ...is, url: `https://linear.app/${key}/issue/${is.identifier}` } : is;
}

/** Whether a folder is a repository's own checkout ("main"), a worktree ("linked") or
 *  neither (null), as Herdr's space menu decides which worktree entries to offer. */
async function checkoutKind(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top?.code !== 0 || common?.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

export default class LinearWorkspace extends LinearClient {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? (p.overlay ? "dialog" : "sidebar");
    this.docked = this.role !== "dialog";
    if (this.role === "crew") return void this.crewInit(cx);
    if (this.role === "issue-menu") return void this.issueMenuInit(cx);
    if (this.role === "status") return void this.statusInit(cx);
    if (this.role === "issue-tags") return void this.tagsInit(cx);
    if (PASSIVE.includes(this.role)) {
      // These copies re-render on shared state and on the live space/agent lists; the
      // strip is the only one that needs a clock, to settle its own height.
      return;
    }
    this.readVersion = 0;
    this.extraIssues = {};
    this.resolved = {};
    this.expanded = JSON.parse(localStorage.getItem("expandedProjects") ?? "{}");
    this.openGroups = JSON.parse(localStorage.getItem("openGroups") ?? "{}");
    this.repositorySource = p?.source ?? currentSource();
    this.launchTarget = { machine: this.repositorySource?.machine ?? null, folder: "" };
    this.agentChoices = [];
    this.agentKey = shared(PREFS)?.[this.launchTarget?.machine ?? ""] ?? "codex";
    super.init(p, cx);
    this.ws = p?.workspaceId ?? shared(ACTIVE) ?? this.ws;
    this.tab = "mine";
    if (this.role === "sidebar") {
      cx.timer.every(10000, cx => this.resolveSpaces(cx));
      // Row ages ("Working 4m") move with the clock, not only when a space changes. The same
      // tick closes spaces whose ticket has been finished for the grace period.
      cx.timer.every(AGE_TICK_MS, cx => { cx.notify(); this.autoClose(cx); });
      try {
        this.groupMode = normalizeGroupMode(localStorage.getItem("groupMode"));
        this.collapsed = JSON.parse(localStorage.getItem("collapsedGroups") ?? "{}") ?? {};
      } catch { this.groupMode = "status"; this.collapsed = {}; }
      this.startEnrich(cx);
      cx.timer.every(ENRICH_MS, cx => this.startEnrich(cx));
      this.loadTeams(cx);
    } else if (["capture", "new"].includes(p.action)) {
      if (this.ws) this.create(cx, true, p.project);
    } else if (this.role !== "projects") this.chooseComputer(this.launchTarget.machine, cx);
  }

  /** Delegates and labels, which herdr-linear cannot answer. One copy of the mod fetches
   *  and publishes; a failure leaves the last good read in place and shows why. */
  startEnrich(cx) {
    if (this.enriching) return this.enrichPromise;
    if (this.demo || this.signedOut) return Promise.resolve();
    const workspace = this.ws, epoch = this.workspaceEpoch;
    this.enriching = true;
    this.enrichPromise = new Promise(resolve => cx.spawn(async cx => {
      const latest = enrichmentRequest();
      const current = () => latest() && workspace === this.ws && epoch === this.workspaceEpoch;
      try {
        const text = await fs.readFile(`${appHome()}/erics-linear.config.json`, "utf8").catch(error => {
          if (error?.code === "ENOENT" || /no such file|not found|ENOENT/i.test(String(error?.message ?? error))) return "{}";
          throw error;
        });
        const config = normalizeConfig(JSON.parse(text));
        if (JSON.stringify(shared(CONFIG)) !== JSON.stringify(config)) setShared(CONFIG, config);
        const result = await fetchEnrichment({ on: this.on || null, config });
        if (!current()) return;
        const previous = sharedEnrich();
        if (result.error && !result.rows.length) {
          // Keep the rows we had; only the error line changes.
          setShared(ENRICH, { ...previous, error: result.error, on: this.on || null });
        } else {
          setShared(ENRICH, { rows: result.rows, error: result.error, fetchedAt: result.fetchedAt, partial: result.partial, on: this.on || null });
        }
        await this.loadPulls(config, current);
        await this.loadTags(config, current);
      } catch (error) {
        if (!current()) return;
        setShared(ENRICH, { ...sharedEnrich(), error: `Layout config: ${error?.message ?? error}`, on: this.on || null });
      } finally { this.enriching = false; cx.notify(); resolve(); }
    }));
    return this.enrichPromise;
  }

  /** Pull requests for the issues open in spaces. A failed read keeps the last good one. */
  async loadPulls(config, current = () => true) {
    const ids = this.records().map(r => r.issue?.id).filter(Boolean);
    const result = await fetchPullRequests({ on: this.on || null, config, ids });
    if (!current()) return;
    if (result.error) setShared(PULLS, { ...(shared(PULLS) ?? {}), error: result.error });
    else setShared(PULLS, { pulls: result.pulls, error: null, fetchedAt: Date.now() });
  }

  /** Labels for the issues open in spaces. A failed read keeps the last good one. */
  async loadTags(config, current = () => true) {
    const ids = this.records().map(r => r.issue?.id).filter(Boolean);
    const result = await fetchIssueTags({ on: this.on || null, config, ids });
    if (!current()) return;
    if (result.error) setShared(TAGS, { ...(shared(TAGS) ?? {}), error: result.error });
    else setShared(TAGS, { tags: result.tags, error: null, fetchedAt: Date.now() });
  }

  loadTeams(cx) {
    if (this.demo || (shared(TEAMS) ?? []).length) return;
    cx.spawn(async cx => {
      try {
        const res = await this.linear({ op: "teams" });
        const teams = (res.teams ?? []).map(t => ({ key: String(t.key ?? ""), name: String(t.name ?? t.key ?? "") }));
        if (teams.length) setShared(TEAMS, teams);
      } catch { /* The tree falls back to raw team keys as headers. */ }
      cx.notify();
    });
  }

  /** Enrichment with its rows indexed for lookup.
   *
   *  Built fresh on each call and never cached on `this`: assigning to a field while a
   *  view is rendering makes Herdr abandon that frame ("this view could not be
   *  re-rendered"). Each render path builds this once at the top and passes it down, so
   *  the 241-row index is built once per frame, not once per issue. */
  enrichment() {
    const published = sharedEnrich();
    return { ...published, ...indexEnrichment(published.rows) };
  }

  /** An issue from herdr-linear, with its delegate and labels filled in from Linear.
   *  `index` is this frame's enrichment; without one a lone lookup builds its own. */
  enrich(issue, index = null) {
    if (!issue?.identifier) return issue;
    const lookup = index ?? this.enrichment();
    const key = String(issue.identifier).toUpperCase();
    const extra = lookup.byIdentifier?.get(key);
    const merged = !extra ? issue : { ...issue, delegate: extra.delegate, labels: extra.labels, labelColors: extra.labelColors ?? {}, state: issue.state ?? extra.state,
      priority: Number.isInteger(issue.priority) ? issue.priority : extra.priority,
      teamKey: issue.teamKey ?? extra.teamKey, updatedAt: issue.updatedAt ?? extra.updatedAt ?? null, project: issue.project === undefined ? extra.project : issue.project };
    // The per-space label read covers tickets in any state and is refreshed after each
    // pin or tag change, so it wins over the bulk read of open issues.
    const fresh = sharedTags()[key];
    return fresh ? { ...merged, labels: fresh.labels, labelColors: fresh.colors } : merged;
  }

  filterWorkspace() { return props()?.workspaceId ?? this.ws ?? activeWorkspace(); }
  homeFilters() { return normalizeFilters(shared(FILTER)?.[this.filterWorkspace()]); }
  delegateFilter() { const crew = this.homeFilters().crew; return crew.length === 1 ? crew[0] : null; }

  attentionRules() { return shared(CONFIG)?.attention ?? normalizeConfig().attention; }

  /** Writing shared state fans a re-render out to every copy of every mod. Doing that
   *  synchronously inside a click handler re-enters a sibling copy mid-frame, which Herdr
   *  reports as "this view could not be re-rendered". Deferring by one task lets the
   *  current frame finish first. */
  applyFilter(next, cx) {
    const workspace = this.filterWorkspace();
    const apply = () => {
      const saved = shared(FILTER) ?? {};
      const current = normalizeFilters(saved[workspace]);
      setShared(FILTER, { ...saved, [workspace]: normalizeFilters(typeof next === "function" ? next(current) : next) });
    };
    if (cx?.spawn) cx.spawn(async cx => { apply(); cx.notify(); });
    else apply();
  }
  setDelegateFilter(name, cx) {
    this.applyFilter(current => ({ ...current, crew: current.crew.length === 1 && current.crew[0] === name ? [] : [name] }), cx);
  }

  openFilters() {
    return openOverlay({ mod: "linear-board", kind: "dialog", width: 420, height: 580,
      props: { role: "filters", workspaceId: this.filterWorkspace() } });
  }

  filterChoices(filters = this.homeFilters()) {
    const workspace = this.filterWorkspace(), data = shared(DATA)?.[workspace] ?? {};
    const index = this.enrichment();
    const records = workRecords({ allSpaces: spaces(), allPanes: panes(), allAgents: agents(),
      issues: data.issues ?? [], links: shared(LINKS) ?? [], workspace });
    return filterOptions({ records: records.map(record => ({ ...record, issue: this.enrich(record.issue, index) })),
      issues: (data.issues ?? []).map(issue => this.enrich(issue, index)),
      projects: data.projects ?? [], teams: shared(TEAMS) ?? [], filters });
  }

  filtersView() {
    const t = theme(), filters = this.homeFilters(), choices = this.filterChoices(filters);
    const labels = { team: "Team", status: "Status", project: "Project", crew: "Crew" };
    const field = this.filterField ?? "team";
    const enrichment = sharedEnrich();
    return v_flex().id("home-filters").size_full().min_h(0).p(12).gap(8).bg(t.popover)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().font_semibold().text_size(14).text_color(t.foreground).child("Filters"))
        .child(this.button("filters-clear-all", "Clear all", cx => this.applyFilter({}, cx)))
        .child(this.button("filters-close", "Close", () => closeOverlay(props().overlay))))
      .child(div().flex_none().text_size(11).text_color(t.muted).child("Match any selection within a filter; match all filters."))
      .child(v_flex().id("filter-fields").flex_1().min_h(0).overflow_y_scrollbar().gap(6)
        .children(FILTER_FIELDS.map(key => v_flex().flex_none().gap(3)
          .child(h_flex().items_center().gap(6)
            .child(this.button(`filter-field-${key}`, `${field === key ? "⌄" : "›"} ${labels[key]} · ${filters[key].length || "All"}`, cx => {
              this.filterField = field === key ? "" : key; cx.notify();
            }))
            .child(div().flex_1())
            .when(filters[key].length > 0, el => el.child(this.button(`filter-clear-${key}`, "Clear", cx => this.applyFilter(current => ({ ...current, [key]: [] }), cx)))))
          .when(filters[key].length > 0, el => el.child(div().px(6).text_size(10).text_color(t.accent)
            .child(choices[key].filter(option => filters[key].includes(option.value)).map(option => option.label).join(", "))))
          .when(field === key, el => el.children(choices[key].map((option, i) => h_flex()
            .id(`filter-option-${key}-${i}`).min_h(29).px(8).gap(8).items_center().rounded(5).cursor_pointer()
            .bg(filters[key].includes(option.value) ? t.selected : t.popover).hover(el => el.bg(t.hover))
            .on_click((_e, cx) => this.applyFilter(current => toggleFilter(current, key, option.value), cx))
            .child(div().w(14).flex_none().text_color(t.accent).child(filters[key].includes(option.value) ? "☑" : "☐"))
            .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(option.label))))))))
      .when(Boolean(enrichment.error || enrichment.partial), el => el.child(div().flex_none().text_size(10).text_color(t.blocked)
        .child(enrichment.error ? `Crew metadata: ${enrichment.error}` : "Crew metadata is a partial read.")))
      .child(div().flex_none().text_size(10).text_color(t.muted).child("Activity is space attention; Linear status is the ticket workflow."));
  }

  checkAgents(cx) {
    const generation = this.agentGeneration = (this.agentGeneration ?? 0) + 1;
    const machine = this.launchTarget?.machine ?? null;
    this.agentsChecked = false;
    this.agentChoices = [];
    this.agentKey = shared(PREFS)?.[machine ?? ""] ?? "";
    cx.spawn(async cx => {
      try {
        const choices = (await knownAgents({ on: machine })).filter(a => a.installed);
        if (generation !== this.agentGeneration) return;
        this.agentChoices = choices;
        if (!this.agentChoices.some(a => a.key === this.agentKey)) this.agentKey = this.agentChoices[0]?.key ?? "";
        this.launchError = "";
      } catch (e) {
        if (generation !== this.agentGeneration) return;
        this.agentChoices = []; this.launchError = `Could not check agents: ${e?.message ?? e}`;
      }
      this.agentsChecked = true;
      cx.notify();
    });
  }

  async readCache(cx) {
    if (this.demo) return;
    try {
      const text = await fs.readFile(`${appHome()}/linear-workspace-cache.json`, "utf8")
        .catch(() => fs.readFile(`${appHome()}/linear-cache.json`, "utf8")).catch(() => "{}");
      this.cache = JSON.parse(text);
      this.workspaces = this.cache.workspaces ?? [];
      if (!this.ws) this.ws = Object.keys(this.cache.lists ?? {})[0] ?? "";
      this.seedAll();
      this.publish();
    } catch { this.cache = {}; }
    cx.notify();
  }

  allIssues() {
    const byId = new Map();
    for (const is of [...Object.values(this.lists ?? {}).flatMap(l => l?.items ?? []),
      ...(shared(DATA)?.[this.ws]?.issues ?? [])]) {
      if (is.identifier) byId.set(is.id, is);
    }
    return [...byId.values()];
  }

  publish(incoming = [], version = (this.readVersion = (this.readVersion ?? 0) + 1)) {
    if (!this.ws || this.demo) return;
    const data = shared(DATA) ?? {};
    const issues = new Map(this.allIssues().map(i => [i.id, i]));
    this.issueVersions ??= {};
    for (const is of incoming) if (is.identifier && version >= (this.issueVersions[`${this.ws}/${is.id}`] ?? 0)) {
      issues.set(is.id, is);
      this.issueVersions[`${this.ws}/${is.id}`] = version;
    }
    const next = { workspace: this.workspace(), projects: this.lists.projects?.items ?? data[this.ws]?.projects ?? [], issues: [...issues.values()] };
    if (JSON.stringify(data[this.ws]) !== JSON.stringify(next)) setShared(DATA, { ...data, [this.ws]: next });
    if (this.role === "sidebar" && shared(ACTIVE) !== this.ws) setShared(ACTIVE, this.ws);
  }

  didLoad(tab, cx, version) {
    this.publish(this.lists[tab]?.error ? [] : this.lists[tab]?.items ?? [], version);
    if (this.role === "sidebar") this.resolveSpaces(cx);
    const p = props();
    if (tab === "projects" && this.screen === "create" && this.form?.waitingProjects) {
      this.form.waitingProjects = false;
      this.loadFormTeams(cx);
      if (!this.launchTarget?.folder && !this.form.draft?.execution && !this.form.restoringExecution &&
        this.targetGeneration === this.form.initialTargetGeneration) this.chooseComputer(this.defaultTaskMachine(), cx);
    }
    if (this.role === "dialog" && ["capture", "new"].includes(p.action) && tab === "projects" && !this.startedForm) this.create(cx, true, p.project);
  }

  replaceRow(is) {
    super.replaceRow(is);
    this.publish([is]);
  }
  load(tab, cx, req = { op: "list", tab }) {
    if (this.role !== "sidebar") return super.load(tab, cx, req);
    const list = (this.lists[tab] ??= { items: [], loaded: false });
    if (list.loading) return list.pending;
    const workspace = this.ws, epoch = this.workspaceEpoch, version = (this.readVersion = (this.readVersion ?? 0) + 1);
    list.loading = true;
    cx.notify();
    list.pending = new Promise(resolve => cx.spawn(async cx => {
      try {
        const result = await this.linear(req);
        if ((workspace !== this.ws || epoch !== this.workspaceEpoch) || this.lists[tab] !== list) return;
        list.items = result.issues ?? result.projects ?? [];
        list.warning = result.warning ?? "";
        list.error = "";
        list.cached = false;
        this.signedOut = false;
        this.keep(tab, list.items);
        this.didLoad(tab, cx, version);
      } catch (error) {
        if (workspace === this.ws && epoch === this.workspaceEpoch && this.lists[tab] === list) list.error = String(error?.message ?? error);
      } finally {
        list.loading = false;
        list.loaded = true;
        cx.notify();
        resolve();
      }
    }));
    return list.pending;
  }

  loadAll(cx) {
    super.loadAll(cx);
    for (const [id, open] of Object.entries(this.expanded ?? {})) {
      if (open) this.load(`project:${id}`, cx, { op: "list", tab: "project", project: id });
    }
    return Promise.all(Object.values(this.lists ?? {}).map(list => list?.pending));
  }
  switchWorkspace(cx) {
    this.workspaceEpoch = (this.workspaceEpoch ?? 0) + 1;
    super.switchWorkspace(cx);
    this.publish();
  }
  records() {
    return workRecords({ allSpaces: spaces(), allPanes: panes(), allAgents: agents(),
      issues: this.allIssues(), links: shared(LINKS) ?? [], workspace: this.ws });
  }

  reload(cx) {
    if (this.role === "sidebar") return this.refresh(cx);
    return super.reload(cx);
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    this.err = "";
    let workspace = this.ws;
    let epoch = this.workspaceEpoch;
    cx.notify();
    cx.spawn(async cx => {
      try {
        // Let older reads settle before requesting a new snapshot.
        await Promise.all([...Object.values(this.lists ?? {}).map(list => list?.pending), this.resolvePending, this.enrichPromise]);
        if ((workspace !== this.ws || epoch !== this.workspaceEpoch)) return;
        if (!this.demo && (this.signedOut || this.on == null)) {
          await this.findLinear();
          if (epoch !== this.workspaceEpoch) return;
          if (workspace !== this.ws) {
            this.lists = {};
            this.expanded = {};
            this.drilled = this.found = null;
            this.seedAll();
            epoch = this.workspaceEpoch = (this.workspaceEpoch ?? 0) + 1;
          }
          workspace = this.ws;
          this.signedOut = false;
        }
        await this.loadAll(cx);
        if ((workspace !== this.ws || epoch !== this.workspaceEpoch)) return;
        const failures = [];
        await Promise.all([this.resolveSpaces(cx, true, failures), this.startEnrich(cx)]);
        if ((workspace !== this.ws || epoch !== this.workspaceEpoch)) return;
        failures.push(...Object.values(this.lists ?? {}).map(list => list?.error).filter(Boolean));
        if (sharedEnrich().error) failures.push(sharedEnrich().error);
        this.err = failures.length ? `Refresh incomplete: ${[...new Set(failures)].join("; ")}` : "";
      } catch (error) {
        if (workspace === this.ws && epoch === this.workspaceEpoch) {
          if (error?.signedOut) this.signedOut = true;
          this.err = `Refresh failed: ${error?.message ?? error}`;
        }
      } finally { this.refreshing = false; cx.notify(); }
    });
  }

  resolveSpaces(cx, force = false, failures = []) {
    if (this.refreshing && !force) return Promise.resolve();
    if (this.resolving) return this.resolvePending;
    if (!this.ws || this.demo || (!force && (this.on == null || this.signedOut))) return Promise.resolve();
    const issues = this.allIssues();
    let keys = [...new Set(spaces().map(space => {
      const matched = matchIssue(space, issues, shared(LINKS) ?? [], this.ws, panes());
      if (matched && !force) return null;
      return matched?.identifier ?? issueKey(space.branch) ?? issueKey(space.name) ?? issueKey(folderOf(space, panes()));
    }).filter(Boolean))];
    if (!force) keys = keys.filter(key => Date.now() - (this.resolved[`${this.ws}/${key}`] ?? 0) > 60000).slice(0, 8);
    if (!keys.length) return Promise.resolve();
    const workspace = this.ws, epoch = this.workspaceEpoch, version = (this.readVersion = (this.readVersion ?? 0) + 1);
    this.resolving = true;
    this.resolvePending = new Promise(resolve => cx.spawn(async cx => {
      try {
        for (const key of keys) {
          if ((workspace !== this.ws || epoch !== this.workspaceEpoch)) break;
          this.resolved[`${workspace}/${key}`] = Date.now();
          try {
            const result = await this.linear({ op: "find", key });
            if ((workspace !== this.ws || epoch !== this.workspaceEpoch)) break;
            if (!result.issues?.length) failures.push(`${key}: Linear returned no issue`);
            this.publish(result.issues ?? [], version);
          } catch (error) { failures.push(`${key}: ${error?.message ?? error}`); }
        }
      } finally { this.resolving = false; cx.notify(); resolve(); }
    }));
    return this.resolvePending;
  }

  /** Opens Crew as a kept window: it reopens where it was dropped, and on the next start,
   *  until it is closed. Sized as a share of the Herdr window so both columns fit on a
   *  laptop screen; each column scrolls on its own. */
  openCrew() {
    return openOverlay({
      mod: "linear-board", kind: "window", key: "crew", keep: true, width: 0.72, height: 0.78,
      props: { role: "crew" },
    });
  }

  openProjects() {
    return openOverlay({ mod: "linear-board", kind: "dialog", width: 0.85, height: 0.85,
      props: { role: "projects", workspaceId: activeWorkspace() } });
  }

  /** Reveals the side panel on one of its children. Keyed rather than multi-argument
   *  bindings, so one key both opens the panel and picks what it shows. */
  showPanel(child) {
    run("layout.show", { id: "panel" });
    run("layout.select", { stack: "panel-body", child });
  }

  onCommand(c, cx) {
    if (this.role !== "sidebar") return;
    if (c === "crew") return void this.openCrew();
    if (c === "projects") return void this.openProjects();
    if (["issue", "agent", "files", "changes"].includes(c)) return void this.showPanel(c);
    if (c === "panel") return void run("layout.toggle", { id: "panel" });
    if (c === "clear") return void this.applyFilter(null, cx);
    if (c === "capture") dialog({ action: "capture" });
    else if (c === "new") dialog({ action: "new" });
    else if (c === "details") {
      const r = this.records().find(r => r.space.active);
      if (r?.issue) this.details(r.issue);
      else dialog({ action: "attach", attachSpace: currentSource() });
    } else if (c === "focus") this.input.focus();
  }
  dismiss() { if (props()?.overlay) super.dismiss(); }
  details(is, extra = {}) {
    if (is.project?.id) this.rememberProject(is.project.id, this.ws || shared(ACTIVE));
    dialog({ issue: { key: is.identifier, workspaceKey: this.workspace()?.urlKey }, ...extra });
  }
  selectWork(record) {
    if (record.issue?.project?.id) this.rememberProject(record.issue.project.id, this.ws || shared(ACTIVE));
    const a = record.agents.find(a => a.status === "blocked") ?? record.agents.find(a => a.status === "done") ?? record.agents[0];
    run("space.select", { id: record.space.id });
    if (a) run("agent.focus", { terminal: a.address });
  }
  // Right-click on a space, for the space clicked, not the focused one. With a ticket: the
  // issue entries (Open in Linear app, browser, Copy link) above the space's own (Rename,
  // worktrees, Close). Without one: Herdr's own space menu. Closing a space is Herdr's
  // confirmed close; its ticket is untouched.
  spaceMenu(space, cx, issue = null, folder = null) {
    cx.stop_propagation();
    const is = issueWithUrl(issue);
    if (!is?.url) return openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space.id } } });
    return openOverlay({ mod: "linear-board", kind: "popup", width: 220, height: is.id ? 333 : 268, props: { role: "issue-menu",
      issue: { id: is.id ?? null, identifier: is.identifier ?? "", title: is.title ?? "", url: is.url, teamKey: is.teamKey ?? is.team?.key ?? null },
      space: { id: space.id, folder: folder ?? space.folder ?? null, machine: space.machine ?? null } } });
  }
  visit(is) {
    const record = this.records().find(r => r.issue?.id === is.id);
    if (this.role === "projects") this.dismiss();
    if (record) this.selectWork(record); else this.details(is);
  }
  openIssue(is, cx, direct = false) {
    if (this.role === "sidebar") return this.visit(is);
    const record = this.records().find(r => r.issue?.id === is.id);
    if (record && (record.space.machine ?? null) !== (this.launchTarget?.machine ?? null)) {
      this.targetGeneration = (this.targetGeneration ?? 0) + 1;
      this.launchTarget = { ...record.space, folder: record.folder };
      this.checkAgents(cx);
    }
    super.openIssue(is, cx, direct);
  }
  enter(cx) {
    if (this.role === "sidebar") {
      const records = this.visibleSpaces(), record = records[0];
      const is = !record && this.linearMatches(records).issues[0];
      if (record) this.selectWork(record);
      else if (is) this.visit(is);
    } else if (this.role === "projects") {
      const is = this.found?.issues?.[0] ?? this.allIssues().find(i => this.matches(i));
      if (is) this.visit(is);
    } else super.enter(cx);
  }

  attach(is, source = props().attachSpace) {
    if (!source?.id) return;
    const link = { workspace: this.ws, space: source.id, folder: source.folder, machine: source.machine ?? null, issue: is };
    const links = (shared(LINKS) ?? []).filter(l => !(l.workspace === this.ws && l.space === source.id));
    setShared(LINKS, [...links, link]);
    this.replaceRow(is);
  }
  afterCreate(is, cx, start) {
    this.publish();
    if (props().attachSpace) { this.attach(is); this.say(`Attached ${is.identifier} to ${props().attachSpace.name}.`, cx); }
    else if (start) this.worktree(cx, true, { issue: is });
  }
  onWorktree(is, folder, machine, space) {
    if (!is?.identifier) return;
    const links = (shared(LINKS) ?? []).filter(l => !(l.workspace === this.ws && l.issue.id === is.id && (l.machine ?? null) === machine));
    setShared(LINKS, [...links, { workspace: this.ws, space: space?.id ?? "", folder, machine, issue: is }]);
    this.publish();
  }
  taskFor(is, description) { return taskContext(is, description ?? (this.detail?.issue?.id === is.id ? this.detail.description : this.desc.value())); }
  worktree(cx, start, what = { issue: this.cur }) {
    if (this.busy) return;
    if (!what.issue) return this.say("Choose an issue before starting work.", cx, true);
    if (this.createdLaunchFor(what.issue, start) || !this.launchIssueReady(what.issue, start)) return super.worktree(cx, start, what);
    const linked = this.records().find(r => r.issue?.id === what.issue.id);
    if (linked) { this.selectWork(linked); this.dismiss(); return; }
    if (!this.launchTarget || this.launchTarget.blocked) return this.say(this.launchTarget?.blocked && this.repositoryError || "Choose a computer first.", cx, true);
    if (start && (!this.agentsChecked || !this.agentChoices.length)) return this.say(this.launchError || "No installed agent is available on this machine.", cx, true);
    if (start) setShared(PREFS, { ...shared(PREFS), [this.launchTarget.machine ?? ""]: this.agentKey });
    super.worktree(cx, start, what);
  }
  chooseComputer(machine, cx, retain = null) {
    this.targetPicker = null;
    if (this.screen === "create" && this.form?.capture) this.form.restoringExecution = retain;
    const source = this.repositorySource;
    const project = this.screen === "create"
      ? this.lists.projects?.items?.find(p => p.id === this.form?.project)
      : this.screen === "project" ? this.curProject : this.screen === "issue" ? this.cur?.project : this.drilled;
    // Names travel between computers; absolute source paths do not. Discovery
    // resolves the name inside the selected computer's own ~/code directory.
    const hints = [project?.name, repositoryName(source?.folder)];
    loadTarget(this, cx, machine, { retain, hints, preferredFolder: this.mappedRepository(machine), preferredAgent: shared(PREFS)?.[machine ?? ""] ?? "" });
  }
  create(cx, capture = !props()?.attachSpace, projectId = null) {
    const issue = this.screen === "issue" ? this.cur : props()?.taskIssue;
    if (capture) this.startedForm = true;
    super.create(cx, capture, projectId);
    const f = this.form;
    if (props().attachSpace || f?.unreadable || f?.draft?.uncertain || this.screen !== "create") return;
    const retain = f.draft?.execution ?? (issue && (issue.project?.id ?? null) === f.project ? this.savedLaunchTarget(issue) : null);
    this.chooseComputer(retain ? retain.machine ?? null : this.defaultTaskMachine(), cx, retain);
    f.initialTargetGeneration = this.targetGeneration;
    if (!retain) this.restoreTaskRepository(issue, f, cx);
    if (props().parentIssue && !f.draft?.revision) {
      const parent = props().parentIssue;
      (capture ? this.captureDescription : this.desc).set_value(`Follow-up to ${parent.identifier}: ${parent.url ?? ""}\n\n`);
    }
  }
  selectRepository(repo, cx) {
    if (selectTargetRepository(this, repo, cx)) {
      this.rememberRepository(this.launchTarget);
      if (this.form?.capture) { this.form.restoringExecution = null; this.saveCapture(cx); }
    }
  }

  button(id, label, action, { primary = false, enabled = true } = {}) {
    const t = theme();
    return h_flex().id(id).flex_none().h(29).px(10).gap(6).items_center().rounded(6)
      .bg(primary ? t.solid : t.raised).text_color(enabled ? (primary ? t.solid_foreground : t.foreground) : t.dim)
      .text_size(12).when(enabled, el => el.cursor_pointer().hover(s => s.opacity(0.85)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); }).child(label);
  }
  section(label, n, color = theme().dim) {
    return h_flex().h(28).flex_none().gap(8).items_center().pt(6)
      .child(div().text_size(11).font_semibold().text_color(color).child(label))
      .child(div().text_size(11).text_color(color).child(String(n)));
  }
  workRow(record, id, lane = record.status, { project = true } = {}) {
    const t = theme(), is = record.issue;
    const color = lane === "blocked" ? t.blocked : lane === "done" ? t.done : lane === "working" ? t.working : t.dim;
    const label = lane === "blocked" ? (record.status === "blocked" ? "Needs input" : "Needs your attention")
      : lane === "done" ? (record.status === "done" ? "Agent finished" : "Done in Linear")
      : lane === "working" ? "Working" : "Idle";
    const since = record.since ?? laneSince(record, lane), now = Date.now();
    const age = elapsed(since.at, now);
    const when = !age ? "" : lane === "done" ? ` ${age === "<1m" ? "just now" : `${age} ago`}` : ` ${age}`;
    const mismatch = is ? linearMismatch(lane, is, this.attentionRules()) : "";
    // Grouped by project the row's project name only repeats its own group header (CHA-4365).
    const status = [`${label}${when}`, project ? is?.project?.name?.trim() : "",
      mismatch || (!is ? "no ticket" : "")].filter(Boolean).join(" · ");
    const source = since.source === "herdr" ? `In this state since ${new Date(since.at).toLocaleString()} (Herdr)`
      : since.source === "linear" ? `Herdr has no state change for this space yet; age is from the ticket's last Linear update, ${new Date(since.at).toLocaleString()}`
      : "No state-change time yet";
    const full = is ? this.enrich(is) : null;
    const badges = this.rowBadges(record, full, id);
    const tags = rowTags(full), stripe = rowColor(full);
    return h_flex().id(id).min_w(0).h(49).flex_none().pl(4).pr(8).gap(7).items_center().rounded(6)
      .bg(record.space.active ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click(() => this.selectWork(record))
      .on_mouse_down("right", (_e, cx) => this.spaceMenu(record.space, cx, record.issue, record.folder))
      // The row's color is its first tag's Linear color; an untagged row keeps the gap.
      .child(div().id(`${id}-color`).w(3).h(30).flex_none().rounded(2)
        .when(Boolean(stripe), el => el.bg(stripe).tooltip(`Color from the Linear tag “${tags.find(tag => tag.color)?.name}”`)))
      .child(icon(lane === "blocked" ? "need" : lane === "working" ? "work" : lane === "done" ? "check" : "idle", color, 13).when(lane === "working", el => el.spin(1100)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).tooltip(is ? issueHover(is) : record.space.name).child(is ? issueHeadline(is) : record.space.name))
        .child(h_flex().min_w(0).gap(4).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(color).tooltip(source).child(status))
          .children(this.tagChips(tags, id))
          .child(this.machineTag(record.space.machine ?? null, `${id}-machine`))))
      .when(badges.length > 0, el => el.child(h_flex().id(`${id}-badges`).flex_none().gap(4).items_center().children(badges)))
      .child(div().id(`${id}-details`).w(22).h(26).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.muted).hover(s => s.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (is) this.details(is);
          else dialog({ action: "attach", attachSpace: { id: record.space.id, name: record.space.name, folder: record.folder, machine: record.space.machine ?? null } });
        }).child(is ? "…" : "+"));
  }
  /** Up to two of a row's Linear tags, in their Linear colors; the rest are counted. */
  tagChips(tags, id) {
    const t = theme(), shown = tags.slice(0, 2), more = tags.length - shown.length;
    const short = name => (name.length > 14 ? `${name.slice(0, 13)}…` : name);
    const all = `Linear tags: ${tags.map(tag => tag.name).join(", ")}`;
    return [
      ...shown.map((tag, i) => this.chip(`${id}-tag-${i}`, short(tag.name), tag.color ?? t.dim).tooltip(all)),
      ...(more > 0 ? [this.chip(`${id}-tag-more`, `+${more}`, t.dim).tooltip(all)] : []),
    ];
  }
  /** The right side of a sidebar row: the agent when it isn't Claude, an Urgent or High
   *  priority, and the linked pull request's state. Each explains itself on hover. */
  rowBadges(record, is, id) {
    const t = theme(), badges = [];
    badges.push(...this.harnessIcons([record], { skipClaude: true }));
    if (is && (is.priority === 1 || is.priority === 2)) {
      const name = is.priority === 1 ? "Urgent" : "High";
      badges.push(div().id(`${id}-priority`).w(13).h(13).flex_none().tooltip(`Priority: ${name}`).accessibility_label(`Priority: ${name}`)
        .child(icon(priorityIcon(is.priority), is.priority === 1 ? t.blocked : t.muted, 13)));
    }
    const pr = is ? rowPullRequest(sharedPulls()[String(is.identifier).toUpperCase()]) : null;
    if (pr) badges.push(this.pullBadge(pr, `${id}-pr`));
    return badges;
  }
  pullBadge(pr, id) {
    const t = theme();
    const look = {
      failing: [t.blocked, "failing", "checks failing"],
      ready: [t.done ?? t.muted, "ready", pr.checks === "passing" ? "checks passed, ready to merge" : "approved, ready to merge"],
      open: [t.working ?? t.muted, "open", pr.checks === "pending" ? "open, checks running" : "open"],
      draft: [t.dim, "draft", "draft"],
      merged: [t.dim, "merged", "merged"],
    }[pr.state];
    const [color, word, why] = look;
    const hover = `Pull request #${pr.number} ${why}: ${pr.title}. Click to open it.`;
    return h_flex().id(id).flex_none().h(16).px(4).gap(3).items_center().rounded(4)
      .bg(tint(color, 0.14)).text_size(10).text_color(color).cursor_pointer().hover(s => s.opacity(0.8))
      .tooltip(hover).accessibility_label(hover)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(pr.url); })
      .child(icon("pr", color, 10)).child(word);
  }
  harnessIcons(records, { skipClaude = false } = {}) {
    const programs = new Map(records.flatMap(r => r.programs ?? []).map(p => [p.key, p]));
    return [...programs.values()].filter(p => !skipClaude || !isClaude(p)).map(p => {
      const glyph = p.icon ? (p.tint ? svg(p.icon).text_color(theme().muted) : image(p.icon))
        : icon("work", theme().muted, 13);
      return div().w(13).h(13).flex_none().tooltip(p.name).accessibility_label(p.name)
        .child(glyph.w(13).h(13).flex_none());
    });
  }
  /** A small pill. Used for the delegate, the machine and each visible Linear label. */
  chip(id, text, color, { faded = false, click = null } = {}) {
    const t = theme();
    return div().id(id).flex_none().px(5).h(16).flex().items_center().rounded(4)
      .bg(tint(color, 0.14)).text_size(10).text_color(faded ? t.dim : color)
      .when(Boolean(click), el => el.cursor_pointer().hover(s => s.opacity(0.8))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => { cx.stop_propagation(); click(e, cx); }))
      .child(String(text));
  }

  /** A machine's own color, the same everywhere it is drawn. */
  machineDot(name, size = 7) {
    const t = theme(), known = machines();
    const state = machineState(name, known);
    const color = machineColor(t, name, known.map(m => m.name ?? null));
    // Offline: an outline only, so a dead machine reads at a glance without its color changing.
    return div().size(size).rounded(size).flex_none()
      .when(state === "online", el => el.bg(color))
      .when(state === "connecting", el => el.bg(tint(color, 0.45)))
      .when(state === "offline", el => el.border_1().border_color(color));
  }

  /** The machine a row runs on: its dot, its name, and whether it can be reached. */
  machineTag(name, id) {
    const t = theme(), state = machineState(name, machines()), word = stateWord(state);
    return h_flex().id(id).flex_none().gap(4).items_center()
      .tooltip(`${machineLabel(name)}${word ? ` · ${word}` : ""}`)
      .child(this.machineDot(name))
      .child(div().text_size(11).font_family(MONO).text_color(state === "online" ? t.muted : t.blocked)
        .child(word ? `${machineLabel(name)} · ${word}` : machineLabel(name)));
  }

  /** Which machines a row's work is running on, and whether Herdr can still reach them.
   *  An issue with no local work gets no chip at all rather than a misleading "local". */
  machineChips(records, id) {
    const t = theme(), known = machines();
    const names = [...new Set(records.map(r => r.space.machine ?? null))];
    return names.map((name, i) => {
      const state = machineState(name, known), word = stateWord(state), ok = state === "online";
      return h_flex().id(`${id}-machine-${i}`).flex_none().px(5).h(16).gap(4).items_center().rounded(4)
        .bg(tint(ok ? t.muted : t.blocked, 0.14)).tooltip(`${machineLabel(name)}${word ? ` · ${word}` : ""}`)
        .child(this.machineDot(name, 6))
        .child(div().text_size(10).text_color(ok ? t.muted : t.blocked).child(word ? `${machineLabel(name)} · ${word}` : machineLabel(name)));
    });
  }

  delegateChips(delegate, id) {
    if (!delegate) return [];
    const t = theme();
    return [this.chip(`${id}-delegate`, delegate, t.working)];
  }

  issueRow(is, scope, row = null) {
    const t = theme();
    const full = row?.issue ?? this.enrich(is);
    const delegate = row?.delegate ?? delegateOf(full);
    const labels = row?.labels ?? visibleLabels(full);
    const needs = row?.needs ?? issueNeedsYou(full, this.attentionRules());
    const records = row?.records ?? this.records().filter(r => r.issue?.id === full.id);
    const id = `issue-${scope}-${is.id}`;
    return v_flex().id(id).flex_none().pl(22).pr(6).py(4).gap(3).min_w(0).rounded(6)
      .when(needs, el => el.bg(tint(t.blocked, 0.07)))
      .hover(s => s.bg(t.hover)).cursor_pointer().on_click(() => this.visit(full))
      .on_mouse_down("right", (_e, cx) => this.issueMenu(full, cx))
      .child(h_flex().gap(7).min_w(0).items_center()
        .child(icon(needs ? "need" : stateIcon(full.state), needs ? t.blocked : t.dim, 12))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(full.title))
        .child(div().min_w(0).max_w(180).truncate().text_size(10).font_family(MONO).text_color(t.dim).tooltip(issueLabel(full)).child(issueLabel(full)))
        .children(this.harnessIcons(records)))
      .child(h_flex().gap(4).min_w(0).items_center().flex_wrap().pl(19)
        .child(div().flex_none().text_size(10).text_color(needs ? t.blocked : t.muted).child(full.state?.name ?? ""))
        .children(this.delegateChips(delegate, id))
        .children(this.machineChips(records, id))
        .children(labels.slice(0, 2).map((l, i) => this.chip(`${id}-label-${i}`, l, t.dim))));
  }

  teamHeader(node) {
    const t = theme();
    return h_flex().id(`team-${node.key}`).h(24).flex_none().px(7).gap(7).items_center().pt(4)
      .child(div().text_size(10).font_semibold().text_color(t.muted).child(node.name.toUpperCase()))
      .child(div().flex_1())
      .when(node.needs > 0, el => el.child(div().text_size(10).text_color(t.blocked).child(String(node.needs))));
  }

  /** A synthetic group such as "Homelab", standing for every "Homelab · X" project. */
  groupRow(node, team) {
    const t = theme(), key = `${team}/${node.name}`, open = Boolean(this.openGroups[key]);
    return v_flex().flex_none().min_w(0)
      .child(h_flex().id(`group-${key}`).h(32).px(7).gap(7).min_w(0).items_center().rounded(6)
        .when(node.needs > 0, el => el.bg(tint(t.blocked, 0.07)))
        .hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => {
          this.openGroups[key] = !open;
          localStorage.setItem("openGroups", JSON.stringify(this.openGroups));
          cx.notify();
        })
        .child(div().w(9).flex_none().text_color(t.dim).text_size(12).child(open ? "⌄" : "›"))
        .child(icon("project", node.needs ? t.blocked : t.dim, 13))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(node.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`${node.children.length}`))
        .when(node.needs > 0, el => el.child(div().flex_none().text_size(10).text_color(t.blocked).child(String(node.needs)))))
      .when(open, el => el.child(v_flex().pl(12).gap(2).children(node.children.map(child => this.projectNode(child, team)))));
  }

  projectNode(node, team) {
    const t = theme(), p = node.project, open = Boolean(this.expanded[p.id]), list = this.lists?.[`project:${p.id}`];
    const rows = node.issues.filter(r => !this.filter?.trim() || this.matches(r.issue));
    return v_flex().flex_none().min_w(0)
      .child(h_flex().id(`project-${p.id}`).h(34).px(7).gap(7).min_w(0).items_center().rounded(6)
        .bg(node.needs ? tint(t.blocked, 0.09) : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => {
          this.expanded[p.id] = !open;
          localStorage.setItem("expandedProjects", JSON.stringify(this.expanded));
          if (!open) this.rememberProject(p.id);
          if (!open && !list?.loaded) this.load(`project:${p.id}`, cx, { op: "list", tab: "project", project: p.id });
          cx.notify();
        })
        .child(div().w(9).flex_none().text_color(t.dim).text_size(12).child(open ? "⌄" : "›"))
        .child(icon(node.needs ? "need" : "project", node.needs ? t.blocked : t.dim, 13))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(node.name))
        .when(node.needs > 0, el => el.child(div().flex_none().text_size(10).text_color(t.blocked).child(`${node.needs} need${node.needs === 1 ? "s" : ""} you`)))
        .when(!node.needs && rows.length > 0, el => el.child(div().flex_none().text_size(10).text_color(t.muted).child(String(rows.length)))))
      .when(open, el => el
        .children(rows.map(r => this.issueRow(r.issue, `project-${p.id}`, r)))
        .when(Boolean(list?.error), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.blocked).child(list.error)))
        .when(Boolean(list?.loading), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.muted).child("Loading issues…")))
        .when(Boolean(list?.loaded && !list.loading && !list.error && !rows.length), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.dim)
          .child("No matching issues")))
        .child(h_flex().pl(22).py(5).gap(5).flex_wrap().child(this.button(`new-${p.id}`, "+ New issue", () => dialog({ action: "new", project: p.id })))));
  }
  projectRow(group) {
    const t = theme(), p = group.project, open = Boolean(this.expanded[p.id]), list = this.lists[`project:${p.id}`];
    const workIds = new Set(group.work.map(r => r.issue?.id));
    const issues = (list?.items ?? this.allIssues().filter(i => i.project?.id === p.id)).filter(i => !workIds.has(i.id) && this.matches(i));
    return v_flex().flex_none().min_w(0)
      .child(h_flex().id(`project-${p.id}`).h(38).px(7).gap(7).min_w(0).items_center().rounded(6)
        .bg(group.needs ? tint(t.blocked, 0.09) : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => {
          this.expanded[p.id] = !open;
          localStorage.setItem("expandedProjects", JSON.stringify(this.expanded));
          if (!open) this.rememberProject(p.id);
          if (!open && !list?.loaded) this.load(`project:${p.id}`, cx, { op: "list", tab: "project", project: p.id });
          cx.notify();
        })
        .child(div().w(9).flex_none().text_color(t.dim).text_size(12).child(open ? "⌄" : "›"))
        .child(icon(group.needs ? "need" : "project", group.needs ? t.blocked : t.dim, 13))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(p.name))
        .when(group.needs > 0, el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${group.needs} ${group.needs === 1 ? "needs" : "need"} you`)))
        .when(!group.needs && group.work.length > 0, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(String(group.work.length)))))
      .when(open, el => el
        .children(group.work.filter(r => !this.filter || this.matches(r.issue)).map(r => this.workRow(r, `project-work-${p.id}-${r.space.id}`)))
        .children(issues.map(is => this.issueRow(is, p.id)))
        .when(Boolean(list?.error), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.blocked).child(list.error)))
        .when(Boolean(list?.warning), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.muted).child(list.warning)))
        .when(Boolean(list?.loading), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.muted).child("Loading issues…")))
        .when(Boolean(list?.loaded && !list.loading && !list.error && !issues.length && !group.work.length), el => el.child(div().pl(22).py(5).text_size(11).text_color(t.dim).child("No matching issues")))
        .child(h_flex().pl(22).py(5).gap(5).flex_wrap().child(this.button(`new-${p.id}`, "+ New issue", () => dialog({ action: "new", project: p.id })))));
  }

  /** Issues per project, enriched, for the tree. A project not yet expanded contributes
   *  whatever is already known about it, so its needs-you count is never silently zero. */
  issuesByProject(index) {
    const byProject = {};
    for (const raw of this.allIssues()) {
      const issue = this.enrich(raw, index);
      const id = issue.project?.id;
      if (!id) continue;
      (byProject[id] ??= []).push(issue);
    }
    return byProject;
  }

  tree(index) {
    return boardTree({
      projects: this.lists?.projects?.items ?? [],
      issuesByProject: this.issuesByProject(index),
      records: this.records(),
      teams: shared(TEAMS) ?? [],
      attention: this.attentionRules(),
    });
  }

  /** Every open space with its sidebar lane, before search and filters. */
  laned(index = this.enrichment()) {
    return this.records().map(record => {
      const issue = this.enrich(record.issue, index);
      const lane = record.status === "blocked" || issueNeedsYou(issue, this.attentionRules()) ? "blocked"
        : record.status === "working" ? "working"
        : record.status === "done" || issue?.state?.type === "completed" ? "done" : "idle";
      return { ...record, issue, lane, pinned: isPinned(issue), since: laneSince({ ...record, issue }, lane) };
    });
  }

  /** Tells the window header how many spaces need you. Counted before search and filters,
   *  and pinned spaces count too: a filter or a pin does not make them need you less.
   *  Written only on change. */
  publishNeeds() {
    const n = this.laned().filter(record => record.lane === "blocked").length;
    if ((shared(NEEDS) ?? 0) !== n) setShared(NEEDS, n);
  }

  visibleSpaces() {
    const index = this.enrichment(), filters = this.homeFilters();
    const words = (this.filter ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
    return this.laned(index).filter(record => {
      if (!matchesFilters(record, filters)) return false;
      const hay = [record.space.name, record.space.machine, record.issue?.identifier, record.issue?.title,
        ...rowTags(record.issue).map(tag => tag.name), ...record.agents.map(a => a.title)].filter(Boolean).join(" ").toLowerCase();
      return words.every(word => hay.includes(word));
    }).sort((a, b) => rank[a.lane] - rank[b.lane]
      || (b.since.at ?? -Infinity) - (a.since.at ?? -Infinity)
      || a.space.name.localeCompare(b.space.name));
  }

  // ---- Grouping, Clean up and auto-close --------------------------------------------------

  setGroupMode(mode, cx) {
    this.groupMode = normalizeGroupMode(mode);
    this.groupMenu = false;
    this.homeScroll = 0;
    try { localStorage.setItem("groupMode", this.groupMode); } catch { /* kept for this session only */ }
    cx.notify();
  }
  /** The group-by dropdown. Four modes, the current one marked; the same in-place Popup
   *  the computer picker uses, so nothing new has to carry the choice between views. */
  groupPicker(mode) {
    const trigger = this.button("group-mode", `Group: ${GROUP_LABELS[mode]} ▾`,
      cx => { this.groupMenu = !this.groupMenu; cx.notify(); })
      .tooltip(`Grouped by ${GROUP_LABELS[mode].toLowerCase()}. Click to group by something else.`);
    return Popup.new("group-mode-picker", trigger).anchor("bottom_left")
      .when(Boolean(this.groupMenu), el => el.content(
        v_flex().id("group-mode-list").p(6).gap(3).bg(theme().popover).children(GROUP_MODES.map(choice =>
          this.button(`group-mode-${choice}`, GROUP_LABELS[choice], cx => this.setGroupMode(choice, cx),
            { primary: choice === mode })))));
  }
  toggleGroup(key, cx) {
    this.collapsed = toggleCollapsed(this.collapsed, key);
    try { localStorage.setItem("collapsedGroups", JSON.stringify(this.collapsed)); } catch { /* kept for this session only */ }
    cx.notify();
  }

  /** Open spaces whose ticket is Done or Canceled, or whose pull request merged. Before
   *  search and filters: a filter does not make a space less finished. */
  finishedSpaces() {
    return cleanupCandidates(this.laned(), is => rowPullRequest(sharedPulls()[String(is.identifier).toUpperCase()]));
  }

  /** Closes spaces whose ticket has been Done or Canceled in Linear for the grace period,
   *  unless one is open now, pinned, has an agent working or waiting, or has uncommitted
   *  edits. Only the space closes: its ticket, folder and branch stay as they are. */
  autoClose(cx) {
    const rules = shared(CONFIG)?.cleanup ?? normalizeConfig().cleanup;
    if (!rules.autoClose || this.demo || this.signedOut || this.autoClosing || !this.ws) return;
    const { due, seen } = autoCloseDue(this.finishedSpaces(), this.finishedSeen ?? {}, Date.now(), rules.graceMinutes * 60000);
    this.finishedSeen = seen;
    // Everything but git is known now; git is read only for spaces that pass the rest.
    const ready = due.filter(c => !keepOpenReason(c.record, null));
    if (!ready.length) return;
    this.autoClosing = true;
    cx.spawn(async cx => {
      const closed = [];
      try {
        for (const c of ready) {
          const git = await readGitState(exec, c.record.folder, c.record.space.machine ?? null);
          // Re-read the space: it may have been closed, reopened or focused meanwhile.
          const live = this.laned().find(r => r.space.id === c.record.space.id);
          if (!live || !ticketFinished(finishedReason(live.issue)) || keepOpenReason(live, git)) continue;
          run("space.close", { id: live.space.id, confirmed: true });
          closed.push(live.issue?.identifier ?? live.space.name);
        }
      } finally {
        this.autoClosing = false;
        if (closed.length) {
          this.note = `Closed ${closed.length} finished space${closed.length === 1 ? "" : "s"}: ${closed.join(", ")}`;
          this.noteAt = Date.now();
          cx.notify();
        }
      }
    });
  }

  /** Shows Clean up in the sidebar and reads each finished space's checkout. */
  openCleanup(cx) {
    const candidates = this.finishedSpaces();
    this.cleanupOpen = true;
    this.cleanupGit = {};
    this.cleanupPicked = {};
    this.cleanupRemove ??= true;
    cx.notify();
    cx.spawn(async cx => {
      await Promise.all(candidates.map(async ({ record }) => {
        const on = record.space.machine ?? null;
        const [git, kind] = await Promise.all([
          readGitState(exec, record.folder, on),
          record.folder ? checkoutKind(record.folder, on).catch(() => null) : null,
        ]);
        if (!this.cleanupOpen) return;
        this.cleanupGit = { ...this.cleanupGit, [record.space.id]: { git, kind } };
        cx.notify();
      }));
    });
  }

  /** Clean up's rows: each finished space, why it is finished, what its checkout holds and
   *  whether it is picked. A space that must stay open shows why and cannot be picked. */
  cleanupRows() {
    return this.finishedSpaces().map(c => {
      const id = c.record.space.id, read = this.cleanupGit?.[id];
      const keep = keepOpenReason(c.record, read ? read.git : undefined);
      return { ...c, id, git: read?.git, kind: read?.kind ?? null, keep, picked: !keep && (this.cleanupPicked?.[id] ?? true) };
    });
  }

  runCleanup(cx) {
    const rows = this.cleanupRows().filter(r => r.picked), removeWorktrees = this.cleanupRemove;
    if (!rows.length || this.cleanupBusy) return;
    this.cleanupBusy = true;
    cx.notify();
    cx.spawn(async cx => {
      let closed = 0, removed = 0;
      const failed = [];
      try {
        for (const r of rows) {
          if (!spaces().some(s => s.id === r.id)) continue;
          run("space.close", { id: r.id, confirmed: true });
          closed++;
          if (!removeWorktrees || !removable(r.git, r.kind)) continue;
          const result = await exec("sh", ["-c", REMOVE_WORKTREE, "sh", r.record.folder], { on: r.record.space.machine ?? null }).catch(error => ({ code: 1, stderr: String(error?.message ?? error) }));
          if (result?.code === 0) removed++;
          else failed.push(`${r.record.issue?.identifier ?? r.record.space.name}: ${String(result?.stderr ?? "").trim().split("\n").pop() || "git refused"}`);
        }
      } finally {
        this.cleanupBusy = false;
        this.cleanupOpen = false;
        this.note = [`Closed ${closed} space${closed === 1 ? "" : "s"}`, removed ? `removed ${removed} worktree${removed === 1 ? "" : "s"}` : "",
          failed.length ? `kept ${failed.join("; ")}` : ""].filter(Boolean).join(", ");
        this.noteAt = Date.now();
        cx.notify();
      }
    });
  }

  cleanupView() {
    const t = theme(), rows = this.cleanupRows(), chosen = rows.filter(r => r.picked);
    const removals = this.cleanupRemove ? chosen.filter(r => removable(r.git, r.kind)).length : 0;
    const label = this.cleanupBusy ? "Closing…" : `Close ${chosen.length}${removals ? ` · remove ${removals} worktree${removals === 1 ? "" : "s"}` : ""}`;
    return v_flex().id("cleanup").flex_1().min_h(0).min_w(0).gap(6)
      .child(h_flex().h(28).flex_none().items_center().gap(8)
        .child(div().text_size(11).font_semibold().text_color(t.done).child("CLEAN UP"))
        .child(div().text_size(11).text_color(t.done).child(String(rows.length)))
        .child(div().flex_1())
        .child(this.button("cleanup-back", "Back", cx => { this.cleanupOpen = false; cx.notify(); })))
      .child(div().flex_none().text_size(11).text_color(t.muted)
        .child("Spaces whose ticket is Done or Canceled in Linear, or whose pull request merged. Closing a space leaves its ticket, files and branch alone."))
      .child(v_flex().id("cleanup-rows").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(3)
        .when(!rows.length, el => el.child(div().py(10).text_size(12).text_color(t.muted).child("Nothing finished is open.")))
        .children(rows.map(r => h_flex().id(`cleanup-${r.id}`).min_w(0).h(40).flex_none().px(6).gap(8).items_center().rounded(6)
          .bg(t.chrome).when(!r.keep, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .on_click((_e, cx) => {
            if (r.keep) return;
            this.cleanupPicked = { ...this.cleanupPicked, [r.id]: !r.picked };
            cx.notify();
          })
          .child(div().w(14).h(14).flex_none().flex().items_center().justify_center().rounded(3).border_1().border_color(t.border)
            .text_size(10).text_color(t.foreground).child(r.picked ? "✓" : ""))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(12).text_color(r.keep ? t.dim : t.foreground)
              .child(r.record.issue ? issueHeadline(r.record.issue) : r.record.space.name))
            .child(div().truncate().text_size(10.5).text_color(r.keep && r.keep !== "checking git" ? t.blocked : t.muted)
              .child(`${r.reason} · ${r.keep && r.keep !== "checking git" ? `stays open: ${r.keep}` : gitSummary(r.git, r.kind)}`))))))
      .child(h_flex().id("cleanup-remove").flex_none().gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.cleanupRemove = !this.cleanupRemove; cx.notify(); })
        .child(div().w(14).h(14).flex_none().flex().items_center().justify_center().rounded(3).border_1().border_color(t.border)
          .text_size(10).text_color(t.foreground).child(this.cleanupRemove ? "✓" : ""))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child("Also remove clean worktree checkouts (branches are kept)")))
      .child(h_flex().flex_none().pb(4)
        .child(this.button("cleanup-run", label, cx => this.runCleanup(cx), { primary: true, enabled: chosen.length > 0 && !this.cleanupBusy })));
  }

  /** A sidebar group header: click to collapse or expand the group. */
  groupHeader(group, color, id) {
    const t = theme();
    return h_flex().id(id).h(HOME_ROWS.header).flex_none().gap(8).items_center().pt(6).cursor_pointer()
      .tooltip(group.collapsed ? "Show this group" : "Collapse this group")
      .on_click((_e, cx) => this.toggleGroup(group.key, cx))
      .child(div().w(8).flex_none().text_size(10).text_color(color).child(group.collapsed ? "›" : "⌄"))
      .child(div().text_size(11).font_semibold().text_color(color).child(group.name))
      .child(div().text_size(11).text_color(color).child(String(group.count)))
      .when(group.tone !== "blocked" && group.needs > 0, el => el.child(div().text_size(11).text_color(t.blocked).child(`${group.needs} need you`)));
  }

  /** Linear's matches for the sidebar's words, without the tickets already shown as spaces. */
  linearMatches(records = this.visibleSpaces()) {
    const q = (this.filter ?? "").trim();
    if (!q || this.found?.query !== q) return { issues: [], searching: q.length >= 2, error: "" };
    const shown = new Set(records.map(r => r.issue?.id).filter(Boolean));
    return { issues: this.found.issues.filter(is => !shown.has(is.id)), searching: false, error: this.found.error ?? "" };
  }

  sidebar() {
    const t = theme(), records = this.visibleSpaces(), filters = this.homeFilters(), count = filterCount(filters);
    const linear = this.linearMatches(records);
    const choices = this.filterChoices(filters);
    const summary = FILTER_FIELDS.filter(key => filters[key].length).map(key =>
      `${key[0].toUpperCase()}${key.slice(1)}: ${choices[key].filter(option => filters[key].includes(option.value)).map(option => option.label).join(", ")}`).join(" · ");
    // Pinned spaces (the Linear "Pinned" label) come first; each keeps its own state line.
    // The rest group by whatever the Group dropdown says -- state, Linear project, delegate
    // or Linear team; any group collapses to its header.
    const tones = { accent: t.accent ?? t.foreground, blocked: t.blocked, done: t.done, working: t.working, dim: t.dim };
    const mode = normalizeGroupMode(this.groupMode);
    const shown = sidebarGroups(records, mode, this.collapsed ?? {}, shared(TEAMS) ?? [])
      .map(group => ({ ...group, color: tones[group.tone] ?? t.dim }));
    setAgentOrder(shown.flatMap(group => group.records).flatMap(record => record.agents.map(a => a.address)));
    this.publishNeeds();
    const finished = this.finishedSpaces().length;
    const note = this.note && Date.now() - (this.noteAt ?? 0) < 120000 ? this.note : "";
    const stack = stackLayout(shown.map(group => ({ rows: group.collapsed ? 0 : group.records.length })), HOME_ROWS);
    const viewport = this.homeViewport ?? 0;
    // The groups' height is known from their rows; anything after them is measured.
    const content = Math.max(stack.height, this.homeContent ?? 0);
    this.homeScroll = clampScroll(this.homeScroll, content, viewport);
    const pin = pinnedHeader(stack, this.homeScroll), bar = thumb(this.homeScroll, content, viewport);
    return v_flex().id("spaces-home").size_full().min_w(0).min_h(0).px(10).gap(7).bg(t.chrome)
      // Refresh sits beside the search box rather than with the buttons below, which wrap
      // at this sidebar's width and would push it onto a line of its own (CHA-4365).
      .child(h_flex().h(32).flex_none().items_center().gap(7)
        .child(h_flex().h_full().flex_1().min_w(0).items_center().px(8).gap(7).bg(t.background).rounded(6)
          .child(icon("search", t.dim, 13)).child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
        .child(this.button("refresh", this.refreshing
          ? h_flex().gap(5).child(div().frames(["◐", "◓", "◑", "◒"], 120)).child("Refreshing…")
          : "↻", cx => this.refresh(cx), { enabled: !this.refreshing })
          .tooltip(this.refreshing ? "Refreshing Linear tickets" : "Refresh Linear tickets")))
      .child(h_flex().flex_none().items_center().flex_wrap().gap(7)
        .child(this.button("new-task", "+ New issue", () => dialog({ action: "new" }), { primary: true }))
        .child(this.button("home-filter-button", count ? `Filters (${count})` : "Filters", () => this.openFilters()))
        .child(this.groupPicker(mode))
        .when(finished > 0 && !this.cleanupOpen, el => el.child(this.button("open-cleanup", `Clean up (${finished})`, cx => this.openCleanup(cx))
          .tooltip("Close spaces whose ticket is Done or Canceled, or whose pull request merged")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.muted).child(`${records.length} spaces`)))
      .when(count > 0, el => el.child(h_flex().h(26).flex_none().items_center().gap(6).px(7).rounded(6).bg(tint(t.accent, 0.12))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.accent).tooltip(summary).child(summary))
        .child(this.button("clear-home-filters", "Clear", cx => this.applyFilter({}, cx)))))
      .when(Boolean(this.cleanupOpen), el => el.child(this.cleanupView()))
      // The list scrolls itself so the current group's header can stay pinned on top:
      // GPUI's scroll areas never say how far they have scrolled.
      .when(!this.cleanupOpen, el => el.child(div().id("spaces-by-status").flex_1().min_h(0).min_w(0).relative().overflow_hidden()
        .on_size_change((size, cx) => {
          const height = size.height / (settings()?.zoom || 1);
          if (height !== this.homeViewport) { this.homeViewport = height; cx.notify(); }
        })
        .on_scroll_wheel((e, cx) => {
          const next = clampScroll(this.homeScroll - (e.delta?.y ?? 0), content, this.homeViewport ?? 0);
          if (next !== this.homeScroll) { this.homeScroll = next; cx.notify(); }
        })
        .when(!records.length, el => el.child(div().py(12).text_size(12).text_color(t.muted)
          .child(this.filter || count ? "No matching spaces" : "No open spaces. Start a task to begin.")))
        .child(v_flex().id("spaces-column").absolute().left(0).right(0).top(-this.homeScroll).gap(HOME_ROWS.gap)
          // Linear search results below the groups vary in height, so the column is measured.
          .on_size_change((size, cx) => {
            const height = size.height / (settings()?.zoom || 1);
            if (height !== this.homeContent) { this.homeContent = height; cx.notify(); }
          })
          .children(shown.flatMap(group => [
            this.groupHeader(group, group.color, `group-${group.key}`),
            ...(group.collapsed ? [] : group.records.map(record =>
              this.workRow(record, `home-${record.space.id}`, record.lane, { project: mode !== "project" }))),
          ]))
          .when(linear.issues.length > 0, el => el
            .child(this.section("LINEAR TICKETS", linear.issues.length))
            .children(linear.issues.map(is => this.issueRow(is, "search"))))
          .when(linear.searching, el => el.child(div().py(6).text_size(11).text_color(t.muted).child("Searching Linear…")))
          .when(Boolean(linear.error), el => el.child(div().py(6).text_size(11).text_color(t.blocked).truncate()
            .child(`Linear search: ${linear.error}`))))
        .when(Boolean(pin), el => el.child(div().id("pinned-group").absolute().left(0).right(0).top(pin.top).bg(t.chrome)
          .child(this.groupHeader(shown[pin.group], shown[pin.group].color, "pinned-group-header"))))
        .when(Boolean(bar), el => el.child(div().absolute().right(0).w(3).top(bar.top).h(bar.h).rounded(2).bg(t.border)))))
      .when(Boolean(note), el => el.child(div().py(3).text_size(11).text_color(t.muted).truncate().tooltip(note).child(note)))
      .when(Boolean(this.signedOut), el => el.child(this.button("sign-in", "Sign in to Linear", cx => this.signIn(cx))))
      .when(Boolean(this.err), el => el.child(div().py(3).text_size(11).text_color(t.blocked).truncate().child(this.err)));
  }

  projectsView() {
    const t = theme(), records = this.records();
    const enrichment = this.enrichment();
    const tree = this.tree(enrichment);
    const projectCount = tree.reduce((sum, team) =>
      sum + team.children.reduce((n, c) => n + (c.kind === "group" ? c.children.length : 1), 0), 0);
    const needsTotal = tree.reduce((sum, team) => sum + team.needs, 0);
    const errors = [...new Set([this.err, ...["projects", "mine", "recent"].map(k => this.lists?.[k]?.error)].filter(Boolean))];
    const search = this.filter?.trim();
    setAgentOrder(records.flatMap(r => r.agents.map(a => a.address)));

    return v_flex().id("linear-board").size_full().min_w(0).min_h(0).px(10).gap(6).bg(t.chrome)
      .child(h_flex().h(31).flex_none().items_center().gap(7)
        .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Projects"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.workspace()?.name ?? "Connecting…"))
        .child(this.button("projects-close", "Close", () => closeOverlay(props().overlay))))
      .child(h_flex().h(32).flex_none().items_center().px(8).gap(7).bg(t.background).rounded(6)
        .child(icon("search", t.dim, 13)).child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().flex_none().flex_wrap().gap(6)
        .child(this.button("new-task", "+ New issue", () => dialog({ action: "new" }), { primary: true }))
        .child(this.button("browse-linear", "Browse", () => dialog())))
      .child(h_flex().h(22).flex_none().items_center().gap(8).pt(2)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child(`${projectCount} PROJECT${projectCount === 1 ? "" : "S"}`))
        .child(div().flex_1())
        .when(needsTotal > 0, el => el.child(div().text_size(10).text_color(t.blocked).child(`${needsTotal} need you`))))
      .child(v_flex().id("board-tree").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(2)
        .when(Boolean(this.signedOut), el => el.child(this.button("sign-in", "Sign in to Linear", cx => this.signIn(cx))))
        .when(!tree.length, el => el.child(div().py(10).text_size(12).text_color(t.muted)
          .child(errors.length ? "Projects unavailable" : "Loading projects…")))
        .children(tree.flatMap(team => [
          this.teamHeader(team),
          ...team.children
            .filter(c => !search || c.kind === "group" || this.matches(c.project)
              || c.issues?.some(r => this.matches(r.issue)))
            .map(c => c.kind === "group" ? this.groupRow(c, team.key) : this.projectNode(c, team.key)),
        ]))
        .when(Boolean(this.found?.issues?.length), el => el
          .child(this.section("ISSUE SEARCH", this.found.issues.length))
          .children(this.found.issues.map(is => this.issueRow(is, "search")))))
      .when(errors.length > 0, el => el.child(div().py(4).text_size(10).text_color(t.blocked).child(errors.join(" · "))))
      .when(Boolean(enrichment.error), el => el.child(div().py(3).text_size(10).text_color(t.blocked).truncate()
        .child(`Delegates: ${enrichment.error}`)))
      .when(!enrichment.error && enrichment.partial, el => el.child(div().py(3).text_size(10).text_color(t.muted)
        .child("Delegates: partial read")))
      .when(["projects", "mine", "recent"].some(k => this.lists?.[k]?.cached), el =>
        el.child(div().py(3).text_size(10).text_color(t.muted).child("Saved projects · refreshing…")));
  }

  header() {
    const t = theme(), ws = shared(ACTIVE), data = shared(DATA)?.[ws], s = spaces().find(s => s.active);
    const is = s && matchIssue(s, data?.issues ?? [], shared(LINKS) ?? [], ws, panes());
    const git = gitFor(s);
    return h_flex().id("issue-context").size_full().min_w(0).px(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(s), el => el.on_mouse_down("right", (_e, cx) => this.spaceMenu(s, cx, is, folderOf(s, panes()))))
      .child(icon(is ? stateIcon(is.state) : "need", is ? t.muted : t.blocked, 13))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(is ? `${is.identifier} · ${is.title}` : "This workspace has no Linear ticket"))
        .child(div().truncate().text_size(11).text_color(t.muted).child(is ? headerParts(this.enrich(is), git?.git, git?.pr).join(" · ") : `${s?.name ?? "Select a workspace"} · attach an existing issue or create one`)))
      .when(Boolean(is), el => el.child(this.button("issue-details", "Issue details", () => dialog({ issue: { key: is.identifier, workspaceKey: data?.workspace?.urlKey } }))))
      .when(Boolean(s && !is), el => el.child(this.button("attach-ticket", "Attach issue", () => dialog({ action: "attach", attachSpace: currentSource() }), { primary: true })));
  }
  // ---- Status bar: machine · ahead/behind · uncommitted · agent running time ------------

  statusInit(cx) {
    this.gitReads = { git: null, pr: null };
    // Deferred like applyFilter: publishing shared state mid-frame re-enters sibling copies.
    cx.spawn(async cx => { this.gitTick(cx); cx.notify(); });
    cx.timer.every(GIT_TICK_MS, cx => { this.gitTick(cx); cx.notify(); });
  }

  /** Re-reads git (and GitHub) for the active workspace when due, then publishes it. A
   *  read that finishes after the workspace changed is dropped, not shown on another. */
  gitTick(cx, now = Date.now()) {
    const s = spaces().find(s => s.active), folder = s ? folderOf(s, panes()) : "";
    const key = gitKey(s, folder);
    if (!key) return;
    if (shared(GIT)?.key !== key) setShared(GIT, { key, git: null, gitAt: 0, pr: null, prAt: 0 });
    const current = shared(GIT), on = s.machine ?? null;
    const read = (kind, at, every, load) => {
      if (this.gitReads[kind] === key || now - at < every) return;
      this.gitReads[kind] = key;
      cx.spawn(async cx => {
        const value = await load(exec, folder, on);
        if (this.gitReads[kind] === key) this.gitReads[kind] = null;
        const latest = shared(GIT);
        if (latest?.key === key) setShared(GIT, { ...latest, [kind]: value, [`${kind}At`]: Date.now() });
        cx.notify();
      });
    };
    read("git", current.gitAt, GIT_MS, readGitState);
    read("pr", current.prAt, PR_MS, readPr);
  }

  statusBar() {
    const t = theme(), s = spaces().find(s => s.active), list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const git = gitFor(s)?.git ?? null;
    const label = (id, name, text, hover = null) => h_flex().id(id).gap(6).items_center()
      .when(Boolean(hover), el => el.tooltip(hover)).child(icon(name, t.dim, 13)).child(text);
    const hover = branchHover(git, s?.branch ?? null);
    const ab = aheadBehind(git), dirty = uncommitted(git), running = runningFor(workingSince(s));
    return h_flex().id("workspace-status").size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .child(label("status-machine", s?.machine ? "server" : "laptop", s?.machine ?? "This computer", hover))
      .when(Boolean(ab), el => el.child(label("status-ahead-behind", "branch", ab, hover)))
      .when(Boolean(dirty), el => el.child(label("status-uncommitted", "worktree", dirty)))
      .when(Boolean(running), el => el.child(label("status-running", "work", `working ${running}`)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(paletteHint()));
  }

  launcher() {
    const t = theme(), ws = shared(ACTIVE), data = shared(DATA)?.[ws], s = spaces().find(s => s.active);
    const is = s && matchIssue(s, data?.issues ?? [], shared(LINKS) ?? [], ws, panes());
    const action = fn => { if (props().overlay) closeOverlay(props().overlay); fn(); };
    return v_flex().id("ticket-launcher").w_full().p(10).gap(8).bg(t.popover)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Work in a Linear issue"))
      .child(this.button("launch-new", "New issue…", () => action(() => dialog({ action: "new" })), { primary: true }))
      .child(this.button("launch-existing", is ? `Continue ${is.identifier}…` : "Choose an existing issue…", () => action(() => dialog(is ? { issue: { key: is.identifier, workspaceKey: data?.workspace?.urlKey } } : {}))))
      .when(Boolean(is), el => el.child(this.button("utility-terminal", "Utility terminal for this issue", () => action(() => run("tab.new", { space: s.id, name: "Shell" })))))
      .when(Boolean(s && !is), el => el.child(this.button("launch-attach", "Attach this workspace…", () => action(() => dialog({ action: "attach", attachSpace: currentSource() })))));
  }
  launchOptions() {
    const t = theme(), machine = this.launchTarget?.machine ?? null;
    const label = machine ?? "This computer", available = computers().find(m => m.name === machine)?.layout ?? "unavailable";
    const computerTrigger = this.button("choose-computer", `${label} · ${available} ▾`, cx => { this.targetPicker = this.targetPicker === "computer" ? null : "computer"; cx.notify(); }, { enabled: !this.busy });
    const repoTrigger = this.button("choose-repository", `${this.launchTarget?.folder ? this.launchTarget.name : "New repository"} ▾`, cx => { this.targetPicker = this.targetPicker === "repository" ? null : "repository"; cx.notify(); }, { enabled: !this.busy && !this.repositoriesLoading && !this.launchTarget?.blocked });
    const row = (id, text, action, enabled = true) => this.button(id, text, action, { enabled });
    return v_flex().flex_none().gap(6).py(7)
      .child(h_flex().gap(7).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.muted).child("Computer"))
        .child(Popup.new("computer-picker", computerTrigger).anchor("bottom_left").when(this.targetPicker === "computer", el => el.content(
          v_flex().p(6).gap(3).bg(t.popover).children(computers().map((m, i) =>
            row(`computer-${i}`, `${m.name ?? "This computer"} · ${m.layout}`, cx => this.chooseComputer(m.name, cx), !this.busy && m.layout === "ready"))))))
        .child(div().text_size(11).text_color(t.muted).child("Repository"))
        .child(Popup.new("repository-picker", repoTrigger).anchor("bottom_left").when(this.targetPicker === "repository", el => el.content(
          v_flex().id("repository-list").h(180).w(340).overflow_y_scrollbar().p(6).gap(3).bg(t.popover)
            .child(row("repository-new", "New repository", cx => this.selectRepository({ folder: "", name: "" }, cx), !this.busy && !this.repositoriesLoading))
            .children((this.repositories ?? []).map((r, i) => row(`repository-${i}`, r.name, cx => this.selectRepository(r, cx), !this.busy && !this.repositoriesLoading))))))
        .child(this.button("refresh-repositories", "↻", cx => this.chooseComputer(machine, cx, this.launchTarget?.folder ? this.launchTarget : null), { enabled: !this.busy })))
      .child(div().text_size(11).text_color(t.muted).child(this.repositoriesLoading ? `Reading ~/code on ${label}…` : `Repository root: ${this.repoRoot || "~/code on the selected computer"}`))
      .when(Boolean(this.repositoryError), el => el.child(div().text_size(11).text_color(t.blocked).child(this.repositoryError)))
      .child(div().text_size(12).font_family(MONO).text_color(t.foreground).child(`${label} · ${this.launchTarget?.folder || `New repository in ${this.repoRoot || "~/code"}, named for the work, made on start`}`))
      .child(h_flex().gap(7).items_center().flex_wrap().child(div().text_size(11).text_color(t.muted).child("Agent"))
        .children(this.agentChoices.map(a => this.button(`agent-${a.key}`, a.name, cx => { this.agentKey = a.key; if (!this.demo) setShared(PREFS, { ...shared(PREFS), [machine ?? ""]: a.key }); cx.notify(); }, { primary: a.key === this.agentKey, enabled: !this.busy })))
        .when(!this.agentChoices.length, el => el.child(div().text_size(11).text_color(t.muted).child(this.agentsChecked ? this.launchError || "No installed agents found" : "Checking installed agents…"))));
  }

  createStartButton() {
    return this.button("create-start", `Create & start${this.startSuffix()}`, cx => this.submit(cx, true), {
      primary: true, enabled: !this.busy && !this.form?.saveError && !this.form?.loadingStates && !this.form?.statesError &&
        Boolean(this.form?.capture ? this.captureDescription.value().trim() || this.title.value().trim() : this.desc.value().trim()) &&
        Boolean(this.form?.team) && Boolean(this.launchTarget && !this.launchTarget.blocked) && this.agentsChecked && this.agentChoices.some(a => a.key === this.agentKey),
    });
  }

  issueView(o) {
    const is = this.cur, attaching = Boolean(props().attachSpace), record = this.records().find(r => r.issue?.id === is.id);
    return v_flex().flex_1().min_h(0).gap(7)
      .when(!attaching && !record, el => el.child(this.launchOptions()))
      .child(h_flex().flex_none().gap(7).items_center().flex_wrap()
        .when(attaching, el => el.child(this.button("attach-selected", `Attach ${is.identifier}`, () => { this.attach(is); this.dismiss(); }, { primary: true })))
        .when(Boolean(record), el => el.child(this.button("open-linked", "Open workspace", () => { this.selectWork(record); this.dismiss(); }, { primary: true })))
        .when(!attaching && !record, el => el.child(this.button("start-work", `Start agent${this.startSuffix()}`, cx => this.worktree(cx, true), { primary: true, enabled: !this.busy && Boolean(this.launchTarget && !this.launchTarget.blocked) && !this.repositoriesLoading && this.agentsChecked && Boolean(this.detail) && !this.detail.startWhy && this.agentChoices.length > 0 })))
        .when(!attaching && Boolean(record) && Boolean(this.detail) && !this.detail.startWhy && !this.busy, el => el.children(this.agentChoices.map(a => this.button(`continue-${a.key}`, `+ ${a.name}`, cx => {
          this.continueAgent(record, is, a, cx);
        }))))
        .child(this.button("linked-followup", "New follow-up", () => { this.dismiss(); dialog({ action: "new", project: is.project?.id, parentIssue: is }); })))
      .child(super.issueView(o));
  }

  continueAgent(record, is, agent, cx) {
    if (this.busy || !this.agentsChecked) return;
    this.busy = `Checking ${is.identifier}…`;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const checked = await this.linear({ op: "check-start", issue: is.id });
        const installed = await knownAgents({ on: record.space.machine });
        const selected = installed.find(a => a.installed && a.key === agent.key);
        if (!selected) throw new Error("This agent is not installed on the workspace's machine.");
        run("tab.new", { space: record.space.id, name: selected.name, ...this.agentLaunch(selected, taskContext(checked.issue, this.detail?.description ?? "")) });
        this.dismiss();
      } catch (e) { this.say(String(e?.message ?? e), cx, true); }
      this.busy = "";
      cx.notify();
    });
  }
  // ---- Live strip: spaces grouped by the machine they run on -------------------------

  spaceRow(record, id) {
    const t = theme(), is = this.enrich(record.issue);
    const color = record.needs ? t.blocked : record.status === "working" ? t.working : t.dim;
    return h_flex().id(id).min_w(0).h(26).flex_none().px(6).gap(6).items_center().rounded(5)
      .bg(record.space.active ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click(() => this.selectWork(record))
      .on_mouse_down("right", (_e, cx) => this.spaceMenu(record.space, cx, record.issue, record.folder))
      .child(icon(record.needs ? "need" : record.status === "working" ? "work" : "idle", color, 11)
        .when(record.status === "working", el => el.spin(1100)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground)
        .tooltip(is ? issueHover(is) : record.space.name).child(is ? issueHeadline(is) : record.space.name))
      .when(Boolean(is?.project?.name?.trim()), el => el.child(div().flex_none().max_w(84).truncate().px(4).rounded(4)
        .bg(tint(t.muted, 0.12)).text_size(9.5).text_color(t.muted)
        .tooltip(is.project.name.trim()).child(is.project.name.trim())))
      .children(this.harnessIcons([record]))
      .child(div().flex_none().text_size(10).text_color(color)
        .child(record.needs ? (record.status === "blocked" ? "needs you" : "ready") : record.status === "working" ? "working" : ""));
  }

  liveStrip() {
    const t = theme(), records = sharedRecords();
    const groups = machineGroups(records, machines()).filter(g => g.records.length || !g.reachable || g.name === null);
    return v_flex().id("live-strip-body").size_full().min_w(0).min_h(0).px(10).gap(1).bg(t.chrome)
      .child(h_flex().h(20).flex_none().items_center().gap(7)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("SPACES"))
        .child(div().flex_1())
        .when(records.some(r => r.needs), el => el.child(div().text_size(10).text_color(t.blocked)
          .child(`${records.filter(r => r.needs).length} need you`)))
        .child(div().text_size(10).text_color(t.dim)
          .child(`${records.filter(r => r.status === "working").length} working · ${records.length} open`)))
      .child(v_flex().flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(1)
        .when(!records.length, el => el.child(div().py(6).text_size(10.5).text_color(t.muted).child("No open workspaces")))
        .children(groups.flatMap(group => [
          h_flex().id(`machine-${group.name ?? "local"}`).h(18).flex_none().items_center().gap(6).pt(3)
            .child(this.machineDot(group.name, 6))
            .child(div().text_size(9.5).font_semibold().text_color(group.reachable ? t.muted : t.blocked)
              .child(machineLabel(group.name).toUpperCase()))
            .child(div().flex_1())
            .when(!group.reachable, el => el.child(div().text_size(9.5).text_color(t.blocked)
              .child(stateWord(machineState(group.name, machines())) || "unreachable")))
            .when(group.reachable && group.records.length > 0, el => el.child(div().text_size(9.5).text_color(t.dim).child(String(group.records.length)))),
          ...group.records.map(r => this.spaceRow(r, `strip-${group.name ?? "local"}-${r.space.id}`)),
        ])));
  }

  // ---- Panel: the issue, and the agent working it ------------------------------------

  activeRecord() { return sharedRecords().find(r => r.space.active) ?? null; }

  issuePanel() {
    const t = theme(), record = this.activeRecord(), enrichment = this.enrichment();
    const raw = record?.issue;
    const extra = raw?.identifier ? enrichment.byIdentifier?.get(String(raw.identifier).toUpperCase()) : null;
    const is = raw ? { ...raw, delegate: extra?.delegate ?? null, labels: extra?.labels ?? [] } : null;
    if (!is) {
      return v_flex().id("issue-panel").size_full().p(12).gap(8).bg(t.background)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("No issue"))
        .child(div().text_size(11).text_color(t.muted).line_height(1.5)
          .child("This workspace has no Linear ticket. Attach one from the header, or create a task from the board."));
    }
    const labels = visibleLabels(is);
    return v_flex().id("issue-panel").size_full().min_h(0).p(12).gap(9).bg(t.background)
      .on_mouse_down("right", (_e, cx) => this.issueMenu(is, cx))
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(icon(stateIcon(is.state), t.muted, 13))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO).text_color(t.foreground).child(is.identifier))
        .child(this.button("issue-panel-open", "Details", () => this.details(is))))
      .child(div().text_size(13).text_color(t.foreground).line_height(1.4).child(is.title))
      .child(h_flex().gap(5).flex_wrap().items_center()
        .child(this.chip("issue-panel-state", is.state?.name ?? "", issueNeedsYou(is, this.attentionRules()) ? t.blocked : t.muted))
        .children(this.delegateChips(delegateOf(is), "issue-panel"))
        .children(this.machineChips(record ? [record] : [], "issue-panel"))
        .children(labels.map((l, i) => this.chip(`issue-panel-label-${i}`, l, t.dim))))
      .child(v_flex().gap(4).pt(4)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("PROJECT"))
        .child(div().text_size(11.5).text_color(t.foreground).child(is.project?.name ?? "No project")))
      .when(Boolean(record?.folder), el => el.child(v_flex().gap(4).pt(4)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("WORKTREE"))
        .child(div().text_size(11).font_family(MONO).text_color(t.muted).child(record.folder))))
      .when(Boolean(is.branch), el => el.child(v_flex().gap(4).pt(4)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("BRANCH"))
        .child(div().text_size(11).font_family(MONO).text_color(t.muted).child(is.branch))));
  }

  // ---- Handing one issue to a Linear agent, from the panel beside it -----------------
  //
  // The same single-field verified write Crew uses, reachable without opening Crew: the
  // agent list is read on demand, because this role loads no Linear list of its own.

  handoffState() {
    this.handoff ??= {
      open: false, issueId: null, target: null,
      agents: { list: [], error: null, loading: false, complete: false, key: null },
      busy: "", result: null, gate: requestGate(),
    };
    return this.handoff;
  }

  handoffToggle(issue, cx) {
    const h = this.handoffState();
    if (h.busy) return;
    const open = !(h.open && h.issueId === issue?.id);
    h.open = open;
    h.issueId = issue?.id ?? null;
    h.target = null;
    h.result = null;
    if (open) this.handoffLoadAgents(cx);
    cx.notify();
  }

  handoffLoadAgents(cx) {
    const h = this.handoffState(), linear = this.crewLinear();
    if (!linear) { h.agents = { ...h.agents, loading: false, key: null }; return; }
    const key = JSON.stringify(linear);
    if (h.agents.key === key && (h.agents.loading || h.agents.complete)) return;
    const current = h.gate.begin("agents");
    h.agents = { ...h.agents, loading: true, key };
    cx.spawn(async cx => {
      const res = await fetchAgents(linear);
      if (!current() || JSON.stringify(this.crewLinear()) !== key) return;
      h.agents = { list: res.agents, error: res.error, loading: false, complete: res.complete, key };
      cx.notify();
    });
  }

  /** Who this issue can go to: Linear agent identities only, never its current delegate. */
  handoffChoices(issue) {
    const h = this.handoffState();
    const roster = crewRoster({ agents: h.agents.list, rows: this.enrichment().rows });
    return reassignChoices(roster, { sourceId: issue?.delegate?.id ?? null, listFailed: Boolean(h.agents.error) });
  }

  /** Writes the delegate, proves it from Linear, then republishes the enrichment so the
   *  chip, the groups and Crew all show the new agent. Starts no terminal. */
  handoffApply(issue, cx) {
    const h = this.handoffState(), target = h.target, linear = this.crewLinear();
    if (h.busy || !target?.id || !issue?.id || !linear) return;
    if (!this.handoffChoices(issue).some(e => e.id === target.id)) return;
    const words = handoffWords(issue.delegate);
    h.busy = `${words.gerund} ${issue.identifier} to ${target.name}…`;
    h.result = null;
    cx.notify();
    cx.spawn(async cx => {
      let outcome;
      try { outcome = await reassignIssue({ ...linear, id: issue.id, delegateId: target.id }); }
      catch (e) { outcome = { ok: false, error: String(e?.message ?? e) }; }
      h.busy = "";
      h.result = outcome?.ok === true
        ? { ok: true, text: `${issue.identifier} is delegated to ${target.name}; Linear confirmed it.` }
        : { ok: false, text: `${issue.identifier} was not delegated: ${outcome?.error ?? "Unknown failure"}` };
      if (outcome?.ok === true) { h.open = false; h.target = null; }
      // Counts and chips come back from Linear, not from what was sent.
      await this.refreshEnrichment(linear, cx);
    });
  }

  handoffPanel(issue) {
    const t = theme(), h = this.handoffState(), words = handoffWords(issue?.delegate);
    const linear = this.crewLinear(), choices = this.handoffChoices(issue);
    return v_flex().id("agent-panel-handoff").flex_none().p(8).gap(6).rounded(6).bg(t.raised)
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground)
        .child(`${words.verb} ${issue.identifier}${h.target ? ` to ${h.target.name}` : " to a Linear agent"}`))
      .when(!linear, el => el.child(div().text_size(10.5).text_color(t.muted).line_height(1.4)
        .child("Waiting for the Herdr sidebar to connect to Linear; the agent list loads as soon as it does.")))
      .when(Boolean(linear) && h.agents.loading && !choices.length, el => el.child(div().text_size(10.5).text_color(t.muted)
        .child("Reading agents from Linear…")))
      .when(Boolean(h.agents.error), el => el.child(div().text_size(10.5).text_color(t.blocked).line_height(1.4)
        .child(`Agent list unavailable: ${h.agents.error}. Only agents confirmed assignable on the available data are offered.`)))
      .when(Boolean(linear) && !h.agents.loading && !choices.length, el => el.child(div().text_size(11).text_color(t.muted)
        .child(words.first ? "No Linear agent is available." : "No other Linear agent is available.")))
      .child(h_flex().gap(5).flex_wrap()
        .children(choices.map((e, i) => this.button(`agent-panel-agent-${i}`, `${e.name} · ${e.total}`,
          cx => { h.target = { id: e.id, name: e.name }; cx.notify(); },
          { primary: h.target?.id === e.id, enabled: !h.busy }))))
      .child(div().text_size(10.5).text_color(t.muted).line_height(1.4)
        .child(`${words.first ? "Sets" : "Changes"} only the Linear delegate. The human assignee, project, priority and workflow state are kept, and the issue is checked in Linear after saving.`))
      .child(div().text_size(10.5).text_color(t.muted).line_height(1.4)
        .child("Linear runs the agent; Herdr starts no terminal and sends no commands. Any session already open here keeps running."))
      .when(Boolean(h.busy), el => el.child(div().text_size(11).text_color(t.muted).child(h.busy)))
      .child(h_flex().gap(6)
        .child(this.button("agent-panel-apply", h.target ? `${words.verb} to ${h.target.name}` : "Choose an agent",
          cx => this.handoffApply(issue, cx),
          { primary: true, enabled: choices.some(e => e.id === h.target?.id) && !h.busy && Boolean(linear) }))
        .child(this.button("agent-panel-cancel", "Cancel",
          cx => { h.open = false; h.target = null; cx.notify(); }, { enabled: !h.busy })));
  }

  handoffResult() {
    const t = theme(), r = this.handoffState().result;
    return div().id("agent-panel-handoff-result").flex_none().px(8).py(6).rounded(6)
      .bg(tint(r.ok ? t.done : t.blocked, 0.1)).text_size(11).line_height(1.4)
      .text_color(r.ok ? t.done : t.blocked).child(r.text);
  }

  /** What the delegate on the active issue is doing, across every machine. Linear says who
   *  owns the ticket; Herdr says what is actually running. Both are shown separately so a
   *  delegated ticket with nothing running does not read as work in progress. */
  agentPanel() {
    const t = theme(), record = this.activeRecord(), enrichment = this.enrichment();
    const is = record?.issue ? this.enrich(record.issue, enrichment) : null;
    const delegate = delegateOf(is) ?? this.delegateFilter();
    // The ticket's own agent, which is not the same as `delegate`: that falls back to the
    // Spaces delegate filter, and a filter must never read as this ticket having an agent.
    const own = is ? delegateOf(is) : null;
    const rows = delegate ? enrichment.rows.filter(r => r.delegate?.name === delegate) : [];
    const records = sharedRecords();
    const live = delegate
      ? records.filter(r => r.issue && rows.some(x => x.identifier === r.issue.identifier))
      : [];
    return v_flex().id("agent-panel").size_full().min_h(0).p(12).gap(9).bg(t.background)
      .child(h_flex().gap(7).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground)
          .child(delegate ?? "No agent"))
        .when(Boolean(delegate), el => el.child(this.button("agent-panel-filter", "Show only this", cx => this.setDelegateFilter(delegate, cx))))
        .when(Boolean(is?.id), el => el.child(this.button("agent-panel-delegate", own ? "Change agent…" : "Delegate…",
          cx => this.handoffToggle(is, cx), { primary: !own, enabled: !this.handoffState().busy }))))
      .when(!delegate && !is?.id, el => el.child(div().text_size(11).text_color(t.muted).line_height(1.5)
        .child("No ticket is open here and no agent is filtered. Open a ticket's workspace, or choose an agent in Crew.")))
      .when(!own && Boolean(is?.id), el => el.child(div().text_size(11).text_color(t.muted).line_height(1.5)
        .child("No Linear agent has this ticket yet. Delegate… hands it to one; Linear runs the agent and its work shows here.")))
      .when(Boolean(is?.id) && this.handoffState().open && this.handoffState().issueId === is.id,
        el => el.child(this.handoffPanel(is)))
      .when(Boolean(this.handoffState().result) && this.handoffState().issueId === (is?.id ?? null),
        el => el.child(this.handoffResult()))
      .when(Boolean(delegate), el => el
        .child(v_flex().gap(4)
          .child(div().text_size(10).font_semibold().text_color(t.dim).child(`DELEGATED IN LINEAR · ${rows.length}`))
          .when(!rows.length, el => el.child(div().py(3).text_size(11).text_color(t.muted).child("Nothing open")))
          .children(rows.slice(0, 12).map(r => h_flex().id(`agent-issue-${r.identifier}`).h(24).gap(6).items_center().min_w(0)
            .child(div().flex_none().text_size(10).font_family(MONO).text_color(t.dim).child(r.identifier))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(r.project?.name ?? ""))
            .child(div().flex_none().text_size(10).text_color(issueNeedsYou({ state: r.state, labels: r.labels }, this.attentionRules()) ? t.blocked : t.muted)
              .child(r.state?.name ?? "")))))
        .child(v_flex().gap(4).pt(6)
          .child(div().text_size(10).font_semibold().text_color(t.dim).child(`RUNNING IN HERDR · ${live.length}`))
          .when(!live.length, el => el.child(div().py(3).text_size(11).text_color(t.muted)
            .child("No workspace open for its tickets. A delegated ticket is not a running agent.")))
          .children(live.map(r => this.spaceRow(r, `agent-live-${r.space.id}`)))));
  }

  // ---- Crew: every Linear agent and its issue queue, one window -----------------------
  //
  // Left: every Linear agent identity, with open and needs-attention counts kept apart.
  // Right: the selected agent's whole open delegated queue, read from Linear by delegate,
  // whether or not any of it has a Herdr space; an issue inspector; and reassignment.
  // Selecting an agent here never filters the main Spaces list.
  //
  // State lives on `this.crew` and is only changed from handlers and spawned tasks, never
  // while rendering.

  crewInit(cx) {
    this.crew = {
      agent: null,          // { id, name } selected on the left
      queues: {},           // agent id -> { rows, complete, error, loading, waiting, fetchedAt }
      agents: { list: [], error: null, loading: false, waiting: true, complete: false, key: null, at: 0 },
      issueId: null,        // the issue open in the inspector
      details: {},          // issue id -> { issue, error, loading, waiting, row }
      picked: new Set(),    // issue ids selected for reassignment
      retryRows: [],         // failed writes remain available even if a queue refresh fails
      reassign: null,       // { target: agent|null } while the reassign panel is open
      busy: "",
      result: null,         // { text, ok, failed: [{identifier, error}] }
      gate: requestGate(),  // last request wins, per agent list / queue / issue
    };
    // A kept window can start before the sidebar has published the layout config and the
    // machine Linear runs on. The tick waits for both, loads the agent list once they are
    // there (and again if they change), retries a failed list, and runs any read that was
    // asked for while waiting.
    this.crewTick(cx);
    cx.timer.every(CREW_TICK_MS, cx => this.crewTick(cx));
  }

  /** The published Linear connection, or null while the sidebar has not published it. */
  crewLinear() { return crewContext(shared(CONFIG), shared(ENRICH)); }

  crewTick(cx) {
    const crew = this.crew, linear = this.crewLinear();
    if (!linear) return;
    const key = JSON.stringify(linear), a = crew.agents;
    const retry = Boolean(a.error) && Date.now() - a.at >= CREW_RETRY_MS;
    let started = false;
    if (a.key !== key || (!a.loading && (a.waiting || retry))) { this.crewLoadAgents(cx); started = true; }
    for (const [id, q] of Object.entries(crew.queues)) {
      if (q.waiting || q.key !== key || (!q.loading && q.enrichmentAt !== sharedEnrich().fetchedAt)) {
        this.crewLoadQueue(id, cx); started = true;
      }
    }
    const d = crew.issueId ? crew.details[crew.issueId] : null;
    if (d?.row && (d.waiting || d.key !== key)) { this.crewInspect(d.row, cx); started = true; }
    if (started) cx.notify();
  }

  crewLoadAgents(cx) {
    const crew = this.crew, linear = this.crewLinear();
    if (!linear) { crew.agents = { ...crew.agents, loading: false, waiting: true }; return; }
    const key = JSON.stringify(linear), current = crew.gate.begin("agents");
    crew.agents = { ...crew.agents, loading: true, waiting: false, key, at: Date.now() };
    cx.spawn(async cx => {
      const res = await fetchAgents(linear);
      if (!current()) return;
      if (JSON.stringify(this.crewLinear()) !== key) return;
      crew.agents = { list: res.agents, error: res.error, loading: false, waiting: false, complete: res.complete, key, at: Date.now() };
      cx.notify();
    });
  }

  crewSelectAgent(entry, cx) {
    const crew = this.crew;
    if (crew.busy) return;
    if (crew.agent?.id !== entry.id || crew.agent?.name !== entry.name) {
      crew.picked = new Set();
      crew.reassign = null;
      crew.result = null;
      crew.retryRows = [];
    }
    crew.agent = { id: entry.id, name: entry.name, undelegated: entry.undelegated === true };
    crew.issueId = null;
    // The handoff bucket has no delegate to query by: its rows come from the enrichment.
    if (!entry.undelegated) this.crewLoadQueue(entry.id, cx);
    cx.notify();
  }

  crewLoadQueue(id, cx) {
    const crew = this.crew, linear = this.crewLinear();
    if (!id) return;
    const previous = crew.queues[id];
    const base = { rows: previous?.rows ?? [], complete: false, error: null, loading: true, fetchedAt: previous?.fetchedAt ?? null };
    if (!linear) { crew.queues[id] = { ...base, waiting: true }; return; }
    // Only the newest read for this agent may land: the read issued after a reassignment
    // must not be overwritten by an older one still in flight.
    const current = crew.gate.begin(`queue:${id}`);
    const key = JSON.stringify(linear), enrichmentAt = sharedEnrich().fetchedAt;
    crew.queues[id] = { ...base, waiting: false, key, enrichmentAt };
    cx.spawn(async cx => {
      const res = await fetchQueue({ ...linear, delegateId: id });
      if (!current()) return;
      if (JSON.stringify(this.crewLinear()) !== key) return;
      const rows = res.error ? [...new Map([...base.rows, ...res.rows].map(row => [row.id, row])).values()] : res.rows;
      crew.queues[id] = { rows, complete: res.complete, error: res.error, loading: false, waiting: false, fetchedAt: res.fetchedAt, key, enrichmentAt };
      // An issue that left the queue can no longer be picked from it.
      const ids = new Set([...rows, ...(crew.retryRows ?? [])].map(r => r.id));
      if (crew.agent?.id === id) crew.picked = new Set([...crew.picked].filter(x => ids.has(x)));
      cx.notify();
    });
  }

  crewInspect(row, cx) {
    const crew = this.crew, linear = this.crewLinear();
    crew.issueId = row.id;
    const base = { issue: crew.details[row.id]?.issue ?? null, error: null, loading: true, row };
    if (!linear) { crew.details[row.id] = { ...base, waiting: true }; cx.notify(); return; }
    const current = crew.gate.begin(`issue:${row.id}`);
    const key = JSON.stringify(linear);
    crew.details[row.id] = { ...base, waiting: false, key };
    cx.notify();
    cx.spawn(async cx => {
      const res = await fetchIssueDetail({ ...linear, id: row.id });
      if (!current()) return;
      if (JSON.stringify(this.crewLinear()) !== key) return;
      crew.details[row.id] = { issue: res.issue, error: res.error, loading: false, waiting: false, row, key };
      cx.notify();
    });
  }

  crewTogglePick(id, cx) {
    if (this.crew.busy) return;
    const picked = new Set(this.crew.picked);
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    this.crew.picked = picked;
    cx.notify();
  }

  crewOpenReassign(ids, cx) {
    if (this.crew.busy) return;
    this.crew.picked = new Set(ids);
    this.crew.reassign = { target: null };
    this.crew.result = null;
    cx.notify();
  }

  /** Moves the picked issues to the chosen agent, verifying each from Linear. Failures
   *  stay picked so the same button retries them. Nothing here touches a terminal: a
   *  running agent keeps running on its old ticket context. */
  crewApplyReassign(rows, cx) {
    const crew = this.crew, target = crew.reassign?.target, source = crew.agent, linear = this.crewLinear();
    if (crew.busy || !target?.id || !rows.length || !linear) return;
    const roster = crewRoster({ agents: crew.agents.list, rows: sharedEnrich().rows });
    if (!reassignChoices(roster, { sourceId: source?.id, listFailed: Boolean(crew.agents.error) }).some(e => e.id === target.id)) return;
    const words = handoffWords(source);
    crew.busy = `${words.gerund} ${rows.length} issue${rows.length === 1 ? "" : "s"} to ${target.name}…`;
    crew.result = null;
    cx.notify();
    cx.spawn(async cx => {
      const batch = await reassignBatch(rows, row => reassignIssue({ ...linear, id: row.id, delegateId: target.id }));
      crew.picked = new Set(batch.failed.map(f => f.id));
      crew.retryRows = rows.filter(row => crew.picked.has(row.id));
      crew.result = {
        ok: batch.ok, text: batchSummary(batch, target.name, words),
        failed: batch.failed.map(f => ({ identifier: f.identifier, error: f.error })),
      };
      if (!crew.picked.size) crew.reassign = null;
      crew.busy = "";
      // Counts and rows come back from Linear, not from what was sent.
      if (source?.id) this.crewLoadQueue(source.id, cx);
      this.crewLoadQueue(target.id, cx);
      if (crew.issueId && batch.results.some(r => r.id === crew.issueId && r.ok)) {
        const d = crew.details[crew.issueId];
        if (d?.row) this.crewInspect(d.row, cx);
      }
      await this.refreshEnrichment(linear, cx);
    });
  }

  /** Re-reads the bulk enrichment and republishes it, so a delegation made here shows on
   *  every row, chip and group at once instead of waiting for the sidebar's next tick.
   *  A read started before this one is dropped rather than published. */
  async refreshEnrichment(linear, cx) {
    const current = enrichmentRequest();
    const enriched = await fetchEnrichment(linear);
    if (current() && JSON.stringify(this.crewLinear()) === JSON.stringify(linear) && (!enriched.error || enriched.rows.length)) {
      setShared(ENRICH, { rows: enriched.rows, error: enriched.error, fetchedAt: enriched.fetchedAt, partial: enriched.partial, on: linear.on });
    }
    cx.notify();
  }

  crewWindow() {
    const t = theme(), enrichment = this.enrichment(), rules = this.attentionRules(), crew = this.crew;
    const roster = crewRoster({ agents: crew.agents.list, rows: enrichment.rows, rules, queues: crew.queues,
      fetchedAt: enrichment.error || enrichment.partial ? null : enrichment.fetchedAt });
    const records = sharedRecords([...enrichment.rows, ...Object.values(crew.queues).flatMap(q => q.rows)]);
    // Open work no agent has yet, so it can be handed out from the same window. Not an
    // agent, so it stays out of the agent count and out of the destination list.
    const bucket = undelegatedEntry({ rows: enrichment.rows, rules,
      complete: Boolean(enrichment.fetchedAt) && !enrichment.error && !enrichment.partial });
    const withWork = roster.filter(e => e.total).length;
    const caveat = enrichment.error ? `Counts may be stale: ${enrichment.error}`
      : enrichment.partial ? "Counts are from a partial read of Linear (at least these many)."
      : !enrichment.fetchedAt ? "Queue counts are loading. Select an agent to read its queue."
      : enrichment.rows.some(row => row.contextIncomplete?.includes("labels")) ? "Attention counts are lower bounds while labels are incomplete." : null;
    return v_flex().id("crew-window").size_full().min_h(0).min_w(0).p(10).gap(8).bg(t.popover)
      .child(h_flex().h(26).flex_none().items_center().gap(8)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Crew"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .child(`${roster.length} agent${roster.length === 1 ? "" : "s"} · ${withWork} with open work`))
        .when(Boolean(this.delegateFilter()), el => el.child(this.button("crew-clear", `Clear Spaces filter (${this.delegateFilter()})`, cx => this.applyFilter(null, cx))))
        .child(this.button("crew-refresh", "↻", cx => {
          this.crewLoadAgents(cx);
          if (crew.agent?.id) this.crewLoadQueue(crew.agent.id, cx);
        }, { enabled: !crew.busy }))
        .child(this.button("crew-close", "✕", () => closeOverlay(props().overlay))))
      .when(Boolean(caveat), el => el.child(div().flex_none().text_size(10.5).text_color(enrichment.error ? t.blocked : t.muted).truncate().child(caveat)))
      .child(h_flex().flex_1().min_h(0).min_w(0).gap(10).items_start()
        .child(this.crewAgentList(roster, records, enrichment, bucket))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(v_flex().flex_1().h_full().min_h(0).min_w(0)
          .child(crew.issueId ? this.crewInspector(records) : crew.agent ? this.crewQueue(roster, records, rules, bucket) : this.crewHint())));
  }

  crewHint() {
    const t = theme();
    return v_flex().flex_1().min_h(0).p(12).gap(6)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Choose an agent"))
      .child(div().text_size(11.5).text_color(t.muted).line_height(1.5)
        .child("Its full open Linear queue appears here, with or without Herdr spaces. Selecting an agent does not change the Spaces list."))
      .child(div().text_size(11.5).text_color(t.muted).line_height(1.5)
        .child(`Choose ${UNDELEGATED_NAME} to see open work no agent has yet, and hand it to one.`));
  }

  /** The handoff bucket's row: open issues with no agent, above the crew it can go to.
   *  Drawn even when empty, so "nothing waiting to be handed out" is visible. */
  crewBucketRow(bucket) {
    const t = theme(), crew = this.crew, active = crew.agent?.undelegated === true;
    const color = bucket.needs ? t.blocked : bucket.total ? t.muted : t.dim;
    return v_flex().id("crew-undelegated").flex_none().min_w(0).px(7).py(5).gap(3).rounded(6)
      .bg(active ? t.selected : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.crewSelectAgent(bucket, cx))
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(div().size(7).rounded(7).flex_none().border_1().border_color(color))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(bucket.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`${bucket.total}${bucket.countIncomplete ? "+" : ""} open`)))
      .child(h_flex().gap(4).pl(14).flex_wrap().items_center()
        .when(bucket.needs > 0, el => el.child(this.chip("crew-undelegated-needs", `${bucket.needs} of ${bucket.total} need attention`, t.blocked)))
        // An unfinished read means zero is unknown, not "none": never claim the latter.
        .when(!bucket.total, el => el.child(div().text_size(10).text_color(t.dim)
          .child(bucket.countIncomplete ? "not read yet" : "nothing waiting for an agent")))
        .when(bucket.total > 0, el => el.child(div().text_size(10).text_color(t.dim).child("no agent yet"))));
  }

  crewAgentList(roster, records, enrichment, bucket) {
    const t = theme(), crew = this.crew;
    return v_flex().id("crew-agents").w(230).flex_none().h_full().min_h(0).overflow_y_scrollbar().gap(2)
      .when(crew.agents.waiting, el => el.child(div().py(8).text_size(11).text_color(t.muted).line_height(1.4)
        .child(enrichment.error ? `Waiting for the Herdr sidebar to connect to Linear: ${enrichment.error}` : "Waiting for the Herdr sidebar to connect to Linear…")))
      .when(crew.agents.loading && !roster.length, el => el.child(div().py(8).text_size(11).text_color(t.muted).child("Reading agents from Linear…")))
      .when(Boolean(crew.agents.error), el => el.child(div().py(4).text_size(10.5).text_color(t.blocked).line_height(1.4)
        .child(`Agent list unavailable: ${crew.agents.error}. Only agents with open work are shown.`)))
      .when(!crew.agents.loading && !crew.agents.error && !crew.agents.complete && crew.agents.list.length > 0, el => el.child(div().py(4).text_size(10.5).text_color(t.muted)
        .child("Agent list is incomplete; Linear has more.")))
      .when(!crew.agents.loading && !crew.agents.waiting && !roster.length, el => el.child(div().py(8).text_size(11).text_color(t.muted)
        .child(enrichment.fetchedAt || crew.agents.error ? "No Linear agents found." : "Reading delegates from Linear…")))
      .when(Boolean(bucket), el => el.child(this.crewBucketRow(bucket)))
      .when(Boolean(bucket) && roster.length > 0, el => el.child(div().h(1).flex_none().my(3).bg(t.border)))
      .children(roster.map((entry, i) => {
        const running = entry.issues.filter(r => herdrActivity(r.identifier, records).records.length).length;
        const active = crew.agent && (crew.agent.id ? crew.agent.id === entry.id : crew.agent.name === entry.name);
        const color = entry.needs ? t.blocked : running ? t.working : t.dim;
        return v_flex().id(`crew-agent-${i}`).flex_none().min_w(0).px(7).py(5).gap(3).rounded(6)
          .bg(active ? t.selected : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.crewSelectAgent(entry, cx))
          .child(h_flex().gap(7).items_center().min_w(0)
            .child(div().size(7).rounded(7).flex_none().bg(color))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(entry.name))
            .child(div().flex_none().text_size(10).text_color(t.dim).child(`${entry.total}${entry.countIncomplete ? "+" : ""} open`)))
          .child(h_flex().gap(4).pl(14).flex_wrap().items_center()
            .when(entry.needs > 0, el => el.child(this.chip(`crew-agent-${i}-needs`, `${entry.needs} of ${entry.total} need attention`, t.blocked)))
            .when(running > 0, el => el.child(this.chip(`crew-agent-${i}-live`, `${running} in Herdr`, t.working)))
            .when(!entry.total, el => el.child(div().text_size(10).text_color(t.dim).child("no open issues")))
            .when(entry.total > 0 && !entry.needs && !running, el => el.child(div().text_size(10).text_color(t.dim).child("nothing running"))));
      }));
  }

  /** A small square toggle; Herdr's Checkbox is controlled, this keeps state on `crew`. */
  crewCheck(id, on, toggle) {
    const t = theme();
    return div().id(id).size(16).flex_none().flex().items_center().justify_center().rounded(4)
      .border_1().border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, 0.2) : t.background)
      .text_size(11).text_color(t.accent).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); })
      .child(on ? "✓" : "");
  }

  crewQueue(roster, records, rules, bucket = null) {
    const t = theme(), crew = this.crew, agent = crew.agent, handoff = agent?.undelegated === true;
    const words = handoffWords(agent);
    const queue = handoff
      ? { rows: bucket?.issues ?? [], complete: !bucket?.countIncomplete, error: null, loading: false }
      : agent?.id ? crew.queues[agent.id]
      : { rows: [], complete: false, error: "This agent has no Linear identity", loading: false };
    const queueRows = queue?.rows ?? [];
    const rows = sortQueue([...new Map([...(crew.retryRows ?? []), ...queueRows].map(row => [row.id, row])).values()], rules);
    const counts = queueCounts(queueRows, rules);
    const status = handoff ? undelegatedStatus(bucket) : queueStatus(queue);
    const picked = rows.filter(r => crew.picked.has(r.id));
    const label = ["complete", "empty", "refreshing"].includes(status.kind) ? "" : " so far";
    return v_flex().flex_1().min_h(0).min_w(0).gap(7)
      .child(h_flex().flex_none().gap(8).items_center().min_w(0)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).truncate().child(agent.name))
        .child(div().text_size(11).text_color(t.muted).child(`${counts.total} open${label}`))
        .when(counts.needs > 0, el => el.child(div().text_size(11).text_color(t.blocked).child(`${counts.needs} need${counts.needs === 1 ? "s" : ""} attention`)))
        .child(div().flex_1())
        .child(this.button("crew-queue-refresh", "↻",
          cx => { const linear = this.crewLinear(); if (handoff) { if (linear) cx.spawn(cx => this.refreshEnrichment(linear, cx)); } else this.crewLoadQueue(agent.id, cx); },
          { enabled: (handoff ? Boolean(this.crewLinear()) : Boolean(agent.id)) && !queue?.loading && !crew.busy })))
      .when(Boolean(status.text), el => el.child(div().flex_none().text_size(11).line_height(1.4)
        .text_color(status.kind === "error" ? t.blocked : status.kind === "partial" ? t.blocked : t.muted).child(status.text)))
      .when(queueRows.some(row => row.contextIncomplete?.includes("labels")), el => el.child(div().flex_none().text_size(11).text_color(t.blocked)
        .child("Attention counts and ordering use the labels read so far. Open in Linear for all labels.")))
      .when(rows.length > 0, el => el.child(h_flex().flex_none().gap(6).items_center()
        .child(this.crewCheck("crew-pick-all", picked.length === rows.length, cx => {
          if (crew.busy) return;
          crew.picked = picked.length === rows.length ? new Set() : new Set(rows.map(r => r.id));
          cx.notify();
        }))
        .child(div().text_size(11).text_color(t.muted).child(picked.length ? `${picked.length} selected` : `Select issues to ${words.verb.toLowerCase()}`))
        .child(div().flex_1())
        .child(this.button("crew-reassign-open", picked.length > 1 ? `${words.verb} ${picked.length}…` : `${words.verb}…`,
          cx => this.crewOpenReassign(picked.map(r => r.id), cx), { enabled: picked.length > 0 && !crew.busy }))))
      .when(Boolean(crew.reassign) && picked.length > 0, el => el.child(this.crewReassignPanel(picked, records, roster)))
      .when(Boolean(crew.busy), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(crew.busy)))
      .when(Boolean(crew.result), el => el.child(this.crewResult()))
      .child(v_flex().id("crew-queue").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(3)
        .children(rows.map(row => this.crewQueueRow(row, records))));
  }

  crewQueueRow(row, records) {
    const t = theme(), crew = this.crew, a = row.attention, live = herdrActivity(row.identifier, records);
    const id = `crew-row-${row.id}`;
    const meta = [row.project?.name ?? "No project", row.state?.name, row.priorityLabel && row.priority ? row.priorityLabel : "No priority", age(row.updatedAt)].filter(Boolean).join(" · ");
    return h_flex().id(id).flex_none().min_w(0).px(7).py(5).gap(8).items_start().rounded(6)
      .bg(a.needs ? tint(t.blocked, 0.07) : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.crewInspect(row, cx))
      .on_mouse_down("right", (_e, cx) => this.issueMenu(row, cx))
      .child(div().pt(1).child(this.crewCheck(`${id}-pick`, crew.picked.has(row.id), cx => this.crewTogglePick(row.id, cx))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(7).min_w(0).items_center()
          .child(icon(a.needs ? "need" : stateIcon(row.state), a.needs ? t.blocked : t.dim, 12))
          .child(div().flex_none().text_size(10.5).font_family(MONO).text_color(t.dim).child(row.identifier))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(row.title)))
        .child(div().truncate().text_size(10.5).text_color(t.muted).child(meta))
        .when((row.contextIncomplete ?? []).length > 0, el => el.child(div().text_size(10.5).text_color(t.blocked)
          .child(`Incomplete context: ${row.contextIncomplete.join(", ")}. Open in Linear for the full context.`)))
        .when((crew.retryRows ?? []).some(r => r.id === row.id), el => el.child(div().text_size(10.5).text_color(t.blocked)
          .child("Reassignment not verified. Kept here for retry; current delegation may differ.")))
        .when(Boolean(a.reason), el => el.child(div().truncate().text_size(10.5).text_color(t.blocked).child(`Needs attention: ${a.reason}`)))
        .when(Boolean(a.blockedBy), el => el.child(div().truncate().text_size(10.5).text_color(a.needs ? t.blocked : t.muted).child(a.blockedBy))))
      .child(v_flex().flex_none().gap(3).items_end()
        .child(this.chip(`${id}-herdr`, live.records.length ? `Herdr: ${live.summary}` : "No Herdr space", live.running ? t.working : t.dim, { faded: !live.records.length }))
        .child(this.button(`${id}-move`, `${handoffWords(this.crew.agent).verb}…`, cx => this.crewOpenReassign([row.id], cx), { enabled: !crew.busy })));
  }

  /** Destination choice and the confirmation, in one place: how many, from whom, to whom,
   *  and what is running so nobody mistakes a ticket move for stopping an agent. */
  crewReassignPanel(picked, records, roster) {
    const t = theme(), crew = this.crew, source = crew.agent, target = crew.reassign.target;
    const words = handoffWords(source);
    // Only Linear agent identities with an id can be delegated to; local program names never.
    const choices = reassignChoices(roster, { sourceId: source?.id ?? null, listFailed: Boolean(crew.agents.error) });
    const running = picked.map(r => ({ row: r, live: herdrActivity(r.identifier, records) })).filter(x => x.live.records.length);
    const n = picked.length;
    return v_flex().id("crew-reassign").flex_none().max_h(260).min_h(0).overflow_y_scrollbar().p(8).gap(6).rounded(6).bg(t.raised)
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground)
        .child(words.first
          ? `${words.verb} ${n} issue${n === 1 ? "" : "s"}${target ? ` to ${target.name}` : " to a Linear agent"}`
          : `${words.verb} ${n} issue${n === 1 ? "" : "s"} from ${source?.name ?? "?"}${target ? ` to ${target.name}` : ""}`))
      .when(n <= 6, el => el.child(div().text_size(10.5).font_family(MONO).text_color(t.muted).child(picked.map(r => r.identifier).join(", "))))
      .when(Boolean(crew.agents.error), el => el.child(div().text_size(10.5).text_color(t.blocked)
        .child("Linear's agent list could not be read. Only agents confirmed assignable on the available data are offered.")))
      .when(!choices.length, el => el.child(div().text_size(11).text_color(t.muted).child(crew.agents.loading || crew.agents.waiting
        ? "Reading agents from Linear…" : words.first ? "No Linear agent is available." : "No other Linear agent is available.")))
      .child(h_flex().gap(5).flex_wrap()
        .children(choices.map((e, i) => this.button(`crew-dest-${i}`, `${e.name} · ${e.total}`, cx => { crew.reassign = { target: { id: e.id, name: e.name } }; cx.notify(); },
          { primary: target?.id === e.id, enabled: !crew.busy }))))
      .child(div().text_size(10.5).text_color(t.muted).line_height(1.4)
        .child(`${words.first ? "Sets" : "Changes"} only the Linear delegate. The human assignee, project, priority and workflow state are kept, and each issue is checked in Linear after saving.`))
      .when(words.first, el => el.child(div().text_size(10.5).text_color(t.muted).line_height(1.4)
        .child("Linear runs the agent; Herdr starts no terminal and sends no commands. Each issue moves under that agent here once Linear confirms it.")))
      .when(running.length > 0, el => el.child(div().text_size(10.5).text_color(t.working).line_height(1.4)
        .child(`Running in Herdr / open workspaces: ${running.map(x => `${x.row.identifier} (${x.live.summary})`).join("; ")}. Reassignment sends no Herdr commands; running sessions continue.`)))
      .child(h_flex().gap(6)
        .child(this.button("crew-apply", target ? `${words.verb} ${n} to ${target.name}` : "Choose an agent", cx => this.crewApplyReassign(picked, cx),
          { primary: true, enabled: choices.some(e => e.id === target?.id) && !crew.busy && Boolean(this.crewLinear()) }))
        .child(this.button("crew-cancel", "Cancel", cx => { crew.reassign = null; cx.notify(); }, { enabled: !crew.busy })));
  }

  crewResult() {
    const t = theme(), r = this.crew.result;
    return v_flex().id("crew-results").flex_none().max_h(120).min_h(0).overflow_y_scrollbar().gap(2).px(8).py(6).rounded(6).bg(tint(r.ok ? t.done : t.blocked, 0.1))
      .child(div().text_size(11).text_color(r.ok ? t.done : t.blocked).child(r.text))
      .children(r.failed.map((f, i) => div().id(`crew-fail-${i}`).text_size(10.5).text_color(t.blocked).line_height(1.4)
        .child(`${f.identifier}: ${f.error}`)));
  }

  crewInspector(records) {
    const t = theme(), crew = this.crew, d = crew.details[crew.issueId] ?? {};
    const is = d.issue ?? d.row ?? null;
    const a = is ? attentionOf(is, this.attentionRules()) : null;
    const live = is ? herdrActivity(is.identifier, records) : { records: [] };
    const record = live.records[0] ?? null;
    const section = (label, kids) => v_flex().flex_none().gap(3).pt(4)
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(label)).children(kids);
    return v_flex().id("crew-inspector").flex_1().min_h(0).min_w(0).gap(7)
      .when(Boolean(is), el => el.on_mouse_down("right", (_e, cx) => this.issueMenu(is, cx)))
      .child(h_flex().flex_none().gap(6).items_center().flex_wrap()
        .child(this.button("crew-back", `← ${crew.agent?.name ?? "Queue"}`, cx => { crew.issueId = null; cx.notify(); }))
        .child(div().flex_1())
        .when(Boolean(is?.url), el => el.child(this.button("crew-linear", "Open in Linear", cx => cx.open_url(is.url))))
        .when(Boolean(record), el => el.child(this.button("crew-workspace", "Open workspace", () => this.selectWork(record), { primary: true })))
        .when(Boolean(is?.id), el => el.child(this.button("crew-reassign-one", "Reassign…", cx => { crew.issueId = null; this.crewOpenReassign([is.id], cx); }, { enabled: !crew.busy }))))
      .when(!is, el => el.child(div().text_size(11).text_color(t.muted).child("Loading issue…")))
      .when(Boolean(is), el => el
        .child(h_flex().flex_none().gap(7).items_center().min_w(0)
          .child(icon(a.needs ? "need" : stateIcon(is.state), a.needs ? t.blocked : t.muted, 13))
          .child(div().flex_none().text_size(11.5).font_family(MONO).text_color(t.muted).child(is.identifier))
          .child(div().flex_1().min_w(0).text_size(13.5).font_semibold().text_color(t.foreground).line_height(1.35).child(is.title)))
        .child(h_flex().flex_none().gap(5).flex_wrap().items_center()
          .child(this.chip("crew-is-state", is.state?.name ?? "No state", a.needs ? t.blocked : t.muted))
          .children((is.labels ?? []).map((l, i) => this.chip(`crew-is-label-${i}`, l, t.dim))))
        .child(div().flex_none().text_size(11).text_color(t.muted)
          .child([is.project?.name ?? "No project", is.priority ? is.priorityLabel : "No priority",
            `Assignee: ${is.assignee?.name ?? "nobody"}`, `Delegate: ${is.delegate?.name ?? "none"}`, age(is.updatedAt)].filter(Boolean).join(" · ")))
        .when(Boolean(a.reason), el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`Needs attention: ${a.reason}`)))
        .child(div().flex_none().text_size(11).text_color(live.running ? t.working : t.muted)
          .child(live.records.length ? `Herdr: ${live.summary}. Reassigning does not stop it.` : "No Herdr space for this issue. That is fine: it is still in the queue."))
        .when(Boolean(d.loading), el => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child("Reading details from Linear…")))
        .when(Boolean(d.error), el => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`Details unavailable: ${d.error}`)))
        .when((is.contextIncomplete ?? []).length > 0, el => el.child(div().flex_none().text_size(11).text_color(t.blocked)
          .child(`Incomplete context: ${is.contextIncomplete.join(", ")}. Open in Linear for the full context.`)))
        .child(v_flex().id("crew-issue-body").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(4).pr(6)
          .when((is.blockers ?? []).length > 0, el => el.child(section("BLOCKED BY", is.blockers.map((b, i) =>
            div().id(`crew-blocker-${i}`).text_size(11).text_color(t.foreground).child(`${b.identifier} · ${b.title}${b.state?.name ? ` · ${b.state.name}` : ""}`)))))
          .when((d.issue?.blocking ?? []).length > 0, el => el.child(section("BLOCKS", d.issue.blocking.map((b, i) =>
            div().id(`crew-blocking-${i}`).text_size(11).text_color(t.foreground).child(`${b.identifier} · ${b.title}${b.state?.name ? ` · ${b.state.name}` : ""}`)))))
          .when((d.issue?.prs ?? []).length > 0, el => el.child(section("PULL REQUESTS", d.issue.prs.map((p, i) =>
            div().id(`crew-pr-${i}`).text_size(11).text_color(t.accent).cursor_pointer().hover(s => s.opacity(0.8))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => cx.open_url(p.url)).child(p.title)))))
          .when(Boolean(d.issue), el => el.child(section("DESCRIPTION", [
            TextView.markdown(`crew-md-${is.id}`, d.issue.description || "*No description.*").selectable(true).text_size(12.5).text_color(t.muted)
              .on_link_click((url, cx) => cx.open_url(url)),
          ])))));
  }

  /** The right-click menu on an issue, opened by issueMenu() as its own popup. */
  issueMenuInit(cx) {
    this.menuAt = 0;
    this.menuGit = null;
    this.menuFocus = cx.focus_handle();
    this.menuFocus.focus();
    const space = props()?.space;
    if (space?.folder) cx.spawn(async cx => {
      this.menuGit = await checkoutKind(space.folder, space.machine ?? null).catch(() => null);
      cx.notify();
    });
  }
  issueMenuItems() {
    const p = props() ?? {};
    const tags = p.demo ? [] : tagMenuItems(p.issue, isPinned({ labels: liveLabels(p.issue?.identifier) }));
    return [...issueMenuItems(p.issue), ...tags, ...spaceMenuItems(p.space, this.menuGit)];
  }
  issueMenuChoose(i, cx) {
    const p = props() ?? {}, it = this.issueMenuItems()[i];
    if (!it || this.menuBusy) return;
    if (it.action === "pin") return void this.pinFromMenu(it, cx);
    // Act before closing: closing drops this popup's view and the context with it.
    if (it.action === "copy") cx.write_to_clipboard(it.url);
    else if (it.action === "tags") openOverlay({ mod: "linear-board", kind: "popup", width: 280, height: 380,
      props: { role: "issue-tags", issue: p.issue } });
    else if (it.action === "open") { if (!p.demo) cx.open_url(it.url); }
    else if (it.action === "run") run(it.command, it.args);
    else if (it.action === "worktree") openOverlay({ mod: "worktree", kind: "dialog",
      ...(it.args.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it.args });
    closeOverlay(p.overlay);
  }
  /** Pins or unpins from the menu. The menu stays open until Linear confirms, so a failure
   *  is shown where it was asked for. */
  pinFromMenu(it, cx) {
    const p = props() ?? {}, is = p.issue ?? {};
    const pinned = it.label !== "Unpin";
    this.menuBusy = pinned ? "Pinning…" : "Unpinning…";
    this.menuError = "";
    cx.notify();
    cx.spawn(async cx => {
      const result = await setPinned({ on: sharedEnrich().on ?? null, config: shared(CONFIG) ?? {}, id: is.id, team: is.teamKey ?? null, pinned });
      if (result.labels) publishLabels(is.identifier, result.labels);
      this.menuBusy = null;
      if (result.ok) return void closeOverlay(p.overlay);
      this.menuError = result.error || "Linear did not confirm the change";
      cx.notify();
    });
  }
  issueMenuView() {
    const t = theme(), p = props() ?? {}, items = this.issueMenuItems();
    const kind = it => (it.action === "copy" || it.action === "open" ? "link" : it.action === "pin" || it.action === "tags" ? "tag" : "space");
    return v_flex().id("issue-menu").track_focus(this.menuFocus).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        const n = items.length;
        if (e.key === "escape") return void closeOverlay(p.overlay);
        if (!n) return;
        if (e.key === "down") this.menuAt = (this.menuAt + 1) % n;
        else if (e.key === "up") this.menuAt = (this.menuAt + n - 1) % n;
        else if (e.key === "enter") return void this.issueMenuChoose(this.menuAt, cx);
        else return;
        cx.notify();
      })
      .when(Boolean(p.issue?.identifier), el => el.child(div().px(8).pt(3).pb(4).truncate().text_size(10.5).font_family(MONO).text_color(t.dim).child(p.issue.identifier)))
      .children(items.map((it, i) => v_flex()
        .when(i > 0 && kind(it) !== kind(items[i - 1]), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`issue-menu-${i}`).h(28).px(8).gap(9).rounded(7).items_center()
        .text_color(t.foreground).when(i === this.menuAt, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => this.issueMenuChoose(i, cx))
        .child(div().flex_1().child(it.action === "pin" && this.menuBusy ? this.menuBusy : it.label)))))
      .when(Boolean(this.menuError), el => el.child(div().px(8).py(4).text_size(11).text_color(t.blocked).child(this.menuError)));
  }

  /** The tag picker for one issue: the workspace's and its team's Linear labels, checked
   *  when the issue has them. Clicking one adds or removes just that label in Linear. */
  tagsInit(cx) {
    const is = props()?.issue ?? {};
    this.tagQuery = "";
    this.tagCatalog = null;
    this.tagOwn = null;
    this.tagBusy = null;
    this.tagError = "";
    this.tagNote = "";
    this.tagSearch = InputState.new({ placeholder: "Find or create a tag…" });
    this.tagSearch.on("change", (_e, cx) => { this.tagQuery = this.tagSearch.value(); cx.notify(); });
    this.tagSearch.on("submit", (_e, cx) => {
      const first = this.tagRows()[0];
      if (canCreate(this.tagCatalog ?? [], this.tagQuery) && (!first || first.name.toLowerCase() !== this.tagQuery.trim().toLowerCase())) this.tagCreate(cx);
      else if (first) this.tagToggle(first, cx);
    });
    this.tagSearch.focus();
    const on = sharedEnrich().on ?? null, config = shared(CONFIG) ?? {};
    cx.spawn(async cx => {
      const [catalog, own] = await Promise.all([
        fetchCatalog({ on, config, team: is.teamKey ?? "" }),
        fetchIssueLabels({ on, config, id: is.id }),
      ]);
      this.tagCatalog = catalog.labels;
      this.tagNote = catalog.complete ? "" : "Showing the first labels Linear returned.";
      if (own.labels) { this.tagOwn = own.labels.map(l => l.name); publishLabels(is.identifier, own.labels); }
      this.tagError = catalog.error || own.error || "";
      cx.notify();
    });
  }
  tagCurrent() { return this.tagOwn ?? liveLabels(props()?.issue?.identifier); }
  tagRows() { return pickable(this.tagCatalog ?? [], this.tagCurrent(), this.tagQuery); }
  async tagWrite(cx, label, wanted) {
    const is = props()?.issue ?? {};
    const result = await setTag({ on: sharedEnrich().on ?? null, config: shared(CONFIG) ?? {}, id: is.id, labelId: label.id, wanted });
    if (result.labels) { this.tagOwn = result.labels.map(l => l.name); publishLabels(is.identifier, result.labels); }
    this.tagError = result.ok ? "" : result.error || "Linear did not confirm the change";
    this.tagBusy = null;
    cx.notify();
  }
  tagToggle(label, cx) {
    if (this.tagBusy || !label?.id) return;
    const wanted = !this.tagCurrent().some(name => String(name).toLowerCase() === label.name.toLowerCase());
    this.tagBusy = label.id;
    this.tagError = "";
    cx.notify();
    cx.spawn(cx => this.tagWrite(cx, label, wanted));
  }
  tagCreate(cx) {
    if (this.tagBusy) return;
    const { name, error } = tagName(this.tagQuery);
    if (error) { this.tagError = error; return void cx.notify(); }
    this.tagBusy = "create";
    this.tagError = "";
    cx.notify();
    cx.spawn(async cx => {
      const made = await createTag({ on: sharedEnrich().on ?? null, config: shared(CONFIG) ?? {}, name });
      if (made.error) { this.tagBusy = null; this.tagError = made.error; return void cx.notify(); }
      this.tagCatalog = [...(this.tagCatalog ?? []), made.label];
      this.tagQuery = "";
      this.tagSearch.set_value("");
      await this.tagWrite(cx, made.label, true);
    });
  }
  tagsView() {
    const t = theme(), p = props() ?? {}, is = p.issue ?? {};
    const rows = this.tagRows(), loading = this.tagCatalog === null;
    const create = !loading && canCreate(this.tagCatalog, this.tagQuery) ? tagName(this.tagQuery).name : null;
    return v_flex().id("issue-tags").size_full().min_h(0).p(6).gap(5).bg(t.popover).text_size(12.5)
      .on_key_down((e, _cx) => { if (e.key === "escape") closeOverlay(p.overlay); })
      .child(h_flex().px(4).gap(6).items_center()
        .child(div().flex_none().text_size(10.5).font_family(MONO).text_color(t.dim).child(is.identifier ?? ""))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child("Linear tags · same on every machine")))
      .child(h_flex().h(28).flex_none().px(7).gap(6).items_center().rounded(6).bg(t.background)
        .child(icon("search", t.dim, 12)).child(Input.new(this.tagSearch).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .child(v_flex().id("issue-tags-list").flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .when(loading, el => el.child(div().px(8).py(6).text_color(t.muted).child("Reading Linear labels…")))
        .when(Boolean(create), el => el.child(h_flex().id("issue-tags-create").h(26).flex_none().px(8).gap(8).items_center().rounded(6)
          .cursor_pointer().hover(s => s.bg(t.hover)).text_color(t.accent ?? t.foreground)
          .on_click((_e, cx) => this.tagCreate(cx))
          .child(div().flex_1().min_w(0).truncate().child(this.tagBusy === "create" ? `Creating “${create}”…` : `+ Create tag “${create}”`))))
        .when(!loading && !rows.length && !create, el => el.child(div().px(8).py(6).text_color(t.muted).child("No matching tags")))
        .children(rows.map((label, i) => h_flex().id(`issue-tag-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6)
          .cursor_pointer().hover(s => s.bg(t.hover)).text_color(t.foreground)
          .on_click((_e, cx) => this.tagToggle(label, cx))
          .child(div().w(14).flex_none().text_color(t.foreground).child(this.tagBusy === label.id ? "…" : label.checked ? "✓" : ""))
          .child(div().w(8).h(8).flex_none().rounded_full().bg(label.color ?? t.dim))
          .child(div().flex_1().min_w(0).truncate().child(label.group ? `${label.group} / ${label.name}` : label.name))
          .when(Boolean(label.team), el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(label.team))))))
      .when(Boolean(this.tagNote), el => el.child(div().px(6).text_size(10.5).text_color(t.muted).child(this.tagNote)))
      .when(Boolean(this.tagError), el => el.child(div().px(6).text_size(11).text_color(t.blocked).child(this.tagError)));
  }

  render(cx) {
    // One frame: each Herdr read is copied in once, not once per row (see host.js).
    return inFrame(() => this.renderFrame(cx));
  }

  renderFrame(cx) {
    if (this.role === "issue-menu") return this.issueMenuView();
    if (this.role === "issue-tags") return this.tagsView();
    if (this.role === "header") return this.header();
    if (this.role === "status") return this.statusBar();
    if (this.role === "launcher") return this.launcher();
    if (this.role === "spaces") return this.liveStrip();
    if (this.role === "issue") return this.issuePanel();
    if (this.role === "agent") return this.agentPanel();
    if (this.role === "crew") return this.crewWindow();
    if (this.role === "filters") return this.filtersView();
    if (this.role === "projects") return this.projectsView();
    if (this.role === "sidebar") return this.sidebar();
    const attaching = props().attachSpace;
    return v_flex().id("linear-workspace-dialog").size_full().min_h(0).bg(theme().popover)
      .when(Boolean(attaching), el => el.child(h_flex().h(35).flex_none().px(16).gap(8).items_center()
        .child(div().flex_1().truncate().text_size(12).text_color(theme().foreground).child(`Attach an issue to ${attaching.name}`))
        .child(this.button("attach-create", "+ Create issue", cx => this.create(cx)))))
      .child(super.render(cx).flex_1().min_h(0));
  }
}

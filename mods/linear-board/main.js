// Derived from the MIT-licensed herdr-linear app mod v0.14.2.
// Modified for Eric's Herdr Linear: spaces-first layout, configurable enrichment and attention rules.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { spaces, panes, agents, machines, theme, shared, setShared, setAgentOrder, run, props, openOverlay, closeOverlay, knownAgents, pickFolder, appHome } from "herdr";
import * as fs from "fs/promises";
import LinearClient from "./client.js";
import { tint, icon, stateIcon, MONO } from "./look.js";
import { issueKey, issueLabel, folderOf, matchIssue, workRecords, taskContext } from "./model.js";
import { boardTree, machineGroups, issueNeedsYou, visibleLabels, delegateOf } from "./board.js";
import { fetchEnrichment, indexEnrichment, delegateCounts } from "./enrich.js";
import { normalizeConfig } from "./config.js";
import { FILTER_FIELDS, normalizeFilters, toggleFilter, filterCount, matchesFilters, filterOptions } from "./filters.js";

// Shared with the linear-workspace layout on purpose: an issue/space link made in one
// must not vanish when you switch to the other.
const DATA = "linear-workspace.data", LINKS = "linear-workspace.links";
const PREFS = "linear-workspace.agents", ACTIVE = "linear-workspace.workspace";
// This layout's own state. Enrichment is published by the sidebar copy and read by every
// other copy, so only one of them talks to Linear.
const ENRICH = "linear-board.enrich", FILTER = "linear-board.filters", TEAMS = "linear-board.teams";
const CONFIG = "erics-linear.config";
const ENRICH_MS = 60000;

// Roles that render from shared state alone and never load a Linear list themselves.
const PASSIVE = ["header", "launcher", "spaces", "issue", "agent", "crew", "filters"];

const activeWorkspace = () => shared(ACTIVE) ?? "";
const sharedIssues = () => shared(DATA)?.[activeWorkspace()]?.issues ?? [];
const sharedEnrich = () => shared(ENRICH) ?? { rows: [], error: null, fetchedAt: null, partial: false };

/** Records for a copy of the mod that has no lists of its own. */
function sharedRecords() {
  return workRecords({
    allSpaces: spaces(), allPanes: panes(), allAgents: agents(),
    issues: sharedIssues(), links: shared(LINKS) ?? [], workspace: activeWorkspace(),
  });
}

function currentSource() {
  const s = spaces().find(s => s.active);
  return s ? { id: s.id, name: s.name, folder: folderOf(s, panes()), machine: s.machine ?? null } : null;
}
function dialog(extra = {}) {
  return openOverlay({ mod: "linear-board", kind: "dialog", width: 0.85, height: 0.85,
    props: { role: "dialog", source: currentSource(), workspaceId: shared(ACTIVE), ...extra } });
}

export default class LinearWorkspace extends LinearClient {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? (p.overlay ? "dialog" : "sidebar");
    this.docked = this.role !== "dialog";
    if (PASSIVE.includes(this.role)) {
      // These copies re-render on shared state and on the live space/agent lists; the
      // strip is the only one that needs a clock, to settle its own height.
      return;
    }
    this.extraIssues = {};
    this.resolved = {};
    this.expanded = JSON.parse(localStorage.getItem("expandedProjects") ?? "{}");
    this.openGroups = JSON.parse(localStorage.getItem("openGroups") ?? "{}");
    this.launchTarget = p?.source ?? currentSource();
    this.agentChoices = [];
    this.agentKey = shared(PREFS)?.[this.launchTarget?.machine ?? ""] ?? "codex";
    super.init(p, cx);
    this.ws = p?.workspaceId ?? shared(ACTIVE) ?? this.ws;
    this.tab = "mine";
    if (this.role === "sidebar") {
      cx.timer.every(10000, cx => this.resolveSpaces(cx));
      this.startEnrich(cx);
      cx.timer.every(ENRICH_MS, cx => this.startEnrich(cx));
      this.loadTeams(cx);
    } else if (this.role !== "projects") this.checkAgents(cx);
  }

  /** Delegates and labels, which herdr-linear cannot answer. One copy of the mod fetches
   *  and publishes; a failure leaves the last good read in place and shows why. */
  startEnrich(cx) {
    if (this.enriching || this.demo || this.signedOut) return;
    this.enriching = true;
    cx.spawn(async cx => {
      try {
        const text = await fs.readFile(`${appHome()}/erics-linear.config.json`, "utf8").catch(error => {
          if (error?.code === "ENOENT" || /no such file|not found|ENOENT/i.test(String(error?.message ?? error))) return "{}";
          throw error;
        });
        const config = normalizeConfig(JSON.parse(text));
        if (JSON.stringify(shared(CONFIG)) !== JSON.stringify(config)) setShared(CONFIG, config);
        const result = await fetchEnrichment({ on: this.on || null, config });
        const previous = sharedEnrich();
        if (result.error && !result.rows.length) {
          // Keep the rows we had; only the error line changes.
          setShared(ENRICH, { ...previous, error: result.error });
        } else {
          setShared(ENRICH, { rows: result.rows, error: result.error, fetchedAt: result.fetchedAt, partial: result.partial });
        }
      } catch (error) {
        setShared(ENRICH, { ...sharedEnrich(), error: `Layout config: ${error?.message ?? error}` });
      } finally { this.enriching = false; cx.notify(); }
    });
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
    const extra = lookup.byIdentifier?.get(String(issue.identifier).toUpperCase());
    if (!extra) return issue;
    return { ...issue, delegate: extra.delegate, labels: extra.labels, state: issue.state ?? extra.state,
      teamKey: issue.teamKey ?? extra.teamKey,
      project: issue.project === undefined ? extra.project : issue.project };
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

  publish(incoming = []) {
    if (!this.ws || this.demo) return;
    const data = shared(DATA) ?? {};
    const issues = new Map(this.allIssues().map(i => [i.id, i]));
    for (const is of incoming) if (is.identifier) issues.set(is.id, is);
    const next = { workspace: this.workspace(), projects: this.lists.projects?.items ?? data[this.ws]?.projects ?? [], issues: [...issues.values()] };
    if (JSON.stringify(data[this.ws]) !== JSON.stringify(next)) setShared(DATA, { ...data, [this.ws]: next });
    if (this.role === "sidebar" && shared(ACTIVE) !== this.ws) setShared(ACTIVE, this.ws);
  }

  didLoad(tab, cx) {
    this.publish(this.lists[tab]?.error ? [] : this.lists[tab]?.items ?? []);
    if (this.role === "sidebar") this.resolveSpaces(cx);
    const p = props();
    if (this.role === "dialog" && p.action === "new" && tab === "projects" && !this.startedForm) {
      this.startedForm = true;
      if (p.project) {
        this.curProject = this.lists.projects?.items.find(x => x.id === p.project) ?? null;
        if (this.curProject) this.screen = "project";
      }
      this.create(cx);
      if (p.parentIssue) this.desc.set_value(`Follow-up to ${p.parentIssue.identifier}: ${p.parentIssue.url ?? ""}\n\n`);
    }
  }

  replaceRow(is) {
    super.replaceRow(is);
    this.publish([is]);
  }
  loadAll(cx) {
    super.loadAll(cx);
    for (const [id, open] of Object.entries(this.expanded)) {
      if (open) this.load(`project:${id}`, cx, { op: "list", tab: "project", project: id });
    }
  }
  switchWorkspace(cx) { super.switchWorkspace(cx); this.publish(); }
  records() {
    return workRecords({ allSpaces: spaces(), allPanes: panes(), allAgents: agents(),
      issues: this.allIssues(), links: shared(LINKS) ?? [], workspace: this.ws });
  }

  resolveSpaces(cx) {
    if (this.resolving || !this.ws || this.on == null || this.signedOut || this.demo) return;
    const issues = this.allIssues();
    const keys = [...new Set(spaces().filter(s => !matchIssue(s, issues, shared(LINKS) ?? [], this.ws, panes()))
      .map(s => issueKey(s.branch) ?? issueKey(s.name) ?? issueKey(folderOf(s, panes()))).filter(Boolean))]
      .filter(k => Date.now() - (this.resolved[`${this.ws}/${k}`] ?? 0) > 60000).slice(0, 8);
    if (!keys.length) return;
    const workspace = this.ws;
    this.resolving = true;
    cx.spawn(async cx => {
      try {
        for (const key of keys) {
          if (workspace !== this.ws) break;
          this.resolved[`${workspace}/${key}`] = Date.now();
          try {
            const res = await this.linear({ op: "find", key });
            if (workspace === this.ws) this.publish(res.issues ?? []);
          } catch { /* Local work stays visible if Linear cannot be reached. */ }
        }
        this.publish();
      } finally { this.resolving = false; cx.notify(); }
    });
  }

  /** Opens the crew roster as a kept window: it reopens where it was dropped, and on the
   *  next start, until it is closed. */
  openCrew() {
    return openOverlay({
      mod: "linear-board", kind: "window", key: "crew", keep: true, width: 300, height: 460,
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
    if (c === "new") dialog({ action: "new" });
    else if (c === "details") {
      const r = this.records().find(r => r.space.active);
      if (r?.issue) this.details(r.issue);
      else dialog({ action: "attach", attachSpace: currentSource() });
    } else if (c === "focus") this.input.focus();
  }
  dismiss() { if (props()?.overlay) super.dismiss(); }
  details(is, extra = {}) {
    dialog({ issue: { key: is.identifier, workspaceKey: this.workspace()?.urlKey }, ...extra });
  }
  selectWork(record) {
    const a = record.agents.find(a => a.status === "blocked") ?? record.agents.find(a => a.status === "done") ?? record.agents[0];
    run("space.select", { id: record.space.id });
    if (a) run("agent.focus", { terminal: a.address });
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
      this.launchTarget = { ...record.space, folder: record.folder };
      this.checkAgents(cx);
    }
    super.openIssue(is, cx, direct);
  }
  enter(cx) {
    if (this.role === "sidebar") {
      const record = this.visibleSpaces()[0];
      if (record) this.selectWork(record);
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
  taskFor(is) { return taskContext(is, this.detail?.issue?.id === is.id ? this.detail.description : this.desc.value()); }
  worktree(cx, start, what = { issue: this.cur }) {
    if (this.busy) return;
    if (!what.issue) return this.say("Choose an issue before starting work.", cx, true);
    const linked = this.records().find(r => r.issue?.id === what.issue.id);
    if (linked) { this.selectWork(linked); this.dismiss(); return; }
    if (!this.launchTarget?.folder) return this.say("Choose the repository folder first.", cx, true);
    if (start && (!this.agentsChecked || !this.agentChoices.length)) return this.say(this.launchError || "No installed agent is available on this machine.", cx, true);
    if (start) setShared(PREFS, { ...shared(PREFS), [this.launchTarget.machine ?? ""]: this.agentKey });
    super.worktree(cx, start, what);
  }
  chooseFolder(cx) {
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: "Choose the repository for this Linear task" });
        if (folder) { this.launchTarget = { folder, machine: null, name: folder.split("/").pop() }; this.checkAgents(cx); }
      } catch (e) { this.say(String(e?.message ?? e), cx, true); }
      cx.notify();
    });
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
  workRow(record, id, lane = record.status) {
    const t = theme(), is = record.issue;
    const color = lane === "blocked" ? t.blocked : lane === "done" ? t.done : lane === "working" ? t.working : t.dim;
    const label = lane === "blocked" ? (record.status === "blocked" ? "Needs input" : "Needs your attention")
      : lane === "done" ? (record.status === "done" ? "Agent finished" : "Done in Linear")
      : lane === "working" ? "Working" : "Idle";
    return h_flex().id(id).min_w(0).h(49).flex_none().px(8).gap(8).items_center().rounded(6)
      .bg(record.space.active ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click(() => this.selectWork(record))
      .child(icon(lane === "blocked" ? "need" : lane === "working" ? "work" : lane === "done" ? "check" : "idle", color, 13).when(lane === "working", el => el.spin(1100)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).tooltip(is ? `${issueLabel(is)} · ${is.title}` : record.space.name).child(is ? `${issueLabel(is)} · ${is.title}` : record.space.name))
        .child(div().truncate().text_size(11).text_color(color).child(`${label}${!is ? " · no ticket" : ""} · ${record.space.machine ?? "local"}`)))
      .children(this.harnessIcons([record]))
      .child(div().id(`${id}-details`).w(22).h(26).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.muted).hover(s => s.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (is) this.details(is);
          else dialog({ action: "attach", attachSpace: { id: record.space.id, name: record.space.name, folder: record.folder, machine: record.space.machine ?? null } });
        }).child(is ? "…" : "+"));
  }
  harnessIcons(records) {
    const programs = new Map(records.flatMap(r => r.programs ?? []).map(p => [p.key, p]));
    return [...programs.values()].map(p => {
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

  /** Which machines a row's work is running on, and whether Herdr can still reach them.
   *  An issue with no local work gets no chip at all rather than a misleading "local". */
  machineChips(records, id) {
    const t = theme();
    const reachable = new Map(machines().map(m => [m.name ?? null, m.layout === "ready"]));
    const names = [...new Set(records.map(r => r.space.machine ?? null))];
    return names.map((name, i) => {
      const ok = reachable.get(name) !== false;
      return this.chip(`${id}-machine-${i}`, name ?? "local", ok ? t.muted : t.blocked, { faded: !ok });
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
        .child(div().pl(22).py(5).child(this.button(`new-${p.id}`, "+ Task", () => dialog({ action: "new", project: p.id })))));
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
        .child(div().pl(22).py(5).child(this.button(`new-${p.id}`, "+ Task", () => dialog({ action: "new", project: p.id })))));
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

  visibleSpaces() {
    const index = this.enrichment(), filters = this.homeFilters();
    const words = (this.filter ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
    return this.records().map(record => {
      const issue = this.enrich(record.issue, index);
      const lane = record.status === "blocked" || issueNeedsYou(issue, this.attentionRules()) ? "blocked"
        : record.status === "working" ? "working"
        : record.status === "done" || issue?.state?.type === "completed" ? "done" : "idle";
      return { ...record, issue, lane };
    }).filter(record => {
      if (!matchesFilters(record, filters)) return false;
      const hay = [record.space.name, record.space.machine, record.issue?.identifier, record.issue?.title,
        ...record.agents.map(a => a.title)].filter(Boolean).join(" ").toLowerCase();
      return words.every(word => hay.includes(word));
    }).sort((a, b) => rank[a.lane] - rank[b.lane] || a.space.name.localeCompare(b.space.name));
  }

  sidebar() {
    const t = theme(), records = this.visibleSpaces(), filters = this.homeFilters(), count = filterCount(filters);
    const choices = this.filterChoices(filters);
    const summary = FILTER_FIELDS.filter(key => filters[key].length).map(key =>
      `${key[0].toUpperCase()}${key.slice(1)}: ${choices[key].filter(option => filters[key].includes(option.value)).map(option => option.label).join(", ")}`).join(" · ");
    const groups = [
      { status: "blocked", name: "NEEDS YOU", color: t.blocked },
      { status: "done", name: "DONE", color: t.done },
      { status: "working", name: "WORKING", color: t.working },
      { status: "idle", name: "IDLE", color: t.dim },
    ].map(group => ({ ...group, records: records.filter(record => record.lane === group.status) }));
    setAgentOrder(records.flatMap(record => record.agents.map(a => a.address)));
    return v_flex().id("spaces-home").size_full().min_w(0).min_h(0).px(10).gap(7).bg(t.chrome)
      .child(h_flex().h(32).flex_none().items_center().gap(5)
        .child(this.button("open-projects", "Projects", () => this.openProjects()))
        .child(this.button("crew", "Crew", () => this.openCrew()))
        .child(this.button("live-agents", "Agents", () => run("mod.open", { name: "erics-linear-agents" })).tooltip("Show agents · ⌘⌥A"))
        .child(div().flex_1())
        .child(this.button("refresh", "↻", cx => { this.loadAll(cx); this.resolveSpaces(cx); this.startEnrich(cx); })))
      .child(h_flex().h(32).flex_none().items_center().px(8).gap(7).bg(t.background).rounded(6)
        .child(icon("search", t.dim, 13)).child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().flex_none().items_center().gap(7)
        .child(this.button("new-task", "+ New task", () => dialog({ action: "new" }), { primary: true }))
        .child(this.button("home-filter-button", count ? `Filters (${count})` : "Filters", () => this.openFilters()))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.muted).child(`${records.length} spaces`)))
      .when(count > 0, el => el.child(h_flex().h(26).flex_none().items_center().gap(6).px(7).rounded(6).bg(tint(t.accent, 0.12))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.accent).tooltip(summary).child(summary))
        .child(this.button("clear-home-filters", "Clear", cx => this.applyFilter({}, cx)))))
      .child(v_flex().id("spaces-by-status").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(3)
        .when(!records.length, el => el.child(div().py(12).text_size(12).text_color(t.muted)
          .child(this.filter || count ? "No matching spaces" : "No open spaces. Start a task to begin.")))
        .children(groups.filter(group => group.records.length).flatMap(group => [
          this.section(group.name, group.records.length, group.color),
          ...group.records.map(record => this.workRow(record, `home-${record.space.id}`, group.status)),
        ])))
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
      .child(h_flex().flex_none().gap(6)
        .child(this.button("new-task", "+ New task", () => dialog({ action: "new" }), { primary: true }))
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
    return h_flex().id("issue-context").size_full().min_w(0).px(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(icon(is ? stateIcon(is.state) : "need", is ? t.muted : t.blocked, 13))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(is ? `${is.identifier} · ${is.title}` : "This workspace has no Linear ticket"))
        .child(div().truncate().text_size(11).text_color(t.muted).child(is ? `${is.state?.name ?? ""} · ${is.project?.name ?? "No project"} · ${s?.machine ?? "local"}` : `${s?.name ?? "Select a workspace"} · attach an existing issue or create one`)))
      .when(Boolean(is), el => el.child(this.button("issue-details", "Issue details", () => dialog({ issue: { key: is.identifier, workspaceKey: data?.workspace?.urlKey } }))))
      .when(Boolean(s && !is), el => el.child(this.button("attach-ticket", "Attach issue", () => dialog({ action: "attach", attachSpace: currentSource() }), { primary: true })));
  }
  launcher() {
    const t = theme(), ws = shared(ACTIVE), data = shared(DATA)?.[ws], s = spaces().find(s => s.active);
    const is = s && matchIssue(s, data?.issues ?? [], shared(LINKS) ?? [], ws, panes());
    const action = fn => { if (props().overlay) closeOverlay(props().overlay); fn(); };
    return v_flex().id("ticket-launcher").w_full().p(10).gap(8).bg(t.popover)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Work in a Linear issue"))
      .child(this.button("launch-new", "New task…", () => action(() => dialog({ action: "new" })), { primary: true }))
      .child(this.button("launch-existing", is ? `Continue ${is.identifier}…` : "Choose an existing issue…", () => action(() => dialog(is ? { issue: { key: is.identifier, workspaceKey: data?.workspace?.urlKey } } : {}))))
      .when(Boolean(is), el => el.child(this.button("utility-terminal", "Utility terminal for this issue", () => action(() => run("tab.new", { space: s.id, name: "Shell" })))))
      .when(Boolean(s && !is), el => el.child(this.button("launch-attach", "Attach this workspace…", () => action(() => dialog({ action: "attach", attachSpace: currentSource() })))));
  }
  launchOptions() {
    const t = theme();
    return v_flex().flex_none().gap(6).py(7)
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(div().text_size(11).text_color(t.muted).child("Repository"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO).text_color(t.foreground).child(this.launchTarget?.folder ?? "Choose a repository"))
        .child(div().text_size(11).text_color(t.dim).child(this.launchTarget?.machine ?? "local"))
        .child(this.button("choose-repo", "Choose…", cx => this.chooseFolder(cx))))
      .child(h_flex().gap(7).items_center().flex_wrap().child(div().text_size(11).text_color(t.muted).child("Agent"))
        .children(this.agentChoices.map(a => this.button(`agent-${a.key}`, a.name, cx => { this.agentKey = a.key; cx.notify(); }, { primary: a.key === this.agentKey })))
        .when(!this.agentChoices.length, el => el.child(div().text_size(11).text_color(t.muted).child(this.agentsChecked ? this.launchError || "No installed agents found" : "Checking installed agents…"))));
  }
  createView(o) {
    const attaching = Boolean(props().attachSpace);
    return v_flex().flex_1().min_h(0).gap(7).child(super.createView(o))
      .when(!attaching, el => el.child(this.launchOptions()))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(o.muted).child(attaching ? `Creating also attaches to ${props().attachSpace.name}` : "Create a ticket, then start work in its own worktree"))
        .when(!attaching, el => el.child(this.button("create-start", "Create & start", cx => {
          if (!this.launchTarget?.folder) return this.say("Choose the repository folder first.", cx, true);
          this.submit(cx, true);
        }, { primary: true, enabled: !this.busy && this.agentsChecked && this.agentChoices.length > 0 }))));
  }
  issueView(o) {
    const is = this.cur, attaching = Boolean(props().attachSpace), record = this.records().find(r => r.issue?.id === is.id);
    return v_flex().flex_1().min_h(0).gap(7)
      .when(!attaching && !record, el => el.child(this.launchOptions()))
      .child(h_flex().flex_none().gap(7).items_center().flex_wrap()
        .when(attaching, el => el.child(this.button("attach-selected", `Attach ${is.identifier}`, () => { this.attach(is); this.dismiss(); }, { primary: true })))
        .when(Boolean(record), el => el.child(this.button("open-linked", "Open workspace", () => { this.selectWork(record); this.dismiss(); }, { primary: true })))
        .when(!attaching && !record, el => el.child(this.button("start-work", "Start agent", cx => this.worktree(cx, true), { primary: true, enabled: !this.busy && this.agentsChecked && Boolean(this.detail) && !this.detail.startWhy && this.agentChoices.length > 0 })))
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
        run("tab.new", { space: record.space.id, name: selected.name, argv: selected.run, task: taskContext(checked.issue, this.detail?.description ?? "") });
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
      .child(icon(record.needs ? "need" : record.status === "working" ? "work" : "idle", color, 11)
        .when(record.status === "working", el => el.spin(1100)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground)
        .tooltip(is ? `${issueLabel(is)} · ${is.title}` : record.space.name).child(is ? issueLabel(is) : record.space.name))
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
            .child(div().text_size(9.5).font_semibold().text_color(group.reachable ? t.muted : t.blocked)
              .child((group.name ?? "local").toUpperCase()))
            .child(div().flex_1())
            .when(!group.reachable, el => el.child(div().text_size(9.5).text_color(t.blocked).child("unreachable")))
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

  /** What the delegate on the active issue is doing, across every machine. Linear says who
   *  owns the ticket; Herdr says what is actually running. Both are shown separately so a
   *  delegated ticket with nothing running does not read as work in progress. */
  agentPanel() {
    const t = theme(), record = this.activeRecord(), enrichment = this.enrichment();
    const is = record?.issue ? this.enrich(record.issue, enrichment) : null;
    const delegate = delegateOf(is) ?? this.delegateFilter();
    const rows = delegate ? enrichment.rows.filter(r => r.delegate?.name === delegate) : [];
    const records = sharedRecords();
    const live = delegate
      ? records.filter(r => r.issue && rows.some(x => x.identifier === r.issue.identifier))
      : [];
    return v_flex().id("agent-panel").size_full().min_h(0).p(12).gap(9).bg(t.background)
      .child(h_flex().gap(7).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground)
          .child(delegate ?? "No agent"))
        .when(Boolean(delegate), el => el.child(this.button("agent-panel-filter", "Show only this", cx => this.setDelegateFilter(delegate, cx)))))
      .when(!delegate, el => el.child(div().text_size(11).text_color(t.muted).line_height(1.5)
        .child("This issue has no Linear delegate. Delegate it in Linear, or pick an agent from the Crew window, and its work shows here.")))
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

  // ---- Crew: every Linear agent, one window ------------------------------------------

  crewRoster() {
    const t = theme(), enrichment = this.enrichment();
    const counts = delegateCounts(enrichment.rows);
    const records = sharedRecords();
    const liveFor = name => records.filter(r => r.issue && enrichment.rows
      .some(x => x.identifier === r.issue.identifier && x.delegate?.name === name));
    return v_flex().id("crew-roster").size_full().min_h(0).p(10).gap(6).bg(t.popover)
      .child(h_flex().h(24).flex_none().items_center().gap(7)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Crew"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted)
          .child(`${counts.length} with open work`))
        .child(this.button("crew-close", "✕", () => closeOverlay(props().overlay))))
      .when(Boolean(enrichment.error), el => el.child(div().text_size(10).text_color(t.blocked).truncate().child(enrichment.error)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .when(!counts.length, el => el.child(div().py(8).text_size(11).text_color(t.muted)
          .child(enrichment.fetchedAt ? "Nothing is delegated to an agent right now." : "Reading delegates from Linear…")))
        .children(counts.map(entry => {
          const running = liveFor(entry.name);
          const needs = entry.issues.filter(r => issueNeedsYou({ state: r.state, labels: r.labels }, this.attentionRules())).length;
          const active = this.crewExpanded === entry.name;
          const color = needs ? t.blocked : running.length ? t.working : t.dim;
          return v_flex().id(`crew-${entry.name}`).flex_none().min_w(0).px(7).py(5).gap(3).rounded(6)
            .bg(active ? t.selected : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
            .on_click((_e, cx) => { this.crewExpanded = active ? null : entry.name; cx.notify(); })
            .child(h_flex().gap(7).items_center().min_w(0)
              .child(div().size(7).rounded(7).flex_none().bg(color))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(entry.name))
              .child(div().flex_none().text_size(10).text_color(t.dim).child(String(entry.issues.length))))
            .child(h_flex().gap(4).pl(14).flex_wrap().items_center()
              .when(needs > 0, el => el.child(this.chip(`crew-${entry.name}-needs`, `${needs} need you`, t.blocked)))
              .when(running.length > 0, el => el.child(this.chip(`crew-${entry.name}-live`, `${running.length} running`, t.working)))
              .when(!needs && !running.length, el => el.child(div().text_size(10).text_color(t.dim).child("idle"))))
            .when(active, el => el.children(entry.issues.map(issue => h_flex().id(`crew-issue-${issue.identifier}`)
              .min_h(30).gap(6).px(5).items_center().rounded(4).hover(el => el.bg(t.hover))
              .on_click((_e, cx) => {
                cx.stop_propagation(); dialog({ issue: { key: issue.identifier } });
              })
              .child(div().flex_none().text_size(10).font_family(MONO).text_color(t.muted).child(issue.identifier))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(issue.project?.name ?? "No project"))
              .child(div().flex_none().text_size(10).text_color(t.muted).child(issue.state?.name ?? "")))));
        })));
  }

  render(cx) {
    if (this.role === "header") return this.header();
    if (this.role === "launcher") return this.launcher();
    if (this.role === "spaces") return this.liveStrip();
    if (this.role === "issue") return this.issuePanel();
    if (this.role === "agent") return this.agentPanel();
    if (this.role === "crew") return this.crewRoster();
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

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Popup } from "gpui-base";
import { spaces, panes, agents, machines, theme, shared, setShared, setAgentOrder, run, props, openOverlay, closeOverlay, knownAgents, appHome } from "herdr";
import * as fs from "fs/promises";
import LinearClient from "./client.js";
import { computers, loadTarget, selectRepository as selectTargetRepository } from "./repository.js";
import { tint, icon, stateIcon, MONO } from "./look.js";
import { issueKey, folderOf, matchIssue, workRecords, projectGroups, taskContext, issueNeedsYou } from "./model.js";

const DATA = "linear-workspace.data", LINKS = "linear-workspace.links";
const PREFS = "linear-workspace.agents", ACTIVE = "linear-workspace.workspace";

function currentSource() {
  const s = spaces().find(s => s.active);
  return s ? { id: s.id, name: s.name, folder: folderOf(s, panes()), machine: s.machine ?? null } : null;
}
function dialog(extra = {}) {
  return openOverlay({ mod: "linear-workspace", kind: "dialog", width: 0.85, height: 0.85,
    props: { role: "dialog", source: currentSource(), workspaceId: shared(ACTIVE), ...extra } });
}

export default class LinearWorkspace extends LinearClient {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? (p.overlay ? "dialog" : "sidebar");
    this.docked = this.role !== "dialog";
    if (["header", "launcher"].includes(this.role)) return;
    this.extraIssues = {};
    this.resolved = {};
    this.expanded = JSON.parse(localStorage.getItem("expandedProjects") ?? "{}");
    this.repositorySource = p?.source ?? currentSource();
    this.launchTarget = { machine: this.repositorySource?.machine ?? null, folder: "" };
    this.agentChoices = [];
    this.agentKey = shared(PREFS)?.[this.launchTarget?.machine ?? ""] ?? "codex";
    super.init(p, cx);
    this.ws = p?.workspaceId ?? shared(ACTIVE) ?? this.ws;
    this.tab = "mine";
    if (this.role === "sidebar") cx.timer.every(10000, cx => this.resolveSpaces(cx));
    else this.chooseComputer(this.launchTarget.machine, cx);
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

  onCommand(c, cx) {
    if (this.role !== "sidebar") return;
    if (c === "new") dialog({ action: "new" });
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
  visit(is) {
    const record = this.records().find(r => r.issue?.id === is.id);
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
    if (this.createdLaunchFor(what.issue, start) || !this.launchIssueReady(what.issue, start)) return super.worktree(cx, start, what);
    const linked = this.records().find(r => r.issue?.id === what.issue.id);
    if (linked) { this.selectWork(linked); this.dismiss(); return; }
    if (!this.launchTarget?.folder) return this.say("Choose the repository folder first.", cx, true);
    if (start && (!this.agentsChecked || !this.agentChoices.length)) return this.say(this.launchError || "No installed agent is available on this machine.", cx, true);
    if (start) setShared(PREFS, { ...shared(PREFS), [this.launchTarget.machine ?? ""]: this.agentKey });
    super.worktree(cx, start, what);
  }
  chooseComputer(machine, cx, retain = null) {
    this.targetPicker = null;
    const source = this.repositorySource;
    const project = this.screen === "create"
      ? this.lists.projects?.items?.find(p => p.id === this.form?.project)
      : this.screen === "project" ? this.curProject : this.drilled;
    const hints = [project?.name];
    if ((source?.machine ?? null) === (machine ?? null)) hints.push(source?.folder);
    loadTarget(this, cx, machine, { retain, hints, preferredFolder: this.mappedRepository(machine), preferredAgent: shared(PREFS)?.[machine ?? ""] ?? "" });
  }
  create(cx) {
    super.create(cx);
    if (!props().attachSpace) this.chooseComputer(this.defaultTaskMachine(), cx);
  }
  selectRepository(repo, cx) {
    if (selectTargetRepository(this, repo, cx)) this.rememberRepository(this.launchTarget);
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
  workRow(record, id) {
    const t = theme(), is = record.issue;
    const color = record.needs ? t.blocked : record.status === "working" ? t.working : t.dim;
    return h_flex().id(id).min_w(0).h(49).flex_none().px(8).gap(8).items_center().rounded(6)
      .bg(record.space.active ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click(() => this.selectWork(record))
      .child(icon(record.needs ? "need" : record.status === "working" ? "work" : "idle", color, 13).when(record.status === "working", el => el.spin(1100)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(is ? `${is.identifier} · ${is.title}` : record.space.name))
        .child(div().truncate().text_size(11).text_color(color).child(`${record.status === "blocked" ? "Needs input" : record.status === "done" ? "Ready to review" : record.status === "working" ? "Working" : "Open workspace"}${!is ? " · no ticket" : ""} · ${record.space.machine ?? "local"}`)))
      .child(div().id(`${id}-details`).w(22).h(26).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.muted).hover(s => s.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (is) this.details(is);
          else dialog({ action: "attach", attachSpace: { id: record.space.id, name: record.space.name, folder: record.folder, machine: record.space.machine ?? null } });
        }).child(is ? "…" : "+"));
  }
  issueRow(is, projectId) {
    const t = theme();
    return h_flex().id(`issue-${projectId}-${is.id}`).h(43).flex_none().pl(22).pr(6).gap(7).min_w(0).items_center().rounded(6)
      .hover(s => s.bg(t.hover)).cursor_pointer().on_click(() => this.visit(is))
      .child(icon(stateIcon(is.state), t.dim, 12))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12).text_color(t.foreground).child(is.title))
        .child(div().truncate().text_size(11).text_color(t.muted).child(`${is.identifier} · ${is.state?.name ?? ""}`)));
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
        .child(div().pl(22).py(5).child(this.button(`new-${p.id}`, "+ Task", () => dialog({ action: "new", project: p.id })))));
  }

  sidebar() {
    const t = theme(), records = this.records(), needs = records.filter(r => r.needs);
    const attention = this.allIssues().filter(issueNeedsYou);
    const withoutWork = attention.filter(is => !needs.some(r => r.issue?.id === is.id));
    const attentionCount = needs.length + withoutWork.length;
    const groups = projectGroups(this.lists.projects?.items ?? [], records, attention);
    const loose = records.filter(r => !r.issue?.project?.id || !groups.some(g => g.project.id === r.issue.project.id));
    const shown = this.filter.trim() ? groups.filter(g => this.matches(g.project) || this.allIssues().some(i => i.project?.id === g.project.id && this.matches(i))) : groups;
    const errors = [...new Set([this.err, ...["projects", "mine", "recent"].map(k => this.lists[k]?.error)].filter(Boolean))];
    setAgentOrder(records.flatMap(r => r.agents.map(a => a.address)));
    return v_flex().id("linear-sidebar").size_full().min_w(0).min_h(0).px(10).gap(7).bg(t.chrome)
      .child(h_flex().h(31).flex_none().items_center().gap(7)
        .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Linear"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.workspace()?.name ?? "Connecting…"))
        .child(this.button("refresh", "↻", cx => { this.loadAll(cx); this.resolveSpaces(cx); })))
      .child(h_flex().h(32).flex_none().items_center().px(8).gap(7).bg(t.background).rounded(6)
        .child(icon("search", t.dim, 13)).child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().flex_none().gap(6).child(this.button("new-task", "+ New task", () => dialog({ action: "new" }), { primary: true })).child(this.button("browse-linear", "Browse", () => dialog())))
      .when(attentionCount > 0, el => el.child(this.section("NEEDS YOU", attentionCount, t.blocked))
        .child(v_flex().id("attention-work").h(Math.min(190, needs.length * 49 + withoutWork.length * 43)).flex_none().overflow_y_scrollbar()
          .children(needs.map(r => this.workRow(r, `attention-${r.space.id}`)))
          .children(withoutWork.map(is => this.issueRow(is, "attention")))))
      .when(!attentionCount, el => el.child(div().py(4).text_size(11).text_color(t.muted).child("Nothing waiting for you")))
      .child(this.section("ALL PROJECTS", groups.length))
      .child(v_flex().id("all-projects").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().gap(2)
        .when(Boolean(this.signedOut), el => el.child(this.button("sign-in", "Sign in to Linear", cx => this.signIn(cx))))
        .when(!groups.length, el => el.child(div().py(10).text_size(12).text_color(t.muted).child(errors.length ? "Projects unavailable" : "Loading projects…")))
        .children(shown.map(g => this.projectRow(g)))
        .when(Boolean(this.found?.issues?.length), el => el.child(this.section("ISSUE SEARCH", this.found.issues.length)).children(this.found.issues.map(is => this.issueRow(is, "search"))))
        .when(loose.length > 0, el => el.child(this.section("OTHER OPEN WORK", loose.length)).children(loose.map(r => this.workRow(r, `loose-${r.space.id}`)))))
      .when(errors.length > 0, el => el.child(div().py(5).text_size(11).text_color(t.blocked).child(errors.join(" · "))))
      .when(["projects", "mine", "recent"].some(k => this.lists[k]?.cached), el => el.child(div().py(3).text_size(11).text_color(t.muted).child("Saved projects · refreshing…")))
      .child(h_flex().h(28).flex_none().items_center().justify_between()
        .child(div().text_size(11).text_color(t.dim).child(`${records.filter(r => r.status === "working").length} working · ${records.length} open`))
        .when(this.workspaces.length > 1, el => el.child(this.button("workspace-next", "Workspace ›", cx => this.switchWorkspace(cx)))));
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
    const t = theme(), machine = this.launchTarget?.machine ?? null;
    const label = machine ?? "This computer", available = computers().find(m => m.name === machine)?.layout ?? "unavailable";
    const computerTrigger = this.button("choose-computer", `${label} · ${available} ▾`, cx => { this.targetPicker = this.targetPicker === "computer" ? null : "computer"; cx.notify(); }, { enabled: !this.busy });
    const repoTrigger = this.button("choose-repository", `${this.launchTarget?.name || "Select an existing repository"} ▾`, cx => { this.targetPicker = this.targetPicker === "repository" ? null : "repository"; cx.notify(); }, { enabled: !this.busy && !this.repositoriesLoading && this.repositories?.length > 0 });
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
            .children((this.repositories ?? []).map((r, i) => row(`repository-${i}`, r.name, cx => this.selectRepository(r, cx), !this.busy && !this.repositoriesLoading))))))
        .child(this.button("refresh-repositories", "↻", cx => this.chooseComputer(machine, cx, this.launchTarget?.folder ? this.launchTarget : null), { enabled: !this.busy })))
      .child(div().text_size(11).text_color(t.muted).child(this.repositoriesLoading ? `Reading ~/code on ${label}…` : `Repository root: ${this.repoRoot || "~/code on the selected computer"}`))
      .when(Boolean(this.repositoryError), el => el.child(div().text_size(11).text_color(t.blocked).child(this.repositoryError)))
      .child(div().text_size(12).font_family(MONO).text_color(t.foreground).child(`${label} · ${this.launchTarget?.folder || "Select a repository before creating or starting"}`))
      .child(h_flex().gap(7).items_center().flex_wrap().child(div().text_size(11).text_color(t.muted).child("Agent"))
        .children(this.agentChoices.map(a => this.button(`agent-${a.key}`, a.name, cx => { this.agentKey = a.key; cx.notify(); }, { primary: a.key === this.agentKey, enabled: !this.busy })))
        .when(!this.agentChoices.length, el => el.child(div().text_size(11).text_color(t.muted).child(this.agentsChecked ? this.launchError || "No installed agents found" : "Checking installed agents…"))));
  }

  createStartButton() {
    return this.button("create-start", "Create & start", cx => this.submit(cx, true), {
      primary: true, enabled: !this.busy && Boolean(this.launchTarget?.folder) && this.agentsChecked && this.agentChoices.length > 0,
    });
  }

  issueView(o) {
    const is = this.cur, attaching = Boolean(props().attachSpace), record = this.records().find(r => r.issue?.id === is.id);
    return v_flex().flex_1().min_h(0).gap(7)
      .when(!attaching && !record, el => el.child(this.launchOptions()))
      .child(h_flex().flex_none().gap(7).items_center().flex_wrap()
        .when(attaching, el => el.child(this.button("attach-selected", `Attach ${is.identifier}`, () => { this.attach(is); this.dismiss(); }, { primary: true })))
        .when(Boolean(record), el => el.child(this.button("open-linked", "Open workspace", () => { this.selectWork(record); this.dismiss(); }, { primary: true })))
        .when(!attaching && !record, el => el.child(this.button("start-work", "Start agent", cx => this.worktree(cx, true), { primary: true, enabled: !this.busy && Boolean(this.launchTarget?.folder) && this.agentsChecked && Boolean(this.detail) && !this.detail.startWhy && this.agentChoices.length > 0 })))
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
  render(cx) {
    if (this.role === "header") return this.header();
    if (this.role === "launcher") return this.launcher();
    if (this.role === "sidebar") return this.sidebar();
    const attaching = props().attachSpace;
    return v_flex().id("linear-workspace-dialog").size_full().min_h(0).bg(theme().popover)
      .when(Boolean(attaching), el => el.child(h_flex().h(35).flex_none().px(16).gap(8).items_center()
        .child(div().flex_1().truncate().text_size(12).text_color(theme().foreground).child(`Attach an issue to ${attaching.name}`))
        .child(this.button("attach-create", "+ Create issue", cx => this.create(cx)))))
      .child(super.render(cx).flex_1().min_h(0));
  }
}

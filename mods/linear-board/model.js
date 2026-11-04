// Pure linking and attention rules. Linear workflow state never changes here.
export function issueKey(value) {
  return String(value ?? "").match(/(?:^|[^a-z0-9])([a-z][a-z0-9_]*-\d+)(?=$|[^a-z0-9])/i)?.[1].toUpperCase() ?? null;
}

export function folderOf(space, allPanes) {
  const tabs = new Set((space.tabs ?? []).map(t => t.id));
  return allPanes.find(p => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || "";
}

export function sameFolder(a, b) {
  const clean = p => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return Boolean(a && b) && clean(a) === clean(b);
}

export function matchIssue(space, issues, links, workspace, allPanes = []) {
  const folder = folderOf(space, allPanes);
  const saved = links.find(l => l.workspace === workspace && (l.machine ?? null) === (space.machine ?? null)
    && (l.space === space.id || sameFolder(l.folder, folder)));
  if (saved) return issues.find(i => i.id === saved.issue.id) ?? saved.issue;
  const branch = space.branch || allPanes.find(p => (space.tabs ?? []).some(t => t.id === p.tab) && p.branch)?.branch;
  if (branch) {
    const exact = issues.find(i => i.branch === branch);
    if (exact) return exact;
  }
  const key = issueKey(branch) ?? issueKey(space.name) ?? issueKey(folder);
  return key ? issues.find(i => i.identifier.toUpperCase() === key) ?? null : null;
}

const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3 };

export function issueLabel(issue) {
  const project = issue?.project?.name?.trim();
  return `${issue.identifier}${project ? ` (${project})` : ""}`;
}

export function workRecords({ allSpaces, allPanes, allAgents, issues, links, workspace }) {
  return allSpaces.map(space => {
    const ownAgents = allAgents.filter(a => a.space === space.id);
    const tabs = new Set((space.tabs ?? []).map(t => t.id));
    const programs = new Map();
    for (const source of [...ownAgents, ...allPanes.filter(p => p.terminal && tabs.has(p.tab))]) {
      if (source.program?.agent) programs.set(source.program.key, source.program);
    }
    const statuses = [space.status, ...ownAgents.map(a => a.status)].filter(Boolean);
    const status = statuses.sort((a, b) => (URGENCY[a] ?? 4) - (URGENCY[b] ?? 4))[0] ?? "idle";
    return {
      space, agents: ownAgents, programs: [...programs.values()], status, needs: status === "blocked" || status === "done",
      folder: folderOf(space, allPanes), issue: matchIssue(space, issues, links, workspace, allPanes),
    };
  }).sort((a, b) => (URGENCY[a.status] ?? 4) - (URGENCY[b.status] ?? 4) || a.space.name.localeCompare(b.space.name));
}

export function issueNeedsYou(issue) {
  return issue.mine === true && /\b(?:needs? (?:human|you|review)|awaiting (?:your )?review|ready for review|blocked)\b/i.test(issue.state?.name ?? "");
}

export function projectGroups(projects, records, attention = []) {
  return projects.map(project => {
    const work = records.filter(r => r.issue?.project?.id === project.id);
    const needed = new Set([
      ...work.filter(r => r.needs).map(r => r.issue?.id ?? r.space.id),
      ...attention.filter(i => i.project?.id === project.id).map(i => i.id),
    ]);
    return { project, work, needs: needed.size };
  }).sort((a, b) => Number(Boolean(b.needs)) - Number(Boolean(a.needs)) || a.project.name.localeCompare(b.project.name));
}

export function taskContext(issue, description = "") {
  return `Work on Linear issue ${issue.identifier}: ${issue.title}\n${issue.url ?? ""}\n\n${description}\n\nKeep this work scoped to ${issue.identifier}. Use this issue for progress and findings; create linked issues for separate follow-up work. Verify the result and report checks and remaining risks. Do not mark the issue Done just because the agent run finishes.`;
}

/** The Linear desktop app's link for a linear.app web link: the same path under linear://.
 *  Anything that is not a linear.app link has no app link. */
export function linearAppUrl(url) {
  const m = /^https:\/\/linear\.app\/([^?#]+)/i.exec(String(url ?? ""));
  return m ? `linear://${m[1].replace(/\/+$/, "")}` : null;
}

/** What right-clicking an issue offers: open it in the Linear app, in the browser, or copy
 *  its link. An issue without a web link offers nothing. */
export function issueMenuItems(issue) {
  const url = issue?.url ? String(issue.url) : "";
  if (!url) return [];
  const app = linearAppUrl(url);
  return [
    ...(app ? [{ label: "Open in Linear app", action: "open", url: app }] : []),
    { label: "Open in browser", action: "open", url },
    { label: "Copy link", action: "copy", url },
  ];
}

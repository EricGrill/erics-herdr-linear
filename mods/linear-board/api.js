// API-key counterpart of herdr-linear v0.14.2's app protocol (MIT).
// Its queries and start guards follow upstream linear.go and app.go.
import { queryLinear } from "./auth.js";

const ISSUE = `id identifier title branchName url priority
  state { id name type color position } team { id key }
  project { id name } assignee { id displayName isMe }`;
const PAGE = "pageInfo { hasNextPage endCursor }";
const OPEN = 'state: { type: { nin: ["completed", "canceled"] } }';
const lifecycle = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
function sortIssues(rows) {
  const position = new Map();
  const rank = type => { const i = ["started", "unstarted", "triage", "backlog"].indexOf(type); return i < 0 ? 4 : i; };
  for (const n of rows) position.set(n.state.name, Math.min(position.get(n.state.name) ?? Infinity, n.state.position));
  rows.sort((a, b) => {
    const order = rank(a.state.type) - rank(b.state.type);
    if (order) return order;
    if (a.state.name !== b.state.name) return (position.get(a.state.name) - position.get(b.state.name)) * (a.state.type === "started" ? -1 : 1) || a.state.name.localeCompare(b.state.name);
    return (a.priority || 5) - (b.priority || 5);
  });
  return rows;
}
const issueOf = n => {
  if (!n?.id || !n.team?.id || !n.state?.id) throw new Error("Linear returned an incomplete issue");
  return { id: n.id, identifier: n.identifier, title: n.title, url: n.url,
    branch: n.branchName || n.identifier.toLowerCase(), priority: n.priority, state: n.state,
    teamId: n.team.id, teamKey: n.team.key, project: n.project ?? null,
    assignee: n.assignee?.displayName ?? "", mine: n.assignee?.isMe === true, group: n.state.name };
};
const projectOf = n => {
  const teams = n.teams?.nodes ?? [];
  return { ...n, lead: n.lead?.displayName ?? "", teams: teams.map(t => t.key),
    branch: `project/${n.url?.replace(/\/+$/, "").split("/").pop() || n.slugId}`,
    teamKey: teams.length === 1 && !n.teams?.pageInfo?.hasNextPage ? teams[0].key : "" };
};
function startWhy(n) {
  if (["completed", "canceled"].includes(n.state.type)) return `${n.identifier} is ${n.state.name} now, so it wasn't started`;
  if (n.assignee && !n.assignee.isMe) return `${n.identifier} is assigned to ${n.assignee.displayName}; start is for your own and unassigned issues`;
  return "";
}

export class LinearAPI {
  constructor(config, on = null) { this.config = config; this.on = on; }
  query(query, variables = {}) { return queryLinear({ config: this.config, on: this.on, query, variables }); }

  async status() {
    const data = await this.query("query TaskIdentity { organization { id name urlKey } viewer { id } }");
    if (!data.organization?.id || !data.viewer?.id) throw new Error("Linear returned no workspace or user identity");
    this.workspace = data.organization;
    this.viewer = data.viewer.id;
    return { workspaces: [this.workspace] };
  }

  async pages(query, variables, pick) {
    const rows = [], seen = new Set();
    let after = null;
    for (let page = 0; page < 10; page++) {
      const connection = pick(await this.query(query, { ...variables, after }));
      if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Linear returned an incomplete list");
      rows.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return rows;
      after = connection.pageInfo.endCursor;
      if (!after || seen.has(after)) throw new Error("Linear pagination did not advance; reload to try again");
      seen.add(after);
    }
    throw new Error("Linear list exceeds 1,000 items; narrow the list in Linear");
  }

  async states(team) {
    const rows = await this.pages(`query TaskStates($id: String!, $after: String) { team(id: $id) { states(first: 100, after: $after) { nodes { id name type color position } ${PAGE} } } }`, { id: team }, d => d.team?.states);
    return rows.sort((a, b) => lifecycle.indexOf(a.type) - lifecycle.indexOf(b.type) || a.position - b.position);
  }
  async fresh(id) {
    const { issue } = await this.query(`query TaskIssue($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id });
    issueOf(issue);
    return issue;
  }
  async update(id, input) {
    const data = await this.query("mutation TaskUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id, input });
    if (data.issueUpdate?.success !== true) throw new Error("Linear refused the update");
  }

  async ask(req) {
    if (req.op === "status") return this.status();
    if (!this.workspace) await this.status();
    if (req.workspace && req.workspace !== this.workspace.id) throw new Error("Configured Linear key belongs to a different workspace; reload to select its workspace");
    switch (req.op) {
      case "list": {
        if (req.tab === "projects") {
          const projects = await this.pages(`query TaskProjects($after: String) { projects(first: 100, after: $after, orderBy: updatedAt, filter: { status: { type: { nin: ["completed", "canceled"] } } }) { nodes { id name slugId url color progress targetDate status { name type color } lead { displayName isMe } teams(first: 25) { nodes { id key } ${PAGE} } } ${PAGE} } }`, {}, d => d.projects);
          const order = ["started", "planned", "paused", "backlog", "completed", "canceled"];
          projects.sort((a, b) => order.indexOf(a.status.type) - order.indexOf(b.status.type) || a.status.name.localeCompare(b.status.name) || Number(b.lead?.isMe ?? false) - Number(a.lead?.isMe ?? false));
          return { projects: projects.map(projectOf) };
        }
        if (req.tab === "recent") {
          const data = await this.query(`query TaskRecent { viewer { createdIssues(first: 50, orderBy: createdAt) { nodes { ${ISSUE} } } } }`);
          if (!Array.isArray(data.viewer?.createdIssues?.nodes)) throw new Error("Linear returned no recent issues");
          return { issues: data.viewer.createdIssues.nodes.map(n => ({ ...issueOf(n), group: "" })) };
        }
        let rows;
        if (req.tab === "mine") rows = await this.pages(`query TaskMine($after: String) { viewer { assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: { ${OPEN} }) { nodes { ${ISSUE} } ${PAGE} } } }`, {}, d => d.viewer?.assignedIssues);
        else if (req.tab === "project") rows = await this.pages(`query TaskProjectIssues($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after, orderBy: updatedAt, filter: { ${OPEN} }) { nodes { ${ISSUE} } ${PAGE} } } }`, { id: req.project }, d => d.project?.issues);
        else throw new Error(`Unknown Linear tab: ${req.tab}`);
        return { issues: sortIssues(rows).map(issueOf) };
      }
      case "teams": {
        const teams = await this.pages(`query TaskTeams($after: String) { teams(first: 100, after: $after) { nodes { id key name defaultIssueState { id } } ${PAGE} } }`, {}, d => d.teams);
        return { teams: teams.sort((a, b) => a.name.localeCompare(b.name)), priorities: ["No priority", "Urgent", "High", "Medium", "Low"] };
      }
      case "states": return { states: await this.states(req.team) };
      case "find": {
        const match = String(req.key).trim().match(/^(?:([A-Za-z][A-Za-z0-9_]*)-)?(\d{1,9})$/);
        if (!match) throw new Error("Enter a Linear issue identifier or number");
        const filter = { number: { eq: Number(match[2]) } };
        if (match[1]) filter.team = { key: { eqIgnoreCase: match[1] } };
        const rows = await this.pages(`query TaskFind($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter) { nodes { ${ISSUE} } ${PAGE} } }`, { filter }, d => d.issues);
        return { issues: rows.map(issueOf) };
      }
      case "search": {
        // Linear's own relevance search over every team's tickets, open or closed.
        const term = String(req.query ?? "").trim();
        if (term.length < 2) return { issues: [] };
        const data = await this.query(`query TaskSearch($term: String!, $first: Int) { searchIssues(term: $term, first: $first) { nodes { ${ISSUE} } } }`, { term, first: 20 });
        if (!Array.isArray(data.searchIssues?.nodes)) throw new Error("Linear returned no search results");
        return { issues: data.searchIssues.nodes.map(n => ({ ...issueOf(n), group: "" })) };
      }
      case "detail": {
        const { issue: n } = await this.query(`query TaskDetail($id: String!) { issue(id: $id) { ${ISSUE} description priorityLabel dueDate cycle { number name } labels(first: 50) { nodes { name color } } attachments(first: 25) { nodes { title url } } } }`, { id: req.issue });
        const issue = issueOf(n);
        const prs = (n.attachments?.nodes ?? []).flatMap(a => {
          const m = a.url?.match(/^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
          return m ? [{ host: m[1], repo: m[2], number: Number(m[3]), title: a.title, url: a.url }] : [];
        });
        return { issue, description: n.description ?? "", priorityLabel: n.priorityLabel, dueDate: n.dueDate,
          labels: n.labels?.nodes ?? [], states: await this.states(n.team.id), workspaceKey: this.workspace.urlKey,
          cycle: n.cycle ? n.cycle.name || `Cycle ${n.cycle.number}` : undefined, prs, startWhy: startWhy(n) };
      }
      case "project": {
        const { project } = await this.query("query TaskProject($id: String!) { project(id: $id) { description content startDate lead { displayName } } }", { id: req.project });
        if (!project) throw new Error("Linear returned no project");
        return { ...project, lead: project.lead?.displayName ?? "" };
      }
      case "create": {
        const n = req.new;
        if (!n?.title?.trim() || !n.team) throw new Error("A title and team are required");
        const input = { teamId: n.team, title: n.title.trim() };
        for (const [source, target] of [["description", "description"], ["project", "projectId"], ["state", "stateId"], ["priority", "priority"]]) if (n[source]) input[target] = n[source];
        if (n.assignToMe) input.assigneeId = this.viewer;
        const data = await this.query(`mutation TaskCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input });
        if (data.issueCreate?.success !== true) throw new Error("Linear did not create the issue");
        const issue = issueOf(data.issueCreate.issue);
        return { issue, note: `Created ${issue.identifier}` };
      }
      case "set-state": {
        if (!req.state) throw new Error("Choose a status first");
        await this.update(req.issue, { stateId: req.state });
        const issue = issueOf(await this.fresh(req.issue));
        return { issue, note: `${issue.identifier} is ${issue.state.name}` };
      }
      case "check-start":
      case "start": {
        const n = await this.fresh(req.issue), issue = issueOf(n), why = startWhy(n);
        if (why) throw new Error(why);
        if (req.op === "check-start") return { issue };
        if ((req.branch && req.branch !== issue.branch) || (req.teamKey && req.teamKey !== issue.teamKey)) throw new Error("Issue branch or team changed; reopen the issue before starting");
        const input = {};
        if (n.state.type !== "started") {
          const state = (await this.states(n.team.id)).find(s => s.type === "started");
          if (!state) throw new Error(`Team ${n.team.key} has no started state`);
          input.stateId = state.id;
        }
        if (!n.assignee) input.assigneeId = this.viewer;
        if (Object.keys(input).length) await this.update(n.id, input);
        const started = issueOf(await this.fresh(n.id));
        return { issue: started, note: `${started.identifier} is ${started.state.name}` };
      }
      default: throw new Error(`Unsupported Linear API operation: ${req.op}`);
    }
  }
}

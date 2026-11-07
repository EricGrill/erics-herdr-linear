// Delegate and label enrichment, straight from Linear's GraphQL API.
//
// Why this exists: herdr-linear's `app` protocol has ops for status, list, find, detail,
// project, set-state, check-start, start, teams, states, create, worktree and job -- and
// none of them return an issue's delegate, its labels, or a saved view. The delegate is
// the whole agent axis of this board, so it comes from Linear directly while everything
// else (sign-in, create, start, worktree) stays on herdr-linear.
//
// Credential handling: the key is read from the environment, or optional Doppler, inside
// the shell that uses it and is
// written to a 0600 curl config rather than passed as an argument, so it never appears in
// any process's argv. Temporary files are removed when the shell exits.
import { request } from "./auth.js";
import { normalizeConfig } from "./config.js";

// Requests are paginated. A bounded refresh reports partial results rather than
// silently claiming a growing workspace is complete.
export const PAGE_SIZE = 250;
// Nested connections multiply query cost. Larger label pages exceed Linear's 10,000 limit.
const LABEL_PAGE_SIZE = 20;

const QUERY = `query BoardEnrichment($after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      url
      priority
      priorityLabel
      updatedAt
      delegate { id name displayName avatarUrl active app isAssignable }
      assignee { displayName }
      state { name type }
      project { id name }
      team { key }
      labels(first: ${LABEL_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { name color } }
    }
  }
}`;

// Completeness must be stated by Linear, never inferred from missing metadata.
function pagination(page) {
  const info = page?.pageInfo;
  if (typeof info?.hasNextPage !== "boolean") {
    return { done: false, cursor: null, error: "Linear returned missing or invalid pageInfo" };
  }
  const cursor = info.endCursor;
  if (info.hasNextPage && (typeof cursor !== "string" || !cursor.trim())) {
    return { done: false, cursor: null, error: "Linear reported more results without a valid cursor" };
  }
  return { done: !info.hasNextPage, cursor: cursor ?? null, error: null };
}

const nodesOf = connection => Array.isArray(connection?.nodes) ? connection.nodes : [];
const eligibleAgent = user => user?.active === true && user?.app === true && user?.isAssignable === true;
const contextMissing = (connection, category) =>
  !Array.isArray(connection?.nodes) || !pagination(connection).done ? [category] : [];

function appendUnique(rows, additions) {
  const seen = new Set(rows.map(row => row.id || row.identifier));
  for (const row of additions) {
    const key = row.id || row.identifier;
    if (!seen.has(key)) { rows.push(row); seen.add(key); }
  }
}

/** Turns one GraphQL answer into rows the board can use. Pure, so it is tested without a
 *  network: anything malformed yields no rows rather than a thrown render. */
export function parseEnrichment(text) {
  let json;
  try { json = JSON.parse(String(text ?? "")); }
  catch { return { rows: [], done: true, cursor: null, error: "Linear sent something that isn't JSON" }; }
  if (Array.isArray(json?.errors) && json.errors.length) {
    const first = String(json.errors[0]?.message ?? "Linear rejected the query");
    return { rows: [], done: true, cursor: null, error: first };
  }
  const page = json?.data?.issues;
  if (!page || !Array.isArray(page.nodes)) {
    return { rows: [], done: true, cursor: null, error: "Linear returned no issues block" };
  }
  const rows = page.nodes.map(node => ({
    id: node?.id ?? null,
    identifier: String(node?.identifier ?? ""),
    title: String(node?.title ?? ""),
    url: node?.url ? String(node.url) : null,
    priority: Number.isInteger(node?.priority) ? node.priority : 0,
    priorityLabel: node?.priorityLabel ? String(node.priorityLabel) : null,
    updatedAt: node?.updatedAt ? String(node.updatedAt) : null,
    delegate: node?.delegate ? {
      id: node.delegate.id ? String(node.delegate.id) : null,
      name: String(node.delegate.name ?? node.delegate.displayName ?? ""),
      avatarUrl: node.delegate.avatarUrl ?? null,
      eligible: eligibleAgent(node.delegate),
    } : null,
    assignee: node?.assignee?.displayName ? String(node.assignee.displayName) : null,
    state: node?.state ? { name: String(node.state.name ?? ""), type: String(node.state.type ?? "") } : null,
    project: node?.project?.id ? { id: String(node.project.id), name: String(node.project.name ?? "") } : null,
    teamKey: node?.team?.key ? String(node.team.key) : null,
    labels: nodesOf(node?.labels).map(l => String(l?.name ?? "")).filter(Boolean),
    labelColors: Object.fromEntries(nodesOf(node?.labels)
      .filter(l => l?.name && /^#[0-9a-f]{6}$/i.test(String(l.color ?? ""))).map(l => [String(l.name), String(l.color)])),
    contextIncomplete: contextMissing(node?.labels, "labels"),
  })).filter(row => row.identifier);
  return {
    rows,
    ...pagination(page),
  };
}

/** Index rows by both identifier and uuid, so a caller can look up either. */
export function indexEnrichment(rows) {
  const byIdentifier = new Map();
  const byId = new Map();
  for (const row of rows) {
    byIdentifier.set(row.identifier.toUpperCase(), row);
    if (row.id) byId.set(row.id, row);
  }
  return { byIdentifier, byId };
}

/** Delegate -> issues, for the crew roster. Only live delegates appear; the roster adds
 *  the rest of the crew from the Linear user list so an idle agent still has a row. */
export function delegateCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = row.delegate?.name;
    if (!name) continue;
    if (!counts.has(name)) counts.set(name, { name, avatarUrl: row.delegate.avatarUrl, issues: [] });
    counts.get(name).issues.push(row);
  }
  return [...counts.values()].sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
}

function authOf(config) {
  try { return { auth: normalizeConfig(config).enrichment }; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}

/** Parses a GraphQL answer down to `data`, or a readable error. */
function dataOf(text) {
  let json;
  try { json = JSON.parse(String(text ?? "")); }
  catch { return { error: "Linear sent something that isn't JSON" }; }
  if (Array.isArray(json?.errors) && json.errors.length) {
    return { error: String(json.errors[0]?.message ?? "Linear rejected the query") };
  }
  if (!json?.data) return { error: "Linear returned no data" };
  return { data: json.data };
}

/**
 * Fetches every active issue's delegate, labels and state.
 * `on`: the machine to run from (null: this one) -- the same machine selection
 * client.js already uses for a signed-in Linear.
 * Never throws: failures come back as { error }, and the caller keeps its last good read.
 */
export async function fetchEnrichment({ on = null, pages = 4, config = {} } = {}) {
  const rows = [];
  const { auth, error } = authOf(config);
  if (error) return { rows, fetchedAt: null, partial: true, error };
  if (!auth.enabled) return { rows, fetchedAt: null, partial: false, error: null };
  let after = null;
  const cursors = new Set();
  for (let page = 0; page < pages; page++) {
    const result = await request({ on, auth, query: QUERY, variables: { after: after ?? null } });
    if (result.error) return { rows, fetchedAt: null, partial: true, error: result.error };
    const parsed = parseEnrichment(result.text);
    if (parsed.error) return { rows, fetchedAt: null, partial: true, error: parsed.error };
    appendUnique(rows, parsed.rows);
    if (parsed.done) return { rows, fetchedAt: Date.now(), partial: false, error: null };
    if (cursors.has(parsed.cursor)) return { rows, fetchedAt: null, partial: true, error: "Linear repeated a pagination cursor" };
    cursors.add(parsed.cursor);
    after = parsed.cursor;
  }
  return { rows, fetchedAt: Date.now(), partial: true, error: null };
}

// ---- Pull requests linked to the issues the sidebar shows ---------------------------
//
// Only for the handful of issues open in spaces, never the whole workspace: attachments
// nested under 250 issues would push the enrichment query past Linear's complexity cap.
// GitHub pull requests arrive as attachments. Their open/merged state, and checks when
// Linear's GitHub integration records them, are in the attachment's `metadata`.

export const PULL_ISSUE_CAP = 50;

const PULLS_QUERY = `query BoardPullRequests($ids: [ID!], $first: Int) {
  issues(first: $first, filter: { id: { in: $ids } }) {
    nodes {
      id
      identifier
      attachments(first: 10) { nodes { title url sourceType metadata updatedAt } }
    }
  }
}`;

const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/i;
const FAILED = /^(?:fail(?:ed|ure|ing)?|error(?:ed)?|timed_out|cancel(?:l)?ed|action_required|startup_failure)$/i;
const PASSED = /^(?:success(?:ful)?|pass(?:ed|ing)?|neutral|skipped)$/i;
const PENDING = /^(?:pending|queued|in_progress|running|waiting|requested|expected)$/i;
const lower = v => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Overall checks verdict from whatever shape the metadata carries: "failing",
 *  "passing", "pending", or null when it says nothing about checks. Pure. */
export function checksOf(meta) {
  if (!meta || typeof meta !== "object") return null;
  const summary = [meta.checksStatus, meta.checkStatus, meta.ciStatus, meta.checks?.status, meta.checks?.conclusion,
    meta.checks?.state, meta.statusCheckRollup?.state, meta.statusCheckRollup].find(v => typeof v === "string" && v.trim());
  const list = [meta.checks, meta.checks?.nodes, meta.checkRuns, meta.statusChecks].find(Array.isArray) ?? [];
  const states = list.map(c => lower(typeof c === "string" ? c : c?.conclusion || c?.state || c?.status)).filter(Boolean);
  if (summary) states.push(lower(summary));
  if (!states.length) return null;
  if (states.some(s => FAILED.test(s))) return "failing";
  if (states.some(s => PENDING.test(s) || !PASSED.test(s))) return "pending";
  return "passing";
}

/** One attachment -> a pull request, or null when it isn't one. `state` is one of
 *  "failing", "ready", "open", "draft", "merged" or "closed". Pure. */
export function pullRequestOf(attachment) {
  const url = String(attachment?.url ?? "");
  const match = url.match(PULL_URL);
  if (!match) return null;
  const meta = attachment.metadata && typeof attachment.metadata === "object" ? attachment.metadata : {};
  const status = lower(meta.status ?? meta.state);
  const checks = checksOf(meta);
  const review = lower(meta.reviewDecision ?? meta.reviewStatus);
  let state = "open";
  if (status === "merged" || meta.mergedAt || meta.merged === true) state = "merged";
  else if (status === "closed" || meta.closedAt) state = "closed";
  else if (checks === "failing") state = "failing";
  else if (status === "draft" || meta.draft === true || meta.isDraft === true) state = "draft";
  else if (status === "approved" || review === "approved" || checks === "passing") state = "ready";
  return {
    url, repo: match[1], number: Number(match[2]),
    title: String(attachment.title ?? `${match[1]}#${match[2]}`),
    state, checks, approved: status === "approved" || review === "approved",
    updatedAt: str(attachment.updatedAt),
  };
}

const PULL_RANK = { failing: 0, ready: 1, open: 2, draft: 3, merged: 4 };

/** The one pull request a row should show: an open one before a merged one, a failing
 *  one before the rest. Closed pull requests are never shown. Pure. */
export function rowPullRequest(prs = []) {
  return prs.filter(pr => pr && pr.state in PULL_RANK)
    .sort((a, b) => PULL_RANK[a.state] - PULL_RANK[b.state] || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0] ?? null;
}

/** One answer -> { "KEY-1": [pull requests] }. Pure. */
export function parsePullRequests(text) {
  const { data, error } = dataOf(text);
  if (error) return { pulls: {}, error };
  if (!Array.isArray(data.issues?.nodes)) return { pulls: {}, error: "Linear returned no issues block" };
  const pulls = {};
  for (const node of data.issues.nodes) {
    if (!node?.identifier) continue;
    pulls[String(node.identifier).toUpperCase()] = nodesOf(node.attachments).map(pullRequestOf).filter(Boolean);
  }
  return { pulls, error: null };
}

/** Pull requests for the given Linear issue ids. Never throws. */
export async function fetchPullRequests({ on = null, config = {}, ids = [] } = {}) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))].slice(0, PULL_ISSUE_CAP);
  if (!wanted.length) return { pulls: {}, error: null };
  const { auth, error } = authOf(config);
  if (error) return { pulls: {}, error };
  if (!auth.enabled) return { pulls: {}, error: null };
  const result = await request({ on, auth, query: PULLS_QUERY, variables: { ids: wanted, first: wanted.length } });
  if (result.error) return { pulls: {}, error: result.error };
  return parsePullRequests(result.text);
}

// ---- Crew: one agent's queue, issue inspection, and delegate reassignment ------------
//
// These read and write Linear through the same shell and credential path as the
// enrichment above. The enrichment stays the source of the roster's counts; a queue read
// is the detailed, per-agent view of the same open-issue set (same state filter).

export const QUEUE_PAGE_SIZE = 50;

const ISSUE_FIELDS = `
      id
      identifier
      title
      url
      priority
      priorityLabel
      updatedAt
      state { id name type }
      project { id name }
      team { key }
      assignee { id displayName }
      delegate { id name displayName active app isAssignable }
      labels(first: ${LABEL_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { name color } }
      inverseRelations(first: 25) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier title state { name type } } } }`;

const QUEUE_QUERY = `query CrewQueue($delegate: ID!, $after: String) {
  issues(first: ${QUEUE_PAGE_SIZE}, after: $after, orderBy: updatedAt, filter: {
    delegate: { id: { eq: $delegate } },
    state: { type: { nin: ["completed", "canceled"] } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes {${ISSUE_FIELDS}
    }
  }
}`;

const DETAIL_QUERY = `query CrewIssue($id: String!) {
  issue(id: $id) {${ISSUE_FIELDS}
      description
      relations(first: 25) { pageInfo { hasNextPage endCursor } nodes { type relatedIssue { identifier title state { name type } } } }
      attachments(first: 25) { pageInfo { hasNextPage endCursor } nodes { title url sourceType } }
  }
}`;

const AGENTS_QUERY = `query CrewAgents($after: String) {
  users(first: 100, after: $after, filter: { app: { eq: true }, active: { eq: true } }) {
    pageInfo { hasNextPage endCursor }
    nodes { id name displayName active app isAssignable }
  }
}`;

// What a reassignment must not disturb, read before and after the write.
const SNAPSHOT_QUERY = `query CrewSnapshot($id: String!) {
  issue(id: $id) {
    id identifier priority
    state { id name }
    project { id name }
    assignee { id displayName }
    delegate { id name displayName }
  }
}`;

// Only the delegate is sent. Assignee, project, priority and state are left out of the
// input so Linear has nothing to change them to.
const REASSIGN_MUTATION = `mutation CrewReassign($id: String!, $delegate: String!) {
  issueUpdate(id: $id, input: { delegateId: $delegate }) { success }
}`;

const str = v => (v == null ? null : String(v));
const stateOf = s => (s ? { id: str(s.id), name: String(s.name ?? ""), type: String(s.type ?? "") } : null);
const relationIssue = i => (i?.identifier ? { identifier: String(i.identifier), title: String(i.title ?? ""), state: stateOf(i.state) } : null);

/** One Linear issue node -> a queue row. Pure. */
export function queueRow(node) {
  if (!node?.identifier) return null;
  const blockers = nodesOf(node.inverseRelations)
    .filter(r => r?.type === "blocks").map(r => relationIssue(r.issue)).filter(Boolean);
  return {
    id: str(node.id),
    identifier: String(node.identifier),
    title: String(node.title ?? ""),
    url: str(node.url),
    priority: Number.isFinite(Number(node.priority)) ? Number(node.priority) : 0,
    priorityLabel: str(node.priorityLabel),
    updatedAt: str(node.updatedAt),
    state: stateOf(node.state),
    project: node.project?.id ? { id: String(node.project.id), name: String(node.project.name ?? "") } : null,
    teamKey: node.team?.key ? String(node.team.key) : null,
    assignee: node.assignee?.id ? { id: String(node.assignee.id), name: String(node.assignee.displayName ?? "") } : null,
    delegate: node.delegate?.id ? { id: String(node.delegate.id), name: String(node.delegate.name ?? node.delegate.displayName ?? ""), eligible: eligibleAgent(node.delegate) } : null,
    labels: nodesOf(node.labels).map(l => String(l?.name ?? "")).filter(Boolean),
    blockers,
    contextIncomplete: [...contextMissing(node.labels, "labels"), ...contextMissing(node.inverseRelations, "blockers")],
  };
}

/** One page of an agent's queue. Pure. */
export function parseQueue(text) {
  const { data, error } = dataOf(text);
  if (error) return { rows: [], done: true, cursor: null, error };
  const page = data.issues;
  if (!page || !Array.isArray(page.nodes)) return { rows: [], done: true, cursor: null, error: "Linear returned no issues block" };
  return {
    rows: page.nodes.map(queueRow).filter(Boolean),
    ...pagination(page),
  };
}

/**
 * Every open issue delegated to one agent, across projects.
 * `complete` is true only when Linear said there were no more pages. An error or the page
 * cap leaves `complete: false` with whatever arrived, so a caller can never mistake a
 * partial read for the whole queue. Never throws.
 */
export async function fetchQueue({ on = null, config = {}, delegateId, pages = 8 } = {}) {
  const rows = [];
  if (!delegateId) return { rows, complete: false, error: "This agent has no Linear identity", fetchedAt: null };
  const { auth, error } = authOf(config);
  if (error) return { rows, complete: false, error, fetchedAt: null };
  if (!auth.enabled) return { rows, complete: false, error: "Linear enrichment is disabled in the layout config", fetchedAt: null };
  let after = null;
  const cursors = new Set();
  for (let page = 0; page < pages; page++) {
    const result = await request({ on, auth, query: QUEUE_QUERY, variables: { delegate: delegateId, after } });
    if (result.error) return { rows, complete: false, error: result.error, fetchedAt: null };
    const parsed = parseQueue(result.text);
    if (parsed.error) return { rows, complete: false, error: parsed.error, fetchedAt: null };
    appendUnique(rows, parsed.rows);
    if (parsed.done) return { rows, complete: true, error: null, fetchedAt: Date.now() };
    if (cursors.has(parsed.cursor)) return { rows, complete: false, error: "Linear repeated a pagination cursor", fetchedAt: null };
    cursors.add(parsed.cursor);
    after = parsed.cursor;
  }
  return { rows, complete: false, error: null, fetchedAt: Date.now() };
}

/** Linear's agent (app) users, the only valid delegation targets. Pure. */
export function parseAgents(text) {
  const { data, error } = dataOf(text);
  if (error) return { agents: [], done: true, cursor: null, error };
  const page = data.users;
  if (!page || !Array.isArray(page.nodes)) return { agents: [], done: true, cursor: null, error: "Linear returned no users block" };
  return {
    agents: page.nodes.filter(u => u?.id && u.app === true && u.active === true)
      .map(u => ({ id: String(u.id), name: String(u.name || u.displayName || ""), eligible: eligibleAgent(u) }))
      .filter(a => a.name),
    ...pagination(page),
  };
}

/** Every active agent identity in the workspace. Never throws. */
export async function fetchAgents({ on = null, config = {}, pages = 5 } = {}) {
  const agents = [];
  const { auth, error } = authOf(config);
  if (error) return { agents, complete: false, error };
  if (!auth.enabled) return { agents, complete: false, error: "Linear enrichment is disabled in the layout config" };
  let after = null;
  const cursors = new Set();
  for (let page = 0; page < pages; page++) {
    const result = await request({ on, auth, query: AGENTS_QUERY, variables: { after } });
    if (result.error) return { agents, complete: false, error: result.error };
    const parsed = parseAgents(result.text);
    if (parsed.error) return { agents, complete: false, error: parsed.error };
    appendUnique(agents, parsed.agents);
    if (parsed.done) return { agents, complete: true, error: null };
    if (cursors.has(parsed.cursor)) return { agents, complete: false, error: "Linear repeated a pagination cursor" };
    cursors.add(parsed.cursor);
    after = parsed.cursor;
  }
  return { agents, complete: false, error: null };
}

/** One issue for the Crew inspector. Pure. */
export function parseIssueDetail(text) {
  const { data, error } = dataOf(text);
  if (error) return { issue: null, error };
  const node = data.issue;
  const row = queueRow(node);
  if (!row) return { issue: null, error: "Linear did not return that issue" };
  const blocking = nodesOf(node.relations).filter(r => r?.type === "blocks")
    .map(r => relationIssue(r.relatedIssue)).filter(Boolean);
  const attachments = nodesOf(node.attachments).filter(a => a?.url)
    .map(a => ({ title: String(a.title ?? a.url), url: String(a.url), sourceType: str(a.sourceType) }));
  const prs = attachments.filter(a => /^https?:\/\/[^/]+\/[^?#]*\/(?:pull|merge_requests|pull-requests|pullrequest)\/\d+(?:[/?#]|$)/i.test(a.url));
  return { issue: { ...row, description: String(node.description ?? ""), blocking, prs, attachments,
    contextIncomplete: [...row.contextIncomplete, ...contextMissing(node.relations, "related issues"), ...contextMissing(node.attachments, "attachments")] }, error: null };
}

export async function fetchIssueDetail({ on = null, config = {}, id } = {}) {
  const { auth, error } = authOf(config);
  if (error) return { issue: null, error };
  if (!auth.enabled) return { issue: null, error: "Linear enrichment is disabled in the layout config" };
  const result = await request({ on, auth, query: DETAIL_QUERY, variables: { id } });
  if (result.error) return { issue: null, error: result.error };
  return parseIssueDetail(result.text);
}

/** The fields a reassignment must leave alone, plus the delegate. Pure. */
export function parseSnapshot(text) {
  const { data, error } = dataOf(text);
  if (error) return { snapshot: null, error };
  const n = data.issue;
  if (!n?.id) return { snapshot: null, error: "Linear did not return that issue" };
  return {
    snapshot: {
      id: String(n.id), identifier: String(n.identifier ?? ""),
      priority: Number(n.priority ?? 0),
      stateId: str(n.state?.id), stateName: str(n.state?.name),
      projectId: str(n.project?.id),
      assigneeId: str(n.assignee?.id), assigneeName: str(n.assignee?.displayName),
      delegateId: str(n.delegate?.id), delegateName: str(n.delegate?.name ?? n.delegate?.displayName),
    },
    error: null,
  };
}

/** What changed that should not have, or did not change that should have. Pure. */
export function reassignmentProblems(before, after, delegateId) {
  const problems = [];
  if (!after) return ["Linear did not return the issue after saving"];
  if (after.delegateId !== delegateId) {
    problems.push(`Linear still shows ${after.delegateName || "no agent"} as the delegate`);
  }
  if (before) {
    if (after.assigneeId !== before.assigneeId) problems.push(`assignee changed from ${before.assigneeName ?? "nobody"} to ${after.assigneeName ?? "nobody"}`);
    if (after.stateId !== before.stateId) problems.push(`state changed from ${before.stateName ?? "?"} to ${after.stateName ?? "?"}`);
    if (after.projectId !== before.projectId) problems.push("project changed");
    if (after.priority !== before.priority) problems.push("priority changed");
  }
  return problems;
}

/**
 * Moves one issue to another delegated agent and proves it from Linear: reads the issue,
 * sends only `delegateId`, reads it again, and checks the delegate landed while assignee,
 * state, project and priority did not move. Never throws.
 * Returns { ok, error, before, after }.
 */
export async function reassignIssue({ on = null, config = {}, id, delegateId } = {}) {
  const fail = (error, extra = {}) => ({ ok: false, error, before: null, after: null, ...extra });
  if (!id || !delegateId) return fail("An issue and a destination agent are both required");
  const { auth, error } = authOf(config);
  if (error) return fail(error);
  if (!auth.enabled) return fail("Linear enrichment is disabled in the layout config");
  const read = async () => {
    const r = await request({ on, auth, query: SNAPSHOT_QUERY, variables: { id } });
    return r.error ? { snapshot: null, error: r.error } : parseSnapshot(r.text);
  };
  const first = await read();
  if (first.error) return fail(`Could not read the issue: ${first.error}`);
  const before = first.snapshot;
  if (before.delegateId !== delegateId) {
    const written = await request({ on, auth, query: REASSIGN_MUTATION, variables: { id, delegate: delegateId } });
    if (written.error) return fail(written.error, { before });
    const { data, error: rejected } = dataOf(written.text);
    if (rejected) return fail(rejected, { before });
    if (data.issueUpdate?.success !== true) return fail("Linear did not accept the change", { before });
  }
  const second = await read();
  if (second.error) return fail(`Saved, but could not read it back: ${second.error}`, { before });
  const after = second.snapshot;
  const problems = reassignmentProblems(before, after, delegateId);
  if (problems.length) return { ok: false, error: problems.join("; "), before, after };
  return { ok: true, error: null, before, after };
}

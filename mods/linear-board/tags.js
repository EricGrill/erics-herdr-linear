// Pins, tags and row colors for sidebar issues, kept as Linear labels.
//
// Why labels: every sidebar row came from a Linear issue, and every machine reads the same
// Linear workspace, so a label put on an issue on one machine is on that issue everywhere.
// Nothing here is stored in machine-local preferences.
//
//   Pin   - a label named "Pinned". Pinned spaces are drawn above the status groups.
//   Tag   - any other label a person would choose (routing labels such as agent:/repo:
//           and label groups are left out of the picker).
//   Color - a row takes the Linear color of its first tag. Recoloring is done in Linear.
//
// Writes add or remove one label at a time (issueAddLabel / issueRemoveLabel), so labels
// set by the completion contract, the review handoff or anyone else are never replaced,
// and every write is read back from Linear before it is reported as done.
import { request } from "./auth.js";
import { normalizeConfig } from "./config.js";
import { PIN_LABEL, QUIET_LABEL, isPinLabel } from "./board.js";

export { PIN_LABEL, isPinLabel };
export const PIN_COLOR = "#F2C94C";
// Linear's own label palette, for a tag created from the sidebar.
export const TAG_COLORS = ["#5E6AD2", "#26B5CE", "#4CB782", "#F2C94C", "#F2994A", "#EB5757", "#BB87FC", "#95A2B3"];
export const TAG_ISSUE_CAP = 50;
const MAX_TAG_NAME = 80;
const HEX = /^#[0-9a-f]{6}$/i;
const CATALOG_PAGE = 250;

const nodesOf = connection => Array.isArray(connection?.nodes) ? connection.nodes : [];
const str = v => (v == null ? null : String(v));
const colorOf = c => (HEX.test(String(c ?? "")) ? String(c) : null);

/** Is this issue pinned? Pure. */
export function isPinned(issue) {
  return (issue?.labels ?? []).some(isPinLabel);
}

/** The tags a sidebar row shows, in Linear's order, with their colors. Pure. */
export function rowTags(issue) {
  const colors = issue?.labelColors ?? {};
  return (issue?.labels ?? []).map(String)
    .filter(name => name && !QUIET_LABEL.test(name) && !isPinLabel(name))
    .map(name => ({ name, color: colorOf(colors[name]) }));
}

/** The row's color: its first tag that has one, or null. Pure. */
export function rowColor(issue) {
  return rowTags(issue).find(tag => tag.color)?.color ?? null;
}

/** A stable palette color for a new tag's name. Pure. */
export function tagColor(name) {
  let n = 0;
  for (const ch of String(name ?? "")) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[n % TAG_COLORS.length];
}

/** A name a person typed, trimmed, or an error. Pure. */
export function tagName(text) {
  const name = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { name: null, error: "A tag needs a name" };
  if (name.length > MAX_TAG_NAME) return { name: null, error: `Tag names are at most ${MAX_TAG_NAME} characters` };
  if (QUIET_LABEL.test(name)) return { name: null, error: "That prefix is reserved for routing labels" };
  return { name, error: null };
}

/** What right-clicking an issue offers for pins and tags. Needs the issue's Linear id. */
export function tagMenuItems(issue, pinned = false) {
  if (!issue?.id) return [];
  return [
    { label: pinned ? "Unpin" : "Pin to top", action: "pin" },
    { label: "Tags…", action: "tags" },
  ];
}

// ---- Reading -------------------------------------------------------------------------

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

function authOf(config) {
  try {
    const auth = normalizeConfig(config).enrichment;
    return auth.enabled ? { auth } : { error: "Linear enrichment is disabled in the layout config" };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

const label = node => (node?.id && node?.name ? { id: String(node.id), name: String(node.name), color: colorOf(node.color) } : null);

/** An issue's labels as the sidebar keeps them: names in order plus a name -> color map. Pure. */
export function labelState(labels = []) {
  const clean = labels.filter(l => l?.name);
  return {
    labels: clean.map(l => String(l.name)),
    colors: Object.fromEntries(clean.filter(l => colorOf(l.color)).map(l => [String(l.name), colorOf(l.color)])),
  };
}

const ISSUES_TAGS_QUERY = `query BoardIssueTags($ids: [ID!], $first: Int) {
  issues(first: $first, filter: { id: { in: $ids } }) {
    nodes { identifier labels(first: 20) { nodes { id name color } } }
  }
}`;

/** One answer -> { "KEY-1": { labels, colors } }. Pure. */
export function parseIssueTags(text) {
  const { data, error } = dataOf(text);
  if (error) return { tags: {}, error };
  if (!Array.isArray(data.issues?.nodes)) return { tags: {}, error: "Linear returned no issues block" };
  const tags = {};
  for (const node of data.issues.nodes) {
    if (!node?.identifier) continue;
    tags[String(node.identifier).toUpperCase()] = labelState(nodesOf(node.labels).map(label).filter(Boolean));
  }
  return { tags, error: null };
}

/** Labels for the issues open in spaces, in any workflow state: the bulk enrichment only
 *  reads open issues, and a pinned ticket that is Done in Linear must stay pinned.
 *  Never throws. */
export async function fetchIssueTags({ on = null, config = {}, ids = [] } = {}) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))].slice(0, TAG_ISSUE_CAP);
  if (!wanted.length) return { tags: {}, error: null };
  let auth;
  try { auth = normalizeConfig(config).enrichment; } catch (e) { return { tags: {}, error: String(e?.message ?? e) }; }
  if (!auth.enabled) return { tags: {}, error: null };
  const result = await request({ on, auth, query: ISSUES_TAGS_QUERY, variables: { ids: wanted, first: wanted.length } });
  if (result.error) return { tags: {}, error: result.error };
  return parseIssueTags(result.text);
}

const CATALOG_QUERY = `query BoardTagCatalog($team: String!, $after: String) {
  issueLabels(first: ${CATALOG_PAGE}, after: $after, filter: { or: [{ team: { null: true } }, { team: { key: { eq: $team } } }] }) {
    pageInfo { hasNextPage endCursor }
    nodes { id name color isGroup team { key } parent { name } }
  }
}`;

/** One page of the workspace's and a team's labels; groups are dropped. Pure. */
export function parseCatalog(text) {
  const { data, error } = dataOf(text);
  if (error) return { labels: [], done: true, cursor: null, error };
  const page = data.issueLabels;
  if (!page || !Array.isArray(page.nodes)) return { labels: [], done: true, cursor: null, error: "Linear returned no labels block" };
  const info = page.pageInfo;
  if (typeof info?.hasNextPage !== "boolean") return { labels: [], done: true, cursor: null, error: "Linear returned missing or invalid pageInfo" };
  const labels = page.nodes.filter(n => n?.id && n?.name && n.isGroup !== true).map(n => ({
    id: String(n.id), name: String(n.name), color: colorOf(n.color),
    team: str(n.team?.key), group: str(n.parent?.name),
  }));
  return { labels, done: !info.hasNextPage, cursor: str(info.endCursor), error: null };
}

/** Every label a tag could be, for one team. `complete` is false when pages ran out. Never throws. */
export async function fetchCatalog({ on = null, config = {}, team = "", pages = 4 } = {}) {
  const labels = [];
  const { auth, error } = authOf(config);
  if (error) return { labels, complete: false, error };
  let after = null;
  for (let page = 0; page < pages; page++) {
    const result = await request({ on, auth, query: CATALOG_QUERY, variables: { team: String(team ?? ""), after } });
    if (result.error) return { labels, complete: false, error: result.error };
    const parsed = parseCatalog(result.text);
    if (parsed.error) return { labels, complete: false, error: parsed.error };
    labels.push(...parsed.labels.filter(l => !labels.some(x => x.id === l.id)));
    if (parsed.done) return { labels, complete: true, error: null };
    if (!parsed.cursor || parsed.cursor === after) return { labels, complete: false, error: "Linear reported more labels without a new cursor" };
    after = parsed.cursor;
  }
  return { labels, complete: false, error: null };
}

/** The picker's rows: tags a person would choose, the issue's own first, then by name,
 *  narrowed by the typed words. `current` is the issue's label names. Pure. */
export function pickable(catalog = [], current = [], query = "") {
  const on = new Set(current.map(n => String(n).toLowerCase()));
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set();
  return catalog
    .filter(l => !QUIET_LABEL.test(l.name) && !isPinLabel(l.name))
    .filter(l => { const key = `${l.group ?? ""}/${l.name}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .map(l => ({ ...l, checked: on.has(l.name.toLowerCase()) }))
    .filter(l => words.every(w => `${l.group ?? ""} ${l.name}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(b.checked) - Number(a.checked) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Whether the typed text names a tag that doesn't exist yet. Pure. */
export function canCreate(catalog = [], query = "") {
  const { name } = tagName(query);
  return Boolean(name) && !catalog.some(l => l.name.toLowerCase() === name.toLowerCase());
}

/** The label to pin with: the workspace's "Pinned" before a team's, or null. Pure. */
export function pinLabelOf(catalog = [], team = null) {
  const pins = catalog.filter(l => isPinLabel(l.name) && !l.group);
  return pins.find(l => !l.team) ?? pins.find(l => team && l.team === team) ?? null;
}

// ---- Writing -------------------------------------------------------------------------

const ISSUE_LABELS_QUERY = `query BoardIssueLabels($id: String!) {
  issue(id: $id) { id identifier labels(first: 50) { nodes { id name color } } }
}`;
const ADD_MUTATION = `mutation BoardTagAdd($id: String!, $label: String!) {
  issueAddLabel(id: $id, labelId: $label) { success }
}`;
const REMOVE_MUTATION = `mutation BoardTagRemove($id: String!, $label: String!) {
  issueRemoveLabel(id: $id, labelId: $label) { success }
}`;
const CREATE_MUTATION = `mutation BoardTagCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name color } }
}`;

/** One issue's labels from an answer. Pure. */
export function parseIssueLabels(text) {
  const { data, error } = dataOf(text);
  if (error) return { labels: null, error };
  if (!data.issue?.id) return { labels: null, error: "Linear did not return that issue" };
  return { labels: nodesOf(data.issue.labels).map(label).filter(Boolean), error: null };
}

async function readLabels(on, auth, id) {
  const r = await request({ on, auth, query: ISSUE_LABELS_QUERY, variables: { id } });
  return r.error ? { labels: null, error: r.error } : parseIssueLabels(r.text);
}

/** One issue's labels as Linear has them now. Never throws. */
export async function fetchIssueLabels({ on = null, config = {}, id } = {}) {
  if (!id) return { labels: null, error: "An issue is required" };
  const { auth, error } = authOf(config);
  if (error) return { labels: null, error };
  return readLabels(on, auth, id);
}

/** The write a change still needs: "add", "remove" or null when Linear already agrees. Pure. */
export function tagChange(labels = [], labelId, wanted) {
  const has = labels.some(l => l.id === labelId);
  return wanted === has ? null : wanted ? "add" : "remove";
}

/**
 * Puts one label on an issue, or takes it off, and proves it from Linear: reads the
 * issue's labels, writes only that label, then reads them again. Never throws.
 * Returns { ok, error, labels } with labels as Linear has them afterwards.
 */
export async function setTag({ on = null, config = {}, id, labelId, wanted } = {}) {
  if (!id || !labelId) return { ok: false, error: "An issue and a label are both required", labels: null };
  const { auth, error } = authOf(config);
  if (error) return { ok: false, error, labels: null };
  const read = () => readLabels(on, auth, id);
  const before = await read();
  if (before.error) return { ok: false, error: `Could not read the issue: ${before.error}`, labels: null };
  const change = tagChange(before.labels, labelId, wanted);
  if (change) {
    const written = await request({ on, auth, query: change === "add" ? ADD_MUTATION : REMOVE_MUTATION, variables: { id, label: labelId } });
    if (written.error) return { ok: false, error: written.error, labels: before.labels };
    const { data, error: rejected } = dataOf(written.text);
    if (rejected) return { ok: false, error: rejected, labels: before.labels };
    const result = change === "add" ? data.issueAddLabel : data.issueRemoveLabel;
    if (result?.success !== true) return { ok: false, error: "Linear did not accept the change", labels: before.labels };
  }
  const after = await read();
  if (after.error) return { ok: false, error: `Saved, but could not read it back: ${after.error}`, labels: null };
  if (tagChange(after.labels, labelId, wanted)) {
    return { ok: false, error: wanted ? "Linear does not show the tag on the issue" : "Linear still shows the tag on the issue", labels: after.labels };
  }
  return { ok: true, error: null, labels: after.labels };
}

/** Makes a workspace label, for a tag typed in the picker or the first pin. Never throws. */
export async function createTag({ on = null, config = {}, name, color = null } = {}) {
  const checked = isPinLabel(name) ? { name: PIN_LABEL, error: null } : tagName(name);
  if (checked.error) return { label: null, error: checked.error };
  const { auth, error } = authOf(config);
  if (error) return { label: null, error };
  const input = { name: checked.name, color: colorOf(color) ?? tagColor(checked.name) };
  const result = await request({ on, auth, query: CREATE_MUTATION, variables: { input } });
  if (result.error) return { label: null, error: result.error };
  const { data, error: rejected } = dataOf(result.text);
  if (rejected) return { label: null, error: rejected };
  const made = label(data.issueLabelCreate?.issueLabel);
  if (data.issueLabelCreate?.success !== true || !made) return { label: null, error: "Linear did not create the tag" };
  return { label: { ...made, team: null, group: null }, error: null };
}

/**
 * Pins or unpins an issue. Pinning uses the workspace's "Pinned" label (a team's one when
 * that is all there is) and makes a workspace label the first time. Unpinning removes
 * every pin label the issue carries, as Linear has them now. Never throws.
 * Returns { ok, error, labels }.
 */
export async function setPinned({ on = null, config = {}, id, team = null, pinned, catalog = null } = {}) {
  if (!id) return { ok: false, error: "An issue is required", labels: null };
  if (!pinned) {
    const { auth, error } = authOf(config);
    if (error) return { ok: false, error, labels: null };
    const now = await readLabels(on, auth, id);
    if (now.error) return { ok: false, error: `Could not read the issue: ${now.error}`, labels: null };
    let result = { ok: true, error: null, labels: now.labels };
    for (const pin of now.labels.filter(l => isPinLabel(l.name))) {
      result = await setTag({ on, config, id, labelId: pin.id, wanted: false });
      if (!result.ok) return result;
    }
    return result;
  }
  let labels = catalog;
  if (!labels) {
    const read = await fetchCatalog({ on, config, team });
    if (read.error) return { ok: false, error: read.error, labels: null };
    labels = read.labels;
  }
  let pin = pinLabelOf(labels, team);
  if (!pin) {
    const made = await createTag({ on, config, name: PIN_LABEL, color: PIN_COLOR });
    if (made.error) return { ok: false, error: `Could not make the ${PIN_LABEL} label: ${made.error}`, labels: null };
    pin = made.label;
  }
  return setTag({ on, config, id, labelId: pin.id, wanted: true });
}

/** The shared enrichment with one issue's labels replaced by what Linear just returned. Pure. */
export function withLabels(published, identifier, labels) {
  const key = String(identifier ?? "").toUpperCase();
  if (!published || !Array.isArray(published.rows) || !key) return published;
  const { labels: names, colors } = labelState(labels);
  return { ...published, rows: published.rows.map(row => String(row.identifier).toUpperCase() === key
    ? { ...row, labels: names, labelColors: colors } : row) };
}

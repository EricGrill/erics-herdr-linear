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
import { exec } from "herdr";
import { normalizeConfig } from "./config.js";

// Requests are paginated. A bounded refresh reports partial results rather than
// silently claiming a growing workspace is complete.
export const PAGE_SIZE = 250;

const QUERY = `query BoardEnrichment($after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      delegate { name displayName avatarUrl }
      assignee { displayName }
      state { name type }
      project { id name }
      team { key }
      labels { nodes { name } }
    }
  }
}`;

const SCRIPT = String.raw`
set -eu
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
env_name=$1
doppler_project=$2
doppler_config=$3
shift 3
key=$(printenv "$env_name" 2>/dev/null) || key=""
if [ -z "$key" ] && [ -n "$doppler_project" ]; then
  command -v doppler >/dev/null 2>&1 || { echo "doppler is not installed" >&2; exit 3; }
  for name in "$@"; do
    key=$(doppler secrets get "$name" --project "$doppler_project" --config "$doppler_config" --plain 2>/dev/null) || key=""
    [ -n "$key" ] && break
  done
fi
[ -n "$key" ] || { echo "no Linear API key available; set the configured environment variable or Doppler fallback" >&2; exit 4; }
case "$key" in
  *'
'*|*"$(printf '\r')"*) echo "Linear API key must not contain a newline" >&2; exit 4 ;;
esac
umask 077
dir=$(mktemp -d) || exit 3
trap 'rm -rf "$dir"' EXIT
escaped_key=$(printf '%s' "$key" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'header = "Authorization: %s"\n' "$escaped_key" > "$dir/curlrc"
cat > "$dir/body" <<'HERDR_BOARD_QUERY'
%BODY%
HERDR_BOARD_QUERY
curl -sS -m 30 --config "$dir/curlrc" \
  -H 'Content-Type: application/json' \
  --data-binary @"$dir/body" \
  https://api.linear.app/graphql
`;

function script(after) {
  const body = JSON.stringify({ query: QUERY, variables: { after: after ?? null } });
  // The heredoc is quoted, so the only thing that could break out is the delimiter itself.
  if (body.includes("HERDR_BOARD_QUERY")) throw new Error("query body collided with its heredoc delimiter");
  // Replacer functions, not strings: a "$&" or "$'" inside the JSON body would otherwise
  // be read as a replacement pattern and corrupt the query.
  return SCRIPT
    .replace("%BODY%", () => body);
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
    delegate: node?.delegate ? {
      name: String(node.delegate.name ?? node.delegate.displayName ?? ""),
      avatarUrl: node.delegate.avatarUrl ?? null,
    } : null,
    assignee: node?.assignee?.displayName ? String(node.assignee.displayName) : null,
    state: node?.state ? { name: String(node.state.name ?? ""), type: String(node.state.type ?? "") } : null,
    project: node?.project?.id ? { id: String(node.project.id), name: String(node.project.name ?? "") } : null,
    teamKey: node?.team?.key ? String(node.team.key) : null,
    labels: (node?.labels?.nodes ?? []).map(l => String(l?.name ?? "")).filter(Boolean),
  })).filter(row => row.identifier);
  return {
    rows,
    done: page.pageInfo?.hasNextPage !== true,
    cursor: page.pageInfo?.endCursor ?? null,
    error: null,
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

/**
 * Fetches every active issue's delegate, labels and state.
 * `on`: the machine to run from (null: this one) -- the same machine selection
 * client.js already uses for a signed-in Linear.
 * Never throws: failures come back as { error }, and the caller keeps its last good read.
 */
export async function fetchEnrichment({ on = null, pages = 4, config = {} } = {}) {
  const rows = [];
  let auth;
  try { auth = normalizeConfig(config).enrichment; }
  catch (e) { return { rows, fetchedAt: null, partial: true, error: String(e?.message ?? e) }; }
  if (!auth.enabled) return { rows, fetchedAt: null, partial: false, error: null };
  let after = null;
  for (let page = 0; page < pages; page++) {
    let result;
    try {
      // The key names are positional arguments ("$@"); the key itself is never one.
      result = await exec("sh", ["-c", script(after), "sh", auth.envKey,
        auth.doppler?.project ?? "", auth.doppler?.config ?? "", ...(auth.doppler?.keyNames ?? [])], { on });
    } catch (e) {
      return { rows, fetchedAt: null, partial: true, error: String(e?.message ?? e) };
    }
    if (result.code !== 0) {
      const detail = String(result.stderr ?? "").trim().split("\n").pop() || `curl exit ${result.code}`;
      return { rows, fetchedAt: null, partial: true, error: detail };
    }
    const parsed = parseEnrichment(result.stdout);
    if (parsed.error) return { rows, fetchedAt: null, partial: true, error: parsed.error };
    rows.push(...parsed.rows);
    if (parsed.done) return { rows, fetchedAt: Date.now(), partial: false, error: null };
    after = parsed.cursor;
  }
  return { rows, fetchedAt: Date.now(), partial: true, error: null };
}

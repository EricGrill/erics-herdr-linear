// Credential-safe Linear transport, shared by the board and task client.
import { exec } from "herdr";
import { normalizeConfig } from "./config.js";

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
'*|*"$(printf '\r')"*) echo "Linear API key must not contain a newline" >&2; exit 5 ;;
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

function script(query, variables) {
  const body = JSON.stringify({ query, variables });
  // The heredoc is quoted, so the only thing that could break out is the delimiter itself.
  if (body.includes("HERDR_BOARD_QUERY")) throw new Error("query body collided with its heredoc delimiter");
  // Replacer functions, not strings: a "$&" or "$'" inside the JSON body would otherwise
  // be read as a replacement pattern and corrupt the query.
  return SCRIPT
    .replace("%BODY%", () => body);
}

/** One GraphQL request through the credential-safe shell. Never throws.
 *  Returns { text } on a completed HTTP exchange, or { error }. */
export async function request({ on = null, auth, query, variables }) {
  let result;
  try {
    // The key names are positional arguments ("$@"); the key itself is never one.
    result = await exec("sh", ["-c", script(query, variables), "sh", auth.envKey,
      auth.doppler?.project ?? "", auth.doppler?.config ?? "", ...(auth.doppler?.keyNames ?? [])], { on });
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  if (result.code !== 0) {
    return { unavailable: result.code === 4, error: String(result.stderr ?? "").trim().split("\n").pop() || `curl exit ${result.code}` };
  }
  return { text: result.stdout };
}

/** API keys stay inside the shell; only API responses cross into the view. */
export async function queryLinear({ config = {}, on = null, query, variables = {} }) {
  const auth = normalizeConfig(config).enrichment;
  const result = await request({ on, auth, query, variables });
  if (result.error) {
    const error = new Error(result.error);
    error.unavailable = result.unavailable === true;
    throw error;
  }
  let response;
  try { response = JSON.parse(result.text); }
  catch { throw new Error("Linear sent something that isn't JSON"); }
  if (response.errors?.length) throw new Error(String(response.errors[0].message ?? "Linear rejected the query"));
  if (!response.data) throw new Error("Linear returned no data");
  return response.data;
}

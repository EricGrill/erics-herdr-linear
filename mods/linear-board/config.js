// Machine-local preferences contain names and rules, never credential values.
export const DEFAULT_ATTENTION_LABELS = [
  "needs-human", "agent:review-needed", "agent:check-result", "agent:stalled", "reopened:not-done",
];
export const DEFAULT_ATTENTION_STATES = [
  "needs human", "in review", "blocked", "awaiting review", "ready for review",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function names(value, fallback, field) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some(x => typeof x !== "string" || !x.trim())) {
    throw new Error(`${field} must be an array of nonempty strings`);
  }
  return [...new Set(value.map(x => x.trim().toLowerCase()))];
}
function object(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

export function normalizeConfig(value = {}) {
  const input = object(value, "Layout config");
  const enrichment = object(input.enrichment, "enrichment");
  const attention = object(input.attention, "attention");
  if (enrichment.enabled !== undefined && typeof enrichment.enabled !== "boolean") throw new Error("enrichment.enabled must be boolean");
  const envKey = enrichment.envKey ?? "LINEAR_API_KEY";
  if (typeof envKey !== "string" || !ENV_NAME.test(envKey)) throw new Error("enrichment.envKey must be an environment variable name");
  let doppler = null;
  if (enrichment.doppler != null) {
    const supplied = object(enrichment.doppler, "enrichment.doppler");
    if (typeof supplied.project !== "string" || !supplied.project.trim()
      || typeof supplied.config !== "string" || !supplied.config.trim()) {
      throw new Error("Doppler requires nonempty project and config names");
    }
    const keyNames = supplied.keyNames ?? ["LINEAR_API_KEY"];
    if (!Array.isArray(keyNames) || !keyNames.length || keyNames.some(x => typeof x !== "string" || !ENV_NAME.test(x))) {
      throw new Error("Doppler keyNames must contain environment variable names");
    }
    doppler = { project: supplied.project, config: supplied.config, keyNames: [...new Set(keyNames)] };
  }
  return {
    enrichment: { enabled: enrichment.enabled ?? true, envKey, doppler },
    attention: {
      labels: names(attention.labels, DEFAULT_ATTENTION_LABELS, "attention.labels"),
      states: names(attention.states, DEFAULT_ATTENTION_STATES, "attention.states"),
    },
  };
}

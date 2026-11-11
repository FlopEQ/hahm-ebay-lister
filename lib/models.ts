// Exact server-owned lists prevent browser requests from choosing arbitrary billed models.
// Lists may be replaced with comma-separated provider-specific environment settings.
const DEFAULT_CLAUDE_MODELS = [
  "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5",
  "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5",
  "claude-haiku-4-5", "claude-haiku-4-5-20251001",
];
const DEFAULT_OPENAI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

export function allowedProviderModels(provider: "anthropic" | "openai"): string[] {
  const configured = provider === "openai"
    ? process.env.OPENAI_ALLOWED_MODELS : process.env.ANTHROPIC_ALLOWED_MODELS;
  const defaults = provider === "openai" ? DEFAULT_OPENAI_MODELS : DEFAULT_CLAUDE_MODELS;
  // Explicit server defaults remain usable, including custom OpenAI deployments.
  const trustedDefaults = provider === "openai"
    ? [process.env.OPENAI_SORT_MODEL || "gpt-5.6-luna", process.env.OPENAI_ANALYSIS_MODEL || "gpt-5.6-terra",
       process.env.OPENAI_ROUTER_MODEL, process.env.OPENAI_ASPECT_MODEL]
    : ["claude-sonnet-5-5"];
  const prefix = provider === "openai" ? "gpt-" : "claude-";
  return [...new Set([...(configured === undefined ? defaults : configured.split(",")),
    ...trustedDefaults].filter((id): id is string => typeof id === "string")
    .map(id => id.trim()).filter(id => id.startsWith(prefix) && id.length <= 64))];
}

const MAX_MODEL_ID_LEN = 64;

function isValidModelString(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && model.length <= MAX_MODEL_ID_LEN;
}

/** True when `model` is a non-empty string this deployment is allowed to call. */
export function isAllowedModel(model: unknown): model is string {
  return isAllowedProviderModel(model, "anthropic") || isAllowedProviderModel(model, "openai");
}

export function isAllowedProviderModel(
  model: unknown,
  provider: "anthropic" | "openai"
): model is string {
  if (!isValidModelString(model)) return false;
  return allowedProviderModels(provider).includes(model);
}

/**
 * Return the requested model only when it passes the allowlist; otherwise the
 * trusted fallback. Trims surrounding whitespace before checking. Use this in any
 * route that accepts a client-supplied model id.
 */
export function resolveModel(requested: unknown, fallback: string): string {
  const m = typeof requested === "string" ? requested.trim() : "";
  return isAllowedModel(m) ? m : fallback;
}

export function resolveProviderModel(
  requested: unknown,
  fallback: string,
  provider: "anthropic" | "openai"
): string {
  const m = typeof requested === "string" ? requested.trim() : "";
  return isAllowedProviderModel(m, provider) ? m : fallback;
}

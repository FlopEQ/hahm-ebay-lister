// Server-side allowlist for the user-selectable AI models.
//
// The per-step model selector lets the browser send a model id to the AI routes.
// That value is untrusted: without validation, anyone past the access gate could
// bill an arbitrary or premium model to the deployment owner's key. We accept
// only the known Claude families and OpenAI GPT model ids this app supports and
// intentionally EXCLUDE Anthropic's premium "fable" tier.
// To offer a different set (e.g. a key that does have fable access), edit this
// pattern.
const ALLOWED_CLAUDE_MODEL_PATTERN = /^claude-(opus|sonnet|haiku)-/;
const ALLOWED_OPENAI_MODEL_PATTERN = /^gpt-[a-z0-9][a-z0-9.-]*$/i;
const MAX_MODEL_ID_LEN = 64;

function isValidModelString(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && model.length <= MAX_MODEL_ID_LEN;
}

/** True when `model` is a non-empty string this deployment is allowed to call. */
export function isAllowedModel(model: unknown): model is string {
  return (
    isValidModelString(model) &&
    (ALLOWED_CLAUDE_MODEL_PATTERN.test(model) || ALLOWED_OPENAI_MODEL_PATTERN.test(model))
  );
}

export function isAllowedProviderModel(
  model: unknown,
  provider: "anthropic" | "openai"
): model is string {
  if (!isValidModelString(model)) return false;
  return provider === "openai"
    ? ALLOWED_OPENAI_MODEL_PATTERN.test(model)
    : ALLOWED_CLAUDE_MODEL_PATTERN.test(model);
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

import type Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_SORT_MODEL = "claude-sonnet-5-5";
export const CLAUDE_ANALYSIS_MODEL = "claude-sonnet-5-5";
export const CLAUDE_ROUTER_MODEL = "claude-sonnet-5-5";
export const CLAUDE_ASPECT_MODEL = "claude-sonnet-5-5";

export type ClaudeTask = "sort" | "classify" | "listing" | "specifics";

export function claudeCostSettings(model: string, task: ClaudeTask, maxTokens: number):
  Partial<Anthropic.MessageCreateParamsNonStreaming> {
  const effort = task === "listing" || task === "specifics" ? "medium" : "low";
  if (/^claude-sonnet-5-5(?:-|$)/.test(model)) {
    // Sonnet 5.5 otherwise enables billed up-front thinking by default. Our
    // single-turn extraction requests have no tools and need only JSON output.
    return { thinking: { type: "between_tools" }, output_config: { effort } };
  }
  if (/^claude-(?:opus|haiku)-5-5(?:-|$)/.test(model)) {
    // Explicit premium/experimental selections can think. Leave enough room
    // for both thinking and JSON; no automatic switch to these models occurs.
    return { output_config: { effort }, max_tokens: Math.max(maxTokens, task === "listing" ? 6000 : 2000) };
  }
  return {};
}

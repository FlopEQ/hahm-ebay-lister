// Adapted from upstream lib/ai-usage.ts: request-local measurement, extended
// for current prices, unknown costs, response errors, and browser summaries.
import { AsyncLocalStorage } from "node:async_hooks";
import type Anthropic from "@anthropic-ai/sdk";
import type { AiUsageSummary } from "@/lib/types";
import { emptyAiUsage, mergeAiUsage } from "@/lib/ai-usage";
import { claudeCostSettings, type ClaudeTask } from "@/lib/claude-models";

const scope = new AsyncLocalStorage<AiUsageSummary[]>();
export const AI_PRICING_AS_OF = "2026-10-08";

export class AiOutputError extends Error {}
export class AiConfigurationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type TokenUsage = {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
};

export function usageFromMessage(model: string, u?: TokenUsage): AiUsageSummary {
  const reported = Boolean(u && [u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0, u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    u.cache_creation?.ephemeral_5m_input_tokens ?? 0].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0));
  const input = reported ? u!.input_tokens : 0;
  const output = reported ? u!.output_tokens : 0;
  const reads = reported ? u!.cache_read_input_tokens || 0 : 0;
  const writes = reported ? u!.cache_creation_input_tokens || 0 : 0;
  let rate: [number, number, number, number, number] | undefined;
  // Standard global USD rates per million tokens, not invoice totals. Date
  // suffixed snapshots share their model line's price. Unknown models stay null.
  if (/^claude-sonnet-5-5(?:-\d{8})?$/.test(model)) rate = [2, 10, 2.5, 4, 0.1];
  else if (/^claude-opus-5-5(?:-\d{8})?$/.test(model)) rate = [4, 20, 5, 8, 0.2];
  else if (/^claude-haiku-5-5(?:-\d{8})?$/.test(model)) rate = input + reads + writes > 100_000
    ? [0.5, 2.5, 0.625, 1, 0.05] : [0.1, 0.5, 0.125, 0.2, 0.01];
  else if (/^claude-sonnet-5(?:-\d{8})?$/.test(model)) rate = [2, 10, 2.5, 4, 0.2];
  else if (/^claude-sonnet-4-[56](?:-\d{8})?$/.test(model)) rate = [3, 15, 3.75, 6, 0.3];
  else if (/^claude-opus-(?:4-[5678]|5)(?:-\d{8})?$/.test(model)) rate = [5, 25, 6.25, 10, 0.5];
  else if (/^claude-haiku-4-5(?:-\d{8})?$/.test(model)) rate = [1, 5, 1.25, 2, 0.1];
  const oneHour = u?.cache_creation?.ephemeral_1h_input_tokens || 0;
  const fiveMinute = u?.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, writes - oneHour);
  return {
    calls: 1, inputTokens: input + reads + writes, outputTokens: output,
    cacheReadTokens: reads, cacheWriteTokens: writes, models: [model], unreportedCalls: reported ? 0 : 1,
    estimatedCostUsd: reported && rate
      ? (input * rate[0] + output * rate[1] + fiveMinute * rate[2] + oneHour * rate[3] + reads * rate[4]) / 1e6 : null,
  };
}

export async function withAiUsageResponse(fn: () => Promise<Response>): Promise<Response> {
  const rows: AiUsageSummary[] = [];
  return scope.run(rows, async () => {
    const response = await fn();
    const usage = rows.reduce((total, row) => mergeAiUsage(total, row)!, emptyAiUsage());
    const body = await response.json();
    return Response.json({ ...body, usage }, { status: response.status, headers: response.headers });
  });
}

export async function measuredMessage(task: ClaudeTask, client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Parameters<Anthropic["messages"]["create"]>[1]): Promise<Anthropic.Message> {
  // Register before awaiting, so a bounded route that returns during a stalled
  // call can still report an unconfirmed cost rather than a misleading zero.
  const rows = scope.getStore();
  const row = usageFromMessage(params.model);
  rows?.push(row);
  try {
    const response = await client.messages.create({ ...params,
      ...claudeCostSettings(params.model, task, params.max_tokens) }, options);
    Object.assign(row, usageFromMessage(response.model || params.model, response.usage));
    if (response.stop_reason === "max_tokens") throw new AiOutputError("The AI response reached its output limit. Review this item before retrying.");
    if (response.stop_reason === "refusal") throw new AiOutputError("The AI could not analyze this item. Review the photos or choose another model.");
    return response;
  } catch (e) {
    const status = e && typeof e === "object" && "status" in e ? Number(e.status) : undefined;
    if (status === 400 || status === 404)
      throw new AiConfigurationError(`The selected AI model (${params.model}) is unavailable or rejected its settings. Choose another model in Model Settings.`, status);
    throw e;
  }
}

// OpenAI is preserved as an optional provider. We record returned tokens but
// do not invent prices for its user-configurable model IDs.
export async function measuredOpenAI<T extends { model: string; usage?: { prompt_tokens: number; completion_tokens: number } | null }>(
  model: string, fn: () => Promise<T>): Promise<T> {
  const row = usageFromMessage(model);
  scope.getStore()?.push(row);
  const response = await fn();
  const u = response.usage;
  Object.assign(row, usageFromMessage(response.model || model, u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : undefined));
  return response;
}

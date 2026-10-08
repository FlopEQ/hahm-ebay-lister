import type { AiUsageSummary } from "@/lib/types";

export const emptyAiUsage = (): AiUsageSummary => ({ calls: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, models: [], unreportedCalls: 0 });

// Shared with the browser. Unknown pricing/usage must remain unknown when
// merging it with known costs, rather than understating the batch estimate.
export function mergeAiUsage(a?: AiUsageSummary, b?: AiUsageSummary): AiUsageSummary | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd === null || b.estimatedCostUsd === null
      ? null : a.estimatedCostUsd + b.estimatedCostUsd,
    models: [...new Set([...a.models, ...b.models])],
    unreportedCalls: a.unreportedCalls + b.unreportedCalls,
  };
}

export function normalizeAiUsage(raw: unknown): AiUsageSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as AiUsageSummary;
  if (![u.calls, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.unreportedCalls]
    .every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
    !(u.estimatedCostUsd === null || (typeof u.estimatedCostUsd === "number" && Number.isFinite(u.estimatedCostUsd) && u.estimatedCostUsd >= 0)) ||
    !Array.isArray(u.models) || u.models.length > 100 || u.models.some(m => typeof m !== "string" || m.length > 128)) return undefined;
  return { ...u, models: [...new Set(u.models)] };
}

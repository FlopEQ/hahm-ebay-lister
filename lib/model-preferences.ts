"use client";
import type { AiUsageSummary } from "@/lib/types";
import { mergeAiUsage } from "@/lib/ai-usage";

export function addAiUsage(previous: AiUsageSummary | undefined, next: AiUsageSummary): AiUsageSummary {
  return mergeAiUsage(previous, next)!;
}

export const unreportedAiUsage = (): AiUsageSummary => ({ calls: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: null, models: [], unreportedCalls: 1 });

export function formatAiCost(usage: AiUsageSummary | undefined): string {
  if (!usage) return "Not tracked";
  if (usage.estimatedCostUsd === null || !Number.isFinite(usage.estimatedCostUsd)) return "Unavailable";
  if (usage.estimatedCostUsd > 0 && usage.estimatedCostUsd < 0.001) return "<$0.001";
  return `$${usage.estimatedCostUsd.toFixed(3)}`;
}

const SORT_KEY     = "listing-writer:sort-model";
const ANALYSIS_KEY = "listing-writer:analysis-model";

export function getSortModel(): string | null {
  try {
    return window.localStorage.getItem(SORT_KEY);
  } catch {
    return null;
  }
}

export function saveSortModel(model: string): void {
  try {
    if (model) window.localStorage.setItem(SORT_KEY, model);
    else window.localStorage.removeItem(SORT_KEY);
  } catch {
    /* private browsing — pref won't persist */
  }
}

export function getAnalysisModel(): string | null {
  try {
    return window.localStorage.getItem(ANALYSIS_KEY);
  } catch {
    return null;
  }
}

export function saveAnalysisModel(model: string): void {
  try {
    if (model) window.localStorage.setItem(ANALYSIS_KEY, model);
    else window.localStorage.removeItem(ANALYSIS_KEY);
  } catch {
    /* private browsing — pref won't persist */
  }
}

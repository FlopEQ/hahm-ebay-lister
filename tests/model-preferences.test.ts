import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAiUsage, formatAiCost, getAnalysisModel, getSortModel, saveAnalysisModel, saveSortModel, unreportedAiUsage } from "@/lib/model-preferences";
import type { AiUsageSummary } from "@/lib/types";
beforeEach(() => {
  const values = new Map<string,string>();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) } });
});
afterEach(() => vi.unstubAllGlobals());
const usage = (cost: number | null): AiUsageSummary => ({ calls: 1, inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 10, cacheWriteTokens: 5, estimatedCostUsd: cost, models: ["claude"], unreportedCalls: 0 });
describe("AI cost and model preferences", () => {
  it("retains explicit model choices until the user selects recommended defaults", () => {
    saveSortModel("saved-sort"); saveAnalysisModel("saved-analysis");
    expect(getSortModel()).toBe("saved-sort"); expect(getAnalysisModel()).toBe("saved-analysis");
    saveSortModel(""); saveAnalysisModel("");
    expect(getSortModel()).toBeNull(); expect(getAnalysisModel()).toBeNull();
  });
  it("adds costs and token counts across multiple paid attempts", () => {
    expect(addAiUsage(usage(0.01), usage(0.03))).toMatchObject({ calls: 2, inputTokens: 200,
      outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 10, estimatedCostUsd: 0.04, models: ["claude"] });
  });
  it("keeps the total unavailable after any unreported attempt", () => {
    const total = addAiUsage(usage(0.01),unreportedAiUsage());
    expect(total.estimatedCostUsd).toBeNull(); expect(total.unreportedCalls).toBe(1);
    expect(formatAiCost(total)).toBe("Unavailable");
  });
  it("distinguishes missing estimates and tiny actual estimates from zero", () => {
    expect(formatAiCost(undefined)).toBe("Not tracked");
    expect(formatAiCost(usage(null))).toBe("Unavailable");
    expect(formatAiCost(usage(0.00001))).toBe("<$0.001");
    expect(formatAiCost(usage(0))).toBe("$0.000");
  });
});

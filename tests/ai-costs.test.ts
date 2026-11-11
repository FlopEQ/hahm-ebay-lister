import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AiConfigurationError, AiOutputError, measuredMessage, usageFromMessage, withAiUsageResponse } from "@/lib/ai-meter";
import { claudeCostSettings } from "@/lib/claude-models";
import { parseModelJson } from "@/lib/anthropic";
import { mergeAiUsage } from "@/lib/ai-usage";
import { sortPhotos, SortUnavailableError } from "@/lib/sortPipeline";

const model = "claude-sonnet-5-5";
const params = { model, max_tokens: 300, messages: [{ role: "user", content: "Extract JSON" }] } as Anthropic.MessageCreateParamsNonStreaming;
function message(text = "{}", overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return { model, content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides } as Anthropic.Message;
}
function client(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("Claude cost settings", () => {
  it.each(["sort", "classify", "listing", "specifics"] as const)("uses explicit Sonnet 5.5 settings for %s", (task) => {
    expect(claudeCostSettings(model, task, 300)).toEqual({ thinking: { type: "between_tools" },
      output_config: { effort: ["listing", "specifics"].includes(task) ? "medium" : "low" } });
  });
  it("preserves older Opus and Sonnet selections", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-5"])
      expect(claudeCostSettings(id, "listing", 3000)).toEqual({});
  });
  it("supports explicit Opus 5.5 with room for thinking, preserving larger budgets", () => {
    expect(claudeCostSettings("claude-opus-5-5", "listing", 3000)).toEqual({ output_config: { effort: "medium" }, max_tokens: 6000 });
    expect(claudeCostSettings("claude-opus-5-5", "classify", 300)).toEqual({ output_config: { effort: "low" }, max_tokens: 2000 });
    expect(claudeCostSettings("claude-opus-5-5", "listing", 10000).max_tokens).toBe(10000);
  });
});

describe("token and cache cost accounting", () => {
  it("charges cache writes once and separates the one-hour rate", () => {
    const usage = usageFromMessage(model, { input_tokens: 1000, output_tokens: 200,
      cache_read_input_tokens: 5000, cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } });
    expect(usage.inputTokens).toBe(9000);
    expect(usage.cacheWriteTokens).toBe(3000);
    expect(usage.cacheReadTokens).toBe(5000);
    expect(usage.estimatedCostUsd).toBeCloseTo((2000 + 2000 + 500 + 2500 + 8000) / 1e6, 12);
    expect(usage.unreportedCalls).toBe(0);
  });
  it("uses five-minute rates when cache lifetime breakdown is absent", () => {
    expect(usageFromMessage(model, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }).estimatedCostUsd).toBe(0.0025);
  });
  it("supports priced dated snapshots and one-hour-only cache breakdowns", () => {
    expect(usageFromMessage("claude-sonnet-5-5-20261001", { input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }).estimatedCostUsd).toBe(0.004);
  });
  it("switches Haiku rates strictly above 100k total prompt tokens including cache", () => {
    const base = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 99000 };
    expect(usageFromMessage("claude-haiku-5-5", base).estimatedCostUsd).toBeCloseTo((100 + 50 + 990) / 1e6, 12);
    expect(usageFromMessage("claude-haiku-5-5", { ...base, cache_creation_input_tokens: 1 }).estimatedCostUsd)
      .toBeCloseTo((500 + 250 + 4950 + 0.625) / 1e6, 12);
  });
  it("keeps unknown-model costs and missing usage unknown", () => {
    expect(usageFromMessage("claude-sonnet-future", { input_tokens: 100, output_tokens: 20 }))
      .toMatchObject({ inputTokens: 100, outputTokens: 20, estimatedCostUsd: null, unreportedCalls: 0 });
    expect(usageFromMessage(model)).toMatchObject({ estimatedCostUsd: null, unreportedCalls: 1 });
    expect(usageFromMessage(model, { input_tokens: NaN, output_tokens: 20 }).estimatedCostUsd).toBeNull();
  });
  it.each([-1, NaN, Infinity])("treats invalid cache token count %s as unreported", (cacheRead) => {
    expect(usageFromMessage(model, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: cacheRead }))
      .toMatchObject({ estimatedCostUsd: null, unreportedCalls: 1 });
  });
  it("prices the actual returned model rather than the requested alias", async () => {
    const response = await withAiUsageResponse(async () => {
      await measuredMessage("listing", client(vi.fn().mockResolvedValue(message("{}", { model: "claude-opus-5-5" }))), params);
      return Response.json({ ok: true });
    });
    expect((await response.json()).usage).toMatchObject({ models: ["claude-opus-5-5"], estimatedCostUsd: 0.0008 });
  });
});

describe("request-local paid attempts", () => {
  it("reports known zero usage when a route completes without calling a model", async () => {
    const response = await withAiUsageResponse(async () => Response.json({ ok: true }, { status: 200 }));
    const zero = (await response.json()).usage;
    expect(zero).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, models: [], unreportedCalls: 0 });
    const paid = usageFromMessage(model, { input_tokens: 100, output_tokens: 20 });
    expect(mergeAiUsage(paid, zero)).toEqual(paid);
  });
  it("counts malformed JSON responses and the successful retry", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("not JSON")).mockResolvedValueOnce(message('{"ok":true}'));
    const response = await withAiUsageResponse(async () => {
      let result;
      for (let i = 0; i < 2; i++) {
        const resp = await measuredMessage("listing", client(create), params);
        try { result = parseModelJson((resp.content[0] as Anthropic.TextBlock).text); break; } catch { /* same-model retry */ }
      }
      return Response.json({ result });
    });
    expect((await response.json()).usage).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40, estimatedCostUsd: 0.0008 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(([request]) => request.model === model)).toBe(true);
  });
  it("isolates overlapping requests even when their responses finish out of order", async () => {
    let release!: (value: Anthropic.Message) => void;
    const slow = new Promise<Anthropic.Message>(resolve => { release = resolve; });
    const first = withAiUsageResponse(async () => {
      await measuredMessage("sort", client(vi.fn().mockReturnValue(slow)), params);
      return Response.json({ item: "first" });
    });
    const second = await withAiUsageResponse(async () => {
      await measuredMessage("listing", client(vi.fn().mockResolvedValue(message("{}", { usage: { input_tokens: 900, output_tokens: 50 } as Anthropic.Usage }))), params);
      return Response.json({ item: "second" });
    });
    release(message());
    expect((await (await first).json()).usage).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
    expect((await second.json()).usage).toMatchObject({ calls: 1, inputTokens: 900, outputTokens: 50 });
  });
  it("returns unknown cost for a failed call and retains the route HTTP status", async () => {
    const response = await withAiUsageResponse(async () => {
      try { await measuredMessage("sort", client(vi.fn().mockRejectedValue(new Error("timeout"))), params); }
      catch { return Response.json({ ok: false, error: "timeout" }, { status: 503, headers: { "x-test": "preserved" } }); }
      throw new Error("Expected timeout");
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-test")).toBe("preserved");
    expect((await response.json()).usage).toMatchObject({ calls: 1, unreportedCalls: 1, estimatedCostUsd: null });
  });
  it("does not understate cost when a confirmed call is followed by an unreported failure", async () => {
    const create = vi.fn().mockResolvedValueOnce(message()).mockRejectedValueOnce(new Error("lost response"));
    const response = await withAiUsageResponse(async () => {
      await measuredMessage("sort", client(create), params);
      try { await measuredMessage("sort", client(create), params); } catch { /* partial result */ }
      return Response.json({ ok: true });
    });
    expect((await response.json()).usage).toMatchObject({ calls: 2, inputTokens: 100, outputTokens: 20,
      unreportedCalls: 1, estimatedCostUsd: null });
  });
  it("reports a still-pending call as unconfirmed when the route returns early", async () => {
    let release!: (value: Anthropic.Message) => void;
    let pending!: Promise<Anthropic.Message>;
    const response = await withAiUsageResponse(async () => {
      pending = measuredMessage("sort", client(vi.fn().mockReturnValue(new Promise<Anthropic.Message>(resolve => { release = resolve; }))), params);
      return Response.json({ ok: false }, { status: 504 });
    });
    expect(response.status).toBe(504);
    expect((await response.json()).usage).toMatchObject({ calls: 1, unreportedCalls: 1, estimatedCostUsd: null });
    release(message());
    await pending;
  });
  it("retains paid usage when the output is truncated", async () => {
    const response = await withAiUsageResponse(async () => {
      await expect(measuredMessage("listing", client(vi.fn().mockResolvedValue(message("partial", { stop_reason: "max_tokens" }))), params))
        .rejects.toBeInstanceOf(AiOutputError);
      return Response.json({ ok: false }, { status: 422 });
    });
    expect((await response.json()).usage).toMatchObject({ calls: 1, unreportedCalls: 0, estimatedCostUsd: 0.0004 });
  });
  it.each([400, 404])("surfaces model configuration errors with their original status %s", async (status) => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("bad settings"), { status }));
    const response = await withAiUsageResponse(async () => {
      try { await measuredMessage("classify", client(create), params); }
      catch (error) {
        expect(error).toBeInstanceOf(AiConfigurationError);
        expect((error as AiConfigurationError).status).toBe(status);
        return Response.json({ ok: false }, { status: (error as AiConfigurationError).status });
      }
      throw new Error("Expected configuration error");
    });
    expect(response.status).toBe(status);
    expect((await response.json()).usage).toMatchObject({ calls: 1, unreportedCalls: 1, estimatedCostUsd: null });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("surfaces model configuration error types", async () => {
    await expect(measuredMessage("classify", client(vi.fn().mockRejectedValue(Object.assign(new Error("bad settings"), { status: 400 }))), params))
      .rejects.toBeInstanceOf(AiConfigurationError);
  });
  it("does not repeat a truncated grouping call", async () => {
    const create = vi.fn().mockResolvedValue(message("partial", { stop_reason: "max_tokens" }));
    await expect(sortPhotos(client(create), [{ mediaType: "image/jpeg", data: "aGVsbG8=" }])).rejects.toBeInstanceOf(SortUnavailableError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

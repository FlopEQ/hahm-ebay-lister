import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { create, list, provider } = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), provider: { value: "anthropic" } }));
vi.mock("@/lib/aiProvider", () => ({ aiProvider: () => provider.value,
  getAiClient: () => ({ messages: { create } }) }));
vi.mock("@/lib/anthropic", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/anthropic")>()),
  getClient: () => ({ models: { list } }),
}));
vi.mock("@/lib/api-guard", () => ({ guardApiRequest: () => undefined,
  safeErrorResponse: (_name: string, error: Error) => Response.json({ ok: false, error: error.message }, { status: 500 }) }));

const listing = { title: "Vintage ceramic blue vase", description: "Blue ceramic vase shown in the photos.",
  suggested_price: 10, category: "home", item_specifics: {} };
function message(value: unknown, stop_reason = "end_turn") {
  return { model: "claude-sonnet-5-5", stop_reason, content: [{ type: "text", text: JSON.stringify(value) }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
function request(profile = "hard_goods", analysisModel?: string) {
  return new NextRequest("http://localhost/api/analyze", { method: "POST", body: JSON.stringify({
    profile, analysisModel, images: [{ mediaType: "image/jpeg", data: "aGVsbG8=" }] }) });
}
beforeEach(() => { vi.resetModules(); create.mockReset(); list.mockReset(); provider.value = "anthropic"; });

describe("balanced analysis route", () => {
  it("uses balanced settings for both automatic classification and actual listing generation", async () => {
    create.mockResolvedValueOnce(message({ profile: "hard_goods" })).mockResolvedValueOnce(message(listing));
    const { POST } = await import("@/app/api/analyze/route");
    const response = await POST(request("auto"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.usage).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40, estimatedCostUsd: 0.0008 });
    expect(create.mock.calls.map(([params]) => ({ model: params.model, thinking: params.thinking, effort: params.output_config.effort })))
      .toEqual([{ model: "claude-sonnet-5-5", thinking: { type: "between_tools" }, effort: "low" },
        { model: "claude-sonnet-5-5", thinking: { type: "between_tools" }, effort: "medium" }]);
  });
  it("surfaces a classifier configuration error instead of silently writing the wrong item profile", async () => {
    create.mockRejectedValue(Object.assign(new Error("invalid model"), { status: 404 }));
    const { POST } = await import("@/app/api/analyze/route");
    const response = await POST(request("auto"));
    expect(response.status).toBe(404);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await response.json()).usage).toMatchObject({ unreportedCalls: 1, estimatedCostUsd: null });
  });
  it("returns paid usage on truncated listings without another billable attempt", async () => {
    create.mockResolvedValue(message(listing, "max_tokens"));
    const { POST } = await import("@/app/api/analyze/route");
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await response.json()).usage).toMatchObject({ calls: 1, estimatedCostUsd: 0.0004 });
  });
  it("honors an explicit premium choice without changing the classifier default", async () => {
    create.mockResolvedValueOnce(message({ profile: "hard_goods" })).mockResolvedValueOnce({ ...message(listing), model: "claude-opus-5-5" });
    const { POST } = await import("@/app/api/analyze/route");
    expect((await POST(request("auto", "claude-opus-5-5"))).status).toBe(200);
    expect(create.mock.calls[0][0].model).toBe("claude-sonnet-5-5");
    expect(create.mock.calls[1][0]).toMatchObject({ model: "claude-opus-5-5", max_tokens: 6000, output_config: { effort: "medium" } });
  });
});

describe("model catalog", () => {
  it("keeps provider catalogs separate with exactly one default per task", async () => {
    provider.value = "openai";
    const { GET } = await import("@/app/api/models/route");
    const data = await (await GET()).json();
    for (const models of [data.sortModels, data.analysisModels]) {
      expect(models.every((m: { id: string }) => m.id.startsWith("gpt-"))).toBe(true);
      expect(models.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
    }
    expect(list).not.toHaveBeenCalled();
  });
  it("offers the balanced default when the live catalog is unavailable", async () => {
    list.mockImplementation(() => { throw new Error("catalog timeout"); });
    const { GET } = await import("@/app/api/models/route");
    const data = await (await GET()).json();
    for (const models of [data.sortModels, data.analysisModels]) {
      expect(models.find((m: { isDefault: boolean }) => m.isDefault).id).toBe("claude-sonnet-5-5");
    }
  });
  it("reads models beyond the first page and keeps the balanced default", async () => {
    list.mockImplementation(() => (async function* () {
      yield { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" };
      yield { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" };
    })());
    const { GET } = await import("@/app/api/models/route");
    const data = await (await GET()).json();
    expect(data.analysisModels.find((m: { isDefault: boolean }) => m.isDefault).id).toBe("claude-sonnet-5-5");
    expect(list).toHaveBeenCalledWith({ limit: 100 }, { timeout: 10000, maxRetries: 0 });
  });
  it("never replaces a missing recommended model with a premium default", async () => {
    list.mockImplementation(() => (async function* () { yield { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }; })());
    const { GET } = await import("@/app/api/models/route");
    const data = await (await GET()).json();
    expect(data.sortModels.find((m: { isDefault: boolean }) => m.isDefault).id).toBe("claude-sonnet-5-5");
    expect(data.analysisModels.find((m: { isDefault: boolean }) => m.isDefault).id).toBe("claude-sonnet-5-5");
  });
});

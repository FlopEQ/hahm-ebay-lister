import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedProviderModel, resolveProviderModel } from "@/lib/models";

afterEach(() => vi.unstubAllEnvs());
describe("exact provider model allowlists", () => {
  it("rejects unknown family members and cross-provider choices", () => {
    expect(isAllowedProviderModel("claude-opus-unapproved", "anthropic")).toBe(false);
    expect(isAllowedProviderModel("gpt-unapproved", "openai")).toBe(false);
    expect(isAllowedProviderModel("gpt-5.6-sol", "anthropic")).toBe(false);
    expect(isAllowedProviderModel("claude-sonnet-5-5", "openai")).toBe(false);
    expect(resolveProviderModel("gpt-unapproved", "gpt-5.6-terra", "openai")).toBe("gpt-5.6-terra");
  });
  it("uses exact configured IDs and retains trusted server defaults", () => {
    vi.stubEnv("ANTHROPIC_ALLOWED_MODELS", " claude-custom-snapshot ,gpt-5.6-sol");
    vi.stubEnv("OPENAI_ALLOWED_MODELS", "gpt-custom-snapshot");
    vi.stubEnv("OPENAI_SORT_MODEL", "gpt-server-default");
    expect(isAllowedProviderModel("claude-custom-snapshot", "anthropic")).toBe(true);
    expect(isAllowedProviderModel("claude-custom-snapshot-extra", "anthropic")).toBe(false);
    expect(isAllowedProviderModel("claude-opus-5-5", "anthropic")).toBe(false);
    expect(isAllowedProviderModel("claude-sonnet-5-5", "anthropic")).toBe(true);
    expect(isAllowedProviderModel("gpt-custom-snapshot", "openai")).toBe(true);
    expect(isAllowedProviderModel("gpt-server-default", "openai")).toBe(true);
    expect(isAllowedProviderModel("gpt-5.6-sol", "openai")).toBe(false);
  });
});

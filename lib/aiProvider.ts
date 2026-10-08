import { getClient } from "@/lib/anthropic";
import { getOpenAIClient } from "@/lib/openai";

export type AiProvider = "anthropic" | "openai";

export function aiProvider(): AiProvider {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "openai"
    ? "openai"
    : "anthropic";
}

export function getAiClient(provider: AiProvider = aiProvider()) {
  return provider === "openai" ? getOpenAIClient() : getClient();
}

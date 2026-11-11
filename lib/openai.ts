import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { parseModelJson } from "@/lib/anthropic";
import { measuredOpenAI } from "@/lib/ai-meter";

let client: OpenAI | null = null;

export const OPENAI_SORT_MODEL = process.env.OPENAI_SORT_MODEL || "gpt-5.6-luna";
export const OPENAI_ANALYSIS_MODEL = process.env.OPENAI_ANALYSIS_MODEL || "gpt-5.6-terra";
export const OPENAI_ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || OPENAI_SORT_MODEL;
export const OPENAI_ASPECT_MODEL = process.env.OPENAI_ASPECT_MODEL || OPENAI_ANALYSIS_MODEL;

export function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env.local on this computer, then restart the app."
    );
  }
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

export class OpenAIAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAIAuthError";
    this.status = status;
  }
}

export function openAIAuthError(e: unknown): OpenAIAuthError | null {
  const status =
    e && typeof e === "object" && "status" in e
      ? Number((e as { status?: number }).status)
      : undefined;
  const message =
    e && typeof e === "object" && "message" in e
      ? String((e as { message?: unknown }).message ?? "")
      : "";

  if (status === 401) {
    return new OpenAIAuthError(
      "OpenAI rejected your API key (401). Check that OPENAI_API_KEY is set correctly in .env.local.",
      401
    );
  }
  if (status === 403) {
    return new OpenAIAuthError(
      "Your OpenAI API key is not permitted to use this model (403). Try a different OpenAI model or check model access.",
      403
    );
  }
  if (status === 402 || /billing|payment|insufficient|quota|credit balance|limit/i.test(message)) {
    return new OpenAIAuthError(
      "Your OpenAI account cannot cover this request. Check billing, credits, or usage limits in the OpenAI dashboard.",
      402
    );
  }
  return null;
}

export type OpenAIJsonOptions = {
  client: OpenAI;
  model: string;
  content: ChatCompletionContentPart[];
  maxTokens: number;
  system?: string;
  timeout?: number;
  maxRetries?: number;
};

export async function openAIJson<T>({
  client,
  model,
  content,
  maxTokens,
  system,
  timeout,
  maxRetries = 0,
}: OpenAIJsonOptions): Promise<T> {
  const resp = await measuredOpenAI(model, () => client.chat.completions.create(
    {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content },
      ],
    },
    { timeout, maxRetries }
  ));
  const text = resp.choices[0]?.message?.content ?? "";
  return parseModelJson<T>(text);
}

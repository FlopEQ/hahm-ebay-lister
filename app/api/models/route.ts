import { NextResponse } from "next/server";
import { getClient } from "@/lib/anthropic";
import { aiProvider } from "@/lib/aiProvider";
import {
  OPENAI_ANALYSIS_MODEL,
  OPENAI_ROUTER_MODEL,
  OPENAI_SORT_MODEL,
} from "@/lib/openai";
import { isAllowedModel } from "@/lib/models";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models.js";
import { CLAUDE_ANALYSIS_MODEL, CLAUDE_SORT_MODEL } from "@/lib/claude-models";

// Keep Haiku as an optional sorting experiment until tested on seller photos.
const ANALYSIS_EXCLUDED = /^claude-haiku/;

const DESCRIPTIONS: Record<string, string> = {
  "claude-sonnet-5-5": "Recommended balance for sorting and listings. $2 input / $10 output per million tokens.",
  "claude-opus-5-5": "Premium option for difficult items. $4 input / $20 output per million tokens.",
  "claude-haiku-5-5": "Experimental economy sorting option. From $0.10 input / $0.50 output per million tokens; compare accuracy on your photos.",
  "claude-opus-4-8":   "Older premium model. $5 input / $25 output per million tokens.",
  "claude-opus-4-7":   "High quality with strong reasoning. Good all-around choice.",
  "claude-opus-4-6":   "Solid quality and great value.",
  "claude-sonnet-4-6": "Fast and capable. Great for sorting; works well for most listings.",
  "claude-haiku-4-5":  "Fastest and most affordable. Best for photo sorting only.",
};

const SORT_DEFAULT     = CLAUDE_SORT_MODEL;
const ANALYSIS_DEFAULT = CLAUDE_ANALYSIS_MODEL;

export interface ModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

interface ModelsPayload {
  sortModels: ModelOption[];
  analysisModels: ModelOption[];
}

const OPENAI_DESCRIPTIONS: Record<string, string> = {
  "gpt-5.6-sol": "Highest quality OpenAI option. Best for unusual or complex items.",
  "gpt-5.6-terra": "Balanced quality and cost. Recommended for writing listings.",
  "gpt-5.6-luna": "Lowest cost OpenAI option. Best for sorting and high-volume batches.",
};

const OPENAI_FALLBACK: ModelsPayload = {
  sortModels: [
    {
      id: OPENAI_SORT_MODEL,
      displayName: displayOpenAIModel(OPENAI_SORT_MODEL),
      description: OPENAI_DESCRIPTIONS[OPENAI_SORT_MODEL] ?? "OpenAI model.",
      isDefault: true,
    },
    ...["gpt-5.6-terra", "gpt-5.6-sol"]
      .filter((id) => id !== OPENAI_SORT_MODEL)
      .map((id) => ({
        id,
        displayName: displayOpenAIModel(id),
        description: OPENAI_DESCRIPTIONS[id] ?? "OpenAI model.",
        isDefault: false,
      })),
  ],
  analysisModels: [
    {
      id: OPENAI_ANALYSIS_MODEL,
      displayName: displayOpenAIModel(OPENAI_ANALYSIS_MODEL),
      description: OPENAI_DESCRIPTIONS[OPENAI_ANALYSIS_MODEL] ?? "OpenAI model.",
      isDefault: true,
    },
    ...["gpt-5.6-sol", "gpt-5.6-luna", OPENAI_ROUTER_MODEL]
      .filter((id, index, arr) => id !== OPENAI_ANALYSIS_MODEL && arr.indexOf(id) === index)
      .map((id) => ({
        id,
        displayName: displayOpenAIModel(id),
        description: OPENAI_DESCRIPTIONS[id] ?? "OpenAI model.",
        isDefault: false,
      })),
  ],
};

// Hardcoded fallback when the Anthropic models API call fails.
const FALLBACK: ModelsPayload = {
  sortModels: [
    { id: CLAUDE_SORT_MODEL, displayName: "Claude Sonnet 5.5", description: DESCRIPTIONS[CLAUDE_SORT_MODEL], isDefault: true },
    { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: DESCRIPTIONS["claude-haiku-5-5"], isDefault: false },
    { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: DESCRIPTIONS["claude-opus-5-5"], isDefault: false },
    { id: "claude-opus-4-8",   displayName: "Claude Opus 4.8",   description: DESCRIPTIONS["claude-opus-4-8"],   isDefault: false },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: DESCRIPTIONS["claude-sonnet-4-6"], isDefault: false },
    { id: "claude-haiku-4-5",  displayName: "Claude Haiku 4.5",  description: DESCRIPTIONS["claude-haiku-4-5"],  isDefault: false },
  ],
  analysisModels: [
    { id: CLAUDE_ANALYSIS_MODEL, displayName: "Claude Sonnet 5.5", description: DESCRIPTIONS[CLAUDE_ANALYSIS_MODEL], isDefault: true },
    { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: DESCRIPTIONS["claude-opus-5-5"], isDefault: false },
    { id: "claude-opus-4-8",   displayName: "Claude Opus 4.8",   description: DESCRIPTIONS["claude-opus-4-8"],   isDefault: false },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: DESCRIPTIONS["claude-sonnet-4-6"], isDefault: false },
  ],
};

let cache: ModelsPayload | null = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function displayOpenAIModel(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => (part === "gpt" ? "GPT" : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function toOption(m: ModelInfo): ModelOption {
  return {
    id: m.id,
    displayName: m.display_name,
    description: DESCRIPTIONS[m.id] ?? "Model available from Anthropic.",
    isDefault: false, // set below
  };
}

function buildPayload(raw: ModelInfo[]): ModelsPayload {
  // Only offer models the call routes will actually accept (lib/models.ts) — this
  // keeps the premium "fable" tier out of the selector so the UI never shows a
  // model the server would reject.
  const vision = raw.filter((m) => isAllowedModel(m.id));
  if (vision.length === 0) return FALLBACK;

  const sortModels = vision.map((m) => ({
    ...toOption(m),
    isDefault: m.id === SORT_DEFAULT,
  }));
  const analysisModels = vision
    .filter((m) => !ANALYSIS_EXCLUDED.test(m.id))
    .map((m) => ({ ...toOption(m), isDefault: m.id === ANALYSIS_DEFAULT }));

  // Display the actual server default, even if it was absent from a stale
  // catalog. Never silently recommend an arbitrary premium first entry.
  if (!sortModels.some(m => m.isDefault)) sortModels.unshift(FALLBACK.sortModels[0]);
  if (!analysisModels.some(m => m.isDefault)) analysisModels.unshift(FALLBACK.analysisModels[0]);

  return { sortModels, analysisModels };
}

export async function GET() {
  if (aiProvider() === "openai") {
    return NextResponse.json(OPENAI_FALLBACK);
  }

  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    const client = getClient();
    const models: ModelInfo[] = [];
    for await (const model of client.models.list({ limit: 100 }, { timeout: 10_000, maxRetries: 0 })) {
      models.push(model);
      if (models.length >= 500) break;
    }
    cache = buildPayload(models);
    cacheAt = now;
    return NextResponse.json(cache);
  } catch {
    return NextResponse.json(FALLBACK);
  }
}

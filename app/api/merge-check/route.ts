import { NextRequest, NextResponse } from "next/server";
import { AnthropicAuthError } from "@/lib/anthropic";
import { aiProvider, getAiClient } from "@/lib/aiProvider";
import { OpenAIAuthError } from "@/lib/openai";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { checkMergePair } from "@/lib/sortPipeline";
import { isAllowedProviderModel } from "@/lib/models";
import type { WireImage } from "@/lib/images";
import { withAiUsageResponse, AiConfigurationError } from "@/lib/ai-meter";

// Merge check across sort-chunk boundaries: big batches are sorted 100 photos
// per request, so an item photographed across a boundary is split into two
// groups. The client sends the first photo of each candidate pair here.

export const maxDuration = 30;

async function handlePOST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { a?: WireImage; b?: WireImage; countA?: number; countB?: number; sortModel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (!body.a?.data || !body.b?.data) {
    return NextResponse.json({ ok: false, error: "Missing photos." }, { status: 400 });
  }

  const provider = aiProvider();
  const requested = typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const model = isAllowedProviderModel(requested, provider) ? requested : undefined;

  try {
    const merge = await checkMergePair(
      getAiClient(provider),
      body.a,
      body.b,
      Math.max(1, Number(body.countA) || 1),
      Math.max(1, Number(body.countB) || 1),
      model,
      provider
    );
    return NextResponse.json({ ok: true, merge });
  } catch (e) {
    if (e instanceof AiConfigurationError)
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    if (e instanceof AnthropicAuthError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    if (e instanceof OpenAIAuthError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return safeErrorResponse("merge-check", e, "Merge check failed.");
  }
}

export async function POST(req: NextRequest) {
  return withAiUsageResponse(() => handlePOST(req));
}

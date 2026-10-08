import { NextRequest, NextResponse } from "next/server";
import { AnthropicAuthError } from "@/lib/anthropic";
import { aiProvider, getAiClient } from "@/lib/aiProvider";
import { OpenAIAuthError } from "@/lib/openai";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { sortPhotos, SortUnavailableError } from "@/lib/sortPipeline";
import { isAllowedProviderModel } from "@/lib/models";
import type { WireImage } from "@/lib/images";
import { withAiUsageResponse, AiConfigurationError } from "@/lib/ai-meter";

// Sorting makes several model calls across grouping/verify/merge stages. 300s
// (already used by the publish route) gives slow Anthropic days room to finish;
// the pipeline's own SORT_TIME_BUDGET_MS (250s) makes it return a partial
// result before the platform would kill the function.
export const maxDuration = 300;

const MAX_PHOTOS = 120;

async function handlePOST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { images?: WireImage[]; sortModel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS) : [];
  // Validate the client-supplied model against the server allowlist — an
  // unchecked value would let anyone past the access gate bill an arbitrary or
  // premium model to the owner's key. Unknown → undefined (pipeline default).
  const requestedSort = typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const provider = aiProvider();
  const sortModel = isAllowedProviderModel(requestedSort, provider) ? requestedSort : undefined;
  if (images.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Please add some photos first." },
      { status: 400 }
    );
  }

  let client;
  try {
    client = getAiClient(provider);
  } catch (e) {
    if (e instanceof AiConfigurationError)
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }

  try {
    const result = await sortPhotos(client, images, sortModel, undefined, provider);
    if (result.groups.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "The AI couldn't pick out any separate items in these photos. Make sure each item is clearly shown, then try again.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      console.error("[sort] auth/billing failure:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    if (e instanceof OpenAIAuthError) {
      console.error("[sort] auth/billing failure:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    if (e instanceof SortUnavailableError) {
      console.error("[sort] every grouping batch failed:", e.message);
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return safeErrorResponse("sort", e, "Sorting failed — please try again.");
  }
}

export async function POST(req: NextRequest) {
  return withAiUsageResponse(() => handlePOST(req));
}

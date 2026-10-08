import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { MAX_PHOTO_ASSET_BASE64_CHARS, savePhotoAsset } from "@/lib/photo-assets";
import { ensurePhotoCleanupStarted } from "@/lib/photo-cleanup";

export const runtime = "nodejs";
export const maxDuration = 120;
const MAX_BODY_BYTES = MAX_PHOTO_ASSET_BASE64_CHARS + 1024;

async function readBoundedJson(req: NextRequest): Promise<unknown> {
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw new Error("The listing photo exceeds the upload size limit.");
  if (!req.body) throw new Error("Missing listing photo.");
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("The listing photo exceeds the upload size limit.");
      }
      parts.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw new Error("Invalid listing photo request."); }
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req, { bucket: "photo-assets", maxRequests: 600 });
  if (denied) return denied;
  ensurePhotoCleanupStarted();
  try {
    const body = await readBoundedJson(req) as { mediaType?: unknown; data?: unknown } | null;
    if (!body || body.mediaType !== "image/jpeg" || typeof body.data !== "string")
      return NextResponse.json({ ok: false, error: "Import a JPEG listing photo before saving." }, { status: 400 });
    const assetId = await savePhotoAsset(body.data);
    return NextResponse.json({ ok: true, assetId });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 400 });
  }
}

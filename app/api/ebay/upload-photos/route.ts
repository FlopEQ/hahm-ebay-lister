import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { uploadPhotos, PhotoUploadError } from "@/lib/ebay/publish";
import { loadPhotoAsset } from "@/lib/photo-assets";
import { MAX_EBAY_PHOTOS } from "@/lib/photoSelection";
import { withDeadline } from "@/lib/network";
import type { PhotoUpload, UploadImage } from "@/lib/uploadBatches";

export const runtime = "nodejs";
export const maxDuration = 120;
const MAX_PHOTOS_PER_REQUEST = 6;
const MAX_BODY_CHARS = 4_000_000;

class BodySizeError extends Error {}
async function readBody(req: NextRequest): Promise<string> {
  const length = req.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) throw new Error("Invalid content length.");
  if (Number(length) > MAX_BODY_CHARS) throw new BodySizeError();
  if (!req.body) throw new Error("Missing request.");
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY_CHARS) { await reader.cancel(); throw new BodySizeError(); }
      parts.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts).toString("utf8");
}

function validImage(image: unknown): image is PhotoUpload {
  if (!image || typeof image !== "object") return false;
  const i = image as Record<string, unknown>;
  if ("assetId" in i)
    return typeof i.assetId === "string" && /^[a-f0-9]{64}$/.test(i.assetId) &&
      typeof i.rotation === "number" && Number.isFinite(i.rotation) && i.rotation % 90 === 0 &&
      !("data" in i) && !("mediaType" in i);
  return typeof i.mediaType === "string" && ["image/jpeg","image/png","image/webp"].includes(i.mediaType) &&
    typeof i.data === "string" && i.data.length > 0 && i.data.length <= 2_800_000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(i.data) && !("rotation" in i);
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  let body: { sku?: unknown; images?: unknown; startIndex?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof BodySizeError)
      return NextResponse.json({ok:false,error:"Photo upload request is too large."},{status:413});
    return NextResponse.json({ok:false,error:"Invalid photo request."},{status:400});
  }
  const sku = typeof body?.sku === "string" ? body.sku.trim() : "";
  const startIndex = body?.startIndex ?? 0;
  const images = body?.images;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(sku) || !Array.isArray(images) || !images.length ||
      images.length > MAX_PHOTOS_PER_REQUEST || !images.every(validImage) ||
      typeof startIndex !== "number" || !Number.isInteger(startIndex) || startIndex < 0 ||
      startIndex + images.length > MAX_EBAY_PHOTOS ||
      images.reduce((n,i) => n + ("data" in i ? i.data.length : 128),0) > 3_800_000)
    return NextResponse.json({ok:false,error:"Invalid SKU, photos, rotation, or photo count."},{status:400});

  // Resolve the entire batch before eBay image creation. Missing private assets
  // must never silently fall back to the smaller AI image.
  let resolved: UploadImage[];
  try {
    resolved = [];
    for (const image of images)
      resolved.push("assetId" in image ? await loadPhotoAsset(image.assetId,image.rotation) : image);
  } catch (error) {
    return NextResponse.json({ok:false,error:(error as Error).message},{status:422});
  }

  let accessToken: string | null;
  try { accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value); }
  catch (error) {
    return NextResponse.json({ok:false,error:(error as Error).message},{status:500});
  }
  if (!accessToken)
    return NextResponse.json({ok:false,error:"eBay isn't connected. Connect your account and try again."},{status:401});

  try {
    const urls = await withDeadline(90_000, () => uploadPhotos(accessToken, resolved, sku, startIndex));
    return NextResponse.json({ok:true,urls,failed:0});
  } catch (error) {
    const urls = error instanceof PhotoUploadError ? error.urls : [];
    return NextResponse.json({ok:false,urls,failed:images.length-urls.length,
      error:error instanceof Error ? error.message : "eBay photo upload failed."},{status:422});
  }
}

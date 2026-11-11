// Split a listing's photos into upload batches that stay far under Vercel's
// 4.5 MB serverless request-body limit.
//
// New photos carry private asset references; legacy photos carry small base64
// images. Publishing receives only confirmed eBay-hosted URLs.

export interface UploadImage {
  mediaType: string;
  data: string; // raw base64, no data-url prefix
}

export type PhotoUpload = UploadImage | { assetId: string; rotation: number };

// ~2.8 MB of base64 (~2.1 MB of image data) per request. Browser-resized
// photos run ~200–800 KB of base64 each, so batches hold 3–4 photos and even
// a worst-case single photo stays nowhere near the 4.5 MB platform limit.
export const MAX_BATCH_BASE64_CHARS = 2_800_000;
// Bound the count too, so many tiny photos don't pile into one slow request.
export const MAX_BATCH_PHOTOS = 4;

export function chunkImagesForUpload<T extends PhotoUpload>(
  images: T[],
  maxChars: number = MAX_BATCH_BASE64_CHARS,
  maxPhotos: number = MAX_BATCH_PHOTOS
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const img of images) {
    const size = "data" in img ? img.data.length : 128;
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= maxPhotos || currentChars + size > maxChars);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    // Keep oversize single images intact; the endpoint rejects unsupported sizes.
    current = [...current, img];
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

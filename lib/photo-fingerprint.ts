import type { Photo } from "./types";

// Keep the exact old shape/order for legacy photos so existing receipts resume.
export function photoFingerprintSource(photo: Photo, rotation = 0) {
  const legacy = { id: photo.id, data: photo.data, rotation };
  return photo.uploadAssetId
    ? { ...legacy, uploadAssetId: photo.uploadAssetId, uploadEncoding: "jpeg-2400-v1" }
    : legacy;
}

export function normalizeSavedPhotos(raw: unknown): Photo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((photo) => {
    if (!photo || typeof photo !== "object") throw new Error("Invalid saved photo.");
    const { id, previewUrl, mediaType, data, uploadAssetId } = photo;
    if ([id, previewUrl, mediaType, data].some(value => typeof value !== "string"))
      throw new Error("Invalid saved photo.");
    if (uploadAssetId !== undefined &&
        (typeof uploadAssetId !== "string" || !/^[a-f0-9]{64}$/.test(uploadAssetId)))
      throw new Error("Invalid saved photo asset. Add this photo again before saving.");
    // Transient high-resolution base64 must never enter workspace JSON.
    return { id, previewUrl, mediaType, data, ...(uploadAssetId === undefined ? {} : { uploadAssetId }) };
  });
}

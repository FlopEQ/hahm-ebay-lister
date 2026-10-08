// Resize photos in the browser before upload.
//
// We produce three sizes per photo:
//   • uploadData — bounded JPEG up to 2400px, saved privately for eBay
//   • data      — ~1024px, used for writing the listing (needs detail: tags, etc.)
//   • previewUrl — 360px thumbnail, used for on-screen display AND for the
//                  sort step (which only needs to tell items apart). Keeping the
//                  sort payload tiny avoids Vercel's 4.5 MB request-body limit
//                  when a whole batch is sent at once.

const FULL_DIM = 1024;
const FULL_QUALITY = 0.82;
const THUMB_DIM = 360;
const THUMB_QUALITY = 0.5;
export const MAX_UPLOAD_BASE64_CHARS = 2_700_000;
const UPLOAD_ENCODINGS = [[2400, 0.9], [2000, 0.8], [1600, 0.75], [1200, 0.7], [1024, 0.6]] as const;

export interface ResizedImage {
  mediaType: "image/jpeg";
  data: string; // base64 (no prefix) ~1024px — for listing analysis
  previewUrl: string; // data url up to 360px — for display + sorting
  uploadData: string; // bounded JPEG, up to 2400px — for eBay
}

export async function resizeImage(file: File): Promise<ResizedImage> {
  const bitmap = await loadBitmap(file);
  try {
    const full = drawToJpeg(bitmap, FULL_DIM, FULL_QUALITY);
    const thumb = drawToJpeg(bitmap, THUMB_DIM, THUMB_QUALITY);
    return { mediaType: "image/jpeg", data: jpegData(full), previewUrl: thumb,
      uploadData: encodeUploadJpeg(bitmap) };
  } finally { if ("close" in bitmap) bitmap.close(); }
}

function jpegData(url: string): string {
  if (!url.startsWith("data:image/jpeg;base64,") || !url.split(",")[1])
    throw new Error("Could not encode this photo as JPEG.");
  return url.split(",")[1];
}

// Shared by initial processing and rotations; each attempt starts from the
// decoded source, never from the previous smaller/low-quality attempt.
export function encodeUploadJpeg(src: ImageBitmap | HTMLImageElement, rotation = 0): string {
  for (const [maxDim, quality] of UPLOAD_ENCODINGS) {
    const { width, height } = scaleDown(src.width, src.height, maxDim);
    const swap = rotation === 90 || rotation === 270;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? height : width;
    canvas.height = swap ? width : height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process image.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(src, -width / 2, -height / 2, width, height);
    const data = jpegData(canvas.toDataURL("image/jpeg", quality));
    if (data.length <= MAX_UPLOAD_BASE64_CHARS) return data;
  }
  throw new Error("This photo is too large to upload after compression. Choose a smaller photo.");
}

function drawToJpeg(
  src: ImageBitmap | HTMLImageElement,
  maxDim: number,
  quality: number
): string {
  const w = "width" in src ? src.width : 0;
  const h = "height" in src ? src.height : 0;
  const { width, height } = scaleDown(w, h, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(src, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function scaleDown(w: number, h: number, max: number) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    throw new Error("Could not read this photo's dimensions.");
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path (e.g. some HEIC/Safari cases).
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image file."));
    };
    img.src = url;
  });
}

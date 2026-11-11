"use client";
import { encodeUploadJpeg, MAX_UPLOAD_BASE64_CHARS } from "./resize";

function quarterTurn(degrees: number): number {
  if (!Number.isFinite(degrees) || degrees % 90 !== 0)
    throw new Error("Photo rotation must be a multiple of 90 degrees.");
  return ((degrees % 360) + 360) % 360;
}

async function loadPhoto(image: {mediaType: string; data: string}): Promise<HTMLImageElement> {
  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not rotate photo."));
  });
  img.src = `data:${image.mediaType};base64,${image.data}`;
  await loaded;
  return img;
}

export async function rotateUploadImageData(image: {mediaType: string; data: string}, degrees: number): Promise<{mediaType: string; data: string}> {
  const rotation = quarterTurn(degrees);
  if (!rotation && image.mediaType === "image/jpeg" && image.data.length <= MAX_UPLOAD_BASE64_CHARS) return image;
  return { mediaType: "image/jpeg", data: encodeUploadJpeg(await loadPhoto(image), rotation) };
}

export async function rotateImageData(
  image: { mediaType: string; data: string },
  degrees: number
): Promise<{ mediaType: string; data: string }> {
  const rotation = quarterTurn(degrees);
  if (rotation === 0) return image;

  const img = await loadPhoto(image);

  const swap = rotation === 90 || rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? img.height : img.width;
  canvas.height = swap ? img.width : img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not rotate photo.");
  if (!image.mediaType || image.mediaType === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);

  const out = canvas.toDataURL(image.mediaType || "image/jpeg", 0.9);
  if (!out.split(",")[1]) throw new Error("Could not encode the rotated photo.");
  return { mediaType: image.mediaType, data: out.split(",")[1] };
}

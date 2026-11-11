import type { ItemGroup } from "@/lib/types";

export const MAX_EBAY_PHOTOS = 24;

export function ebayPhotoIds(group: ItemGroup, limit = MAX_EBAY_PHOTOS): string[] {
  const hidden = new Set(group.hiddenPhotoIds ?? []);
  return group.photoIds.filter((id) => !hidden.has(id)).slice(0, limit);
}

export function normalizedRotation(value: number | undefined): number {
  const n = Number(value || 0);
  return ((n % 360) + 360) % 360;
}

export function rotated(group: ItemGroup, photoId: string): number {
  return normalizedRotation(group.photoRotations?.[photoId]);
}

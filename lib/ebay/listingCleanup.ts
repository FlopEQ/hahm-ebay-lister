import type { ListingResult } from "@/lib/types";

export function cleanIsbnValue(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\D/g, "");
}

export function cleanListingIdentifiers(listing: ListingResult): ListingResult {
  const itemSpecifics = listing.item_specifics;
  if (!itemSpecifics) return listing;

  let changed = false;
  const nextSpecifics: Record<string, string> = {};
  for (const [key, value] of Object.entries(itemSpecifics)) {
    const nextValue = key.trim().toLowerCase() === "isbn" ? cleanIsbnValue(value) : value;
    if (nextValue !== value) changed = true;
    nextSpecifics[key] = nextValue;
  }

  return changed ? { ...listing, item_specifics: nextSpecifics } : listing;
}

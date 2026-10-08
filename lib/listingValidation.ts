import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import { ebayPhotoIds } from "@/lib/photoSelection";
import type { EbayPolicyOptions, ItemGroup, ListingValidation, ValidationIssue } from "@/lib/types";

function priceValue(raw: number | string | undefined): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

function hasPositive(raw: number | string | undefined): boolean {
  return priceValue(raw) !== null;
}

function issue(severity: ValidationIssue["severity"], message: string): ValidationIssue {
  return { severity, message };
}

export function validateListing(
  group: ItemGroup,
  opts: {
    duplicateSku?: boolean;
    ebayConnected: boolean;
    ebayPolicies: EbayPolicyOptions | null;
  }
): ListingValidation {
  const issues: ValidationIssue[] = [];
  const listing = group.listing;
  const selectedPhotoIds = ebayPhotoIds(group);

  if (group.status !== "done" || !listing) {
    issues.push(issue("error", "Listing has not been written yet."));
  }
  if (!group.sku.trim()) issues.push(issue("error", "SKU is missing."));
  if (opts.duplicateSku) issues.push(issue("error", "Another item in this batch uses this SKU."));
  if (selectedPhotoIds.length === 0) issues.push(issue("error", "At least one eBay photo is selected."));
  if (selectedPhotoIds.length > 0 && selectedPhotoIds.length < 3) {
    issues.push(issue("warning", "Recommended: add at least 3 photos."));
  }
  if ((group.hiddenPhotoIds ?? []).includes(group.photoIds[0])) {
    issues.push(issue("warning", "The original cover photo is hidden; the first selected photo will be used."));
  }

  if (listing) {
    if (!listing.description?.trim()) issues.push(issue("error", "Description is missing."));
    if (!listing.title?.trim()) issues.push(issue("error", "Title is missing."));
    if ((listing.title || "").length > 80) issues.push(issue("error", "Title is over 80 characters."));
    if (priceValue(listing.suggested_price) === null) issues.push(issue("error", "Price is missing."));
    if (!(listing.ebay_condition || listing.condition)?.trim()) issues.push(issue("error", "Condition is missing."));
    if (SIZE_REQUIRED_CATEGORIES.has(listing.category ?? "") && !listing.size?.trim()) {
      issues.push(issue("error", "Required apparel size is missing."));
    }
    if (Object.values(listing.item_specifics ?? {}).filter((v) => String(v || "").trim()).length < 3) {
      issues.push(issue("warning", "Item specifics look thin."));
    }
    if (!hasPositive(listing.package_weight_oz)) {
      issues.push(issue("warning", "Package weight is using the automatic default."));
    }
    if (
      !hasPositive(listing.package_length_in) ||
      !hasPositive(listing.package_width_in) ||
      !hasPositive(listing.package_height_in)
    ) {
      issues.push(issue("warning", "Package dimensions are using automatic defaults."));
    }
    if (opts.ebayConnected) {
      if (!listing.fulfillment_policy_id && !opts.ebayPolicies?.defaults.fulfillmentPolicyId) {
        issues.push(issue("error", "No shipping policy is available."));
      }
      if (!listing.payment_policy_id && !opts.ebayPolicies?.defaults.paymentPolicyId) {
        issues.push(issue("error", "No payment policy is available."));
      }
      if (!listing.return_policy_id && !opts.ebayPolicies?.defaults.returnPolicyId) {
        issues.push(issue("error", "No return policy is available."));
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ready: errors.length === 0, errors, warnings };
}

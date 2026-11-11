import type { EbayPolicyOption, EbayPolicyOptions, ListingResult } from "@/lib/types";

const normalize = (name: string) => name.trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");

/** Only use unambiguous preferred names; never silently choose an unrelated policy. */
export function defaultPolicyId(policies: EbayPolicyOption[], preferred: string,
  configuredId?: string, configuredName?: string): string {
  if (configuredId?.trim()) return policies.find(p => p.id === configuredId.trim())?.id || "";
  const target = normalize(configuredName?.trim() || preferred);
  const exact = policies.filter(p => normalize(p.name) === target);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1 || configuredName?.trim()) return "";
  // eBay sometimes appends a suffix to the standard payment/return policy name.
  const prefixed = policies.filter(p => normalize(p.name).startsWith(target + " ") || normalize(p.name).startsWith(target + " ("));
  if (prefixed.length === 1) return prefixed[0].id;
  if (prefixed.length > 1) return "";
  return policies.length === 1 ? policies[0].id : "";
}

export function withPolicyDefaults(listing: ListingResult, policies: EbayPolicyOptions): ListingResult {
  return { ...listing,
    fulfillment_policy_id: listing.fulfillment_policy_id || policies.defaults.fulfillmentPolicyId || undefined,
    payment_policy_id: listing.payment_policy_id || policies.defaults.paymentPolicyId || undefined,
    return_policy_id: listing.return_policy_id || policies.defaults.returnPolicyId || undefined,
  };
}

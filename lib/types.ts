// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  category_name?: string;
  ebay_condition?: string;
  brand?: string;
  item_type?: string;
  color?: string[] | string;
  size?: string;
  material?: string;
  condition?: string;
  condition_notes?: string;
  measurements?: string;
  description: string;
  suggested_price?: number | string;
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
  fulfillment_policy_id?: string;
  payment_policy_id?: string;
  return_policy_id?: string;
  package_weight_oz?: number | string;
  package_length_in?: number | string;
  package_width_in?: number | string;
  package_height_in?: number | string;
}

export interface EbayPolicyOption {
  id: string;
  name: string;
}

export interface EbayPolicyOptions {
  fulfillmentPolicies: EbayPolicyOption[];
  paymentPolicies: EbayPolicyOption[];
  returnPolicies: EbayPolicyOption[];
  defaults: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
}

export interface StagedOffer {
  offerId: string;
  sku: string;
  status: string;
  title?: string;
  price?: string;
  currency?: string;
  listingId?: string;
}

export type WorkspaceStep = "upload" | "review" | "listings";

export type BatchCategory = "books" | "dvd" | "cd" | "games" | "other";

export interface AiUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
  models: string[];
  unreportedCalls: number;
}

export interface SavedWorkspace {
  version: 1;
  updatedAt: string;
  photos: Photo[];
  binPrefix: string;
  batchCategory: BatchCategory;
  step: WorkspaceStep;
  groups: ItemGroup[];
  orphanIds: string[];
  skuStart: number;
  aiUsage?: AiUsageSummary;
}

export interface SavedBatchMeta {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  archived?: boolean;
  itemCount: number;
  photoCount: number;
  postedCount: number;
}

export interface SavedBatchRecord extends SavedBatchMeta {
  workspace: SavedWorkspace;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface ListingValidation {
  ready: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
  batchCategory?: BatchCategory;
  // Optional model overrides; server falls back to its defaults when omitted.
  analysisModel?: string;
  routerModel?: string;
}

export interface AnalyzeResponse {
  ok: boolean;
  usage?: AiUsageSummary;
  listing?: ListingResult;
  error?: string;
}

export interface SortResponse {
  ok: boolean;
  usage?: AiUsageSummary;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────

export interface Photo {
  id: string;
  previewUrl: string;
  mediaType: string;
  data: string; // base64, no prefix
  uploadAssetId?: string; // immutable private JPEG used only for eBay uploads
}

export type ItemStatus = "idle" | "writing" | "done" | "error";

export type PostStatus = "idle" | "drafting" | "drafted" | "posting" | "posted" | "error";

// Market price check from active eBay comps (see lib/ebay/comps.ts). Text
// matches are advisory; strong identifier matches can replace the AI estimate
// before review, while still staying editable.
export interface CompsSummary {
  ok: boolean;
  query: string;
  source?: "identifier" | "text";
  identifierType?: "UPC" | "EAN" | "ISBN";
  count: number;
  median?: number;
  trimmedMean?: number;
  low?: number;
  high?: number;
  confidence: number;
  basis: string;
  // Median with the deployment's PRICE_MARKUP_PERCENT applied — what the
  // "use median" button should set. Absent when no markup is configured.
  listPrice?: number;
}

export interface ItemGroup {
  id: string;
  sku: string; // bin reference, e.g. "K75-A"
  name: string;
  photoIds: string[];
  hiddenPhotoIds?: string[];
  photoRotations?: Record<string, number>;
  listing?: ListingResult;
  status: ItemStatus;
  error?: string;
  analysisUsage?: AiUsageSummary;
  // Market price check (fetched right after the listing is written)
  comps?: CompsSummary;
  // eBay posting state (Phase 2)
  postStatus?: PostStatus;
  listingId?: string;
  offerId?: string;
  postError?: string;
  // Non-fatal quality warnings from the last publish (e.g. schema unavailable)
  postWarnings?: string[];
  ebayReview?: { categoryId: string; expiresAt: number; signature: string };
  ebayPreparation?: {
    categories: { id: string; name: string; path?: string }[];
    conditions: { value: string; label: string }[];
    aspects: { name: string; required: boolean; values: string[]; mode: string }[];
    issues: string[];
  };
  ebayUpload?: { fingerprint: string; urls: string[] };
  ebayAttempt?: { id: string; fingerprint: string };
}

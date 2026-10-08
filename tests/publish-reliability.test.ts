import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("@/lib/ebay/taxonomy", () => ({
  suggestLeafCategories: vi.fn(async () => [{ id: "267", name: "Books", path: "Books" }]),
  categoryAspects: vi.fn(async () => [{ name: "Brand", required: true, usage: "REQUIRED", values: [], mode: "FREE_TEXT", cardinality: "SINGLE", maxLength: 65 }]),
  acceptedConditionIds: vi.fn(async () => new Set([5000])),
}));
import { prepareListing, publishListing, publishStagedOffer, type PublishInput } from "@/lib/ebay/publish";
import { signReview, withPublishOperation } from "@/lib/ebay/reliability";
import { acceptedConditionIds, categoryAspects, suggestLeafCategories } from "@/lib/ebay/taxonomy";

const setup = { fulfillmentPolicyId: "ful", paymentPolicyId: "pay", returnPolicyId: "ret", locationKey: "origin" };
let directory: string;
let previousDirectory: string | undefined;
let requests: { method: string; url: string; body: any }[];
let handler: (url: string, method: string, body: any) => Response | Promise<Response>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function input(): PublishInput {
  const expiresAt = Date.now() + 60_000;
  return { sku: "BIN-12", requestId: "attempt_123456", expectedPhotoCount: 2,
    imageUrls: ["https://i.ebayimg.com/images/a.jpg", "https://i.ebayimg.com/images/b.jpg"],
    review: { categoryId: "267", expiresAt, signature: signReview("267", expiresAt) },
    listing: { title: "Reviewed book", description: "Exact reviewed description", category: "book", category_id: "267",
      ebay_condition: "USED_GOOD", suggested_price: 24.35, item_specifics: { Brand: "Seller Brand", Author: "Ada | Grace" },
      condition_notes: "Crease on cover", package_weight_oz: 20, package_length_in: 13, package_width_in: 10, package_height_in: 4 } };
}
function defaultHandler(url: string, method: string): Response {
  if (url.includes("fulfillment_policy")) return response({ fulfillmentPolicies: [{ fulfillmentPolicyId: "ful" }] });
  if (url.includes("payment_policy")) return response({ paymentPolicies: [{ paymentPolicyId: "pay" }] });
  if (url.includes("return_policy")) return response({ returnPolicies: [{ returnPolicyId: "ret" }] });
  if (url.includes("/offer?")) return response({ offers: [] });
  if (url.includes("/inventory_item/") && method === "GET") return response({}, 404);
  if (url.includes("/inventory_item/") && method === "PUT") return new Response(null, { status: 204 });
  if (url.endsWith("/offer") && method === "POST") return response({ offerId: "offer-1" }, 201);
  throw new Error(`Unexpected request: ${method} ${url}`);
}
beforeEach(async () => {
  vi.mocked(suggestLeafCategories).mockReset().mockResolvedValue([{ id: "267", name: "Books", path: "Books" }]);
  vi.mocked(categoryAspects).mockReset().mockResolvedValue([{ name: "Brand", required: true, usage: "REQUIRED", values: [], mode: "FREE_TEXT", cardinality: "SINGLE", maxLength: 65 }]);
  vi.mocked(acceptedConditionIds).mockReset().mockResolvedValue(new Set([5000]));
  previousDirectory = process.env.WORKSPACE_DATA_DIR;
  directory = await mkdtemp(path.join(tmpdir(), "ebay-publish-regression-"));
  process.env.WORKSPACE_DATA_DIR = directory;
  requests = [];
  handler = defaultHandler;
  vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
    const url = String(raw), method = init.method || "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    return handler(url, method, body);
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousDirectory === undefined) delete process.env.WORKSPACE_DATA_DIR;
  else process.env.WORKSPACE_DATA_DIR = previousDirectory;
  // mkdtemp creates this test's own unique directory; never remove app data.
  await rm(directory, { recursive: true, force: true });
});
const writes = () => requests.filter(r => r.method !== "GET");
const staged = (status = "UNPUBLISHED") => ({ sku: "BIN-12", status, categoryId: "267", format: "FIXED_PRICE",
  pricingSummary: { price: { value: "24.35", currency: "USD" } }, listingDescription: "Exact reviewed description",
  listingPolicies: setup, merchantLocationKey: setup.locationKey });
function stagedDependency(url: string): Response | undefined {
  if (url.includes("/inventory_item/")) return response({ product: { title: "Reviewed book", description: "Exact reviewed description",
    aspects: { Brand: ["Seller Brand"] }, imageUrls: input().imageUrls }, condition: "USED_GOOD" });
  if (url.includes("/location/")) return response({ merchantLocationStatus: "ENABLED", location: { address: { country: "US", postalCode: "10001" } } });
  if (url.includes("_policy")) return defaultHandler(url, "GET");
}

describe("listing preparation", () => {
  it("returns missing required facts as blank fields without inventing values", async () => {
    vi.mocked(categoryAspects).mockResolvedValueOnce([{ name: "Material", required: true, usage: "REQUIRED", values: ["Cotton"], mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: 65 }]);
    const result = await prepareListing("token", { title: "Reviewed item", description: "Seller description", category_id: "267", ebay_condition: "USED_GOOD" });
    expect(result.listing.item_specifics?.Material).toBe("");
    expect(result.preparation.issues).toContain("Enter Material");
    expect(requests).toHaveLength(0);
  });
  it("honors the seller's explicit category when suggestions differ", async () => {
    const result = await prepareListing("token", { ...input().listing, category_id: "12345" });
    expect(result.listing.category_id).toBe("12345");
    expect(result.review.categoryId).toBe("12345");
    expect(categoryAspects).toHaveBeenCalledWith("12345", true);
    expect(acceptedConditionIds).toHaveBeenCalledWith("12345", "token", true);
  });
  it("refuses preparation when required metadata is unavailable", async () => {
    vi.mocked(categoryAspects).mockResolvedValueOnce([]);
    await expect(prepareListing("token", input().listing)).rejects.toThrow(/requirements.*unavailable/i);
    expect(requests).toHaveLength(0);
  });
  it("uses the apparel condition policy for an excellent item with a generic category key", async () => {
    vi.mocked(acceptedConditionIds).mockResolvedValueOnce(new Set([2990, 3000, 3010]));
    const listing = { ...input().listing, category: "other", condition: "EXCELLENT", ebay_condition: undefined };
    const result = await prepareListing("token", listing);
    expect(result.listing.ebay_condition).toBe("PRE_OWNED_EXCELLENT");
    expect(result.preparation.issues).not.toContain("Choose a condition supported by this category.");
    expect(requests).toHaveLength(0);
  });
});

describe("reviewed publishing safety", () => {
  it.each([response({}, 503), response({ offers: null }), response({ offers: [{ offerId: "other", format: "FIXED_PRICE", status: "UNKNOWN" }] })])("blocks an unverifiable offer state before any writes", async state => {
    handler = (url, method) => url.includes("/offer?") ? state.clone() : defaultHandler(url, method);
    await expect(publishListing("token", setup, input(), { publish: false })).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });
  it("preserves every reviewed payload value and photo order", async () => {
    const draft = input(), original = structuredClone(draft);
    expect(await publishListing("token", setup, draft, { publish: false })).toMatchObject({ success: true, draft: true, sku: draft.sku });
    const inventory = writes().find(r => r.url.includes("inventory_item"))!.body;
    expect(inventory).toMatchObject({ condition: "USED_GOOD", conditionDescription: "Crease on cover",
      product: { title: draft.listing.title, description: draft.listing.description, imageUrls: draft.imageUrls,
        aspects: { Brand: ["Seller Brand"], Author: ["Ada", "Grace"] } },
      packageWeightAndSize: { weight: { value: 20 }, dimensions: { length: 13, width: 10, height: 4 } } });
    expect(writes().find(r => r.url.endsWith("/offer"))!.body).toMatchObject({ categoryId: "267",
      pricingSummary: { price: { value: "24.35" } }, listingPolicies: { fulfillmentPolicyId: "ful", paymentPolicyId: "pay", returnPolicyId: "ret" } });
    expect(draft).toEqual(original);
  });
  it("stops on an inventory rejection without condition or category fallback", async () => {
    handler = (url, method) => method === "PUT" ? response({ errors: [{ errorId: 25021, message: "Condition not supported" }] }, 400) : defaultHandler(url, method);
    const draft = input();
    expect(await publishListing("token", setup, draft)).toMatchObject({ success: false });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.condition).toBe("USED_GOOD");
    expect(draft.listing.category_id).toBe("267");
  });
  it.each(["count", "duplicate", "foreign"])("blocks %s photo mismatch", async kind => {
    const draft = input();
    if (kind === "count") draft.expectedPhotoCount = 3;
    if (kind === "duplicate") draft.imageUrls![1] = draft.imageUrls![0];
    if (kind === "foreign") draft.imageUrls![1] = "https://example.com/a.jpg";
    await expect(publishListing("token", setup, draft)).rejects.toThrow(/photo/i);
    expect(writes()).toHaveLength(0);
  });
  it("preserves an existing inventory draft for a different item", async () => {
    handler = (url, method) => url.includes("inventory_item") ? response({ product: { title: "Someone else's item", description: "Existing" } }) : defaultHandler(url, method);
    await expect(publishListing("token", setup, input())).rejects.toThrow(/different draft/i);
    expect(writes()).toHaveLength(0);
  });
  it("refuses multiple unpublished offers before writing inventory", async () => {
    handler = (url, method) => url.includes("/offer?") ? response({ offers: [1, 2].map(n => ({ offerId: `offer-${n}`, format: "FIXED_PRICE", status: "UNPUBLISHED" })) }) : defaultHandler(url, method);
    await expect(publishListing("token", setup, input())).rejects.toThrow(/multiple/i);
    expect(writes()).toHaveLength(0);
  });
  it("reuses an offer after a lost create response and allows editing the owned inventory", async () => {
    let stored: any;
    let created = false;
    handler = (url, method, body) => {
      if (url.includes("/offer?")) return response({ offers: created ? [{ offerId: "offer-1", format: "FIXED_PRICE", status: "UNPUBLISHED" }] : [] });
      if (url.includes("/inventory_item/") && method === "GET") return stored ? response(stored) : response({}, 404);
      if (url.includes("/inventory_item/") && method === "PUT") { stored = body; return new Response(null, { status: 204 }); }
      if (url.endsWith("/offer") && method === "POST") { created = true; throw new Error("Lost create response"); }
      if (url.endsWith("/offer/offer-1") && method === "PUT") return new Response(null, { status: 204 });
      return defaultHandler(url, method);
    };
    const draft = input();
    await expect(publishListing("token", setup, draft, { publish: false })).rejects.toThrow(/interrupted/i);
    draft.listing.description = "Seller revised this description";
    expect(await publishListing("token", setup, draft, { publish: false })).toMatchObject({ success: true, offerId: "offer-1", draft: true });
    expect(requests.filter(r => r.method === "POST" && r.url.endsWith("/offer"))).toHaveLength(1);
    expect(stored.product.description).toBe(draft.listing.description);
  });
});
describe("publish reconciliation", () => {
  it("recovers the main publish attempt after both POST and reconciliation responses are lost", async () => {
    let published = false;
    let failReconciliation = false;
    handler = (url, method, body) => {
      if (url.includes("/offer?")) return response({ offers: published ? [{ ...staged("PUBLISHED"), offerId: "offer-1", listing: { listingId: "live-1" } }] : [] });
      if (url.endsWith("/offer/offer-1/publish") && method === "POST") {
        published = true; failReconciliation = true; throw new Error("Lost accepted publish response");
      }
      if (url.endsWith("/offer/offer-1") && method === "GET") {
        if (failReconciliation) { failReconciliation = false; throw new Error("Lost verification response"); }
        return response(staged());
      }
      if (url.includes("/inventory_item/") && method === "GET" && requests.some(r => r.method === "PUT"))
        return response(requests.find(r => r.method === "PUT" && r.url.includes("/inventory_item/"))!.body);
      if (url.includes("/location/")) return stagedDependency(url)!;
      return defaultHandler(url, method);
    };
    const draft = input();
    expect(await publishListing("token", setup, draft)).toMatchObject({ success: false, error: expect.stringMatching(/unconfirmed/i) });
    const firstWrites = writes().length;
    expect(await publishListing("token", setup, draft)).toMatchObject({ success: true, offerId: "offer-1", listingId: "live-1" });
    expect(writes()).toHaveLength(firstWrites);
    expect(requests.filter(r => r.method === "POST" && r.url.endsWith("/publish"))).toHaveLength(1);
  });
  it("does not trust a client supplied reconciliation ID for an unrelated live offer", async () => {
    handler = (url, method) => url.includes("/offer?")
      ? response({ offers: [{ ...staged("PUBLISHED"), offerId: "offer-1", listing: { listingId: "other-live" } }] })
      : defaultHandler(url, method);
    const draft = { ...input(), reconcileOfferId: "offer-1" };
    expect(await publishListing("token", setup, draft)).toMatchObject({ success: false, alreadyListed: true, listingId: "other-live" });
    expect(writes()).toHaveLength(0);
  });
  it("recovers a lost successful publish response without a second POST", async () => {
    let published = false;
    handler = async (url, method) => {
      const dependency = stagedDependency(url);
      if (dependency) return dependency;
      if (method === "POST") { published = true; throw new Error("Connection lost after acceptance"); }
      return response(published ? { ...staged("PUBLISHED"), listing: { listingId: "live-1" } } : staged());
    };
    expect(await publishStagedOffer("token", "offer-1")).toMatchObject({ success: true, listingId: "live-1" });
    expect(writes()).toHaveLength(1);
  });
  it("reports an unconfirmed lost publish outcome", async () => {
    handler = async (url, method) => {
      const dependency = stagedDependency(url);
      if (dependency) return dependency;
      if (method === "POST") throw new Error("Connection lost");
      return response(staged());
    };
    expect(await publishStagedOffer("token", "offer-1")).toMatchObject({ success: false, error: expect.stringMatching(/unconfirmed/i) });
    expect(writes()).toHaveLength(1);
  });
  it("refuses to publish an unknown staged offer state", async () => {
    handler = () => response({ sku: "BIN-12", status: "UNKNOWN" });
    await expect(publishStagedOffer("token", "offer-1")).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });
  it("blocks staged publication when category metadata is unavailable", async () => {
    vi.mocked(categoryAspects).mockResolvedValueOnce([]);
    handler = url => stagedDependency(url) || response(staged());
    await expect(publishStagedOffer("token", "offer-1")).rejects.toThrow(/verify|category/i);
    expect(writes()).toHaveLength(0);
  });
  it("blocks staged publication when a selected business policy no longer exists", async () => {
    handler = url => url.includes("return_policy") ? response({ returnPolicies: [] }) : stagedDependency(url) || response(staged());
    await expect(publishStagedOffer("token", "offer-1")).rejects.toThrow(/policy/i);
    expect(writes()).toHaveLength(0);
  });
  it("blocks standalone staged publication while the same SKU is being saved", async () => {
    const draft = input();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const save = withPublishOperation(draft, false, async () => { entered(); await gate; return { success: true, sku: draft.sku }; });
    await started;
    handler = url => stagedDependency(url) || response(staged());
    try {
      await expect(publishStagedOffer("token", "offer-1")).rejects.toThrow(/running|finish/i);
      expect(writes()).toHaveLength(0);
      expect(requests).toHaveLength(1);
    } finally { release(); await save; }
  });
});
describe("durable operation receipts", () => {
  it("replays a successful receipt without repeating any eBay calls", async () => {
    const draft = input();
    const result = await publishListing("token", setup, draft, { publish: false });
    const count = requests.length;
    expect(await publishListing("token", setup, draft, { publish: false })).toEqual(result);
    expect(requests).toHaveLength(count);
  });
  it("rejects changed data under a successful attempt ID", async () => {
    const draft = input();
    await publishListing("token", setup, draft, { publish: false });
    draft.listing.suggested_price = 99;
    const count = requests.length;
    await expect(publishListing("token", setup, draft, { publish: false })).rejects.toThrow(/different listing data/i);
    expect(requests).toHaveLength(count);
  });
  it("isolates operation receipts between seller account scopes", async () => {
    const draft = { ...input(), accountScope: "seller-one" };
    const run = vi.fn(async () => ({ success: true, sku: draft.sku, draft: true }));
    await withPublishOperation(draft, false, run);
    await withPublishOperation({ ...draft, accountScope: "seller-two" }, false, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("locks concurrent operations for the same SKU", async () => {
    const draft = input();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = withPublishOperation(draft, false, async () => { entered(); await gate; return { success: true, sku: draft.sku, draft: true }; });
    await started;
    try { await expect(withPublishOperation({ ...draft, requestId: "another_attempt" }, false, async () => ({ success: true, sku: draft.sku }))).rejects.toThrow(/running|progress/i); }
    finally { release(); await first; }
  });
  it("recovers an interrupted lock only after confirming its owner process is gone", async () => {
    const draft = input(), dir = path.join(directory, "ebay-operations");
    await mkdir(dir);
    const key = createHash("sha256").update(draft.sku).digest("hex");
    await writeFile(path.join(dir, `${key}.lock`), JSON.stringify({ pid: 987654, startedAt: Date.now() }));
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Dead process"), { code: "ESRCH" }); });
    const run = vi.fn(async () => ({ success: true, sku: draft.sku }));
    expect(await withPublishOperation(draft, false, run)).toMatchObject({ success: true });
    expect(probe).toHaveBeenCalledWith(987654, 0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

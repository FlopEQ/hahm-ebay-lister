import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_EBAY_PHOTOS } from "../photoSelection";
import type { PublishInput, PublishResult } from "./publish";

// Local development can prepare drafts without adding an access code.
const localSecret = randomBytes(32).toString("hex");
function reviewSecret() {
  const secret = process.env.SESSION_SECRET || process.env.APP_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("SESSION_SECRET or APP_SECRET is required for listing review.");
  return secret || localSecret;
}
export function signReview(categoryId: string, expiresAt: number): string {
  return createHmac("sha256", reviewSecret()).update(`${categoryId}:${expiresAt}`).digest("hex");
}
export function verifyReview(categoryId: string, expiresAt: number, signature: string): boolean {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86400_000) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signReview(categoryId, expiresAt), "hex"));
}

export function validatePublishInput(raw: unknown): asserts raw is PublishInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid listing request.");
  const input = raw as PublishInput;
  if (typeof input.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(input.sku))
    throw new Error("SKU must be 1–50 letters, numbers, dots, underscores or hyphens.");
  const l = input.listing;
  if (!l || typeof l !== "object" || typeof l.title !== "string" || !l.title.trim() || l.title.length > 80 ||
      typeof l.description !== "string" || !l.description.trim() || l.description.length > 15000)
    throw new Error("A title of 1–80 characters and a description of up to 15,000 characters are required.");
  if (typeof l.category_id !== "string" || !/^\d{1,20}$/.test(l.category_id))
    throw new Error("Prepare and review an eBay category before saving.");
  if (typeof l.ebay_condition !== "string" || !l.ebay_condition)
    throw new Error("Select an eBay condition before saving.");
  const price = typeof l.suggested_price === "string" ? Number(l.suggested_price) : l.suggested_price;
  if (price === undefined || !Number.isFinite(price) || price < 0.01 || price > 1_000_000)
    throw new Error("Enter a valid price between 0.01 and 1,000,000.");
  if (l.item_specifics !== undefined && (!l.item_specifics || typeof l.item_specifics !== "object" ||
      Array.isArray(l.item_specifics) || Object.keys(l.item_specifics).length > 100 ||
      Object.entries(l.item_specifics).some(([k,v]) => !k || k.length > 100 || typeof v !== "string" || v.length > 500)))
    throw new Error("Invalid item specifics.");
  for (const key of ["condition_notes", "category", "fulfillment_policy_id", "payment_policy_id", "return_policy_id"] as const)
    if (l[key] !== undefined && (typeof l[key] !== "string" || l[key]!.length > 3000))
      throw new Error(`Invalid ${key.replace(/_/g, " ")}.`);
  const dimensions = [l.package_length_in, l.package_width_in, l.package_height_in];
  const present = (v: unknown) => v !== undefined && v !== "";
  if (dimensions.filter(present).length > 0 && dimensions.filter(present).length !== 3)
    throw new Error("Enter all three package dimensions or leave them all blank.");
  for (const value of [l.package_weight_oz, ...dimensions])
    if (present(value) && (!Number.isFinite(Number(value)) || Number(value) <= 0))
      throw new Error("Package measurements must be positive numbers.");
  if (!Number.isInteger(input.expectedPhotoCount) || input.expectedPhotoCount! < 1 || input.expectedPhotoCount! > MAX_EBAY_PHOTOS ||
      !Array.isArray(input.imageUrls) || input.imageUrls.length !== input.expectedPhotoCount)
    throw new Error("Every selected photo must upload before saving to eBay.");
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId))
    throw new Error("Missing save attempt ID. Reload the draft and try again.");
}

// Receipts use the existing server-data location. No photos or credentials are stored here.
// The exclusive SKU lock also protects separate app processes using this directory.
function operationDir() {
  return path.join(process.env.WORKSPACE_DATA_DIR || path.join(process.cwd(), "data"), "ebay-operations");
}
function scopeKey(input: PublishInput) {
  return createHash("sha256").update(`${input.accountScope || "local"}:${input.sku}`).digest("hex");
}
function operationFile(input: PublishInput, publish: boolean) {
  const key = createHash("sha256").update(`${scopeKey(input)}:${input.requestId}:${publish}`).digest("hex");
  return path.join(operationDir(),`${key}.json`);
}
function operationFingerprint(input: PublishInput, publish: boolean) {
  return createHash("sha256").update(JSON.stringify({sku:input.sku,listing:input.listing,imageUrls:input.imageUrls,publish})).digest("hex");
}
export async function recordPendingPublish(input: PublishInput, offerId: string) {
  const file = operationFile(input,true), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify({fingerprint:operationFingerprint(input,true),pendingOfferId:offerId}),"utf8");
  await rename(tmp,file);
}
function inventoryIdentity(product: any): string {
  return JSON.stringify({ title:product?.title, description:product?.description, imageUrls:product?.imageUrls });
}
export async function ownsInventory(input: PublishInput, product: unknown): Promise<boolean> {
  try {
    const saved = JSON.parse(await readFile(path.join(operationDir(),`${scopeKey(input)}.inventory.json`),"utf8"));
    return saved.identity === inventoryIdentity(product);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function recordInventory(input: PublishInput, product: unknown): Promise<void> {
  const file = path.join(operationDir(),`${scopeKey(input)}.inventory.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify({identity:inventoryIdentity(product)}),"utf8");
  await rename(tmp,file);
}
export async function withPublishOperation(
  input: PublishInput, publish: boolean, run: () => Promise<PublishResult>,
): Promise<PublishResult> {
  const dir = operationDir();
  await mkdir(dir, { recursive: true });
  const fingerprint = operationFingerprint(input,publish);
  const file = operationFile(input,publish);
  delete input.reconcileOfferId;
  try {
    const receipt = JSON.parse(await readFile(file, "utf8"));
    if (receipt.fingerprint !== fingerprint) throw new Error("This attempt ID was used for different listing data. Start a new save attempt.");
    if (receipt.result?.success) return receipt.result;
    if (typeof receipt.pendingOfferId === "string") input.reconcileOfferId = receipt.pendingOfferId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return withSkuLock(input.sku,async () => {
    const result = await run();
    if (result.success) {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp,JSON.stringify({fingerprint,result,savedAt:new Date().toISOString()}),"utf8");
      await rename(tmp,file);
    }
    return result;
  });
}

export async function withSkuLock<T>(sku: string, run: () => Promise<T>): Promise<T> {
  const dir = operationDir();
  await mkdir(dir,{recursive:true});
  // Cookie receipts are account-scoped, but the lock is shared across browsers:
  // two cookies may belong to the same seller. Serialize that SKU conservatively.
  const lockFile = path.join(dir, `${createHash("sha256").update(sku).digest("hex")}.lock`);
  let lock;
  try { lock = await open(lockFile, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Recover only a lock left by a process that no longer exists. An active
      // owner is never unlocked merely because a request has taken a long time.
      let recovery;
      try { recovery = await open(`${lockFile}.recovery`,"wx"); }
      catch { throw new Error("A save for this SKU is already recovering. Wait before retrying."); }
      try {
        let owner;
        try { owner = JSON.parse(await readFile(lockFile,"utf8")); } catch { /* fail closed */ }
        let dead = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid,0); }
          catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        if (!dead) throw new Error("A save for this SKU is already running. Wait for it to finish before retrying.");
        await unlink(lockFile);
        lock = await open(lockFile,"wx");
      } finally {
        await recovery.close();
        await unlink(`${lockFile}.recovery`).catch(() => {});
      }
    } else {
      throw error;
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return await run();
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}

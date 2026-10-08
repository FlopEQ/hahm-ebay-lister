import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { withWorkspaceLock } from "./workspace-lock";
import { notePhotoAssetUse } from "./photo-cleanup";

export const MAX_PHOTO_ASSET_BASE64_CHARS = 2_700_000;
const MAX_DIMENSION = 2400;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
const ASSET_ID = /^[a-f0-9]{64}$/;

function assetDirectory(): string {
  return path.resolve(process.env.WORKSPACE_DATA_DIR || path.join(process.cwd(), "data"), "photo-assets");
}
function assetPath(assetId: string): string {
  if (!ASSET_ID.test(assetId)) throw new Error("Invalid saved photo reference. Restore the original photo before uploading.");
  return path.join(assetDirectory(), `${assetId}.jpg`);
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function decodeBase64(data: string): Buffer {
  if (typeof data !== "string" || !data || data.length > MAX_PHOTO_ASSET_BASE64_CHARS ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new Error("The listing photo must be a JPEG within the upload size limit. Import the photo again.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("The listing photo encoding is invalid. Import the photo again.");
  return bytes;
}
async function validateJpeg(bytes: Buffer): Promise<void> {
  if (bytes.length * 4 / 3 > MAX_PHOTO_ASSET_BASE64_CHARS || bytes.length < 4 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    throw new Error("The saved listing photo is incomplete or invalid. Import the original photo again.");
  try {
    const options = { failOn: "warning" as const, limitInputPixels: MAX_PIXELS };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== "jpeg" || !metadata.width || !metadata.height ||
        metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages || 1) !== 1)
      throw new Error("Unsupported listing photo dimensions.");
    // Metadata alone does not establish that a JPEG can be decoded in full.
    await sharp(bytes, options).raw().toBuffer();
  } catch {
    throw new Error("The saved listing photo cannot be read or exceeds 2400 pixels. Import the original photo again.");
  }
}

export async function savePhotoAsset(data: string): Promise<string> {
  const bytes = decodeBase64(data);
  await validateJpeg(bytes);
  return withWorkspaceLock(async () => {
    const assetId = await savePhotoAssetBytes(bytes);
    await notePhotoAssetUse(assetId);
    return assetId;
  });
}

async function savePhotoAssetBytes(bytes: Buffer): Promise<string> {
  const assetId = digest(bytes);
  const file = assetPath(assetId);
  await mkdir(assetDirectory(), { recursive: true });
  const directory = await lstat(assetDirectory());
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Photo storage must use an ordinary directory.");
  const matchesExisting = async (): Promise<boolean> => {
    let existing: Buffer;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected photo storage entry.");
      existing = await readFile(file);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("Could not verify the saved listing photo. Check storage access and try again.");
    }
    if (!existing.equals(bytes))
      throw new Error("The saved listing photo has changed or is corrupt. Restore the original saved photo before importing it again.");
    return true;
  };
  // On Windows, renaming over an existing file can fail while another process
  // briefly holds it open. Identical validated bytes are already durable.
  if (await matchesExisting()) return assetId;
  // Unique temporary names allow concurrent saves of identical photos. The
  // final path depends only on validated bytes, so replacing it is immutable.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const output = await open(temporary, "wx", 0o600);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    try { await rename(temporary, file); }
    catch (error) {
      // Another upload of this content may have won the rename. Never delete
      // its target, and never accept an existing target with different bytes.
      if (!await matchesExisting()) throw error;
    }
  } catch {
    throw new Error("Could not save the listing photo. Check available storage and import it again.");
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return assetId;
}

export async function loadPhotoAsset(assetId: string, rotation = 0): Promise<{ mediaType: string; data: string }> {
  const file = assetPath(assetId);
  if (!Number.isFinite(rotation) || rotation % 90 !== 0)
    throw new Error("Choose a quarter-turn photo rotation before uploading.");
  const bytes = await withWorkspaceLock(async () => {
    let saved: Buffer;
    try {
      const directory = await lstat(assetDirectory()), stat = await lstat(file);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unexpected photo storage entry.");
      saved = await readFile(file);
    } catch { throw new Error("The saved listing photo is missing or inaccessible. Import the original photo again before uploading."); }
    if (digest(saved) !== assetId)
      throw new Error("The saved listing photo has changed or is corrupt. Import the original photo again.");
    await validateJpeg(saved);
    await notePhotoAssetUse(assetId);
    return saved;
  });
  const degrees = ((rotation % 360) + 360) % 360;
  if (!degrees) return { mediaType: "image/jpeg", data: bytes.toString("base64") };
  try {
    for (let dimension = MAX_DIMENSION; dimension >= 200; dimension = Math.floor(dimension * 0.85)) {
      for (const quality of [90, 80, 70, 60, 50, 40]) {
        const encoded = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PIXELS })
          .rotate(degrees, { background: "#ffffff" }).flatten({ background: "#ffffff" })
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality }).toBuffer();
        const data = encoded.toString("base64");
        if (data.length <= MAX_PHOTO_ASSET_BASE64_CHARS) return { mediaType: "image/jpeg", data };
      }
    }
  } catch {
    throw new Error("Could not rotate the saved listing photo. Import the original photo again.");
  }
  throw new Error("The rotated listing photo exceeds the upload size limit. Import a smaller photo.");
}

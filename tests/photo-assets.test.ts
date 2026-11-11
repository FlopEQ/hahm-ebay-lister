import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { loadPhotoAsset, MAX_PHOTO_ASSET_BASE64_CHARS, savePhotoAsset } from "@/lib/photo-assets";
import { POST } from "@/app/api/photo-assets/route";
import { guardApiRequest } from "@/lib/api-guard";

vi.mock("@/lib/api-guard", () => ({ guardApiRequest: vi.fn(() => null) }));
let directory: string;
let previousDirectory: string | undefined;
async function jpeg(width = 120, height = 80): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#de3210" } }).jpeg().toBuffer();
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/photo-assets", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers } });
}

beforeEach(async () => {
  previousDirectory = process.env.WORKSPACE_DATA_DIR;
  directory = await mkdtemp(path.join(tmpdir(), "photo-assets-test-"));
  process.env.WORKSPACE_DATA_DIR = directory;
  vi.mocked(guardApiRequest).mockReturnValue(null);
});
afterEach(async () => {
  if (previousDirectory === undefined) delete process.env.WORKSPACE_DATA_DIR;
  else process.env.WORKSPACE_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("immutable listing photo storage", () => {
  it("saves exact bytes under their content hash and reloads losslessly", async () => {
    const bytes = await jpeg();
    const assetId = await savePhotoAsset(bytes.toString("base64"));
    expect(assetId).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(path.join(directory, "photo-assets", `${assetId}.jpg`))).toEqual(bytes);
    expect(await loadPhotoAsset(assetId)).toEqual({ mediaType: "image/jpeg", data: bytes.toString("base64") });
  });
  it("handles simultaneous identical uploads with no temporary files left behind", async () => {
    const data = (await jpeg()).toString("base64");
    const assets = await Promise.all(Array.from({ length: 30 }, () => savePhotoAsset(data)));
    expect(new Set(assets).size).toBe(1);
    expect(await readdir(path.join(directory, "photo-assets"))).toEqual([`${assets[0]}.jpg`]);
  });
  it("reuses an identical durable asset without rewriting it", async () => {
    const data = (await jpeg()).toString("base64");
    const id = await savePhotoAsset(data);
    expect(await savePhotoAsset(data)).toBe(id);
    expect(await loadPhotoAsset(id)).toEqual({ mediaType: "image/jpeg", data });
  });
  it("refuses to overwrite a changed target under the same immutable reference", async () => {
    const data = (await jpeg()).toString("base64");
    const id = await savePhotoAsset(data);
    const file = path.join(directory, "photo-assets", `${id}.jpg`);
    await writeFile(file, "preserve changed contents");
    await expect(savePhotoAsset(data)).rejects.toThrow("corrupt");
    expect(await readFile(file, "utf8")).toBe("preserve changed contents");
  });
  it.each(["../outside", "a".repeat(63), "A".repeat(64), "CON", "C:\\Windows\\system.ini"])("rejects unsafe reference %s", async id => {
    await expect(loadPhotoAsset(id)).rejects.toThrow("Invalid saved photo reference");
  });
  it("reports missing and changed files without falling back", async () => {
    await expect(loadPhotoAsset("f".repeat(64))).rejects.toThrow("missing");
    const id = await savePhotoAsset((await jpeg()).toString("base64"));
    await writeFile(path.join(directory, "photo-assets", `${id}.jpg`), "changed");
    await expect(loadPhotoAsset(id)).rejects.toThrow("corrupt");
  });
  it("rejects noncanonical base64, non-JPEG bytes and excess encoded size", async () => {
    const valid = (await jpeg()).toString("base64");
    for (const data of [`data:image/jpeg;base64,${valid}`, valid + "\n", "!!!!", "Zh==", "a".repeat(MAX_PHOTO_ASSET_BASE64_CHARS + 4)])
      await expect(savePhotoAsset(data)).rejects.toThrow();
    const png = await sharp({ create: { width: 5, height: 5, channels: 4, background: "transparent" } }).png().toBuffer();
    await expect(savePhotoAsset(png.toString("base64"))).rejects.toThrow("incomplete or invalid");
  });
  it("rejects overlarge dimensions and truncated JPEGs even with an end marker", async () => {
    await expect(savePhotoAsset((await jpeg(2401, 2)).toString("base64"))).rejects.toThrow("exceeds 2400");
    const valid = await jpeg(600, 400);
    const incomplete = Buffer.concat([valid.subarray(0, Math.floor(valid.length * 0.75)), Buffer.from([0xff, 0xd9])]);
    await expect(savePhotoAsset(incomplete.toString("base64"))).rejects.toThrow();
  });
  it("rotates by quarter turns without enlarging the source", async () => {
    const id = await savePhotoAsset((await jpeg(120, 80)).toString("base64"));
    for (const rotation of [90, -90, 450]) {
      const output = await loadPhotoAsset(id, rotation);
      const metadata = await sharp(Buffer.from(output.data, "base64")).metadata();
      expect(metadata).toMatchObject({ format: "jpeg", width: 80, height: 120 });
      expect(output.data.length).toBeLessThanOrEqual(MAX_PHOTO_ASSET_BASE64_CHARS);
    }
    expect(await loadPhotoAsset(id, 360)).toEqual(await loadPhotoAsset(id));
    for (const rotation of [45, Infinity, NaN]) await expect(loadPhotoAsset(id, rotation)).rejects.toThrow("quarter-turn");
  });
  it("bounds the rotated output of a detailed large photo", async () => {
    const bytes = await sharp(randomBytes(2200 * 1800 * 3), { raw: { width: 2200, height: 1800, channels: 3 } })
      .jpeg({ quality: 45 }).toBuffer();
    const id = await savePhotoAsset(bytes.toString("base64"));
    const output = await loadPhotoAsset(id, 90);
    expect(output.data.length).toBeLessThanOrEqual(MAX_PHOTO_ASSET_BASE64_CHARS);
    const metadata = await sharp(Buffer.from(output.data, "base64")).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1800);
    expect(metadata.height).toBeLessThanOrEqual(2200);
  });
});

describe("guarded photo asset endpoint", () => {
  it("saves a valid JPEG and returns only its reference", async () => {
    const response = await POST(request({ mediaType: "image/jpeg", data: (await jpeg()).toString("base64") }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, assetId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(guardApiRequest).toHaveBeenCalledWith(expect.any(NextRequest), { bucket: "photo-assets", maxRequests: 600 });
  });
  it("checks access before reading or storing any photo", async () => {
    vi.mocked(guardApiRequest).mockReturnValue(NextResponse.json({ ok: false }, { status: 401 }));
    const response = await POST(request({ mediaType: "image/jpeg", data: (await jpeg()).toString("base64") }));
    expect(response.status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects invalid types and an excessive declared body length", async () => {
    const pngResponse = await POST(request({ mediaType: "image/png", data: "abc" }));
    expect(pngResponse.status).toBe(400);
    const tooLarge = await POST(request({}, { "content-length": String(MAX_PHOTO_ASSET_BASE64_CHARS + 5000) }));
    expect(tooLarge.status).toBe(400);
    expect((await tooLarge.json()).error).toContain("size limit");
    expect(await readdir(directory)).toEqual([]);
  });
  it("bounds actual request bytes even without content length", async () => {
    const response = await POST(request({ data: "a".repeat(MAX_PHOTO_ASSET_BASE64_CHARS + 2000) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("size limit");
    expect(await readdir(directory)).toEqual([]);
  });
});

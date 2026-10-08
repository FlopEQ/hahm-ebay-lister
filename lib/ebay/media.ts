import { boundedFetch } from "@/lib/network";

const MEDIA_BASE = "https://apim.ebay.com/commerce/media/v1_beta";
const MEDIA_ORIGINS = new Set(["https://apim.ebay.com", "https://api.ebay.com", "https://apiz.ebay.com"]);

function imageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      (host === "ebayimg.com" || host.endsWith(".ebayimg.com")) ? url.href : null;
  } catch { return null; }
}

function resourceUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (!MEDIA_ORIGINS.has(url.origin) || url.username || url.password || url.search || url.hash ||
      !/^\/commerce\/media\/v1_beta\/image\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function failure(status: number): Error {
  if (status === 401 || status === 403) return new Error("eBay photo upload authorization failed. Reconnect eBay and check inventory access.");
  if (status === 400) return new Error("eBay rejected the photo. Check its format, dimensions, and file size.");
  if (status === 429) return new Error("eBay photo upload reached its rate limit. Wait before retrying the unfinished upload.");
  if (status === 404) return new Error("The uploaded eBay photo could not be found or has expired.");
  return new Error(`eBay photo upload failed (HTTP ${status}). The unfinished photo was not confirmed.`);
}

async function readImage(response: Response): Promise<string | null> {
  try { return imageUrl((await response.json())?.imageUrl); }
  catch { return null; }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try { return await boundedFetch(url, init); }
  catch { throw new Error("eBay photo upload was interrupted. The unfinished photo was not confirmed."); }
}

/** One create request only: a lost response must never trigger a blind POST retry. */
export async function uploadMediaImage(accessToken: string, data: string, mediaType: string, name: string): Promise<string> {
  const bytes = Buffer.from(data.includes(",") ? data.slice(data.indexOf(",") + 1) : data, "base64");
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const response = await request(`${MEDIA_BASE}/image/create_image_from_file`, {
    method: "POST", headers, body: form, redirect: "error",
  });
  if (response.status !== 201) throw failure(response.status);
  const result = await readImage(response);
  if (result) return result;
  const resource = resourceUrl(response.headers.get("location"));
  if (resource) {
    const recovered = await request(resource, { method: "GET", headers, redirect: "error" });
    if (!recovered.ok) throw failure(recovered.status);
    const recoveredUrl = await readImage(recovered);
    if (recoveredUrl) return recoveredUrl;
  }
  throw new Error("eBay did not return a valid uploaded photo URL. The unfinished photo was not confirmed.");
}

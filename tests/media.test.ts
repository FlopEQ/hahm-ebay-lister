import { afterEach, describe, expect, test, vi } from "vitest";
import { uploadMediaImage } from "../lib/ebay/media";

const eps = "https://i.ebayimg.com/images/g/photo/s-l1600.jpg";
const location = "https://apim.ebay.com/commerce/media/v1_beta/image/abc-123";
afterEach(() => vi.unstubAllGlobals());

describe("Media API image upload", () => {
  test("includes structured eBay reasons, redacts the token, and never retries POST", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{
      errorId: 12345, message: "Short reason", longMessage: "Photo too small. private-token" }] }), { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("private-token", "aGVsbG8=", "image/jpeg", "book.jpg"))
      .rejects.toThrow("eBay error 12345: Photo too small. [redacted]");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test("reports a recovery GET rejection with eBay's reason", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 201, headers: { location } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ errorId: 99, message: "Image expired" }] }), { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg"))
      .rejects.toThrow("eBay error 99: Image expired");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("bounds malformed or oversized error details", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "x".repeat(2000) }] }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: { private: "data" } }] }), { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const error = await uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg").catch(e => e);
    expect(error.message.length).toBeLessThan(550);
    await expect(uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg"))
      .rejects.toThrow("HTTP 500");
  });
  test("uploads one binary multipart image and returns the listing URL", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ imageUrl: eps }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await uploadMediaImage("private-token", "aGVsbG8=", "image/jpeg", "book.jpg")).toBe(eps);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file");
    expect(options.headers).toEqual({ Authorization: "Bearer private-token", Accept: "application/json" });
    expect(options.redirect).toBe("error");
    expect(options.body.get("XML Payload")).toBeNull();
    const file = options.body.get("image") as File;
    expect(file.name).toBe("book.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(await file.text()).toBe("hello");
  });

  test("recovers a missing URL with one authenticated GET", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 201, headers: { location } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imageUrl: eps }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg")).toBe(eps);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(location);
    expect(fetch.mock.calls[1][1].method).toBe("GET");
    expect(fetch.mock.calls[1][1].redirect).toBe("error");
  });

  test.each(["https://attacker.example/image/abc", "https://apim.ebay.com/commerce/media/v1_beta/image/abc?token=x", "https://apim.ebay.com/elsewhere", "https://user:pass@apim.ebay.com/commerce/media/v1_beta/image/abc"])("never follows hostile Location %s", async (hostile) => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 201, headers: { location: hostile } }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg")).rejects.toThrow("valid uploaded photo URL");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(["http://i.ebayimg.com/a.jpg", "https://ebayimg.com.attacker.example/a.jpg", "https://i.ebayimg.com:8443/a.jpg"])("rejects invalid returned URL %s", async (url) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ imageUrl: url }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg")).rejects.toThrow("valid uploaded photo URL");
  });

  test("reports safe errors without response contents or POST retries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("private-token secret details", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("private-token", "aGVsbG8=", "image/jpeg", "book.jpg")).rejects.toThrow("authorization failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not repeat an upload after a lost response", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMediaImage("token", "aGVsbG8=", "image/jpeg", "book.jpg")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ebay/media", () => ({uploadMediaImage:vi.fn()}));
import { uploadMediaImage } from "@/lib/ebay/media";
import { PhotoUploadError, uploadPhotos } from "@/lib/ebay/publish";
const deferred = () => { let resolve!: (url:string) => void, reject!: (error:Error) => void;
  const promise = new Promise<string>((yes,no) => {resolve = yes;reject = no;}); return {promise,resolve,reject}; };
const images = (n:number) => Array.from({length:n},(_,i) => ({mediaType:"image/jpeg",data:`photo${i}`}));
beforeEach(() => { vi.mocked(uploadMediaImage).mockReset(); });
describe("ordered eBay photo uploads", () => {
  it("keeps input ordering when upload responses complete out of order", async () => {
    const gates = Array.from({length:4},deferred);
    vi.mocked(uploadMediaImage).mockImplementation((_token,data) => gates[Number(data.slice(5))].promise);
    const pending = uploadPhotos("token",images(4),"SKU",8);
    gates[3].resolve("url3");gates[1].resolve("url1");gates[2].resolve("url2");gates[0].resolve("url0");
    expect(await pending).toEqual(["url0","url1","url2","url3"]);
    expect(vi.mocked(uploadMediaImage).mock.calls.map(call => call[3])).toEqual(["SKU-9.jpg","SKU-10.jpg","SKU-11.jpg","SKU-12.jpg"]);
  });
  it("waits for every started upload and returns only the prefix before the first failure", async () => {
    const gates = Array.from({length:4},deferred);
    vi.mocked(uploadMediaImage).mockImplementation((_token,data) => gates[Number(data.slice(5))].promise);
    let settled = false;
    const outcome = uploadPhotos("token",images(4),"SKU").then(value => ({value,error:undefined}),error => ({value:undefined,error})).finally(() => {settled = true;});
    gates[1].reject(new Error("Second image rejected"));gates[0].resolve("url0");
    await Promise.resolve();await Promise.resolve();
    expect(settled).toBe(false);
    gates[3].resolve("url3");gates[2].resolve("url2");
    const result = await outcome;
    expect(result.error).toBeInstanceOf(PhotoUploadError);
    expect(result.error.urls).toEqual(["url0"]);
    expect(result.error.message).toBe("Second image rejected");
    expect(uploadMediaImage).toHaveBeenCalledTimes(4);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
vi.mock("@/lib/api-guard", () => ({ guardApiRequest: vi.fn(() => null) }));
vi.mock("@/lib/ebay/session", () => ({ EBAY_COOKIE: "ebay", accessTokenFromCookie: vi.fn(async () => "token") }));
vi.mock("@/lib/photo-assets", () => ({ loadPhotoAsset: vi.fn(async () => ({mediaType:"image/jpeg",data:"YQ=="})) }));
vi.mock("@/lib/ebay/publish", () => ({ uploadPhotos: vi.fn(), PhotoUploadError: class extends Error {
  constructor(message:string,public urls:string[]) { super(message); }
} }));
import { POST } from "@/app/api/ebay/upload-photos/route";
import { loadPhotoAsset } from "@/lib/photo-assets";
import { uploadPhotos, PhotoUploadError } from "@/lib/ebay/publish";
import { guardApiRequest } from "@/lib/api-guard";
import { accessTokenFromCookie } from "@/lib/ebay/session";
const raw = {mediaType:"image/jpeg",data:"YQ=="};
const asset = (rotation = 0, digit = "a") => ({assetId:digit.repeat(64),rotation});
const request = (images:unknown[],startIndex=0) => new NextRequest("http://localhost/api/ebay/upload-photos",{method:"POST",body:JSON.stringify({sku:"BIN-1",images,startIndex})});
beforeEach(() => {
  vi.mocked(guardApiRequest).mockReset().mockReturnValue(null);
  vi.mocked(accessTokenFromCookie).mockReset().mockResolvedValue("token");
  vi.mocked(loadPhotoAsset).mockReset().mockResolvedValue(raw);
  vi.mocked(uploadPhotos).mockReset().mockImplementation(async (_token, images) => images.map((_,i) => `https://i.ebayimg.com/${i}.jpg`));
});
describe("photo upload route", () => {
  it.each([undefined,"12"])("cancels an oversized streamed body despite declared length %s",async declared => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new Uint8Array(2_000_000));
      controller.enqueue(new Uint8Array(2_000_000));
      controller.enqueue(new Uint8Array(1));
    },cancel});
    const headers = new Headers(); if (declared) headers.set("content-length",declared);
    const req = {headers,body} as NextRequest;
    expect((await POST(req)).status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(loadPhotoAsset).not.toHaveBeenCalled(); expect(uploadPhotos).not.toHaveBeenCalled();
  });
  it("rejects a declared oversized body before reading any bytes",async () => {
    const getReader = vi.fn(() => {throw new Error("Must not read oversized body");});
    const req = {headers:new Headers({"content-length":"4000001"}),body:{getReader}} as unknown as NextRequest;
    expect((await POST(req)).status).toBe(413);
    expect(getReader).not.toHaveBeenCalled();
    expect(loadPhotoAsset).not.toHaveBeenCalled(); expect(uploadPhotos).not.toHaveBeenCalled();
  });
  it("allows the 24th selected photo but refuses a 25th", async () => {
    expect((await POST(request([raw],23))).status).toBe(200);
    expect((await POST(request([raw],24))).status).toBe(400);
    expect(uploadPhotos).toHaveBeenCalledTimes(1);
  });
  it.each([asset(45),asset(Infinity),asset(0,"z"),{...asset(),data:"YQ=="}])("rejects malformed private asset references",async ref => {
    expect((await POST(request([ref]))).status).toBe(400);
    expect(loadPhotoAsset).not.toHaveBeenCalled(); expect(uploadPhotos).not.toHaveBeenCalled();
  });
  it("resolves all assets before creating any eBay images",async () => {
    vi.mocked(loadPhotoAsset).mockResolvedValueOnce(raw).mockRejectedValueOnce(new Error("Missing second asset"));
    const res = await POST(request([asset(),asset(90,"b")]));
    expect(res.status).toBe(422); expect((await res.json()).error).toContain("Missing second asset");
    expect(uploadPhotos).not.toHaveBeenCalled();
  });
  it("retains legacy raw uploads and mixed reference order", async () => {
    const resolved = {mediaType:"image/jpeg",data:"Yg=="};
    vi.mocked(loadPhotoAsset).mockResolvedValue(resolved);
    const images = [raw,asset(270),{...raw,data:"Yw=="}];
    expect((await POST(request(images,5))).status).toBe(200);
    expect(loadPhotoAsset).toHaveBeenCalledWith("a".repeat(64),270);
    expect(uploadPhotos).toHaveBeenCalledWith("token",[raw,resolved,images[2]],"BIN-1",5);
  });
  it("returns only confirmed prefix URLs after failure without automatically retrying", async () => {
    vi.mocked(uploadPhotos).mockRejectedValueOnce(new PhotoUploadError("Photo failed",["https://i.ebayimg.com/first.jpg"]));
    const res = await POST(request([raw,raw,raw]));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ok:false,urls:["https://i.ebayimg.com/first.jpg"],failed:2,error:"Photo failed"});
    expect(uploadPhotos).toHaveBeenCalledTimes(1);
  });
  it("enforces access guard and connected session", async () => {
    vi.mocked(guardApiRequest).mockReturnValueOnce(NextResponse.json({error:"Denied"},{status:403}));
    expect((await POST(request([raw]))).status).toBe(403);
    expect(uploadPhotos).not.toHaveBeenCalled();
    vi.mocked(accessTokenFromCookie).mockResolvedValueOnce(null);
    expect((await POST(request([raw]))).status).toBe(401);
    expect(uploadPhotos).not.toHaveBeenCalled();
  });
});

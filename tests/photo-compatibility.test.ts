import { describe, expect, it } from "vitest";
import { normalizeSavedPhotos, photoFingerprintSource } from "@/lib/photo-fingerprint";
import { chunkImagesForUpload, MAX_BATCH_BASE64_CHARS, MAX_BATCH_PHOTOS, type PhotoUpload } from "@/lib/uploadBatches";
import { ebayPhotoIds } from "@/lib/photoSelection";
import type { ItemGroup, Photo } from "@/lib/types";
const legacy:Photo = {id:"p1",mediaType:"image/jpeg",data:"YQ==",previewUrl:"data:image/jpeg;base64,YQ=="};
describe("photo compatibility", () => {
  it("preserves the exact legacy fingerprint serialization while identifying new assets", () => {
    expect(JSON.stringify(photoFingerprintSource(legacy,90))).toBe(JSON.stringify({id:"p1",data:"YQ==",rotation:90}));
    const first = photoFingerprintSource({...legacy,uploadAssetId:"a".repeat(64)},90);
    expect(first).toEqual({id:"p1",data:"YQ==",rotation:90,uploadAssetId:"a".repeat(64),uploadEncoding:"jpeg-2400-v1"});
    expect(first).not.toEqual(photoFingerprintSource({...legacy,uploadAssetId:"b".repeat(64)},90));
  });
  it("saves references and legacy data while stripping transient high resolution bytes", () => {
    expect(normalizeSavedPhotos([{...legacy,uploadData:"large"},{...legacy,id:"p2",uploadAssetId:"a".repeat(64),uploadData:"large"}]))
      .toEqual([legacy,{...legacy,id:"p2",uploadAssetId:"a".repeat(64)}]);
    expect(() => normalizeSavedPhotos([{...legacy,uploadAssetId:"invalid"}])).toThrow(/asset/i);
  });
  it("bounds mixed reference/raw upload batches by size and count without changing order", () => {
    const images:PhotoUpload[] = [{mediaType:"image/jpeg",data:"a".repeat(2_700_000)},
      ...Array.from({length:24},(_,i) => ({assetId:String(i).padStart(64,"a"),rotation:0})),
      {mediaType:"image/jpeg",data:"a".repeat(200_000)}];
    const batches = chunkImagesForUpload(images);
    expect(batches.flat()).toEqual(images);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_PHOTOS);
      expect(batch.reduce((n,image) => n + ("data" in image ? image.data.length : 128),0)).toBeLessThanOrEqual(MAX_BATCH_BASE64_CHARS);
    }
  });
  it("selects up to 24 visible photos in their existing order", () => {
    const group:ItemGroup = {id:"g",name:"item",sku:"SKU",status:"idle",photoIds:Array.from({length:27},(_,i) => `p${i}`),hiddenPhotoIds:["p0","p2"]};
    const selected = ebayPhotoIds(group);
    expect(selected).toHaveLength(24); expect(selected[0]).toBe("p1"); expect(selected[23]).toBe("p25");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import type { SavedWorkspace } from "@/lib/types";
vi.mock("@/lib/api-guard", () => ({guardApiRequest:vi.fn(() => null)}));
let directory:string;
let route:typeof import("@/app/api/workspace/route");
let assets:typeof import("@/lib/photo-assets");
let cleanup:typeof import("@/lib/photo-cleanup");
let guard:typeof import("@/lib/api-guard");
const ledgerFile = () => path.join(directory,"photo-cleanup.json");
const ledger = async () => JSON.parse(await readFile(ledgerFile(),"utf8"));
function request(body:unknown) { return new NextRequest("http://localhost/api/workspace",{method:"POST",body:JSON.stringify(body)}); }
async function action(body:unknown) {
  const response = await route.POST(request(body));const data = await response.json();
  expect(response.status,JSON.stringify(data)).toBe(200);expect(data.ok).toBe(true);return data;
}
function workspace(ids:string[]):SavedWorkspace {
  return {version:1,updatedAt:new Date().toISOString(),photos:ids.map((id,i) => ({id:`p${i}`,mediaType:"image/jpeg",data:"YQ==",previewUrl:"data:image/jpeg;base64,YQ==",uploadAssetId:id})),
    binPrefix:"",batchCategory:"other",step:"upload",groups:[],orphanIds:[],skuStart:0};
}
async function photo() {
  const bytes = await sharp({create:{width:40,height:30,channels:3,background:"#ca1234"}}).jpeg().toBuffer();
  const data = bytes.toString("base64");return {id:await assets.savePhotoAsset(data),data};
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(),"photo-cleanup-workspace-test-"));
  vi.stubEnv("WORKSPACE_DATA_DIR",directory);vi.stubEnv("NODE_ENV","test");
  vi.resetModules();
  guard = await import("@/lib/api-guard");vi.mocked(guard.guardApiRequest).mockReturnValue(null);
  route = await import("@/app/api/workspace/route");assets = await import("@/lib/photo-assets");cleanup = await import("@/lib/photo-cleanup");
});
afterEach(async () => {vi.unstubAllEnvs();vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});

describe("workspace photo retention integration", () => {
  it("keeps duplicate batch photos until the final referencing batch is deleted, then starts seven days",async () => {
    const {id} = await photo();const created = await action({action:"create",name:"Original"});
    await action({action:"save",batchId:created.batch.id,workspace:workspace([id])});
    const duplicated = await action({action:"duplicate",batchId:created.batch.id});
    await action({action:"delete",batchId:created.batch.id});
    expect((await ledger()).firstUnreferencedAt[id]).toBeUndefined();
    expect((await readFile(path.join(directory,"photo-assets",`${id}.jpg`))).length).toBeGreaterThan(0);
    const before = Date.now();await action({action:"delete",batchId:duplicated.batch.id});
    const marked = (await ledger()).firstUnreferencedAt[id];expect(marked).toBeGreaterThanOrEqual(before);
    expect(await cleanup.cleanupPhotoAssets({dataDir:directory,now:marked+cleanup.PHOTO_RETENTION_MS})).toMatchObject({status:"complete",deleted:1});
    await expect(readFile(path.join(directory,"photo-assets",`${id}.jpg`))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("starts orphan age when a saved photo is removed and clears it when saved again",async () => {
    const {id} = await photo();const created = await action({action:"create"});
    await action({action:"save",batchId:created.batch.id,workspace:workspace([id])});
    expect((await ledger()).firstUnreferencedAt[id]).toBeUndefined();
    const before = Date.now();await action({action:"save",batchId:created.batch.id,workspace:workspace([])});
    expect((await ledger()).firstUnreferencedAt[id]).toBeGreaterThanOrEqual(before);
    await action({action:"save",batchId:created.batch.id,workspace:workspace([id])});
    expect((await ledger()).firstUnreferencedAt[id]).toBeUndefined();
  });
  it("rejects stale photo references after cleanup without rewriting the saved batch",async () => {
    const {id} = await photo();const created = await action({action:"create"});
    await action({action:"save",batchId:created.batch.id,workspace:workspace([id])});
    await action({action:"save",batchId:created.batch.id,workspace:workspace([])});
    const marked = (await ledger()).firstUnreferencedAt[id];
    await cleanup.cleanupPhotoAssets({dataDir:directory,now:marked+cleanup.PHOTO_RETENTION_MS});
    const file = path.join(directory,"batches",`${created.batch.id}.json`),before = await readFile(file,"utf8");
    const response = await route.POST(request({action:"save",batchId:created.batch.id,workspace:workspace([id])}));
    expect(response.status).toBe(500);expect((await response.json()).error).toMatch(/missing/i);
    expect(await readFile(file,"utf8")).toBe(before);
  });
  it("reports successful batch deletion even when cleanup metadata is corrupt",async () => {
    const created = await action({action:"create"});await writeFile(ledgerFile(),"{corrupt ledger");
    vi.spyOn(console,"warn").mockImplementation(() => {});
    await action({action:"delete",batchId:created.batch.id});
    await expect(readFile(path.join(directory,"batches",`${created.batch.id}.json`))).rejects.toMatchObject({code:"ENOENT"});
    const index = JSON.parse(await readFile(path.join(directory,"batches","index.json"),"utf8"));expect(index.batches).toEqual([]);
  });
  it("uses the real access guard to prevent unauthorized scheduler or storage mutations",async () => {
    const actual = await vi.importActual<typeof import("@/lib/api-guard")>("@/lib/api-guard");
    vi.mocked(guard.guardApiRequest).mockImplementation(actual.guardApiRequest);
    vi.stubEnv("APP_SECRET","test-secret");vi.stubEnv("NODE_ENV","production");
    expect((await route.POST(request({action:"create"}))).status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
    expect((globalThis as typeof globalThis & {__photoCleanupTimers?:Map<string,unknown>}).__photoCleanupTimers?.has(path.resolve(directory)) ?? false).toBe(false);
  });
  it("refreshes retention when identical immutable bytes are imported again",async () => {
    const {id,data} = await photo();const old = Date.now()-cleanup.PHOTO_RETENTION_MS;
    await writeFile(ledgerFile(),JSON.stringify({version:1,firstUnreferencedAt:{[id]:old}}));
    const before = Date.now();expect(await assets.savePhotoAsset(data)).toBe(id);
    expect((await ledger()).firstUnreferencedAt[id]).toBeGreaterThanOrEqual(before);
    expect((await readdir(path.join(directory,"photo-assets"))).filter(name => name.endsWith(".jpg"))).toEqual([`${id}.jpg`]);
  });
  it("refreshes retention when a stored asset is loaded without rotation",async () => {
    const {id,data} = await photo();const old = Date.now()-cleanup.PHOTO_RETENTION_MS;
    await writeFile(ledgerFile(),JSON.stringify({version:1,firstUnreferencedAt:{[id]:old}}));
    const before = Date.now();expect(await assets.loadPhotoAsset(id)).toEqual({mediaType:"image/jpeg",data});
    expect((await ledger()).firstUnreferencedAt[id]).toBeGreaterThanOrEqual(before);
  });
});

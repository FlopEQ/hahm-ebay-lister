import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { cleanupPhotoAssets, notePhotoAssetUse, PHOTO_RETENTION_MS, protectSavedPhotoAssets } from "@/lib/photo-cleanup";
import { withWorkspaceLock } from "@/lib/workspace-lock";
let directory:string, outside:string, now:number;
const json = (file:string,value:unknown) => writeFile(file,JSON.stringify(value),"utf8");
const ledgerFile = () => path.join(directory,"photo-cleanup.json");
const ledger = async () => JSON.parse(await readFile(ledgerFile(),"utf8"));
const assetFile = (id:string) => path.join(directory,"photo-assets",`${id}.jpg`);
async function asset(color:number) {
  const bytes = await sharp({create:{width:20,height:15,channels:3,background:{r:color,g:10,b:20}}}).jpeg().toBuffer();
  const id = createHash("sha256").update(bytes).digest("hex");
  await writeFile(assetFile(id),bytes); return id;
}
function workspace(ids:string[]) {
  return {version:1,updatedAt:new Date(now).toISOString(),photos:ids.map((id,i) => ({id:`p${i}`,mediaType:"image/jpeg",data:"YQ==",previewUrl:"data:image/jpeg;base64,YQ==",uploadAssetId:id})),
    binPrefix:"",batchCategory:"other",step:"upload",groups:[],orphanIds:[],skuStart:0};
}
async function batch(id:string,ids:string[],archived=false) {
  await json(path.join(directory,"batches",`${id}.json`),{id,name:id,archived,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),workspace:workspace(ids)});
}
async function index(ids:string[] = []) {
  await json(path.join(directory,"batches","index.json"),{version:1,activeBatchId:ids[0] || null,batches:ids.map(id => ({id,name:id,archived:id==="archived",createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()}))});
}
beforeEach(async () => {
  now = Date.now(); directory = await mkdtemp(path.join(tmpdir(),"photo-cleanup-test-"));
  outside = await mkdtemp(path.join(tmpdir(),"photo-cleanup-outside-test-"));
  await mkdir(path.join(directory,"photo-assets")); await mkdir(path.join(directory,"batches")); await index();
});
afterEach(async () => {
  // Both roots are unique mkdtemp outputs owned solely by this test.
  await rm(directory,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true});
});
const sweep = (time=now) => cleanupPhotoAssets({dataDir:directory,now:time});
describe("seven day orphan photo retention", () => {
  it("keeps assets referenced by active, archived, duplicate, unindexed and legacy workspaces",async () => {
    const ids = await Promise.all([20,40,60,80,100].map(asset));
    await batch("active",[ids[0]]);await batch("archived",[ids[1]],true);await batch("duplicate",[ids[2]]);await batch("unindexed",[ids[3]]);
    await index(["active","archived","duplicate"]);await json(path.join(directory,"workspace.json"),workspace([ids[4]]));
    expect(await sweep()).toMatchObject({status:"complete",deleted:0,pending:0});
    expect(await sweep(now+PHOTO_RETENTION_MS*2)).toMatchObject({status:"complete",deleted:0,pending:0});
    for (const id of ids) expect((await readFile(assetFile(id))).length).toBeGreaterThan(0);
  });
  it("starts aging at the first healthy unreferenced scan instead of an old file mtime",async () => {
    const id = await asset(20);await utimes(assetFile(id),new Date(0),new Date(0));
    expect(await sweep()).toMatchObject({status:"complete",deleted:0,pending:1});
    expect((await ledger()).firstUnreferencedAt[id]).toBe(now);
    expect(await sweep(now+PHOTO_RETENTION_MS-1)).toMatchObject({deleted:0,pending:1});
    expect(await sweep(now+PHOTO_RETENTION_MS)).toMatchObject({status:"complete",deleted:1,pending:0});
    await expect(readFile(assetFile(id))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("clears orphan age when a saved batch references the asset and starts fresh after removal",async () => {
    const id = await asset(30);await sweep();await batch("kept",[id]);await index(["kept"]);
    await sweep(now+PHOTO_RETENTION_MS);expect((await ledger()).firstUnreferencedAt[id]).toBeUndefined();
    await batch("kept",[]);await sweep(now+PHOTO_RETENTION_MS+10);
    expect((await ledger()).firstUnreferencedAt[id]).toBe(now+PHOTO_RETENTION_MS+10);
    expect(await sweep(now+PHOTO_RETENTION_MS*2)).toMatchObject({deleted:0,pending:1});
  });
  it("resets the unsaved retention age when an asset is reused",async () => {
    const id = await asset(40);await sweep();
    await notePhotoAssetUse(id,directory,now+PHOTO_RETENTION_MS-10);
    expect(await sweep(now+PHOTO_RETENTION_MS)).toMatchObject({deleted:0,pending:1});
    expect((await ledger()).firstUnreferencedAt[id]).toBeGreaterThanOrEqual(now+PHOTO_RETENTION_MS-10);
  });
  it("validates saved references before clearing markers",async () => {
    const id = await asset(50);await sweep();
    await expect(protectSavedPhotoAssets([id,"f".repeat(64)],directory)).rejects.toThrow();
    expect((await readFile(assetFile(id))).length).toBeGreaterThan(0);
    await protectSavedPhotoAssets([id],directory);
    expect((await ledger()).firstUnreferencedAt[id]).toBeUndefined();
  });
  it.each(["corrupt-index","missing-index","missing-indexed-batch","corrupt-physical-batch"])("pauses and restarts age after uncertain workspace state: %s",async problem => {
    const id = await asset(60);await sweep();
    if (problem==="corrupt-index") await writeFile(path.join(directory,"batches","index.json"),"{");
    if (problem==="missing-index") await unlink(path.join(directory,"batches","index.json"));
    if (problem==="missing-indexed-batch") await index(["missing"]);
    if (problem==="corrupt-physical-batch") await writeFile(path.join(directory,"batches","unknown.json"),"{");
    expect(await sweep(now+PHOTO_RETENTION_MS)).toMatchObject({status:"paused",deleted:0});
    expect((await readFile(assetFile(id))).length).toBeGreaterThan(0);
    await index();await rm(path.join(directory,"batches","unknown.json"),{force:true});
    expect(await sweep(now+PHOTO_RETENTION_MS+1)).toMatchObject({status:"complete",deleted:0,pending:1});
    expect((await ledger()).firstUnreferencedAt[id]).toBe(now+PHOTO_RETENTION_MS+1);
  });
  it("fails closed on a malformed orphan ledger",async () => {
    const id = await asset(70);await writeFile(ledgerFile(),"{bad ledger");
    expect(await sweep(now+PHOTO_RETENTION_MS*2)).toMatchObject({status:"paused",deleted:0});
    expect((await readFile(assetFile(id))).length).toBeGreaterThan(0);
  });
  it("tolerates missing marked files and leaves unknown and temporary files untouched",async () => {
    const id = await asset(80);await sweep();await unlink(assetFile(id));
    await writeFile(path.join(directory,"photo-assets","notes.txt"),"keep");
    await writeFile(path.join(directory,"photo-assets",`${id}.jpg.pending.tmp`),"keep");
    expect(await sweep(now+PHOTO_RETENTION_MS)).toMatchObject({status:"complete",deleted:0,pending:0});
    expect(await readdir(path.join(directory,"photo-assets"))).toEqual(expect.arrayContaining(["notes.txt",`${id}.jpg.pending.tmp`]));
  });
  it("serializes cleanup behind a workspace save and preserves newly saved references",async () => {
    const id = await asset(90);await sweep();
    let release!:()=>void,entered!:()=>void;
    const gate = new Promise<void>(resolve => {release=resolve;});
    const started = new Promise<void>(resolve => {entered=resolve;});
    const save = withWorkspaceLock(async () => {entered();await gate;await batch("new-save",[id]);await index(["new-save"]);},directory);
    await started;
    const cleanup = sweep(now+PHOTO_RETENTION_MS);
    release();await save;
    expect(await cleanup).toMatchObject({status:"complete",deleted:0,pending:0});
    expect((await readFile(assetFile(id))).length).toBeGreaterThan(0);
  });
  it("writes a complete atomic ledger across simultaneous sweeps without leftover temporary files",async () => {
    const id = await asset(100);
    const results = await Promise.all(Array.from({length:8},() => sweep()));
    expect(results.every(result => result.status==="complete")).toBe(true);
    expect(await ledger()).toEqual({version:1,firstUnreferencedAt:{[id]:now}});
    expect((await readdir(directory)).filter(name => name.includes(".tmp"))).toEqual([]);
  });
  it("does not age an asset against a marker from a future clock",async () => {
    const id = await asset(110);
    await json(ledgerFile(),{version:1,firstUnreferencedAt:{[id]:now+PHOTO_RETENTION_MS}});
    expect(await sweep()).toMatchObject({status:"complete",deleted:0,pending:1});
    expect((await ledger()).firstUnreferencedAt[id]).toBe(now);
  });
  it("pauses on a photo directory junction and never touches its outside target",async () => {
    const sentinel = path.join(outside,`${"a".repeat(64)}.jpg`);await writeFile(sentinel,"outside protected");
    await rm(path.join(directory,"photo-assets"),{recursive:true});
    await symlink(outside,path.join(directory,"photo-assets"),process.platform==="win32" ? "junction" : "dir");
    expect(await sweep(now+PHOTO_RETENTION_MS*2)).toMatchObject({status:"paused",deleted:0});
    expect(await readFile(sentinel,"utf8")).toBe("outside protected");
  });
});

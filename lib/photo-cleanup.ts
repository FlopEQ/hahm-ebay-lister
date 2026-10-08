import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withWorkspaceLock, workspaceDataDirectory } from "./workspace-lock";

export const PHOTO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_ID = /^[a-f0-9]{64}$/;
const BATCH_ID = /^[A-Za-z0-9_-]+$/;
interface Ledger { version: 1; firstUnreferencedAt: Record<string, number> }
export interface PhotoCleanupResult {
  status: "complete" | "paused"; deleted: number; pending: number; error?: string;
}

function rootDirectory(dataDir?: string) { return path.resolve(dataDir || workspaceDataDirectory()); }
async function regularFile(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected photo storage entry.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function directoryEntries(directory: string): Promise<string[] | null> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Photo storage must use ordinary directories.");
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function readLedger(root: string): Promise<Ledger> {
  const file = path.join(root, "photo-cleanup.json");
  if (!await regularFile(file)) return {version:1,firstUnreferencedAt:{}};
  const ledger = JSON.parse(await readFile(file,"utf8"));
  if (ledger?.version !== 1 || !ledger.firstUnreferencedAt || typeof ledger.firstUnreferencedAt !== "object" ||
      Array.isArray(ledger.firstUnreferencedAt) || Object.entries(ledger.firstUnreferencedAt)
        .some(([id,time]) => !ASSET_ID.test(id) || typeof time !== "number" || !Number.isFinite(time) || time < 0))
    throw new Error("Photo cleanup metadata cannot be read safely.");
  return ledger;
}
async function writeLedger(root: string, ledger: Ledger) {
  await mkdir(root,{recursive:true});
  const file = path.join(root,"photo-cleanup.json");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const output = await open(temporary,"wx",0o600);
    try { await output.writeFile(JSON.stringify(ledger)); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary,file);
  } finally { await unlink(temporary).catch(() => {}); }
}
function workspaceReferences(raw: unknown, refs: Set<string>) {
  const workspace = raw as {version?:unknown;photos?:unknown};
  if (workspace?.version !== 1 || !Array.isArray(workspace.photos))
    throw new Error("A saved batch cannot be read safely.");
  for (const photo of workspace.photos) {
    if (!photo || typeof photo !== "object") throw new Error("A saved photo cannot be read safely.");
    if ([photo.id,photo.previewUrl,photo.mediaType,photo.data].some(value => typeof value !== "string"))
      throw new Error("A saved photo cannot be read safely.");
    if (photo.uploadAssetId !== undefined) {
      if (typeof photo.uploadAssetId !== "string" || !ASSET_ID.test(photo.uploadAssetId))
        throw new Error("A saved photo reference cannot be read safely.");
      refs.add(photo.uploadAssetId);
    }
  }
}
async function allReferences(root: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const batches = path.join(root,"batches");
  const names = await directoryEntries(batches);
  if (names !== null) {
    const indexFile = path.join(batches,"index.json");
    if (!await regularFile(indexFile)) throw new Error("The saved batch index is missing.");
    const index = JSON.parse(await readFile(indexFile,"utf8"));
    if (index?.version !== 1 || !Array.isArray(index.batches)) throw new Error("The saved batch index cannot be read safely.");
    const storedNames = new Set(names.map(name => process.platform === "win32" ? name.toLowerCase() : name));
    for (const batch of index.batches)
      if (typeof batch?.id !== "string" || !BATCH_ID.test(batch.id) ||
          !storedNames.has(process.platform === "win32" ? `${batch.id}.json`.toLowerCase() : `${batch.id}.json`))
        throw new Error("An indexed saved batch is missing.");
    for (const name of names.filter(n => n.toLowerCase().endsWith(".json") && n.toLowerCase() !== "index.json")) {
      const file = path.join(batches,name);
      if (!await regularFile(file)) throw new Error("A saved batch is missing.");
      const record = JSON.parse(await readFile(file,"utf8"));
      workspaceReferences(record?.workspace,refs);
    }
  }
  const legacy = path.join(root,"workspace.json");
  if (await regularFile(legacy)) workspaceReferences(JSON.parse(await readFile(legacy,"utf8")),refs);
  return refs;
}

// An import or upload can use a photo before its batch save finishes. Refresh
// the grace period under the same lock as cleanup, including identical imports.
export async function notePhotoAssetUse(assetId: string, dataDir?: string, now = Date.now()) {
  if (!ASSET_ID.test(assetId) || !Number.isFinite(now) || now < 0) throw new Error("Invalid photo retention reference.");
  const root = rootDirectory(dataDir);
  return withWorkspaceLock(async () => {
    const ledger = await readLedger(root);
    ledger.firstUnreferencedAt[assetId] = now;
    await writeLedger(root,ledger);
  },root);
}

export async function protectSavedPhotoAssets(ids: string[], dataDir?: string) {
  if (ids.some(id => !ASSET_ID.test(id))) throw new Error("Invalid saved photo reference.");
  if (!ids.length) return;
  const root = rootDirectory(dataDir);
  return withWorkspaceLock(async () => {
    await directoryEntries(path.join(root,"photo-assets"));
    for (const id of new Set(ids))
      if (!await regularFile(path.join(root,"photo-assets",`${id}.jpg`)))
        throw new Error("A saved listing photo is missing. Import the original photo again before saving this batch.");
    const ledger = await readLedger(root);
    let changed = false;
    for (const id of ids) if (id in ledger.firstUnreferencedAt) { delete ledger.firstUnreferencedAt[id]; changed = true; }
    if (changed) await writeLedger(root,ledger);
  },root);
}

export async function cleanupPhotoAssets(options: {now?:number;dataDir?:string} = {}): Promise<PhotoCleanupResult> {
  const root = rootDirectory(options.dataDir), now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid photo cleanup time.");
  return withWorkspaceLock(async () => {
    let ledger: Ledger;
    try { ledger = await readLedger(root); }
    catch { return {status:"paused",deleted:0,pending:0,error:"Photo cleanup metadata cannot be read safely; photos were retained."}; }
    let refs: Set<string>, assets: string[];
    try {
      refs = await allReferences(root);
      assets = (await directoryEntries(path.join(root,"photo-assets")) || []).filter(n => /^[a-f0-9]{64}\.jpg$/.test(n));
      for (const name of assets)
        if (!await regularFile(path.join(root,"photo-assets",name))) throw new Error("A photo storage entry disappeared.");
    } catch {
      // Unknown references interrupt the proven orphan interval. Retain files
      // and restart their grace period after a complete healthy scan.
      ledger.firstUnreferencedAt = {};
      await writeLedger(root,ledger);
      return {status:"paused",deleted:0,pending:0,error:"Saved batches or photo storage cannot be read safely; photos were retained."};
    }
    const ids = new Set(assets.map(name => name.slice(0,-4)));
    for (const id of Object.keys(ledger.firstUnreferencedAt))
      if (refs.has(id) || !ids.has(id)) delete ledger.firstUnreferencedAt[id];
    const expired: string[] = [];
    for (const id of ids) {
      if (refs.has(id)) continue;
      const first = ledger.firstUnreferencedAt[id];
      if (first === undefined || first > now) ledger.firstUnreferencedAt[id] = now;
      else if (now - first >= PHOTO_RETENTION_MS) expired.push(id);
    }
    // Establish all markers durably before deleting. A crash after deletion
    // leaves a harmless missing-file marker which the next scan removes.
    await writeLedger(root,ledger);
    let deleted = 0;
    for (const id of expired) {
      try { await unlink(path.join(root,"photo-assets",`${id}.jpg`)); deleted++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      delete ledger.firstUnreferencedAt[id];
    }
    await writeLedger(root,ledger);
    return {status:"complete",deleted,pending:Object.keys(ledger.firstUnreferencedAt).length};
  },root);
}

type CleanupTimers = Map<string, ReturnType<typeof setInterval>>;
const globalTimers = globalThis as typeof globalThis & { __photoCleanupTimers?: CleanupTimers };
export function ensurePhotoCleanupStarted(dataDir?: string) {
  if (process.env.NODE_ENV === "test") return;
  const root = rootDirectory(dataDir);
  const timers = globalTimers.__photoCleanupTimers ??= new Map();
  if (timers.has(root)) return;
  const run = () => { void cleanupPhotoAssets({dataDir:root}).then(result => {
    if (result.status === "paused") console.warn(`[photo-cleanup] ${result.error}`);
    else if (result.deleted) console.info(`[photo-cleanup] Removed ${result.deleted} unused photos.`);
  }).catch(() => console.warn("[photo-cleanup] Cleanup could not finish; it will retry.")); };
  const timer = setInterval(run,60*60*1000);
  timer.unref();
  timers.set(root,timer);
  // Started only by an authenticated request, never during a production build.
  queueMicrotask(run);
}

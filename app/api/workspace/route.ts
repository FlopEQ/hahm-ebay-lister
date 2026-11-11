import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { guardApiRequest } from "@/lib/api-guard";
import { maxNumericSku, nextNumericSku, numericSkuValue } from "@/lib/sku";
import type { BatchCategory, SavedBatchMeta, SavedBatchRecord, SavedWorkspace } from "@/lib/types";
import { normalizeAiUsage } from "@/lib/ai-usage";
import { normalizeSavedPhotos } from "@/lib/photo-fingerprint";
import { withWorkspaceLock } from "@/lib/workspace-lock";
import { cleanupPhotoAssets, ensurePhotoCleanupStarted, protectSavedPhotoAssets } from "@/lib/photo-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATA_DIR = process.env.WORKSPACE_DATA_DIR || path.join(process.cwd(), "data");
const LEGACY_WORKSPACE_FILE = path.join(DATA_DIR, "workspace.json");
const BATCH_DIR = path.join(DATA_DIR, "batches");
const INDEX_FILE = path.join(BATCH_DIR, "index.json");
const BATCH_CATEGORIES = new Set<BatchCategory>(["books", "dvd", "cd", "games", "other"]);

interface BatchIndex {
  version: 1;
  activeBatchId: string | null;
  lastCustomSkuNumber?: string;
  batches: SavedBatchMeta[];
}

type WorkspaceAction =
  | "list"
  | "load"
  | "save"
  | "create"
  | "rename"
  | "duplicate"
  | "archive"
  | "delete"
  | "clear";

function emptyWorkspace(initialSku = ""): SavedWorkspace {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    photos: [],
    binPrefix: initialSku,
    batchCategory: "other",
    step: "upload",
    groups: [],
    orphanIds: [],
    skuStart: 0,
  };
}

function lastNumericSkuInWorkspace(workspace: SavedWorkspace): string {
  let last = "";
  for (const group of workspace.groups) {
    last = maxNumericSku(last, numericSkuValue(group.sku));
  }
  return last;
}

function normalizeBatchCategory(value: unknown): BatchCategory {
  return typeof value === "string" && BATCH_CATEGORIES.has(value as BatchCategory)
    ? (value as BatchCategory)
    : "other";
}

function normalizeWorkspace(raw: unknown): SavedWorkspace | null {
  const w = raw as Partial<SavedWorkspace> | null;
  if (!w || w.version !== 1) return null;
  return {
    version: 1,
    updatedAt: typeof w.updatedAt === "string" ? w.updatedAt : new Date().toISOString(),
    photos: normalizeSavedPhotos(w.photos),
    binPrefix: typeof w.binPrefix === "string" ? w.binPrefix : "",
    batchCategory: normalizeBatchCategory(w.batchCategory),
    step: w.step === "review" || w.step === "listings" ? w.step : "upload",
    groups: Array.isArray(w.groups) ? w.groups : [],
    orphanIds: Array.isArray(w.orphanIds) ? w.orphanIds : [],
    skuStart: Number.isFinite(w.skuStart) ? Number(w.skuStart) : 0,
    aiUsage: normalizeAiUsage(w.aiUsage),
  };
}

function metaFromWorkspace(
  id: string,
  name: string,
  workspace: SavedWorkspace,
  existing?: Partial<SavedBatchMeta>
): SavedBatchMeta {
  return {
    id,
    name: name.trim() || "Untitled batch",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: workspace.updatedAt,
    archived: Boolean(existing?.archived),
    itemCount: workspace.groups.length,
    photoCount: workspace.photos.length,
    postedCount: workspace.groups.filter((g) => g.postStatus === "posted").length,
  };
}

function batchFile(id: string): string {
  return path.join(BATCH_DIR, `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, file);
}

async function readIndex(): Promise<BatchIndex> {
  await migrateLegacyWorkspace();
  try {
    const text = await readFile(INDEX_FILE, "utf8");
    const index = JSON.parse(text) as Partial<BatchIndex>;
    const normalized: BatchIndex = {
      version: 1,
      activeBatchId: typeof index.activeBatchId === "string" ? index.activeBatchId : null,
      lastCustomSkuNumber: numericSkuValue(index.lastCustomSkuNumber ?? "") || undefined,
      batches: Array.isArray(index.batches) ? index.batches : [],
    };
    if (!normalized.lastCustomSkuNumber) {
      normalized.lastCustomSkuNumber = await deriveLastCustomSkuNumber(normalized.batches);
    }
    return normalized;
  } catch {
    return { version: 1, activeBatchId: null, batches: [] };
  }
}

async function deriveLastCustomSkuNumber(batches: SavedBatchMeta[]): Promise<string | undefined> {
  let last = "";
  for (const batch of batches) {
    const record = await readBatch(batch.id);
    if (record) last = maxNumericSku(last, lastNumericSkuInWorkspace(record.workspace));
  }
  return last || undefined;
}

async function writeIndex(index: BatchIndex): Promise<void> {
  index.batches.sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || b.updatedAt.localeCompare(a.updatedAt));
  await writeJson(INDEX_FILE, index);
}

async function readBatch(id: string): Promise<SavedBatchRecord | null> {
  try {
    const raw = JSON.parse(await readFile(batchFile(id), "utf8"));
    const workspace = normalizeWorkspace(raw.workspace);
    if (!workspace || !raw.id || !raw.name) return null;
    return {
      ...metaFromWorkspace(String(raw.id), String(raw.name), workspace, raw),
      workspace,
    };
  } catch {
    return null;
  }
}

async function writeBatch(record: SavedBatchRecord): Promise<void> {
  await writeJson(batchFile(record.id), record);
}

async function cleanupAfterWorkspaceChange() {
  try {
    const result = await cleanupPhotoAssets({dataDir:DATA_DIR});
    if (result.status === "paused") console.warn(`[photo-cleanup] ${result.error}`);
  } catch { console.warn("[photo-cleanup] Cleanup could not finish; it will retry."); }
}

async function saveWorkspaceToBatch(
  batchId: string,
  workspaceInput: unknown,
  name?: string
): Promise<SavedBatchRecord> {
  const workspace = normalizeWorkspace(workspaceInput);
  if (!workspace) throw new Error("Invalid workspace data.");
  workspace.updatedAt = new Date().toISOString();
  const index = await readIndex();
  const existingMeta = index.batches.find((b) => b.id === batchId);
  const existingRecord = existingMeta ? await readBatch(batchId) : null;
  const assetIds = workspace.photos.flatMap(photo => photo.uploadAssetId ? [photo.uploadAssetId] : []);
  await protectSavedPhotoAssets(assetIds,DATA_DIR);
  const record: SavedBatchRecord = {
    ...metaFromWorkspace(
      batchId,
      name || existingMeta?.name || existingRecord?.name || "Untitled batch",
      workspace,
      existingMeta || existingRecord || undefined
    ),
    workspace,
  };
  await writeBatch(record);
  index.activeBatchId = batchId;
  const lastSku = lastNumericSkuInWorkspace(workspace);
  if (lastSku) index.lastCustomSkuNumber = maxNumericSku(index.lastCustomSkuNumber, lastSku);
  index.batches = [record, ...index.batches.filter((b) => b.id !== batchId)];
  await writeIndex(index);
  if (existingRecord?.workspace.photos.some(photo => photo.uploadAssetId && !assetIds.includes(photo.uploadAssetId)))
    await cleanupAfterWorkspaceChange();
  return record;
}

async function migrateLegacyWorkspace(): Promise<void> {
  try {
    await readFile(INDEX_FILE, "utf8");
    return;
  } catch {
    /* no index yet */
  }
  try {
    const legacy = normalizeWorkspace(JSON.parse(await readFile(LEGACY_WORKSPACE_FILE, "utf8")));
    if (!legacy) return;
    const id = crypto.randomUUID();
    legacy.updatedAt = new Date().toISOString();
    const record: SavedBatchRecord = {
      ...metaFromWorkspace(id, legacy.binPrefix ? `Batch ${legacy.binPrefix}` : "Migrated batch", legacy),
      workspace: legacy,
    };
    await writeBatch(record);
    await writeIndex({ version: 1, activeBatchId: id, batches: [record] });
    await unlink(LEGACY_WORKSPACE_FILE);
  } catch {
    /* nothing to migrate */
  }
}

async function createBatch(name?: string): Promise<SavedBatchRecord> {
  const index = await readIndex();
  const workspace = emptyWorkspace(nextNumericSku(index.lastCustomSkuNumber ?? ""));
  const id = crypto.randomUUID();
  const record: SavedBatchRecord = {
    ...metaFromWorkspace(id, name || "New batch", workspace),
    workspace,
  };
  await writeBatch(record);
  index.activeBatchId = id;
  index.batches = [record, ...index.batches];
  await writeIndex(index);
  return record;
}

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  ensurePhotoCleanupStarted(DATA_DIR);
  try { return await withWorkspaceLock(() => workspaceRequest(req),DATA_DIR); }
  catch { return NextResponse.json({ok:false,error:"Saved batch storage is busy or unavailable. Wait a moment and try again."},{status:503}); }
}

async function workspaceRequest(req: NextRequest) {

  let body: {
    action?: WorkspaceAction;
    batchId?: string;
    name?: string;
    archived?: boolean;
    workspace?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  try {
    const action = body.action || "load";
    const index = await readIndex();

    if (action === "list") {
      return NextResponse.json({ ok: true, batches: index.batches, activeBatchId: index.activeBatchId });
    }

    if (action === "create") {
      const record = await createBatch(body.name);
      const nextIndex = await readIndex();
      return NextResponse.json({ ok: true, batch: record, batches: nextIndex.batches, activeBatchId: record.id });
    }

    const batchId = body.batchId || index.activeBatchId || index.batches[0]?.id || null;

    if (action === "load") {
      if (!batchId) {
        const record = await createBatch("New batch");
        const nextIndex = await readIndex();
        return NextResponse.json({ ok: true, batch: record, batches: nextIndex.batches, activeBatchId: record.id });
      }
      const record = await readBatch(batchId);
      if (!record) return NextResponse.json({ ok: false, error: "Batch not found." }, { status: 404 });
      index.activeBatchId = record.id;
      await writeIndex(index);
      return NextResponse.json({ ok: true, batch: record, batches: index.batches, activeBatchId: record.id });
    }

    if (!batchId) {
      return NextResponse.json({ ok: false, error: "Missing batch ID." }, { status: 400 });
    }

    if (action === "save") {
      const record = await saveWorkspaceToBatch(batchId, body.workspace, body.name);
      const nextIndex = await readIndex();
      return NextResponse.json({ ok: true, batch: record, batches: nextIndex.batches, activeBatchId: record.id });
    }

    const record = await readBatch(batchId);
    if (!record) return NextResponse.json({ ok: false, error: "Batch not found." }, { status: 404 });

    if (action === "rename") {
      record.name = body.name?.trim() || record.name;
      await writeBatch(record);
      index.batches = index.batches.map((b) => (b.id === record.id ? { ...b, name: record.name } : b));
      await writeIndex(index);
      return NextResponse.json({ ok: true, batch: record, batches: index.batches, activeBatchId: index.activeBatchId });
    }

    if (action === "archive") {
      record.archived = body.archived !== false;
      await writeBatch(record);
      index.batches = index.batches.map((b) => (b.id === record.id ? { ...b, archived: record.archived } : b));
      await writeIndex(index);
      return NextResponse.json({ ok: true, batch: record, batches: index.batches, activeBatchId: index.activeBatchId });
    }

    if (action === "duplicate") {
      const copyId = crypto.randomUUID();
      const copyWorkspace = { ...record.workspace, updatedAt: new Date().toISOString() };
      const copy: SavedBatchRecord = {
        ...metaFromWorkspace(copyId, body.name || `${record.name} copy`, copyWorkspace),
        workspace: copyWorkspace,
      };
      await writeBatch(copy);
      index.activeBatchId = copy.id;
      index.batches = [copy, ...index.batches];
      await writeIndex(index);
      return NextResponse.json({ ok: true, batch: copy, batches: index.batches, activeBatchId: copy.id });
    }

    if (action === "delete" || action === "clear") {
      await unlink(batchFile(record.id)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      index.batches = index.batches.filter((b) => b.id !== record.id);
      index.activeBatchId = index.batches[0]?.id || null;
      await writeIndex(index);
      await cleanupAfterWorkspaceChange();
      return NextResponse.json({ ok: true, batches: index.batches, activeBatchId: index.activeBatchId });
    }

    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

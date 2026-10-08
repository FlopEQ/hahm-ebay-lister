"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { addAiUsage, formatAiCost, getAnalysisModel, getSortModel, unreportedAiUsage } from "@/lib/model-preferences";
import { resizeImage } from "@/lib/resize";
import { ebayPhotoIds, MAX_EBAY_PHOTOS } from "@/lib/photoSelection";
import { photoFingerprintSource } from "@/lib/photo-fingerprint";
import { processPhotoIntake } from "@/lib/photo-intake";
import { rotateImageData } from "@/lib/rotateImage";
import { buildSku } from "@/lib/sku";
import { chunkImagesForUpload, type PhotoUpload } from "@/lib/uploadBatches";
import { cleanListingIdentifiers } from "@/lib/listingCleanup";
import { EbayConnect } from "./EbayConnect";
import { ModelSelector } from "./ModelSelector";
import { ReviewBoard } from "./ReviewBoard";
import { ListingsView } from "./ListingsView";
import type {
  AnalyzeResponse,
  AiUsageSummary,
  BatchCategory,
  CompsSummary,
  EbayPolicyOptions,
  ItemGroup,
  ListingResult,
  Photo,
  SavedBatchMeta,
  SavedBatchRecord,
  SavedWorkspace,
  SortResponse,
  WorkspaceStep,
} from "@/lib/types";

type Step = WorkspaceStep;
// Big batches are sorted in chunks of SORT_CHUNK photos per request — each
// chunk's thumbnail payload stays under Vercel's 4.5 MB body limit — then
// stitched back together with a merge check at every chunk boundary.
const MAX_PHOTOS = 300;
const SORT_CHUNK = 100;
const WRITE_CONCURRENCY = 3;
// Ordinary single-item listings support up to 24 photos. They ship in small
// batches (lib/uploadBatches.ts) before publish, so no single request ever
// nears Vercel's 4.5 MB body limit.
const MAX_PUBLISH_PHOTOS = MAX_EBAY_PHOTOS;
const BATCH_CATEGORY_OPTIONS: { value: BatchCategory; label: string }[] = [
  { value: "books", label: "Books" },
  { value: "dvd", label: "DVD" },
  { value: "cd", label: "CD" },
  { value: "games", label: "Games" },
  { value: "other", label: "Other" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeWorkspaceGroups(groups: ItemGroup[]): ItemGroup[] {
  return groups.map((g) => ({
    ...g,
    status: g.status === "writing" ? "idle" : g.status,
    postStatus:
      g.postStatus === "drafting" || g.postStatus === "posting"
        ? "error"
        : g.postStatus,
    postError: g.postStatus === "drafting" || g.postStatus === "posting"
      ? "The previous save was interrupted. Retry to check eBay before posting again." : g.postError,
  }));
}

let workspaceWrites: Promise<Response> = Promise.resolve(new Response());
function saveBatch(body: unknown): Promise<Response> {
  workspaceWrites = workspaceWrites.then(() => apiPost("/api/workspace", body), () => apiPost("/api/workspace", body));
  return workspaceWrites;
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2,"0")).join("");
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(performance.now() * 1000)}-${Math.random()}`;
}

function analysisProfileForCategory(category: BatchCategory): string {
  return category === "other" ? "auto" : "media";
}

// Parse a fetch response as JSON, but turn non-JSON error bodies (e.g. a 413
// "Request Entity Too Large" plain-text page) into a friendly message instead
// of a cryptic "Unexpected token" error. Callers pass a hint that fits their
// step — "sort fewer photos" advice on a posting error sent sellers down the
// wrong path.
async function readJson(
  res: Response,
  tooLargeHint = "Try again with fewer or smaller photos."
): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      throw new Error(
        `That was too much photo data to send at once. ${tooLargeHint}`
      );
    }
    throw new Error(
      text.trim().slice(0, 140) || `Request failed (${res.status}).`
    );
  }
}

// Run async workers over items with a fixed concurrency limit.
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [binPrefix, setBinPrefix] = useState("");
  const [batchCategory, setBatchCategory] = useState<BatchCategory>("other");
  const [step, setStep] = useState<Step>("upload");
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsageSummary>();
  const aiUsageRef = useRef<AiUsageSummary | undefined>(undefined);
  const aiCallsRef = useRef(0);
  const analyzingGroupsRef = useRef(new Set<string>());
  const addUsage = useCallback((usage?: AiUsageSummary) => {
    if (!usage) return;
    aiUsageRef.current = addAiUsage(aiUsageRef.current, usage);
    setAiUsage(aiUsageRef.current);
  }, []);
  const aiPost = useCallback(async (url: string, body: unknown, hint?: string) => {
    try {
      const data = await readJson(await apiPost(url, body), hint);
      data.usage ??= unreportedAiUsage();
      addUsage(data.usage);
      return data;
    } catch (error) {
      const usage = unreportedAiUsage();
      addUsage(usage);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage });
    }
  }, [addUsage]);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const importingRef = useRef(false);
  const [sortProgress, setSortProgress] = useState<string | null>(null);
  // Where bin lettering starts — continues after SKUs already on eBay, so a
  // second batch from bin K31 gets K31-N… instead of colliding with K31-A.
  const [skuStart, setSkuStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [ebayPolicies, setEbayPolicies] = useState<EbayPolicyOptions | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceStatus, setWorkspaceStatus] = useState("Loading saved batches...");
  const [batches, setBatches] = useState<SavedBatchMeta[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchName, setBatchName] = useState("New batch");
  const [batchBusy,setBatchBusy] = useState(false);
  const batchNavigationRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSaveRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const photoMap = useMemo(() => {
    const m = new Map<string, Photo>();
    photos.forEach((p) => m.set(p.id, p));
    return m;
  }, [photos]);
  const photoById = useCallback((id: string) => photoMap.get(id), [photoMap]);

  // Latest groups, readable inside async workers without stale closures.
  const groupsRef = useRef(groups);
  const sendingRef = useRef(new Set<string>());
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const applyBatch = useCallback((record: SavedBatchRecord) => {
    if (sendingRef.current.size) return;
    skipNextSaveRef.current = true;
    setActiveBatchId(record.id);
    setBatchName(record.name);
    setPhotos(record.workspace.photos);
    setBinPrefix(record.workspace.binPrefix);
    setBatchCategory(record.workspace.batchCategory ?? "other");
    setStep(record.workspace.step);
    setGroups(safeWorkspaceGroups(record.workspace.groups));
    aiUsageRef.current = record.workspace.aiUsage;
    setAiUsage(record.workspace.aiUsage);
    setOrphanIds(record.workspace.orphanIds);
    setSkuStart(record.workspace.skuStart);
    const when = new Date(record.updatedAt).toLocaleString();
    setWorkspaceStatus(`Loaded ${record.name} from ${when}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiPost("/api/workspace", { action: "load" });
        const data = (await readJson(res)) as {
          ok?: boolean;
          batch?: SavedBatchRecord;
          batches?: SavedBatchMeta[];
          activeBatchId?: string | null;
          error?: string;
        };
        if (!data.ok || !data.batch) throw new Error(data.error || "Could not load saved batch.");
        if (cancelled) return;
        setBatches(data.batches ?? []);
        setActiveBatchId(data.activeBatchId ?? data.batch.id);
        applyBatch(data.batch);
      } catch (e) {
        if (!cancelled) setWorkspaceStatus((e as Error).message);
      } finally {
        if (!cancelled) setWorkspaceLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBatch]);

  useEffect(() => {
    if (!workspaceLoaded || batchNavigationRef.current) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!activeBatchId) return;
    setWorkspaceStatus("Saving batch...");
    saveTimerRef.current = setTimeout(() => {
      const workspace: SavedWorkspace = {
        version: 1,
        updatedAt: new Date().toISOString(),
        photos,
        binPrefix,
        batchCategory,
        step,
        groups: safeWorkspaceGroups(groups),
        orphanIds,
        skuStart,
        aiUsage,
      };
      void (async () => {
        try {
          const res = await saveBatch({
            action: "save",
            batchId: activeBatchId,
            name: batchName,
            workspace,
          });
          const data = (await readJson(res)) as {
            ok?: boolean;
            batch?: SavedBatchRecord;
            batches?: SavedBatchMeta[];
            error?: string;
          };
          if (!data.ok || !data.batch) throw new Error(data.error || "Could not save batch.");
          setBatches(data.batches ?? []);
          const when = new Date(data.batch.updatedAt).toLocaleTimeString();
          setWorkspaceStatus(`Saved ${data.batch.name} at ${when}`);
        } catch (e) {
          setWorkspaceStatus((e as Error).message);
        }
      })();
    }, 1200);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [workspaceLoaded, activeBatchId, batchName, photos, binPrefix, batchCategory, step, groups, orphanIds, skuStart, aiUsage]);

  // Keep eBay connection status in sync (also after the connect bar updates).
  useEffect(() => {
    const check = () =>
      fetch("/api/ebay/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setEbayConnected(Boolean(d.connected)))
        .catch(() => setEbayConnected(false));
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!ebayConnected) {
      setEbayPolicies(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiPost("/api/ebay/policies", {});
        const data = (await readJson(res)) as {
          ok?: boolean;
          policies?: EbayPolicyOptions;
        };
        if (!cancelled && data.ok && data.policies) setEbayPolicies(data.policies);
      } catch {
        if (!cancelled) setEbayPolicies(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ebayConnected]);

  // ── Upload ──────────────────────────────────────────────
  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList?.length || importingRef.current || batchNavigationRef.current || aiCallsRef.current ||
        sendingRef.current.size || !workspaceLoaded || !activeBatchId) return;
    setError(null);
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
      return;
    }
    const accepted = files.slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    if (!accepted.length) { setError(`This batch already has ${MAX_PHOTOS} photos.`); return; }
    importingRef.current = true;
    setImporting(true);
    setImportProgress(`Saving photos 0 of ${accepted.length}…`);
    try {
      const result = await processPhotoIntake(accepted, async file => {
        const { uploadData, ...small } = await resizeImage(file);
        const saved = await readJson(await apiPost("/api/photo-assets", {mediaType:"image/jpeg",data:uploadData}));
        if (!saved.ok || typeof saved.assetId !== "string" || !/^[a-f0-9]{64}$/.test(saved.assetId))
          throw new Error(saved.error || "Could not save this photo on the server.");
        return {id:newId(),...small,uploadAssetId:saved.assetId} satisfies Photo;
      }, (done,total) => setImportProgress(`Saving photos ${done} of ${total}…`));
      setPhotos(prev => [...prev,...result.photos]);
      const notices = [...result.errors];
      if (accepted.length < files.length) notices.push(`The ${MAX_PHOTOS}-photo batch limit skipped ${files.length-accepted.length} photos.`);
      if (notices.length) setError(notices.join("\n"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      importingRef.current = false;
      setImporting(false);
      setImportProgress("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [photos.length,workspaceLoaded,activeBatchId]);

  const removePhoto = (id: string) => {
    if (!importingRef.current && !aiCallsRef.current && !batchNavigationRef.current)
      setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // ── Sort ────────────────────────────────────────────────
  const sort = async () => {
    if (photos.length === 0 || importingRef.current || batchNavigationRef.current || aiCallsRef.current) return;
    aiCallsRef.current++;
    setSorting(true);
    setError(null);
    try {
      // Continue bin lettering after any SKUs already on eBay for this bin.
      let skuOffset = 0;
      if (binPrefix.trim()) {
        try {
          const r = await apiPost("/api/ebay/next-sku", { prefix: binPrefix.trim() });
          const d = (await readJson(r)) as { ok?: boolean; nextIndex?: number };
          if (d.ok && Number.isInteger(d.nextIndex) && (d.nextIndex as number) > 0) {
            skuOffset = d.nextIndex as number;
          }
        } catch {
          /* not connected or lookup failed — start at A like before */
        }
      }

      // Sort in chunks so each request's thumbnail payload stays small.
      type RawGroup = { name: string; photoIds: string[] };
      const chunkResults: RawGroup[][] = [];
      const orphanIdsAll: string[] = [];
      for (let off = 0; off < photos.length; off += SORT_CHUNK) {
        const chunk = photos.slice(off, off + SORT_CHUNK);
        if (photos.length > SORT_CHUNK) {
          setSortProgress(
            `Sorting photos ${off + 1}–${off + chunk.length} of ${photos.length}…`
          );
        }
        const data = await aiPost("/api/sort", {
          // Use the small thumbnail for sorting to keep the payload small.
          images: chunk.map((p) => ({
            mediaType: p.mediaType,
            data: p.previewUrl.split(",")[1],
          })),
          sortModel: getSortModel() ?? undefined,
        }, "Try sorting fewer photos per batch.") as SortResponse;
        if (!data.ok || !data.groups) {
          throw new Error(data.error || "Could not sort the photos.");
        }
        const idxToId = (i: number) => chunk[i]?.id;
        chunkResults.push(
          data.groups
            .map((g) => ({
              name: g.name,
              photoIds: g.photoIndices.map(idxToId).filter(Boolean) as string[],
            }))
            .filter((g) => g.photoIds.length > 0)
        );
        orphanIdsAll.push(
          ...((data.orphanIndices ?? []).map(idxToId).filter(Boolean) as string[])
        );
      }

      // Stitch chunks back together: an item photographed across a chunk
      // boundary lands split in two — ask the model whether the group holding
      // the boundary's last photo and the one holding the next chunk's first
      // photo are actually the same item.
      const merged: RawGroup[] = [...(chunkResults[0] ?? [])];
      for (let c = 1; c < chunkResults.length; c++) {
        const rest = [...chunkResults[c]];
        const lastId = photos[c * SORT_CHUNK - 1]?.id;
        const firstId = photos[c * SORT_CHUNK]?.id;
        const prevGroup = merged.find((g) => lastId && g.photoIds.includes(lastId));
        const nextGroup = rest.find((g) => firstId && g.photoIds.includes(firstId));
        if (prevGroup && nextGroup) {
          setSortProgress("Checking for items split across batches…");
          try {
            const a = photoMap.get(prevGroup.photoIds[0]);
            const b = photoMap.get(nextGroup.photoIds[0]);
            if (a && b) {
              const d = await aiPost("/api/merge-check", {
                a: { mediaType: a.mediaType, data: a.previewUrl.split(",")[1] },
                b: { mediaType: b.mediaType, data: b.previewUrl.split(",")[1] },
                countA: prevGroup.photoIds.length,
                countB: nextGroup.photoIds.length,
                sortModel: getSortModel() ?? undefined,
              }) as { ok?: boolean; merge?: boolean; usage?: AiUsageSummary };
              if (d.ok && d.merge) {
                prevGroup.photoIds = [...prevGroup.photoIds, ...nextGroup.photoIds];
                rest.splice(rest.indexOf(nextGroup), 1);
              }
            }
          } catch {
            /* boundary check is best-effort — worst case the item stays split */
          }
        }
        merged.push(...rest);
      }

      const assigned = new Set<string>();
      merged.forEach((g) => g.photoIds.forEach((id) => assigned.add(id)));
      orphanIdsAll.forEach((id) => assigned.add(id));
      // Any photo the sorter never placed shouldn't vanish — surface it.
      const leftover = photos.filter((p) => !assigned.has(p.id)).map((p) => p.id);

      const nextGroups: ItemGroup[] = merged.map((g, i) => ({
        id: newId(),
        sku: buildSku(binPrefix, skuOffset + i),
        name: g.name,
        photoIds: g.photoIds,
        status: "idle",
      }));
      setSkuStart(skuOffset);
      setGroups(nextGroups);
      setOrphanIds([...orphanIdsAll, ...leftover]);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      aiCallsRef.current--;
      setSorting(false);
      setSortProgress(null);
    }
  };

  // ── Review edits ────────────────────────────────────────
  const rename = (groupId: string, name: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name } : g))
    );

  const renameSku = (groupId: string, sku: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId && !sendingRef.current.has(groupId) ? { ...g, sku } : g))
    );

  const movePhoto = (photoId: string, toGroupId: string | "orphans") => {
    if (sendingRef.current.size) return;
    setGroups((prev) =>
      prev.map((g) => {
        const nextIds =
          g.id === toGroupId
            ? g.photoIds.includes(photoId)
              ? g.photoIds
              : [...g.photoIds, photoId]
            : g.photoIds.filter((id) => id !== photoId);
        // A gained/lost photo invalidates an already-written listing — reset
        // it so "Write all listings" knows to redo this one (and only this one).
        const changed = nextIds.length !== g.photoIds.length;
        return {
          ...g,
          photoIds: nextIds,
          ...(changed && g.status === "done" ? { status: "idle" as const } : {}),
        };
      })
    );
    setOrphanIds((prev) => {
      const without = prev.filter((id) => id !== photoId);
      return toGroupId === "orphans" ? [...without, photoId] : without;
    });
  };

  // Reorder photos within a group. The array order is the eBay photo order
  // (index 0 = cover/gallery image), so this is all that's needed — `writeGroup`
  // and `postGroup` re-derive their image order from `photoIds` at call time.
  const reorderPhoto = (groupId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId || sendingRef.current.has(groupId)) return g;
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= g.photoIds.length ||
          toIndex >= g.photoIds.length
        ) {
          return g;
        }
        const next = [...g.photoIds];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return { ...g, photoIds: next };
      })
    );
  };

  const togglePhotoHidden = (groupId: string, photoId: string) =>
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId || sendingRef.current.has(groupId)) return g;
        const hidden = new Set(g.hiddenPhotoIds ?? []);
        if (hidden.has(photoId)) hidden.delete(photoId);
        else hidden.add(photoId);
        return { ...g, hiddenPhotoIds: Array.from(hidden) };
      })
    );

  const makeCoverPhoto = (groupId: string, photoId: string) =>
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId || sendingRef.current.has(groupId)) return g;
        const rest = g.photoIds.filter((id) => id !== photoId);
        const hidden = new Set(g.hiddenPhotoIds ?? []);
        hidden.delete(photoId);
        return { ...g, photoIds: [photoId, ...rest], hiddenPhotoIds: Array.from(hidden) };
      })
    );

  const rotatePhoto = (groupId: string, photoId: string, delta: number) =>
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId || sendingRef.current.has(groupId)) return g;
        const next = {
          ...(g.photoRotations ?? {}),
          [photoId]: (((g.photoRotations?.[photoId] ?? 0) + delta) % 360 + 360) % 360,
        };
        if (next[photoId] === 0) delete next[photoId];
        return { ...g, photoRotations: next };
      })
    );

  const deleteGroup = (groupId: string) =>
    setGroups((prev) => {
      const target = prev.find((g) => g.id === groupId);
      if (target && target.photoIds.length > 0) {
        setOrphanIds((o) => [...o, ...target.photoIds]);
      }
      return prev.filter((g) => g.id !== groupId);
    });

  const addGroup = () =>
    setGroups((prev) => [
      ...prev,
      {
        id: newId(),
        sku: buildSku(binPrefix, skuStart + prev.length),
        name: `new-item-${prev.length + 1}`,
        photoIds: [],
        status: "idle",
      },
    ]);

  // ── Write listings ──────────────────────────────────────
  const writeGroup = useCallback(
    async (groupId: string) => {
      if (batchNavigationRef.current || analyzingGroupsRef.current.has(groupId)) return;
      // Snapshot this group's photos from the latest state (no stale closure).
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group) return;
      analyzingGroupsRef.current.add(groupId);
      aiCallsRef.current++;
      const imgs = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, status: "writing", error: undefined } : g
        )
      );
      try {
        const data = await aiPost("/api/analyze", {
          profile: analysisProfileForCategory(batchCategory),
          batchCategory,
          images: imgs,
          analysisModel: getAnalysisModel() ?? undefined,
          routerModel: getSortModel() ?? undefined,
        }) as AnalyzeResponse;
        if (data.usage) setGroups(prev => prev.map(g => g.id === groupId ? { ...g, analysisUsage: addAiUsage(g.analysisUsage, data.usage!) } : g));
        if (!data.ok || !data.listing) {
          throw new Error(data.error || "Could not write this listing.");
        }
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, status: "done", listing: data.listing }
              : g
          )
        );
        // Market price check — advisory and best-effort, so it runs in the
        // background and silently stays hidden if it can't answer.
        void (async () => {
          try {
            const res = await apiPost("/api/ebay/comps", { listing: data.listing });
            const d = (await readJson(res)) as { ok?: boolean; comps?: CompsSummary };
            if (d.ok && d.comps?.ok) {
              setGroups((prev) =>
                prev.map((g) => {
                  if (g.id !== groupId) return g;
                  const comps = d.comps!;
                  const compPrice = comps.listPrice ?? comps.median;
                  const canTrustIdentifierPrice =
                    comps.source === "identifier" &&
                    comps.count >= 2 &&
                    comps.confidence >= 0.1 &&
                    compPrice !== undefined &&
                    compPrice > 0;
                  const userChangedPrice =
                    String(g.listing?.suggested_price ?? "") !==
                    String(data.listing?.suggested_price ?? "");
                  return {
                    ...g,
                    comps,
                    listing:
                      g.listing && canTrustIdentifierPrice && !userChangedPrice
                        ? { ...g.listing, suggested_price: compPrice }
                        : g.listing,
                  };
                })
              );
            }
          } catch {
            /* comps unavailable — price stays purely the AI estimate */
          }
        })();
      } catch (e) {
        const usage = (e as { usage?: AiUsageSummary }).usage;
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? { ...g, status: "error", error: (e as Error).message, analysisUsage: usage ? addAiUsage(g.analysisUsage, usage) : g.analysisUsage }
              : g
          )
        );
      } finally {
        analyzingGroupsRef.current.delete(groupId);
        aiCallsRef.current--;
      }
    },
    [batchCategory, photoMap, aiPost]
  );

  const writeAll = async () => {
    // Only write listings that don't exist yet. Re-running everything after a
    // trip back to the review step re-billed the AI for unchanged listings
    // (issue #30) — groups whose photos changed are reset to "idle" by
    // movePhoto, so they (and only they) get rewritten here.
    const usable = groups
      .filter((g) => g.photoIds.length > 0 && g.status !== "done")
      .map((g) => g.id);
    setStep("listings");
    if (usable.length === 0) return;
    await runPool(usable, WRITE_CONCURRENCY, writeGroup);
  };

  const editListing = (groupId: string, patch: Partial<ListingResult>) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId && g.listing && !sendingRef.current.has(groupId)
          ? { ...g, listing: cleanListingIdentifiers({ ...g.listing, ...patch,
              ...(patch.size !== undefined ? {item_specifics:{...g.listing.item_specifics,Size:patch.size}} : {}),
              ...(patch.condition !== undefined ? { ebay_condition: undefined } : {}) }),
              ...((patch.category_id !== undefined || patch.title !== undefined || patch.condition !== undefined)
                ? { ebayReview: undefined, ebayPreparation: undefined } : {}) }
          : g
      )
    );

  const sendGroupToEbay = useCallback(
    async (groupId: string, mode: "draft" | "publish") => {
      let group = groupsRef.current.find(g => g.id === groupId);
      if (batchNavigationRef.current || !group?.listing || group.postStatus === "posted" || sendingRef.current.has(groupId)) return;
      sendingRef.current.add(groupId);
      const patchGroup = (patch: Partial<ItemGroup>) => {
        groupsRef.current = groupsRef.current.map(g => g.id === groupId ? {...g,...patch} : g);
        setGroups(prev => prev.map(g => g.id === groupId ? {...g,...patch} : g));
      };
      const persist = async () => {
        if (!activeBatchId) throw new Error("Save this batch before sending to eBay.");
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const res = await saveBatch({action:"save",batchId:activeBatchId,name:batchName,workspace:{
          version:1,updatedAt:new Date().toISOString(),photos,binPrefix,batchCategory,step,
          groups:safeWorkspaceGroups(groupsRef.current),orphanIds,skuStart,aiUsage:aiUsageRef.current,
        }});
        const d = await readJson(res);
        if (!d.ok) throw new Error(d.error || "Could not save recovery details. Retry before posting.");
      };
      patchGroup({postStatus:mode === "draft" ? "drafting" : "posting",postError:undefined});
      try {
        if (groupsRef.current.some(g => g.id !== groupId && g.sku.toLowerCase() === group!.sku.toLowerCase()))
          throw new Error("Another item in this batch uses this SKU. Give each item a unique SKU.");
        if (!group.ebayReview || group.ebayReview.categoryId !== group.listing.category_id || group.ebayReview.expiresAt <= Date.now()) {
          const ids = ebayPhotoIds(group,MAX_PUBLISH_PHOTOS);
          const evidenceIds = [...new Set([...ids.slice(0,2),...ids.slice(-2)])];
          const evidence = await Promise.all(evidenceIds.map(async id => {
            const p = photoMap.get(id);
            if (!p) throw new Error("A selected photo is missing. Restore it before preparing for eBay.");
            return rotateImageData({mediaType:p.mediaType,data:p.data},group!.photoRotations?.[id] || 0);
          }));
          let data;
          try { data = await aiPost("/api/ebay/prepare",{listing:group.listing,images:chunkImagesForUpload(evidence)[0] || []}); }
          catch (error) {
            const usage = (error as {usage?: AiUsageSummary}).usage;
            if (usage) patchGroup({analysisUsage:addAiUsage(group.analysisUsage,usage)});
            throw error;
          }
          patchGroup({analysisUsage:addAiUsage(group.analysisUsage,data.usage)});
          if (!data.ok) throw new Error(data.error || "Could not prepare the category.");
          patchGroup({listing:data.listing,ebayReview:data.review,ebayPreparation:data.preparation,
            postStatus:"idle",postWarnings:["Review the eBay category, condition and item specifics below, then stage or post this item."],postError:undefined});
          await persist();
          return;
        }
        const selectedIds = ebayPhotoIds(group,MAX_PUBLISH_PHOTOS);
        if (!selectedIds.length || selectedIds.some(id => !photoMap.has(id)))
          throw new Error("Some selected photos are missing. Restore them before saving to eBay.");
        const photoFingerprint = await fingerprint(selectedIds.map(id => photoFingerprintSource(photoMap.get(id)!,group!.photoRotations?.[id] || 0)));
        const images: PhotoUpload[] = await Promise.all(selectedIds.map(id => {
          const p = photoMap.get(id)!;
          if (p.uploadAssetId) return {assetId:p.uploadAssetId,rotation:group!.photoRotations?.[id] || 0};
          return rotateImageData({mediaType:p.mediaType,data:p.data},group!.photoRotations?.[id] || 0);
        }));
        const imageUrls = group.ebayUpload?.fingerprint === photoFingerprint ? [...group.ebayUpload.urls] : [];
        if (imageUrls.length > images.length) throw new Error("Saved photo receipts are inconsistent. Change the photo selection and retry.");
        let uploadedCount = imageUrls.length;
        for (const batch of chunkImagesForUpload(images.slice(uploadedCount))) {
          // Media creation has no idempotency guarantee: never repeat its POST automatically.
          const data = await readJson(await apiPost("/api/ebay/upload-photos",{sku:group.sku,images:batch,startIndex:uploadedCount}));
          if (Array.isArray(data.urls) && data.urls.length > 0 && data.urls.length <= batch.length) {
            imageUrls.push(...data.urls); uploadedCount += data.urls.length;
            patchGroup({ebayUpload:{fingerprint:photoFingerprint,urls:[...imageUrls]}});
            await persist();
          }
          if (!data.ok || !Array.isArray(data.urls) || data.urls.length !== batch.length)
            throw new Error(data.error || "Some photos failed to upload. Retry; confirmed photo batches are saved.");
        }
        const attemptFingerprint = await fingerprint({mode,sku:group.sku,listing:group.listing,imageUrls});
        const attempt = group.ebayAttempt?.fingerprint === attemptFingerprint ? group.ebayAttempt : {id:newId(),fingerprint:attemptFingerprint};
        patchGroup({ebayAttempt:attempt});
        // Save the attempt ID and photo receipts before any listing writes.
        await persist();
        const res = await apiPost(mode === "draft" ? "/api/ebay/draft" : "/api/ebay/publish",{
          sku:group.sku,listing:group.listing,imageUrls,expectedPhotoCount:images.length,
          requestId:attempt.id,review:group.ebayReview,
        });
        const data = await readJson(res);
        if (!data.success) throw new Error(data.error || "eBay rejected the listing. Review it before retrying.");
        patchGroup({postStatus:mode === "draft" ? "drafted" : "posted",listingId:data.listingId,
          offerId:data.offerId,postWarnings:data.warnings,postError:undefined});
        await persist();
      } catch(e) {
        const current = groupsRef.current.find(g => g.id === groupId);
        // Preserve confirmed success if only the subsequent workspace save failed.
        patchGroup({postStatus:current?.postStatus === "posted" || current?.postStatus === "drafted" ? current.postStatus : "error",
          postError:(e as Error).message});
      } finally { sendingRef.current.delete(groupId); }
    },
    [photoMap,activeBatchId,batchName,photos,binPrefix,batchCategory,step,orphanIds,skuStart,aiPost]
  );

  const saveDraftGroup = useCallback(
    (groupId: string) => sendGroupToEbay(groupId, "draft"),
    [sendGroupToEbay]
  );

  const postGroup = useCallback(
    (groupId: string) => sendGroupToEbay(groupId, "publish"),
    [sendGroupToEbay]
  );

  const postAll = async (groupIds?: string[]) => {
    const ready = groupIds ??
      groups
        .filter((g) => g.status === "done" && g.postStatus !== "posted")
        .map((g) => g.id);
    // Sequential — keeps eBay calls gentle and errors easy to read.
    for (const id of ready) {
      await postGroup(id);
    }
  };

  const refreshBatchList = async () => {
    const res = await apiPost("/api/workspace", { action: "list" });
    const data = (await readJson(res)) as {
      ok?: boolean;
      batches?: SavedBatchMeta[];
      activeBatchId?: string | null;
      error?: string;
    };
    if (!data.ok) throw new Error(data.error || "Could not load batches.");
    setBatches(data.batches ?? []);
    setActiveBatchId(data.activeBatchId ?? null);
  };

  const runBatchAction = async (action: string, extra: Record<string,unknown> = {}) => {
    if (batchNavigationRef.current || importingRef.current || sendingRef.current.size || aiCallsRef.current) return;
    batchNavigationRef.current = true;
    setBatchBusy(true);
    try {
      // Flush recent edits before a switch can cancel the debounce timer.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (workspaceLoaded && activeBatchId) {
        const saved = await readJson(await saveBatch({action:"save",batchId:activeBatchId,name:batchName,workspace:{
          version:1,updatedAt:new Date().toISOString(),photos,binPrefix,batchCategory,step,
          groups:safeWorkspaceGroups(groups),orphanIds,skuStart,aiUsage:aiUsageRef.current,
        }}));
        if (!saved.ok) throw new Error(saved.error || "Could not save the current batch. Retry before switching.");
      }
      let data = await readJson(await saveBatch({action,...extra}));
      if (!data.ok) throw new Error(data.error || "Could not update this batch.");
      if (action === "delete") {
        data = await readJson(await saveBatch(data.activeBatchId
          ? {action:"load",batchId:data.activeBatchId}
          : {action:"create",name:`Batch ${new Date().toLocaleDateString()}`}));
        if (!data.ok) throw new Error(data.error || "Could not load the next batch.");
      }
      setBatches(data.batches || []);
      if (data.batch) applyBatch(data.batch);
      else setWorkspaceStatus(action === "rename" ? `Renamed batch to ${batchName}` : "Batch updated");
    } catch(e) { setWorkspaceStatus((e as Error).message); }
    finally { batchNavigationRef.current = false; setBatchBusy(false); }
  };
  const loadBatch = (batchId: string) => runBatchAction("load",{batchId});
  const createBatch = () => runBatchAction("create",{name:`Batch ${new Date().toLocaleDateString()}`});
  const renameBatch = () => activeBatchId ? runBatchAction("rename",{batchId:activeBatchId,name:batchName}) : Promise.resolve();
  const duplicateBatch = () => activeBatchId ? runBatchAction("duplicate",{batchId:activeBatchId}) : Promise.resolve();
  const archiveBatch = () => activeBatchId ? runBatchAction("archive",{batchId:activeBatchId,archived:!batches.find(b => b.id === activeBatchId)?.archived}) : Promise.resolve();
  const deleteBatch = () => {
    if (!activeBatchId || !window.confirm("Delete this saved batch and its listing drafts? Photos used by other batches are kept. Unused server photos are removed after 7 days.")) return;
    void runBatchAction("delete",{batchId:activeBatchId});
  };

  const usableGroups = useMemo(
    () => groups.filter((g) => g.photoIds.length > 0),
    [groups]
  );

  return (
    <main className="wrap" inert={batchBusy || undefined}>
      <EbayConnect />

      <div className="workspace-bar">
        <div className="workspace-main">
          <label>
            Batch
            <select
              value={activeBatchId ?? ""}
              disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded}
              onChange={(e) => void loadBatch(e.target.value)}
            >
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.archived ? "[Archived] " : ""}
                  {batch.name} ({batch.itemCount} items)
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={batchName}
              disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded}
              onChange={(e) => setBatchName(e.target.value)}
              onBlur={() => void renameBatch()}
            />
          </label>
          <label>
            Category
            <select
              value={batchCategory}
              disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded}
              onChange={(e) => setBatchCategory(e.target.value as BatchCategory)}
            >
              {BATCH_CATEGORY_OPTIONS.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span>{workspaceStatus}</span>
        <span title="Includes photo sorting and listing attempts. Provider billing may differ.">Estimated batch AI cost: {formatAiCost(aiUsage)}</span>
        <div className="workspace-actions">
          <button type="button" className="btn-ghost" disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded} onClick={() => void createBatch()}>
            New batch
          </button>
          <button type="button" className="btn-ghost" disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded || !activeBatchId} onClick={() => void duplicateBatch()}>
            Duplicate
          </button>
          <button type="button" className="btn-ghost" disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded || !activeBatchId} onClick={() => void archiveBatch()}>
            {batches.find((b) => b.id === activeBatchId)?.archived ? "Restore" : "Archive"}
          </button>
          <button type="button" className="btn-ghost danger" disabled={importing || sorting || groups.some(g => g.status === "writing" || g.postStatus === "posting" || g.postStatus === "drafting") || !workspaceLoaded || !activeBatchId} onClick={() => void deleteBatch()}>
            Delete
          </button>
        </div>
      </div>

      {step === "upload" && (
        <>
          <section className="panel" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="section-label">
              1 · Add all your photos
            </h2>

            <div className="field bin-field">
              <label htmlFor="bin">
                Bin / SKU code{" "}
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  (where these items are stored)
                </span>
              </label>
              <input
                id="bin"
                type="text"
                placeholder="e.g. K75"
                value={binPrefix}
                onChange={(e) => setBinPrefix(e.target.value)}
                autoCapitalize="characters"
              />
              <span className="field-hint">
                Each item gets {binPrefix ? `${buildSku(binPrefix, 0)}, ${buildSku(binPrefix, 1)}` : "A, B, C"}
                … in order, so you can find it in the bin later. If this bin
                already has listings on eBay, lettering continues where it left
                off. Numeric SKU batches start at the next remembered number.
                You can edit any SKU after sorting.
              </span>
            </div>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={importing ? -1 : 0}
              aria-disabled={importing || sorting || !workspaceLoaded}
              onClick={() => { if (!importing && !sorting && workspaceLoaded) inputRef.current?.click(); }}
              onKeyDown={(e) => {
                if (!importing && !sorting && workspaceLoaded && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <span className="icon" aria-hidden="true">
                📸
              </span>
              <strong>Tap to choose photos, or drag them all here</strong>
              <span>
                Every item in the batch · up to {MAX_PHOTOS} photos · JPG, PNG,
                WebP
              </span>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                disabled={importing || sorting || !workspaceLoaded || !activeBatchId}
                hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
            </div>

            {importing && <p className="note" role="status">{importProgress}</p>}

            {photos.length > 0 && (
              <div className="thumbs" aria-label="Selected photos">
                {photos.map((p) => (
                  <div className="thumb" key={p.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" />
                    <button
                      type="button"
                      aria-label="Remove photo"
                      disabled={importing || sorting}
                      onClick={() => removePhoto(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="result-actions" style={{ borderTop: "none", paddingTop: 0 }}>
              <ModelSelector />
              <button
                type="button"
                className="btn btn-primary"
                onClick={sort}
                disabled={photos.length === 0 || importing || sorting || !workspaceLoaded}
              >
                {sorting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sorting{" "}
                    {photos.length} photos…
                  </>
                ) : (
                  <>🔀 Sort {photos.length || ""} photos into items</>
                )}
              </button>
            </div>

            {error && (
              <p className="note note-error" role="alert">
                {error}
              </p>
            )}
          </section>

          {sorting && (
            <section className="panel">
              <div className="loading-card">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {sortProgress ??
                    "Grouping photos by item, then double-checking for mixed-up or split items. This takes a little while for big batches."}
                </span>
              </div>
            </section>
          )}
        </>
      )}

      {step === "review" && (
        <ReviewBoard
          groups={groups}
          orphanIds={orphanIds}
          photoById={photoById}
          onRename={rename}
          onRenameSku={renameSku}
          onMovePhoto={movePhoto}
          onReorderPhoto={reorderPhoto}
          onDeleteGroup={deleteGroup}
          onAddGroup={addGroup}
          onWriteAll={writeAll}
          onBack={() => setStep("upload")}
        />
      )}

      {step === "listings" && (
        <ListingsView
          groups={usableGroups}
          aiUsage={aiUsage}
          photoById={photoById}
          ebayConnected={ebayConnected}
          ebayPolicies={ebayPolicies}
          onEdit={editListing}
          onRenameSku={renameSku}
          onRetry={writeGroup}
          onReorderPhoto={reorderPhoto}
          onTogglePhotoHidden={togglePhotoHidden}
          onMakeCoverPhoto={makeCoverPhoto}
          onRotatePhoto={rotatePhoto}
          onSaveDraft={saveDraftGroup}
          onPost={postGroup}
          onPostAll={postAll}
          onBack={() => setStep("review")}
        />
      )}

      <p className="footnote">
        Your saved batches live on this server so you can reopen them from
        another computer, duplicate them, archive finished work, or delete old
        batches when you are done.
      </p>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ListingCard } from "./ListingCard";
import {
  downloadFile,
  listingsToCsv,
  listingsToJson,
} from "@/lib/export";
import { apiPost } from "@/lib/api-client";
import { printInventoryLabels } from "@/lib/labelPrint";
import { validateListing } from "@/lib/listingValidation";
import { formatAiCost } from "@/lib/model-preferences";
import type {
  EbayPolicyOptions,
  AiUsageSummary,
  ItemGroup,
  ListingValidation,
  ListingResult,
  Photo,
  StagedOffer,
} from "@/lib/types";

const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "EXCELLENT", label: "Excellent" },
  { value: "VERY_GOOD", label: "Very good" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
];

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.trim().slice(0, 140) || `Request failed (${res.status}).`);
  }
}

function numberToInput(value: number | string | undefined): string {
  if (value === undefined || value === "") return "";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface ListingsViewProps {
  groups: ItemGroup[];
  aiUsage?: AiUsageSummary;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  ebayPolicies: EbayPolicyOptions | null;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onReorderPhoto: (groupId: string, fromIndex: number, toIndex: number) => void;
  onTogglePhotoHidden: (groupId: string, photoId: string) => void;
  onMakeCoverPhoto: (groupId: string, photoId: string) => void;
  onRotatePhoto: (groupId: string, photoId: string, delta: number) => void;
  onSaveDraft: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPostAll: (groupIds?: string[]) => void;
  onBack: () => void;
}

function StagedOffersPanel({ ebayConnected }: { ebayConnected: boolean }) {
  const [offers, setOffers] = useState<StagedOffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ebayConnected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost("/api/ebay/staged-offers", { action: "list" });
      const data = (await readJson(res)) as { ok?: boolean; offers?: StagedOffer[]; error?: string };
      if (!data.ok) throw new Error(data.error || "Could not load staged offers.");
      setOffers(data.offers ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ebayConnected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (action: "publish" | "delete", offerId: string) => {
    setBusyId(offerId);
    setError(null);
    try {
      const res = await apiPost("/api/ebay/staged-offers", { action, offerId });
      const data = (await readJson(res)) as { success?: boolean; error?: string };
      if (!data.success) throw new Error(data.error || "eBay rejected the request.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (!ebayConnected) return null;

  return (
    <details className="manager-panel">
      <summary>
        Staged eBay offers
        <span>{loading ? "Loading..." : `${offers.length} waiting`}</span>
      </summary>
      <div className="manager-actions">
        <button type="button" className="btn-ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <p className="post-result err">{error}</p>}
      {offers.length === 0 ? (
        <p className="manager-empty">No staged offers found.</p>
      ) : (
        <div className="bulk-table-wrap">
          <table className="bulk-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Status</th>
                <th>Price</th>
                <th>Offer ID</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.offerId}>
                  <td>{offer.sku || "-"}</td>
                  <td>{offer.status}</td>
                  <td>
                    {offer.price
                      ? `${offer.currency || "USD"} ${offer.price}`
                      : "-"}
                  </td>
                  <td>{offer.offerId}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busyId === offer.offerId}
                        onClick={() => void runAction("publish", offer.offerId)}
                      >
                        Publish
                      </button>
                      <button
                        type="button"
                        className="btn-ghost danger"
                        disabled={busyId === offer.offerId}
                        onClick={() => void runAction("delete", offer.offerId)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function BulkEditTable({
  groups,
  ebayPolicies,
  onEdit,
  onRenameSku,
}: {
  groups: ItemGroup[];
  ebayPolicies: EbayPolicyOptions | null;
  onEdit: ListingsViewProps["onEdit"];
  onRenameSku: ListingsViewProps["onRenameSku"];
}) {
  const editable = groups.filter((g) => g.status === "done" && g.listing);
  if (editable.length === 0) return null;

  return (
    <details className="manager-panel">
      <summary>
        Bulk edit table
        <span>{editable.length} listing{editable.length === 1 ? "" : "s"}</span>
      </summary>
      <div className="bulk-table-wrap">
        <table className="bulk-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Title</th>
              <th>Price</th>
              <th>Condition</th>
              <th>Size</th>
              <th>Shipping</th>
              <th>Payment</th>
              <th>Returns</th>
              <th>Wt oz</th>
              <th>L</th>
              <th>W</th>
              <th>H</th>
            </tr>
          </thead>
          <tbody>
            {editable.map((group) => {
              const listing = group.listing!;
              return (
                <tr key={group.id}>
                  <td>
                    <input
                      value={group.sku}
                      disabled={group.postStatus === "posted"}
                      onChange={(e) => onRenameSku(group.id, e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      value={listing.title}
                      onChange={(e) => onEdit(group.id, { title: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={numberToInput(listing.suggested_price)}
                      onChange={(e) =>
                        onEdit(group.id, {
                          suggested_price: e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <select
                      value={listing.condition ?? "GOOD"}
                      onChange={(e) => onEdit(group.id, { condition: e.target.value })}
                    >
                      {CONDITIONS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={listing.size ?? ""}
                      onChange={(e) => onEdit(group.id, { size: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={listing.fulfillment_policy_id ?? ""}
                      onChange={(e) =>
                        onEdit(group.id, { fulfillment_policy_id: e.target.value || undefined })
                      }
                    >
                      <option value="">Default</option>
                      {(ebayPolicies?.fulfillmentPolicies ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={listing.payment_policy_id ?? ""}
                      onChange={(e) =>
                        onEdit(group.id, { payment_policy_id: e.target.value || undefined })
                      }
                    >
                      <option value="">Default</option>
                      {(ebayPolicies?.paymentPolicies ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={listing.return_policy_id ?? ""}
                      onChange={(e) =>
                        onEdit(group.id, { return_policy_id: e.target.value || undefined })
                      }
                    >
                      <option value="">Default</option>
                      {(ebayPolicies?.returnPolicies ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  {[
                    ["package_weight_oz", "1"],
                    ["package_length_in", "0.1"],
                    ["package_width_in", "0.1"],
                    ["package_height_in", "0.1"],
                  ].map(([key, step]) => (
                    <td key={key}>
                      <input
                        type="number"
                        min="0"
                        step={step}
                        placeholder="auto"
                        value={numberToInput(listing[key as keyof ListingResult] as number | string)}
                        onChange={(e) =>
                          onEdit(group.id, {
                            [key]: optionalNumber(e.target.value),
                          } as Partial<ListingResult>)
                        }
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ListingsView({
  groups,
  aiUsage,
  photoById,
  ebayConnected,
  ebayPolicies,
  onEdit,
  onRenameSku,
  onRetry,
  onReorderPhoto,
  onTogglePhotoHidden,
  onMakeCoverPhoto,
  onRotatePhoto,
  onSaveDraft,
  onPost,
  onPostAll,
  onBack,
}: ListingsViewProps) {
  const [filter, setFilter] = useState<"all" | "problems" | "ready">("all");
  const done = groups.filter((g) => g.status === "done").length;
  const writing = groups.filter((g) => g.status === "writing").length;
  const failed = groups.filter((g) => g.status === "error").length;
  const drafted = groups.filter((g) => g.postStatus === "drafted").length;
  const posted = groups.filter((g) => g.postStatus === "posted").length;
  const posting = groups.some((g) => g.postStatus === "drafting" || g.postStatus === "posting");
  const duplicateSkus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups) {
      const sku = group.sku.trim().toLowerCase();
      if (sku) counts.set(sku, (counts.get(sku) ?? 0) + 1);
    }
    return counts;
  }, [groups]);
  const validations = useMemo(() => {
    const map = new Map<string, ListingValidation>();
    for (const group of groups) {
      map.set(
        group.id,
        validateListing(group, {
          duplicateSku: (duplicateSkus.get(group.sku.trim().toLowerCase()) ?? 0) > 1,
          ebayConnected,
          ebayPolicies,
        })
      );
    }
    return map;
  }, [groups, duplicateSkus, ebayConnected, ebayPolicies]);
  const readyGroups = groups.filter((g) => validations.get(g.id)?.ready && g.postStatus !== "posted");
  const problemGroups = groups.filter((g) => (validations.get(g.id)?.errors.length ?? 0) > 0);
  const readyToPost = readyGroups.length;
  const shownGroups =
    filter === "ready"
      ? groups.filter((g) => validations.get(g.id)?.ready)
      : filter === "problems"
        ? problemGroups
        : groups;
  const allDone = writing === 0 && done > 0;

  return (
    <section className="panel" aria-labelledby="listings-heading">
      <div className="result-head">
        <h3 id="listings-heading">Your listings</h3>
        <span className="badge">
          {done}/{groups.length} ready
          {writing > 0 ? ` · ${writing} writing` : ""}
          {failed > 0 ? ` · ${failed} failed` : ""}
          {problemGroups.length > 0 ? ` · ${problemGroups.length} need fixes` : ""}
          {drafted > 0 ? ` · ${drafted} drafted` : ""}
          {posted > 0 ? ` · ${posted} posted` : ""}
        </span>
      </div>

      <p className="field-hint">Estimated batch AI cost: {formatAiCost(aiUsage)}. Includes sorting, listing attempts and preparation.</p>

      <div className="validation-toolbar">
        <div className="segmented">
          <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" className={filter === "problems" ? "active" : ""} onClick={() => setFilter("problems")}>
            Problems ({problemGroups.length})
          </button>
          <button type="button" className={filter === "ready" ? "active" : ""} onClick={() => setFilter("ready")}>
            Ready ({readyGroups.length})
          </button>
        </div>
        <button
          type="button"
          className="btn-ghost"
          disabled={readyGroups.length === 0}
          onClick={() =>
            printInventoryLabels(
              readyGroups.map((g) => ({
                sku: g.sku,
                title: g.listing?.title || g.name,
              }))
            )
          }
        >
          Print labels for ready
        </button>
      </div>

      {ebayConnected && readyToPost > 0 && (
        <div className="post-all-bar">
          <span>
            {posted > 0
              ? `${posted} posted · ${readyToPost} ready`
              : problemGroups.length > 0
                ? `${readyToPost} ready · ${problemGroups.length} need fixes`
                : "Connected to eBay — post a single item to test first, or post them all."}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onPostAll(readyGroups.map((g) => g.id))}
            disabled={posting}
          >
            {posting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Posting…
              </>
            ) : (
              `🚀 Post ${readyToPost} ready to eBay`
            )}
          </button>
        </div>
      )}

      <StagedOffersPanel ebayConnected={ebayConnected} />

      <BulkEditTable
        groups={groups}
        ebayPolicies={ebayPolicies}
        onEdit={onEdit}
        onRenameSku={onRenameSku}
      />

      <div className="listing-list">
        {shownGroups.map((group) => (
          <ListingCard
            key={group.id}
            group={group}
            photoById={photoById}
            ebayConnected={ebayConnected}
            ebayPolicies={ebayPolicies}
            validation={validations.get(group.id)}
            onEdit={onEdit}
            onRenameSku={onRenameSku}
            onRetry={onRetry}
            onReorderPhoto={onReorderPhoto}
            onTogglePhotoHidden={onTogglePhotoHidden}
            onMakeCoverPhoto={onMakeCoverPhoto}
            onRotatePhoto={onRotatePhoto}
            onSaveDraft={onSaveDraft}
            onPost={onPost}
          />
        ))}
      </div>

      <div className="result-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back to items
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={done === 0}
          onClick={() =>
            downloadFile(
              "ebay-listings.csv",
              listingsToCsv(groups),
              "text/csv"
            )
          }
        >
          ⬇️ Download spreadsheet (CSV)
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={done === 0}
          onClick={() =>
            downloadFile(
              "ebay-listings.json",
              listingsToJson(groups),
              "application/json"
            )
          }
        >
          ⬇️ Download all ({done})
        </button>
      </div>

      {allDone && (
        <p className="footnote" style={{ marginTop: "1.5rem" }}>
          Next phase: post all of these straight to eBay with one click.
        </p>
      )}
    </section>
  );
}

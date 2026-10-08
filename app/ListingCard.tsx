"use client";

import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import { printInventoryLabel } from "@/lib/labelPrint";
import { ebayPhotoIds, MAX_EBAY_PHOTOS, rotated } from "@/lib/photoSelection";
import { formatAiCost } from "@/lib/model-preferences";
import type { EbayPolicyOptions, ItemGroup, ListingResult, ListingValidation, Photo } from "@/lib/types";

const TITLE_LIMIT = 80;

// eBay's pre-owned condition tiers, matching the values the model returns.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "EXCELLENT", label: "Pre-owned · Excellent" },
  { value: "VERY_GOOD", label: "Pre-owned · Very good" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
];

function formatPrice(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : String(n);
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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  ebayPolicies: EbayPolicyOptions | null;
  validation?: ListingValidation;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onReorderPhoto: (groupId: string, fromIndex: number, toIndex: number) => void;
  onTogglePhotoHidden: (groupId: string, photoId: string) => void;
  onMakeCoverPhoto: (groupId: string, photoId: string) => void;
  onRotatePhoto: (groupId: string, photoId: string, delta: number) => void;
  onSaveDraft: (groupId: string) => void;
  onPost: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  ebayPolicies,
  validation,
  onEdit,
  onRenameSku,
  onRetry,
  onReorderPhoto,
  onTogglePhotoHidden,
  onMakeCoverPhoto,
  onRotatePhoto,
  onSaveDraft,
  onPost,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [newSpecificKey, setNewSpecificKey] = useState("");
  const [newSpecificValue, setNewSpecificValue] = useState("");
  const listing = group.listing;
  const selectedPhotoIds = ebayPhotoIds(group);
  const cover = photoById(selectedPhotoIds[0] ?? group.photoIds[0]);
  const hiddenPhotoIds = new Set(group.hiddenPhotoIds ?? []);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(([k]) => !k.startsWith("---"));
  }, [listing?.item_specifics]);

  const titleLen = listing?.title?.length ?? 0;

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();
  const sendingToEbay = group.postStatus === "drafting" || group.postStatus === "posting";
  const hasPostBlockers = Boolean(validation && !validation.ready);

  // Publishing refuses a missing/zero price (no more invented defaults), so
  // flag it here the same way size is flagged — before the seller hits Post.
  const priceNum =
    typeof listing?.suggested_price === "string"
      ? parseFloat(listing.suggested_price)
      : listing?.suggested_price;
  const priceMissing =
    group.status === "done" &&
    (priceNum === undefined || Number.isNaN(priceNum) || priceNum <= 0);
  const photoReorderDisabled = group.postStatus === "posted" || group.photoIds.length < 2;
  const resetPhotoDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };
  const setSpecifics = (item_specifics: Record<string, string>) =>
    onEdit(group.id, { item_specifics });
  const updateSpecific = (key: string, value: string) =>
    setSpecifics({ ...(listing?.item_specifics ?? {}), [key]: value });
  const renameSpecific = (oldKey: string, nextKey: string) => {
    const clean = nextKey.trim();
    if (!clean || clean === oldKey) return;
    const current = { ...(listing?.item_specifics ?? {}) };
    const value = current[oldKey] ?? "";
    delete current[oldKey];
    current[clean] = value;
    setSpecifics(current);
  };
  const removeSpecific = (key: string) => {
    const current = { ...(listing?.item_specifics ?? {}) };
    delete current[key];
    setSpecifics(current);
  };
  const addSpecific = () => {
    const key = newSpecificKey.trim();
    if (!key) return;
    setSpecifics({ ...(listing?.item_specifics ?? {}), [key]: newSpecificValue.trim() });
    setNewSpecificKey("");
    setNewSpecificValue("");
  };

  return (
    <article className={`listing-card status-${group.status}`} style={sendingToEbay ? {pointerEvents:"none"} : undefined}>
      <fieldset disabled={sendingToEbay} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" &&
              (priceMissing ? (
                <span style={{ color: "var(--color-danger)" }}>⚠️ needs a price</span>
              ) : (
                <>✅ {formatPrice(listing?.suggested_price)} · ready</>
              ))}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.error || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
          <span className="listing-card-sub" title="Includes listing generation, retries and preparation.">Estimated item AI cost: {formatAiCost(group.analysisUsage)}</span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <div className="listing-card-body">
          {group.photoIds.length > 0 && (
            <div>
              <div className="photo-strip-head">
                <strong>{selectedPhotoIds.length} of {Math.min(group.photoIds.length, MAX_EBAY_PHOTOS)} eBay photos selected</strong>
                <span>First selected photo is the cover</span>
              </div>
              <div className="listing-photo-strip" aria-label="Listing photo order">
              {group.photoIds.map((photoId, index) => {
                const photo = photoById(photoId);
                if (!photo) return null;
                const hidden = hiddenPhotoIds.has(photoId);
                const selectedIndex = selectedPhotoIds.indexOf(photoId);
                const classes = ["listing-photo-thumb"];
                if (!photoReorderDisabled) classes.push("draggable");
                if (dragIndex === index) classes.push("dragging");
                if (overIndex === index && dragIndex !== null && dragIndex !== index) {
                  classes.push("drop-target");
                }
                if (hidden) classes.push("hidden");
                return (
                  <figure
                    key={photoId}
                    className={classes.join(" ")}
                    draggable={!photoReorderDisabled}
                    onDragStart={(e) => {
                      if (photoReorderDisabled) return;
                      setDragIndex(index);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", photoId);
                    }}
                    onDragEnter={() => {
                      if (!photoReorderDisabled) setOverIndex(index);
                    }}
                    onDragOver={(e) => {
                      if (!photoReorderDisabled) e.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== index) {
                        onReorderPhoto(group.id, dragIndex, index);
                      }
                      resetPhotoDrag();
                    }}
                    onDragEnd={resetPhotoDrag}
                  >
                    <div className="listing-photo-frame">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.previewUrl}
                        alt={`Listing photo ${index + 1}`}
                        style={{ transform: `rotate(${rotated(group, photoId)}deg)` }}
                      />
                      {selectedIndex === 0 && <span className="thumb-cover-badge">Cover</span>}
                      {hidden && <span className="thumb-hidden-badge">Hidden</span>}
                    </div>
                    <div className="photo-tools">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onTogglePhotoHidden(group.id, photoId)}
                      >
                        {hidden ? "Use" : "Hide"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={hidden || selectedIndex === 0}
                        onClick={() => onMakeCoverPhoto(group.id, photoId)}
                      >
                        Cover
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onRotatePhoto(group.id, photoId, -90)}
                      >
                        ↺
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onRotatePhoto(group.id, photoId, 90)}
                      >
                        ↻
                      </button>
                    </div>
                  </figure>
                );
              })}
              </div>
            </div>
          )}

          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            {/* SKU stays editable up until the item is posted, so a SKU fix
                never requires going back and re-writing listings (issue #30). */}
            <div className="stat editable">
              <label className="k" htmlFor={`sku-${group.id}`}>
                SKU
              </label>
              <input
                id={`sku-${group.id}`}
                type="text"
                className="size-input"
                value={group.sku}
                disabled={group.postStatus === "posted"}
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
            </div>
            <div className={`stat editable${priceMissing ? " needs-attention" : ""}`}>
              <label className="k" htmlFor={`price-${group.id}`}>
                Price
              </label>
              <div className="price-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    onEdit(group.id, {
                      suggested_price:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
              </div>
              {group.comps?.ok && group.comps.median !== undefined && (
                <span className="comps-line" title={group.comps.basis}>
                  Market: {group.comps.count} similar active listings, $
                  {group.comps.low?.toFixed(0)}–${group.comps.high?.toFixed(0)}
                  {" · "}
                  <button
                    type="button"
                    className="comps-use"
                    onClick={() =>
                      onEdit(group.id, {
                        suggested_price:
                          group.comps!.listPrice ?? group.comps!.median,
                      })
                    }
                  >
                    {/* listPrice = median + the deployment's storewide markup */}
                    {group.comps.listPrice !== undefined
                      ? `use $${group.comps.listPrice.toFixed(2)} (median + markup)`
                      : `use median $${group.comps.median.toFixed(2)}`}
                  </button>
                </span>
              )}
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={group.ebayPreparation ? (listing.ebay_condition || "") : (listing.condition || "")}
                onChange={(e) => onEdit(group.id, group.ebayPreparation ? { ebay_condition:e.target.value } : { condition:e.target.value })}
              >
                <option value="">Choose condition</option>
                {(group.ebayPreparation?.conditions || CONDITIONS).map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div className={`stat editable${sizeMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {ebayConnected && (
            <div className="result-field">
              <label htmlFor={`category-${group.id}`}>eBay category</label>
              {group.ebayPreparation?.categories.length ? (
                <select id={`category-${group.id}`} value={listing.category_id || ""}
                  onChange={e => onEdit(group.id,{category_id:e.target.value,category_name:undefined})}>
                  {!group.ebayPreparation.categories.some(c => c.id === listing.category_id) && listing.category_id &&
                    <option value={listing.category_id}>{listing.category_name || listing.category_id}</option>}
                  {group.ebayPreparation.categories.map(c => <option key={c.id} value={c.id}>{c.path || c.name}</option>)}
                </select>
              ) : (
                <input id={`category-${group.id}`} value={listing.category_id || ""} placeholder="Resolved when you prepare for eBay"
                  onChange={e => onEdit(group.id,{category_id:e.target.value,category_name:undefined})} />
              )}
              {listing.category_name && <p>{listing.category_name}</p>}
              {group.ebayPreparation && <p>Check the condition and all required specifics before saving to eBay.
                {group.ebayPreparation.aspects.filter(a => a.required).map(a => ` ${a.name}${a.values.length ? ` (${a.values.slice(0,8).join(", ")}${a.values.length > 8 ? ", …" : ""})` : ""}`).join(";")}
              </p>}
            </div>
          )}

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          {priceMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No price yet — the analysis couldn&rsquo;t estimate one for
              this item. Set a price above before posting
              {group.comps?.ok ? " (see the market check under Price)" : ""}.
            </p>
          )}

          {ebayConnected && (
            <details className="shipping-details">
              <summary>Shipping, returns, and package</summary>
              <div className="shipping-grid">
                <label>
                  Shipping policy
                  <select
                    value={listing.fulfillment_policy_id ?? ""}
                    onChange={(e) =>
                      onEdit(group.id, {
                        fulfillment_policy_id: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Use account default</option>
                    {(ebayPolicies?.fulfillmentPolicies ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Payment policy
                  <select
                    value={listing.payment_policy_id ?? ""}
                    onChange={(e) =>
                      onEdit(group.id, {
                        payment_policy_id: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Use account default</option>
                    {(ebayPolicies?.paymentPolicies ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Return policy
                  <select
                    value={listing.return_policy_id ?? ""}
                    onChange={(e) =>
                      onEdit(group.id, {
                        return_policy_id: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Use account default</option>
                    {(ebayPolicies?.returnPolicies ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Weight oz
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="decimal"
                    placeholder="auto"
                    value={numberToInput(listing.package_weight_oz)}
                    onChange={(e) =>
                      onEdit(group.id, {
                        package_weight_oz: optionalNumber(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Length in
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="auto"
                    value={numberToInput(listing.package_length_in)}
                    onChange={(e) =>
                      onEdit(group.id, {
                        package_length_in: optionalNumber(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Width in
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="auto"
                    value={numberToInput(listing.package_width_in)}
                    onChange={(e) =>
                      onEdit(group.id, {
                        package_width_in: optionalNumber(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Height in
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="auto"
                    value={numberToInput(listing.package_height_in)}
                    onChange={(e) =>
                      onEdit(group.id, {
                        package_height_in: optionalNumber(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <p>
                Blank package fields use the app&rsquo;s automatic item-profile defaults.
              </p>
            </details>
          )}

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) => onEdit(group.id, { description: e.target.value })}
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
            </div>
          </div>

          <details className="specifics-details" open={Boolean(group.ebayPreparation)}>
            <summary>{specifics.length} item specifics</summary>
            <div className="specifics-editor">
              {specifics.map(([k, v]) => (
                <div className="specifics-edit-row" key={k}>
                  <input
                    type="text"
                    defaultValue={k}
                    aria-label="Specific name"
                    onBlur={(e) => renameSpecific(k, e.target.value)}
                  />
                  <input
                    type="text"
                    value={v}
                    aria-label={`${k} value`}
                    placeholder={group.ebayPreparation?.aspects.find(a => a.name === k)?.required ? "Required" : "Value"}
                    list={`specific-${group.id}-${encodeURIComponent(k)}`}
                    onChange={(e) => updateSpecific(k, e.target.value)}
                  />
                  <datalist id={`specific-${group.id}-${encodeURIComponent(k)}`}>
                    {(group.ebayPreparation?.aspects.find(a => a.name === k)?.values || []).map(v => <option key={v} value={v} />)}
                  </datalist>
                  <button
                    type="button"
                    className="btn-ghost danger"
                    onClick={() => removeSpecific(k)}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="specifics-edit-row add">
                <input
                  type="text"
                  placeholder="Specific"
                  value={newSpecificKey}
                  onChange={(e) => setNewSpecificKey(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Value"
                  value={newSpecificValue}
                  onChange={(e) => setNewSpecificValue(e.target.value)}
                />
                <button type="button" className="btn-ghost" onClick={addSpecific}>
                  Add
                </button>
              </div>
            </div>
          </details>

          <div className="listing-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                printInventoryLabel({
                  sku: group.sku,
                  title: listing.title || group.name,
                })
              }
            >
              Print label
            </button>
          </div>

          {validation && (
            <div className={`validation-card${validation.ready ? " ok" : ""}`}>
              <strong>{validation.ready ? "Ready to post" : "Needs fixes before posting"}</strong>
              {validation.errors.length > 0 && (
                <ul>
                  {validation.errors.map((item) => (
                    <li key={item.message}>{item.message}</li>
                  ))}
                </ul>
              )}
              {validation.warnings.length > 0 && (
                <ul className="warnings">
                  {validation.warnings.map((item) => (
                    <li key={item.message}>{item.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <>
              <p className="post-result ok">
                ✅ Posted to eBay
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/itm/${group.listingId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View listing ↗
                    </a>
                  </>
                ) : null}
              </p>
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
            </>
          ) : ebayConnected ? (
            <div className="post-row">
              {group.postStatus === "drafted" && (
                <p className="post-result ok">
                  ✅ Staged on eBay
                  {group.offerId ? ` · Offer ${group.offerId}` : ""}
                </p>
              )}
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => onSaveDraft(group.id)}
                disabled={sendingToEbay || hasPostBlockers}
              >
                {group.postStatus === "drafting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Staging on eBay…
                  </>
                ) : group.postStatus === "drafted" ? (
                  "Stage again"
                ) : (
                  group.ebayReview ? "Stage on eBay" : "Prepare for eBay"
                )}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onPost(group.id)}
                disabled={sendingToEbay || hasPostBlockers}
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Posting to eBay…
                  </>
                ) : (
                  group.ebayReview ? "🚀 Post this to eBay" : "Prepare for eBay"
                )}
              </button>
              {group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">Connect eBay (top of page) to post this listing.</p>
          )}
        </div>
      )}
      </fieldset>
    </article>
  );
}

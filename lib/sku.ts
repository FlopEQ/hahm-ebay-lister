// SKU helpers ported from ebay_lister_v2_robust.py so web SKUs match the bin
// codes you already use (e.g. bin "K75" → items K75-A, K75-B, …).

export function sanitizeSku(value: string): string {
  let sku = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  sku = sku.replace(/-+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return sku.slice(0, 50);
}

// Bijective base-26: 0→A, 25→Z, 26→AA, 27→AB, … (matches _next_suffix).
export function nextSuffix(index: number): string {
  const letters: string[] = [];
  let current = index;
  for (;;) {
    const remainder = current % 26;
    current = Math.floor(current / 26);
    letters.push(String.fromCharCode(65 + remainder));
    if (current === 0) break;
    current -= 1;
  }
  return letters.reverse().join("");
}

// Build the full item SKU for the Nth item in a bin. With no prefix, fall back
// to a plain letter so items still have a stable, unique reference.
export function addNumericString(value: string, amount: number): string {
  const add = String(Math.max(0, Math.floor(amount)));
  let i = value.length - 1;
  let j = add.length - 1;
  let carry = 0;
  let out = "";

  while (i >= 0 || j >= 0 || carry) {
    const a = i >= 0 ? value.charCodeAt(i--) - 48 : 0;
    const b = j >= 0 ? add.charCodeAt(j--) - 48 : 0;
    const sum = a + b + carry;
    out = String(sum % 10) + out;
    carry = Math.floor(sum / 10);
  }

  return out;
}

export function nextNumericSku(value: string): string {
  const clean = sanitizeSku(value);
  return /^\d+$/.test(clean) ? addNumericString(clean, 1) : "";
}

export function numericSkuValue(value: string): string {
  const clean = sanitizeSku(value);
  return /^\d+$/.test(clean) ? clean : "";
}

export function maxNumericSku(a: string | null | undefined, b: string | null | undefined): string {
  const left = a ? numericSkuValue(a) : "";
  const right = b ? numericSkuValue(b) : "";
  if (!left) return right;
  if (!right) return left;
  return BigInt(right) > BigInt(left) ? right : left;
}

export function buildSku(prefix: string, index: number): string {
  const clean = sanitizeSku(prefix);
  if (/^\d+$/.test(clean)) return addNumericString(clean, index);
  const suffix = nextSuffix(index);
  return clean ? `${clean}-${suffix}` : suffix;
}

// Inverse of nextSuffix: "A"→0, "Z"→25, "AA"→26. Returns -1 for non-letters.
export function suffixToIndex(suffix: string): number {
  const s = (suffix || "").toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return -1;
  let value = 0;
  for (const ch of s) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

// Given SKUs that already exist on eBay, find where lettering for this bin
// should continue — so a second batch from bin K31 starts at the letter after
// the last one used (K31-N…) instead of colliding with K31-A again.
export function nextIndexFromSkus(existingSkus: string[], prefix: string): number {
  const clean = sanitizeSku(prefix);
  if (!clean) return 0;
  if (/^\d+$/.test(clean)) {
    const start = BigInt(clean);
    let max: bigint | null = null;
    for (const sku of existingSkus) {
      const current = sanitizeSku(String(sku || ""));
      if (!/^\d+$/.test(current)) continue;
      const value = BigInt(current);
      if (value >= start && (max === null || value > max)) max = value;
    }
    return max === null ? 0 : Number(max - start + 1n);
  }
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-([A-Za-z]+)$`, "i");
  let max = -1;
  for (const sku of existingSkus) {
    const m = re.exec(String(sku || "").trim());
    if (!m) continue;
    const idx = suffixToIndex(m[1]);
    if (idx > max) max = idx;
  }
  return max + 1;
}

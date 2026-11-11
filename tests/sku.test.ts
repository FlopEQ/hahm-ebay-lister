import { describe, expect, test } from "vitest";
import { buildSku, maxNumericSku, nextNumericSku, numericSkuValue } from "@/lib/sku";

describe("numeric SKU helpers", () => {
  test("continues numeric SKUs without adding letter suffixes", () => {
    expect(buildSku("100021", 0)).toBe("100021");
    expect(buildSku("100021", 1)).toBe("100022");
    expect(buildSku("099999", 2)).toBe("100001");
  });

  test("finds the next custom numeric SKU", () => {
    expect(nextNumericSku("100021")).toBe("100022");
    expect(nextNumericSku("0099")).toBe("0100");
    expect(nextNumericSku("K75")).toBe("");
  });

  test("only treats all-number SKUs as custom numeric SKUs", () => {
    expect(numericSkuValue("100021")).toBe("100021");
    expect(numericSkuValue("100021-A")).toBe("");
    expect(numericSkuValue("K75-A")).toBe("");
  });

  test("compares numeric SKU strings without losing leading zeros", () => {
    expect(maxNumericSku("0099", "0100")).toBe("0100");
    expect(maxNumericSku("100", "099")).toBe("100");
  });
});

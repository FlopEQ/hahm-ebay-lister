import { describe, expect, test } from "vitest";
import { buildCompQuery, buildCompSearch, compStats, filterComps } from "@/lib/ebay/comps";
import type { ListingResult } from "@/lib/types";

const listing = (over: Partial<ListingResult>): ListingResult => ({
  title: "Ralph Lauren Wool Sweater Blue Men's L",
  description: "",
  ...over,
});

describe("buildCompQuery", () => {
  test("prefers a valid UPC over fuzzy brand and type", () => {
    const result = buildCompSearch(
      listing({
        brand: "Some Brand",
        item_type: "Widget",
        item_specifics: { UPC: "810017647248" },
      })
    );
    expect(result).toEqual({
      query: "810017647248",
      source: "identifier",
      identifierType: "UPC",
      param: "gtin",
    });
    expect(buildCompQuery(listing({ item_specifics: { UPC: "810017647248" } }))).toBe(
      "810017647248"
    );
  });

  test("prefers a valid ISBN before fuzzy title search", () => {
    const result = buildCompSearch(
      listing({
        brand: "No Brand",
        item_type: "Book",
        item_specifics: { ISBN: "978-0-306-40615-7" },
      })
    );
    expect(result).toEqual({
      query: "9780306406157",
      source: "identifier",
      identifierType: "ISBN",
      param: "q",
    });
  });

  test("ignores invalid identifier values", () => {
    expect(
      buildCompQuery(
        listing({
          brand: "Ralph Lauren",
          item_type: "Cable Knit Sweater",
          item_specifics: { UPC: "12345" },
        })
      )
    ).toBe("Ralph Lauren Cable Knit Sweater");
  });

  test("prefers brand + item type", () => {
    expect(
      buildCompQuery(listing({ brand: "Ralph Lauren", item_type: "Cable Knit Sweater" }))
    ).toBe("Ralph Lauren Cable Knit Sweater");
  });
  test("ignores No Brand and falls back to the first title words", () => {
    expect(buildCompQuery(listing({ brand: "No Brand" }))).toBe(
      "Ralph Lauren Wool Sweater Blue Men's"
    );
  });
});

describe("filterComps", () => {
  const item = (title: string, price: number, conditionId?: string) => ({
    title,
    price: { value: String(price), currency: "USD" },
    conditionId,
  });

  test("excludes lots, parts, and reproductions", () => {
    const prices = filterComps(
      [
        item("Ralph Lauren Sweater", 40),
        item("Lot of 5 Ralph Lauren Sweaters", 120),
        item("Ralph Lauren Sweater for parts", 5),
        item("Reproduction Ralph Lauren style Sweater", 15),
      ],
      "EXCELLENT"
    );
    expect(prices).toEqual([40]);
  });

  test("dimension titles are NOT mistaken for lots", () => {
    const prices = filterComps(
      [item("Framed Watercolor 16 x 20 Landscape", 45)],
      "EXCELLENT"
    );
    expect(prices).toEqual([45]);
  });

  test("excludes wrong-condition comps when condition ids are present", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "EXCELLENT"
    );
    expect(prices).toEqual([40]);
  });

  test("keeps new comps for new items", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "NEW_WITH_TAGS"
    );
    expect(prices).toEqual([90]);
  });
});

describe("compStats", () => {
  test("empty prices → zero confidence and no median", () => {
    const s = compStats([]);
    expect(s.count).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.median).toBeUndefined();
  });

  test("computes a sane median and band", () => {
    const s = compStats([48, 52, 55, 60, 62, 64, 70, 74, 80, 85, 90, 95]);
    expect(s.count).toBe(12);
    expect(s.median).toBeGreaterThan(60);
    expect(s.median).toBeLessThan(70);
    expect(s.low).toBeLessThan(s.median!);
    expect(s.high).toBeGreaterThan(s.median!);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  test("wildly dispersed comps lower confidence", () => {
    const tight = compStats([50, 52, 54, 55, 56, 58, 60, 61, 62, 63, 64, 65]);
    const loose = compStats([5, 20, 45, 55, 90, 150, 300, 12, 75, 33, 210, 400]);
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });
});

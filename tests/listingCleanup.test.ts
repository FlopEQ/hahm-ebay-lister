import { describe, expect, test } from "vitest";
import { cleanIsbnValue, cleanListingIdentifiers } from "@/lib/listingCleanup";
import type { ListingResult } from "@/lib/types";

describe("listing cleanup", () => {
  test("keeps ISBN values as numbers only", () => {
    expect(cleanIsbnValue("978-0-306-40615-7")).toBe("9780306406157");
    expect(cleanIsbnValue("978 0 306 40615 7")).toBe("9780306406157");
    expect(cleanIsbnValue("ISBN: 978-0-306-40615-7")).toBe("9780306406157");
  });

  test("cleans ISBN item specifics without changing other fields", () => {
    const listing: ListingResult = {
      title: "Book",
      description: "Description",
      item_specifics: {
        ISBN: "978-0-306-40615-7",
        Author: "Carl Sagan",
      },
    };

    expect(cleanListingIdentifiers(listing).item_specifics).toEqual({
      ISBN: "9780306406157",
      Author: "Carl Sagan",
    });
  });

  test("matches ISBN key case-insensitively", () => {
    const listing: ListingResult = {
      title: "Book",
      description: "Description",
      item_specifics: { Isbn: "0 306 40615 2" },
    };

    expect(cleanListingIdentifiers(listing).item_specifics?.Isbn).toBe("0306406152");
  });
});

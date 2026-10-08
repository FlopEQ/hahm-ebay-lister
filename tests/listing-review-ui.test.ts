import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as categories from "@/lib/categories";
import * as labelPrint from "@/lib/labelPrint";
import * as photoSelection from "@/lib/photoSelection";
import * as modelPreferences from "@/lib/model-preferences";
import type { ItemGroup } from "@/lib/types";

// Next keeps JSX intact for its own compiler. Compile this component locally
// so the server-render tests work without changing the app's JSX configuration.
const source = readFileSync(path.join(process.cwd(), "app", "ListingCard.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const modules: Record<string, unknown> = {
  react: React, "@/lib/categories": categories,
  "@/lib/labelPrint": labelPrint, "@/lib/photoSelection": photoSelection,
  "@/lib/model-preferences": modelPreferences,
};
const componentModule = { exports: {} as typeof import("@/app/ListingCard") };
new Function("require", "module", "exports", "React", compiled)(
  (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected component dependency: ${name}`);
    return modules[name];
  }, componentModule, componentModule.exports, React,
);
const { ListingCard } = componentModule.exports;

function preparedGroup(): ItemGroup {
  return {
    id: "review-item", sku: "BIN-100", name: "Book", photoIds: [], status: "done", postStatus: "idle",
    listing: {
      title: "Reviewed book", description: "A book with a marked cover", category: "book",
      category_id: "267", ebay_condition: "USED_GOOD", suggested_price: 12,
      item_specifics: { Author: "", Brand: "Publisher" },
    },
    ebayPreparation: {
      categories: [{ id: "267", name: "Books", path: "Books & Magazines > Books" }, { id: "280", name: "Magazines" }],
      conditions: [{ value: "USED_GOOD", label: "Good" }, { value: "USED_ACCEPTABLE", label: "Acceptable" }],
      aspects: [{ name: "Author", required: true, values: ["Ada", "Grace"], mode: "SELECTION_ONLY" }],
      issues: ["Enter Author"],
    },
  };
}

function render(group = preparedGroup()) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(ListingCard, {
    group, photoById: () => undefined, ebayConnected: true, ebayPolicies: null,
    onEdit: noop, onRenameSku: noop, onRetry: noop, onReorderPhoto: noop,
    onTogglePhotoHidden: noop, onMakeCoverPhoto: noop, onRotatePhoto: noop,
    onSaveDraft: noop, onPost: noop,
  }));
}

function element(html: string, tag: string, id: string): string {
  const match = html.match(new RegExp(`<${tag}[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/${tag}>`));
  expect(match, `Missing ${tag} ${id}`).not.toBeNull();
  return match![0];
}

describe("prepared listing review", () => {
  it("shows the accumulated item AI cost", () => {
    const group = preparedGroup();
    group.analysisUsage = { calls: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0,
      cacheWriteTokens: 0, estimatedCostUsd: 0.024, models: ["claude"], unreportedCalls: 0 };
    expect(render(group)).toContain("Estimated item AI cost: $0.024");
    group.analysisUsage.estimatedCostUsd = null;
    expect(render(group)).toContain("Estimated item AI cost: Unavailable");
  });
  it("shows a blank required specific as an editable input with allowed suggestions", () => {
    const html = render();
    const author = html.match(/<input[^>]*aria-label="Author value"[^>]*>/)?.[0];
    expect(author).toBeDefined();
    expect(author).toContain('value=""');
    expect(author).toContain('placeholder="Required"');
    expect(author).not.toMatch(/\b(?:disabled|readonly)=/i);
    const suggestions = element(html, "datalist", "specific-review-item-Author");
    expect(suggestions).toContain('value="Ada"');
    expect(suggestions).toContain('value="Grace"');
    expect(html).toMatch(/<details[^>]*class="specifics-details"[^>]*open=""/);
  });

  it("offers the exact category-specific eBay conditions and selects the reviewed one", () => {
    const condition = element(render(), "select", "cond-review-item");
    expect(condition).toContain('<option value="USED_GOOD" selected="">Good</option>');
    expect(condition).toContain('<option value="USED_ACCEPTABLE">Acceptable</option>');
    expect(condition).not.toContain('value="EXCELLENT"');
    expect(condition).not.toContain('value="NEW_WITH_TAGS"');
  });

  it("shows suggested category choices with the reviewed category selected", () => {
    const category = element(render(), "select", "category-review-item");
    expect(category).toContain('<option value="267" selected="">Books &amp; Magazines &gt; Books</option>');
    expect(category).toContain('<option value="280">Magazines</option>');
  });

  it.each(["drafting", "posting"] as const)("disables the edit fieldset while %s", (postStatus) => {
    const html = render({ ...preparedGroup(), postStatus });
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it("keeps the edit fieldset enabled while awaiting review", () => {
    const fieldset = render().match(/<fieldset[^>]*>/)?.[0];
    expect(fieldset).toBeDefined();
    expect(fieldset).not.toContain("disabled");
  });
});

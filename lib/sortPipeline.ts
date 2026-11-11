import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { anthropicAuthError, parseModelJson } from "@/lib/anthropic";
import { OPENAI_SORT_MODEL, openAIAuthError, openAIJson } from "@/lib/openai";
import {
  buildSortPrompt,
  buildVerifyGroupPrompt,
  buildVerifyMergePrompt,
  slugifyFolderName,
} from "@/lib/prompts";
import {
  labeledContent,
  openAILabeledContent,
  toImageBlock,
  toOpenAIImagePart,
  type WireImage,
} from "@/lib/images";
import type { AiProvider } from "@/lib/aiProvider";
import { CLAUDE_SORT_MODEL } from "@/lib/claude-models";
import { measuredMessage, AiOutputError, AiConfigurationError } from "@/lib/ai-meter";

const GROUP_MODEL = CLAUDE_SORT_MODEL;
const CHECK_MODEL = CLAUDE_SORT_MODEL;
const BATCH_SIZE = 10;

// Concurrency caps — keep parallel bursts gentle so we don't trip Anthropic's
// per-minute rate limits on big batches (which silently zeroed out sorting).
const GROUP_CONCURRENCY = 2;
const VERIFY_CONCURRENCY = 3;
const MERGE_CONCURRENCY = 4;

// The sort route runs under a 300s Vercel maxDuration. Stop starting new work
// with headroom to spare so a slow run returns a usable (if less polished)
// result instead of being killed by the platform (FUNCTION_INVOCATION_TIMEOUT,
// which loses everything).
export const SORT_TIME_BUDGET_MS = 250_000;
// Cap each Anthropic call — the SDK default timeout is 10 MINUTES, so one
// stalled call could otherwise eat the whole function budget before our own
// retry logic ever saw it.
const PER_CALL_TIMEOUT_MS = 60_000;
// Don't bother starting a call with less budget than this left.
const MIN_CALL_MS = 5_000;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface SortGroup {
  name: string;
  photoIndices: number[];
}
export interface SortResult {
  groups: SortGroup[];
  orphanIndices: number[];
}

// Thrown when EVERY grouping batch failed (API errors / rate limits) — distinct
// from a successful run where the model simply found no groups. Lets the route
// tell the user to wait and retry instead of the misleading "try fewer photos."
export class SortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortUnavailableError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

type AiClient = Anthropic | OpenAI;
type AiContent = Anthropic.ContentBlockParam[] | ChatCompletionContentPart[];

// Run an async fn over items with a fixed concurrency cap, preserving order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Call the active AI provider and parse JSON, retrying transient/rate-limit
// errors with backoff. The deadline bounds the whole attempt loop.
// `deadline` (epoch ms) bounds the whole attempt loop: calls are skipped once
// the budget is (nearly) spent, and each call's HTTP timeout never extends past
// it. SDK-internal retries are disabled — this loop is the only retry layer, so
// time spent is predictable.
async function modelJson<T>(
  client: AiClient,
  provider: AiProvider,
  model: string,
  content: AiContent,
  maxTokens: number,
  label: string,
  deadline: number
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) {
      console.warn(`[sort] ${label}: time budget exhausted — skipping call`);
      return null;
    }
    try {
      if (provider === "openai") {
        return await openAIJson<T>({
          client: client as OpenAI,
          model,
          content: content as ChatCompletionContentPart[],
          maxTokens,
          timeout: Math.min(PER_CALL_TIMEOUT_MS, remaining),
          maxRetries: 0,
        });
      } else {
        const resp = await measuredMessage("sort", client as Anthropic,
          {
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: content as Anthropic.ContentBlockParam[] }],
          },
          { timeout: Math.min(PER_CALL_TIMEOUT_MS, remaining), maxRetries: 0 }
        );
        return parseModelJson<T>(firstText(resp));
      }
    } catch (e) {
      if (e instanceof AiConfigurationError) throw e;
      if (e instanceof AiOutputError) {
        console.warn(`[sort] ${label}: ${e.message}`);
        return null;
      }
      const status =
        e && typeof e === "object" && "status" in e
          ? Number((e as { status?: number }).status)
          : undefined;
      // Account-level failures won't fix themselves on retry — surface them.
      const fatal = provider === "openai" ? openAIAuthError(e) : anthropicAuthError(e);
      if (fatal) throw fatal;
      const retryable = status === undefined || RETRYABLE_STATUS.has(status);
      if (attempt < 1 && retryable) {
        const wait = Math.min(10000, 800 * 2 ** attempt) + Math.floor(Math.random() * 400);
        if (Date.now() + wait + MIN_CALL_MS >= deadline) {
          console.warn(`[sort] ${label}: no budget left for retry — giving up`);
          return null;
        }
        console.warn(`[sort] ${label}: ${status ?? "parse/conn"} error — retry ${attempt + 1} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      console.warn(`[sort] ${label}: giving up (${status ?? (e as Error).message})`);
      return null;
    }
  }
  return null;
}

// Step 1 — group photos in independent batches of 10 (run a few at a time).
// The merge step (step 3) reunites any item split across a batch boundary, so
// batches don't need sequential context — letting us parallelize safely.
async function groupPhotos(
  client: AiClient,
  provider: AiProvider,
  images: WireImage[],
  model: string,
  deadline: number
): Promise<{ name: string; indices: number[] }[]> {
  const total = images.length;
  const batches: { offset: number; batch: WireImage[]; labelStart: number; labelEnd: number }[] = [];
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = images.slice(offset, offset + BATCH_SIZE);
    batches.push({ offset, batch, labelStart: offset + 1, labelEnd: offset + batch.length });
  }

  const perBatch = await mapLimit(batches, GROUP_CONCURRENCY, async (b) => {
    const content: AiContent =
      provider === "openai"
        ? [...openAILabeledContent(b.batch, b.labelStart, "low")]
        : [...labeledContent(b.batch, b.labelStart)];
    const note =
      b.offset > 0
        ? ` (These are photos ${b.labelStart}–${b.labelEnd} of ${total} total. Group only the photos shown above.)`
        : "";
    content.push({
      type: "text",
      text: buildSortPrompt(b.batch.length, b.labelStart, b.labelEnd, note),
    });
    const data = await modelJson<{
      groups?: { folder_name?: string; photo_indices?: number[] }[];
    }>(client, provider, model, content, 2000, `group ${b.labelStart}-${b.labelEnd}`, deadline);

    const out: { name: string; indices: number[] }[] = [];
    for (const g of data?.groups ?? []) {
      const indices: number[] = [];
      for (const idx of g.photo_indices ?? []) {
        const real = Number(idx) - 1;
        if (Number.isInteger(real) && real >= 0 && real < total) indices.push(real);
      }
      if (indices.length) out.push({ name: slugifyFolderName(g.folder_name ?? "item"), indices });
    }
    // data === null means the call failed after exhausting retries (vs. a
    // successful call that simply returned no groups) — track it so we can tell a
    // total outage apart from "the model found nothing to group."
    return { out, failed: data === null };
  });

  if (perBatch.length > 0 && perBatch.every((b) => b.failed)) {
    throw new SortUnavailableError(
      "The photo-sorting service was unavailable or rate-limited — every request failed. Wait a minute and try again; reducing the number of photos won't help."
    );
  }

  return perBatch.flatMap((b) => b.out);
}

// Step 2 — verify each multi-photo group for accidentally mixed items.
// A verify that can't run (budget spent) keeps the group as sorted — a rougher
// result beats a platform timeout that loses the whole sort.
async function verifyGroups(
  client: AiClient,
  provider: AiProvider,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number
): Promise<{ groups: { name: string; indices: number[] }[]; orphans: number[] }> {
  const orphans: number[] = [];

  const checks = await mapLimit(groups, VERIFY_CONCURRENCY, async (group) => {
    if (group.indices.length === 1) return group;
    const content: AiContent =
      provider === "openai"
        ? openAILabeledContent(group.indices.map((i) => images[i]), 1, "low")
        : labeledContent(group.indices.map((i) => images[i]), 1);
    content.push({ type: "text", text: buildVerifyGroupPrompt(group.indices.length) });
    const result = await modelJson<{ valid?: boolean; keep_indices?: number[] }>(
      client,
      provider,
      model,
      content,
      300,
      `verify ${group.name}`,
      deadline
    );

    if (!result || result.valid !== false) return group;
    const keepRaw = result.keep_indices ?? [];
    if (keepRaw.length === 0) return group;
    const keepSet = new Set(keepRaw.map((x) => Number(x) - 1));
    const kept: number[] = [];
    group.indices.forEach((globalIdx, localIdx) => {
      if (keepSet.has(localIdx)) kept.push(globalIdx);
      else orphans.push(globalIdx);
    });
    return kept.length > 0 ? { name: group.name, indices: kept } : group;
  });

  return { groups: checks, orphans };
}

// Step 3 — merge adjacent groups that are really one item split in two.
// A pair that can't be checked (budget spent) simply stays unmerged.
async function mergeSplitGroups(
  client: AiClient,
  provider: AiProvider,
  images: WireImage[],
  groups: { name: string; indices: number[] }[],
  model: string,
  deadline: number
): Promise<{ name: string; indices: number[] }[]> {
  if (groups.length < 2) return groups;

  const pairs = groups.slice(0, -1);
  const pairVotes = await mapLimit(pairs, MERGE_CONCURRENCY, async (group, i) => {
    const next = groups[i + 1];
    const content =
      provider === "openai"
        ? (() => {
            const aBlock = toOpenAIImagePart(images[group.indices[0]], "low");
            const bBlock = toOpenAIImagePart(images[next.indices[0]], "low");
            if (!aBlock || !bBlock) return null;
            return [
              { type: "text" as const, text: "Photo 1:" },
              aBlock,
              { type: "text" as const, text: "--- Group B ---" },
              { type: "text" as const, text: "Photo 2:" },
              bBlock,
              { type: "text" as const, text: buildVerifyMergePrompt(group.indices.length, next.indices.length) },
            ] satisfies ChatCompletionContentPart[];
          })()
        : (() => {
            const aBlock = toImageBlock(images[group.indices[0]]);
            const bBlock = toImageBlock(images[next.indices[0]]);
            if (!aBlock || !bBlock) return null;
            return [
              { type: "text" as const, text: "Photo 1:" },
              aBlock,
              { type: "text" as const, text: "--- Group B ---" },
              { type: "text" as const, text: "Photo 2:" },
              bBlock,
              { type: "text" as const, text: buildVerifyMergePrompt(group.indices.length, next.indices.length) },
            ] satisfies Anthropic.ContentBlockParam[];
          })();
    if (!content) return false;
    const result = await modelJson<{ merge?: boolean }>(
      client,
      provider,
      model,
      content,
      100,
      `merge ${i}`,
      deadline
    );
    return result?.merge === true;
  });

  const merged: { name: string; indices: number[] }[] = [];
  let i = 0;
  while (i < groups.length) {
    if (i < groups.length - 1 && pairVotes[i]) {
      merged.push({
        name: groups[i].name,
        indices: [...groups[i].indices, ...groups[i + 1].indices],
      });
      i += 2;
    } else {
      merged.push(groups[i]);
      i += 1;
    }
  }
  return merged;
}

function uniqueNames(groups: { name: string; indices: number[] }[]): SortGroup[] {
  const counts = new Map<string, number>();
  return groups.map((g) => {
    const n = (counts.get(g.name) ?? 0) + 1;
    counts.set(g.name, n);
    return { name: n === 1 ? g.name : `${g.name}-${n}`, photoIndices: g.indices };
  });
}

// One-off merge check between two groups that landed in DIFFERENT sort chunks
// (the client sorts big batches 100 photos at a time; an item photographed
// across the chunk boundary gets split). Same prompt as the in-request merge
// step, exposed for the /api/merge-check route.
export async function checkMergePair(
  client: AiClient,
  imageA: WireImage,
  imageB: WireImage,
  countA: number,
  countB: number,
  model?: string,
  provider: AiProvider = "anthropic"
): Promise<boolean> {
  const content =
    provider === "openai"
      ? (() => {
          const aBlock = toOpenAIImagePart(imageA, "low");
          const bBlock = toOpenAIImagePart(imageB, "low");
          if (!aBlock || !bBlock) return null;
          return [
            { type: "text" as const, text: "Photo 1:" },
            aBlock,
            { type: "text" as const, text: "--- Group B ---" },
            { type: "text" as const, text: "Photo 2:" },
            bBlock,
            { type: "text" as const, text: buildVerifyMergePrompt(countA, countB) },
          ] satisfies ChatCompletionContentPart[];
        })()
      : (() => {
          const aBlock = toImageBlock(imageA);
          const bBlock = toImageBlock(imageB);
          if (!aBlock || !bBlock) return null;
          return [
            { type: "text" as const, text: "Photo 1:" },
            aBlock,
            { type: "text" as const, text: "--- Group B ---" },
            { type: "text" as const, text: "Photo 2:" },
            bBlock,
            { type: "text" as const, text: buildVerifyMergePrompt(countA, countB) },
          ] satisfies Anthropic.ContentBlockParam[];
        })();
  if (!content) return false;
  const result = await modelJson<{ merge?: boolean }>(
    client,
    provider,
    model ?? (provider === "openai" ? OPENAI_SORT_MODEL : CHECK_MODEL),
    content,
    100,
    "merge chunk-boundary",
    // The merge-check route runs under a 30s maxDuration — budget within it.
    Date.now() + 25_000
  );
  return result?.merge === true;
}

export async function sortPhotos(
  client: AiClient,
  images: WireImage[],
  model?: string,
  budgetMs: number = SORT_TIME_BUDGET_MS,
  provider: AiProvider = "anthropic"
): Promise<SortResult> {
  const m = model ?? (provider === "openai" ? OPENAI_SORT_MODEL : GROUP_MODEL);
  const deadline = Date.now() + budgetMs;
  const grouped = await groupPhotos(client, provider, images, m, deadline);
  if (grouped.length === 0) return { groups: [], orphanIndices: [] };
  const verified = await verifyGroups(client, provider, images, grouped, m, deadline);
  const merged = await mergeSplitGroups(client, provider, images, verified.groups, m, deadline);
  return { groups: uniqueNames(merged), orphanIndices: verified.orphans };
}

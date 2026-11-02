/**
 * Scores receipt reading (T16, spec §6.4) on a folder of labelled receipts,
 * so the model is chosen on measured accuracy and cost. Every receipt costs
 * one paid Claude call per model.
 *
 *   pnpm --filter @expendi-business/api exec tsx scripts/eval-receipts.ts \
 *     --dir <folder> [--model <id>]... [--concurrency 3]
 *
 * Repeat --model to compare models, e.g. --model claude-opus-5-5
 * --model claude-sonnet-5-5 --model claude-haiku-5-5. Without it, the run
 * uses RECEIPT_MODEL (default claude-opus-5-5). Needs ANTHROPIC_API_KEY, from
 * the environment or Doppler, as the API loads it.
 *
 * The folder holds the receipt images (.jpg, .jpeg, .png, .gif or .webp,
 * shrunk the way the phone uploads them) and a labels.json; see
 * scripts/eval-receipts.labels.example.json:
 *
 *   { "receipts": [
 *       { "file": "till.jpg", "readable": true, "kind": "paper_receipt",
 *         "merchant": "Naivas Supermarket", "amount": "1,234.50",
 *         "currency": "KES", "date": "2026-10-30", "mpesaCode": null,
 *         "etimsInvoiceNumber": "0040799830000012345",
 *         "supplierKraPin": "P051234567X" },
 *       { "file": "blurry.jpg", "readable": false } ] }
 *
 * A readable receipt lists every field; null means the receipt doesn't show
 * it, so reading something there counts as wrong. `amount` is written as
 * printed and compared in cents. A receipt labelled `readable: false` should
 * come back as "couldn't read". Keep the folder outside the repo: real
 * receipts carry names and phone numbers.
 *
 * Each field is compared after normalising both sides (merchant: case,
 * spacing and punctuation; codes: case and spaces) and scored as correct,
 * missed (left empty) or wrong (another value, or one invented where the
 * receipt shows none). Wrong is worse than missed: an employee may not
 * notice it. A readable receipt that comes back unreadable misses each of
 * its fields. The output names files and shows only the fields that
 * differ, never images or whole receipts.
 */
import "../src/secrets/bootstrap.js";

import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Config, Effect, Either, Option } from "effect";
import { z } from "zod";

import type {
  ReceiptExtractionErrorCode,
  ReceiptExtractorShape,
  ReceiptMediaType,
} from "../src/services/extraction/receipt-extractor.js";
import type { ReceiptFields } from "../src/services/extraction/receipt-schema.js";
import {
  DEFAULT_RECEIPT_MODEL,
  makeAnthropicClient,
  makeClaudeReceiptExtractor,
  MAX_RECEIPT_IMAGE_BYTES,
} from "../src/services/extraction/receipt-extractor.js";
import {
  decimalToCents,
  RECEIPT_KINDS,
} from "../src/services/extraction/receipt-schema.js";

const SCORED_FIELDS = [
  "kind",
  "merchant",
  "amount",
  "currency",
  "date",
  "mpesaCode",
  "etimsInvoiceNumber",
  "supplierKraPin",
] as const;
type ScoredField = (typeof SCORED_FIELDS)[number];
type Values = Record<ScoredField, string | null>;

const MEDIA_TYPES: Readonly<Record<string, ReceiptMediaType>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Nano-dollars per input and output token (USD per million tokens × 1000),
 * from the price list of October 2026. Cache writes cost 1.25× input and
 * reads 0.1× input. Check https://platform.claude.com/docs/en/about-claude/pricing
 * before relying on a figure.
 */
const PRICES: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  "claude-fable-5-1": { input: 10_000, output: 50_000 },
  "claude-opus-5-5": { input: 4_000, output: 20_000 },
  "claude-opus-5": { input: 5_000, output: 25_000 },
  "claude-opus-4-8": { input: 5_000, output: 25_000 },
  "claude-sonnet-5-5": { input: 2_000, output: 10_000 },
  "claude-sonnet-5": { input: 2_000, output: 10_000 },
  "claude-haiku-5-5": { input: 100, output: 500 },
  "claude-haiku-4-5": { input: 1_000, output: 5_000 },
};

const nullableText = z.string().nullable();
const labelsSchema = z.object({
  receipts: z
    .array(
      z.discriminatedUnion("readable", [
        z.strictObject({
          file: z.string().min(1),
          readable: z.literal(true),
          kind: z.enum(RECEIPT_KINDS),
          merchant: nullableText,
          amount: nullableText,
          currency: nullableText,
          date: z.iso.date().nullable(),
          mpesaCode: nullableText,
          etimsInvoiceNumber: nullableText,
          supplierKraPin: nullableText,
        }),
        z.strictObject({
          file: z.string().min(1),
          readable: z.literal(false),
        }),
      ]),
    )
    .min(1),
});
type Label = z.infer<typeof labelsSchema>["receipts"][number];

const nonBlank = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

const compactUpper = (value: string | null) =>
  nonBlank(value?.replace(/\s+/g, "").toUpperCase());

/** Both sides of every comparison go through here. */
function normalise(values: Values): Values {
  return {
    kind: values.kind,
    merchant: nonBlank(
      values.merchant
        ?.normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    ),
    amount: values.amount,
    currency: compactUpper(values.currency),
    date: nonBlank(values.date?.trim()),
    mpesaCode: compactUpper(values.mpesaCode),
    etimsInvoiceNumber: compactUpper(values.etimsInvoiceNumber),
    supplierKraPin: compactUpper(values.supplierKraPin),
  };
}

const NOTHING_READ: Values = {
  kind: null,
  merchant: null,
  amount: null,
  currency: null,
  date: null,
  mpesaCode: null,
  etimsInvoiceNumber: null,
  supplierKraPin: null,
};

const valuesOf = (fields: ReceiptFields): Values => ({
  kind: fields.kind,
  merchant: fields.merchant,
  amount: fields.amountCents,
  currency: fields.currency,
  date: fields.date,
  mpesaCode: fields.mpesaCode,
  etimsInvoiceNumber: fields.etimsInvoiceNumber,
  supplierKraPin: fields.supplierKraPin,
});

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

function costNanoUsd(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    usage.inputTokens * price.input +
    (usage.cacheCreationInputTokens * price.input * 5) / 4 +
    (usage.cacheReadInputTokens * price.input) / 10 +
    usage.outputTokens * price.output
  );
}

type Outcome =
  | {
      readonly kind: "read" | "unreadable";
      readonly reason: string | null;
      readonly values: Values;
      readonly servedBy: string;
      readonly usage: Usage;
      readonly latencyMs: number;
    }
  | { readonly kind: "error"; readonly code: ReceiptExtractionErrorCode };

async function readReceipt(
  extractor: ReceiptExtractorShape,
  dir: string,
  label: Label,
): Promise<Outcome> {
  const bytes = new Uint8Array(await readFile(join(dir, label.file)));
  const mediaType =
    MEDIA_TYPES[extname(label.file).toLowerCase()] ?? "image/jpeg";
  const started = performance.now();
  const result = await Effect.runPromise(
    Effect.either(extractor.extract({ bytes, mediaType })),
  );
  const latencyMs = performance.now() - started;
  if (Either.isLeft(result)) return { kind: "error", code: result.left.code };
  const extraction = result.right;
  return {
    kind: extraction.status,
    reason: extraction.status === "unreadable" ? extraction.reason : null,
    values:
      extraction.status === "read"
        ? normalise(valuesOf(extraction.fields))
        : NOTHING_READ,
    servedBy: extraction.raw.model,
    usage: extraction.raw.usage,
    latencyMs,
  };
}

async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await run(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface FieldScore {
  correct: number;
  missed: number;
  wrong: number;
}

interface ModelReport {
  readonly model: string;
  readonly fields: Record<ScoredField, FieldScore>;
  readonly readableLabels: number;
  readonly unreadable: number;
  readonly unreadableLabels: number;
  readonly falseReads: number;
  readonly errors: number;
  readonly averageLatencyMs: number | null;
  readonly averageCostNanoUsd: number | null;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`;

const quoted = (value: string | null) =>
  value === null ? "empty" : JSON.stringify(value);

const average = (values: readonly number[]) =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const dollars = (nanoUsd: number | null) =>
  nanoUsd === null ? "n/a" : `$${(nanoUsd / 1e9).toFixed(4)}`;

function printTable(rows: readonly (readonly string[])[]) {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of rows) {
    console.log(
      row.map((cell, column) => cell.padEnd(widths?.[column] ?? 0)).join("  "),
    );
  }
}

const noScores = (): Record<ScoredField, FieldScore> => ({
  kind: { correct: 0, missed: 0, wrong: 0 },
  merchant: { correct: 0, missed: 0, wrong: 0 },
  amount: { correct: 0, missed: 0, wrong: 0 },
  currency: { correct: 0, missed: 0, wrong: 0 },
  date: { correct: 0, missed: 0, wrong: 0 },
  mpesaCode: { correct: 0, missed: 0, wrong: 0 },
  etimsInvoiceNumber: { correct: 0, missed: 0, wrong: 0 },
  supplierKraPin: { correct: 0, missed: 0, wrong: 0 },
});

/** Prints each receipt's differences and the model's totals. */
function score(
  model: string,
  labels: readonly Label[],
  outcomes: readonly Outcome[],
): ModelReport {
  const fields = noScores();
  const latencies: number[] = [];
  const costs: number[] = [];
  const reasons = new Map<string, number>();
  const servedBy = new Map<string, number>();
  let readableLabels = 0;
  let unreadableLabels = 0;
  let unreadable = 0;
  let falseReads = 0;
  let errors = 0;

  labels.forEach((label, index) => {
    const outcome = outcomes[index];
    if (!outcome) return;
    if (outcome.kind === "error") {
      errors += 1;
      console.log(`  ${label.file}: error ${outcome.code}`);
      return;
    }
    latencies.push(outcome.latencyMs);
    const cost = costNanoUsd(outcome.servedBy, outcome.usage);
    if (cost !== null) costs.push(cost);
    if (outcome.servedBy !== model) {
      servedBy.set(outcome.servedBy, (servedBy.get(outcome.servedBy) ?? 0) + 1);
    }

    if (!label.readable) {
      unreadableLabels += 1;
      if (outcome.kind === "read") {
        falseReads += 1;
        console.log(`  ${label.file}: read, but labelled unreadable`);
      }
      return;
    }
    readableLabels += 1;
    if (outcome.kind === "unreadable") {
      unreadable += 1;
      const reason = outcome.reason ?? "unknown";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      console.log(`  ${label.file}: unreadable (${reason})`);
    }
    const expected = normalise({
      ...label,
      amount: label.amount === null ? null : decimalToCents(label.amount),
    });
    const diffs: string[] = [];
    for (const field of SCORED_FIELDS) {
      const want = expected[field];
      const got = outcome.values[field];
      const tally = fields[field];
      if (want === got) {
        tally.correct += 1;
      } else if (got === null) {
        tally.missed += 1;
        if (outcome.kind === "read") diffs.push(`${field}: missed`);
      } else {
        tally.wrong += 1;
        diffs.push(`${field}: expected ${quoted(want)}, got ${quoted(got)}`);
      }
    }
    if (diffs.length > 0) console.log(`  ${label.file}: ${diffs.join("; ")}`);
  });

  const report: ModelReport = {
    model,
    fields,
    readableLabels,
    unreadable,
    unreadableLabels,
    falseReads,
    errors,
    averageLatencyMs: average(latencies),
    averageCostNanoUsd: average(costs),
  };

  console.log("");
  printTable([
    ["field", "correct", "missed", "wrong", "accuracy"],
    ...SCORED_FIELDS.map((field) => {
      const tally = fields[field];
      return [
        field,
        String(tally.correct),
        String(tally.missed),
        String(tally.wrong),
        percent(tally.correct, readableLabels),
      ];
    }),
  ]);
  const reasonList = [...reasons]
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  console.log(
    `\nunreadable: ${unreadable}/${readableLabels} readable receipts (${percent(unreadable, readableLabels)})${reasonList ? `: ${reasonList}` : ""}`,
  );
  console.log(
    `read although labelled unreadable: ${falseReads}/${report.unreadableLabels}; errors: ${errors}`,
  );
  console.log(
    `average latency: ${report.averageLatencyMs === null ? "n/a" : `${(report.averageLatencyMs / 1000).toFixed(1)} s`}; estimated cost: ${dollars(report.averageCostNanoUsd)} per receipt`,
  );
  for (const [served, count] of servedBy) {
    console.log(
      `warning: ${count} receipt(s) were answered by ${served} (a refusal fallback), so they don't measure ${model}`,
    );
  }
  return report;
}

async function loadLabels(dir: string): Promise<Label[]> {
  const parsed = labelsSchema.safeParse(
    JSON.parse(await readFile(join(dir, "labels.json"), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `labels.json is malformed:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const label of parsed.data.receipts) {
    if (seen.has(label.file)) problems.push(`${label.file}: listed twice`);
    seen.add(label.file);
    if (!MEDIA_TYPES[extname(label.file).toLowerCase()]) {
      problems.push(`${label.file}: not a .jpg, .jpeg, .png, .gif or .webp`);
    }
    if (label.readable && label.amount !== null) {
      if (decimalToCents(label.amount) === null) {
        problems.push(
          `${label.file}: amount "${label.amount}" isn't a plain amount`,
        );
      }
    }
    const size = await stat(join(dir, label.file)).then(
      (info) => info.size,
      () => null,
    );
    if (size === null) problems.push(`${label.file}: file not found`);
    else if (size > MAX_RECEIPT_IMAGE_BYTES) {
      problems.push(
        `${label.file}: over the upload limit; shrink it as the phone does`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`labels.json has problems:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data.receipts;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      model: { type: "string", multiple: true },
      concurrency: { type: "string", default: "3" },
    },
  });
  const concurrency = Number(values.concurrency);
  if (!values.dir || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error(
      "Usage: tsx scripts/eval-receipts.ts --dir <folder> [--model <id>]... [--concurrency 3]",
    );
    return 2;
  }

  const settings = await Effect.runPromise(
    Config.all({
      apiKey: Config.option(Config.redacted("ANTHROPIC_API_KEY")),
      model: Config.withDefault(
        Config.string("RECEIPT_MODEL"),
        DEFAULT_RECEIPT_MODEL,
      ),
    }),
  );
  if (Option.isNone(settings.apiKey)) {
    console.error(
      "ANTHROPIC_API_KEY isn't set. Export it, or run with SECRETS_MANAGER=doppler and a DOPPLER_TOKEN that can read it. The eval makes paid Claude calls.",
    );
    return 1;
  }

  const dir = resolve(values.dir);
  const labels = await loadLabels(dir);
  const models = values.model?.length ? values.model : [settings.model];
  const client = makeAnthropicClient(settings.apiKey.value);
  console.log(
    `${labels.length} receipts × ${models.length} model(s), ${concurrency} at a time`,
  );

  const reports: ModelReport[] = [];
  for (const model of models) {
    console.log(`\n== ${model} ==`);
    const extractor = makeClaudeReceiptExtractor(client, { model });
    const outcomes = await mapConcurrently(labels, concurrency, (label) =>
      readReceipt(extractor, dir, label),
    );
    reports.push(score(model, labels, outcomes));
  }

  console.log("\n== summary ==");
  printTable([
    [
      "model",
      ...SCORED_FIELDS,
      "wrong values",
      "unreadable",
      "errors",
      "avg latency",
      "cost/receipt",
    ],
    ...reports.map((report) => [
      report.model,
      ...SCORED_FIELDS.map((field) =>
        percent(report.fields[field].correct, report.readableLabels),
      ),
      String(
        SCORED_FIELDS.reduce(
          (sum, field) => sum + report.fields[field].wrong,
          0,
        ),
      ),
      percent(report.unreadable, report.readableLabels),
      String(report.errors),
      report.averageLatencyMs === null
        ? "n/a"
        : `${(report.averageLatencyMs / 1000).toFixed(1)} s`,
      dollars(report.averageCostNanoUsd),
    ]),
  ]);
  return 0;
}

process.exitCode = await main();

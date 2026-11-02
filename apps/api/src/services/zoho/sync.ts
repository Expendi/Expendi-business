import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type {
  AccountingConnectionRow,
  AccountingSyncRow,
} from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { SessionDeps } from "./books.js";
import type { ZohoExpense } from "./zoho-client.js";
import { accountingSyncs } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { FileStorage } from "../storage/file-storage.js";
import { callBooks, loadSignedIn } from "./books.js";
import { loadOpenConnection } from "./connections.js";
import { ACCOUNTING_SYNC } from "./enqueue.js";
import { CannotPost, postingFor } from "./posting.js";
import { AccountingTokenKey } from "./token-crypto.js";
import { Zoho } from "./zoho-client.js";

/**
 * Pushes queued paid spending to Zoho Books (spec §6.17, "Retries" and
 * "Lost access"). The station's `zoho-sync` job runs it; one item at a time,
 * and never inside a database transaction while Zoho is being called.
 *
 * Zoho has no idempotency key, so every create is preceded by a search for
 * the item's reference: a create that timed out but went through is found
 * and reused rather than posted twice. The first Zoho ID seen is stored
 * before the receipt is attached, so a failed upload never re-creates.
 */

/** Tries before a sync is marked `failed` and staff need to retry it. */
export const MAX_SYNC_ATTEMPTS = 6;

/** The wait after each failed try: 1 min, 5 min, 15 min, 1 h, 3 h. */
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
] as const;

/** Zoho allows 100 calls a minute per organization; a try makes up to 4. */
const SYNC_BATCH_SIZE = 20;
const RATE_LIMIT_WAIT_MS = 15 * 60_000;

const SYNC_ACTOR = { type: "system", id: "zoho-sync" } as const;

export type SyncOutcome =
  /** Posted, or found already posted, with its receipt. */
  | "synced"
  /** Failed this time; tried again after a wait. */
  | "deferred"
  /** Out of tries, or can't be posted as it stands: staff retry it. */
  | "failed"
  /** The connection isn't active: waits, uncounted, until it is. */
  | "paused"
  /** Zoho's rate limit: waits, uncounted. */
  | "rate_limited"
  /** Not due, already done, or gone. */
  | "skipped";

type SyncDeps = SessionDeps | FileStorage;

interface Claimed {
  readonly sync: AccountingSyncRow;
  readonly connection: AccountingConnectionRow;
}

const syncWhere = (organizationId: string, syncId: string) =>
  and(
    eq(accountingSyncs.id, syncId),
    eq(accountingSyncs.organizationId, organizationId),
  );

/**
 * Takes a due sync for one try: counts the attempt and binds it to the Zoho
 * organization it's first tried in, so a retry never posts into another
 * company file.
 */
function claimAttempt(
  organizationId: string,
  syncId: string,
): Effect.Effect<Claimed | "paused" | "skipped", DatabaseError, SessionDeps> {
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [row] = yield* query(() =>
        tx
          .select()
          .from(accountingSyncs)
          .where(syncWhere(organizationId, syncId))
          .for("update"),
      );
      if (row?.status !== "pending" || row.nextAttemptAt > new Date()) {
        return "skipped" as const;
      }
      const connection = yield* loadOpenConnection(tx, organizationId);
      if (
        connection?.status !== "active" ||
        !connection.externalOrganizationId
      ) {
        return "paused" as const;
      }
      const [sync] = yield* query(() =>
        tx
          .update(accountingSyncs)
          .set({
            attempts: row.attempts + 1,
            externalOrganizationId:
              row.externalOrganizationId ?? connection.externalOrganizationId,
          })
          .where(eq(accountingSyncs.id, row.id))
          .returning(),
      );
      return sync ? { sync, connection } : ("skipped" as const);
    }),
  );
}

function saveExternalId(
  sync: AccountingSyncRow,
  externalId: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope({ organizationId: sync.organizationId }, (tx) =>
    query(() =>
      tx
        .update(accountingSyncs)
        .set({ externalId })
        .where(syncWhere(sync.organizationId, sync.id)),
    ),
  );
}

/** One try at one item, outside any transaction. */
function attempt({ sync, connection }: Claimed) {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const storage = yield* FileStorage;
    // The job acts for no person, so it reads as the company's admin role,
    // as the recurring bills job does: bills and payroll runs need it.
    const posting = yield* withScope(
      { organizationId: sync.organizationId, role: "admin" },
      (tx) => postingFor(tx, sync, connection),
    );
    const signedIn = yield* loadSignedIn(sync.organizationId);
    const ledger = sync.externalOrganizationId;
    if (
      signedIn.row.id !== connection.id ||
      !ledger ||
      signedIn.row.externalOrganizationId !== ledger
    ) {
      return yield* new CannotPost({
        message:
          "The company's Zoho organization changed after this was first tried. Check the old organization for it before retrying.",
        retryable: false,
      });
    }

    let posted: ZohoExpense;
    if (sync.externalId) {
      const externalId = sync.externalId;
      // An upload that timed out may have landed: ask Zoho before sending again.
      const found =
        posting.receipt && !sync.receiptAttached
          ? yield* callBooks(signedIn, (session) =>
              zoho.findExpenses(session, ledger, posting.draft.referenceNumber),
            )
          : [];
      posted = {
        id: externalId,
        referenceNumber: posting.draft.referenceNumber,
        hasReceipt:
          sync.receiptAttached ||
          found.some(({ id, hasReceipt }) => id === externalId && hasReceipt),
      };
    } else {
      const found = yield* callBooks(signedIn, (session) =>
        zoho.findExpenses(session, ledger, posting.draft.referenceNumber),
      );
      if (found.length > 1) {
        return yield* new CannotPost({
          message: `Zoho already has ${found.length} expenses with reference ${posting.draft.referenceNumber}. Remove the extra ones in Zoho, then retry.`,
          retryable: false,
        });
      }
      posted =
        found[0] ??
        (yield* callBooks(signedIn, (session) =>
          zoho.createExpense(session, ledger, posting.draft),
        ));
      yield* saveExternalId(sync, posted.id);
    }

    let receiptAttached = posted.hasReceipt;
    if (posting.receipt && !receiptAttached) {
      const stored = yield* storage.get(posting.receipt.storageKey);
      if (!stored) {
        return yield* new CannotPost({
          message: "The receipt file is missing from storage.",
          retryable: true,
        });
      }
      const receipt = posting.receipt;
      yield* callBooks(signedIn, (session) =>
        zoho.attachReceipt(session, ledger, posted.id, {
          bytes: stored.bytes,
          contentType: receipt.contentType,
          fileName: receipt.fileName,
        }),
      );
      receiptAttached = true;
    }

    yield* withScope({ organizationId: sync.organizationId }, (tx) =>
      query(() =>
        tx
          .update(accountingSyncs)
          .set({
            status: "synced",
            externalId: posted.id,
            receiptAttached,
            syncedAt: new Date(),
            lastError: null,
          })
          .where(syncWhere(sync.organizationId, sync.id)),
      ),
    );
    return "synced" as const;
  });
}

type AttemptError = Effect.Effect.Error<ReturnType<typeof attempt>>;

/** What staff read on a failed or waiting sync. Never holds a token. */
function describeFailure(error: Exclude<AttemptError, DatabaseError>): string {
  switch (error._tag) {
    case "ZohoError":
      return error.code === "NETWORK_ERROR"
        ? "Zoho didn't answer in time."
        : error.message;
    case "StorageError":
      return "The receipt couldn't be read from storage.";
    default:
      return error.message;
  }
}

function waitingFor(status: AccountingConnectionRow["status"]): string {
  switch (status) {
    case "needs_reconnect":
      return "Waiting for the Zoho connection to be reconnected.";
    case "pending":
      return "Waiting for the Zoho connection to be set up.";
    case "active":
    case "disconnected":
      return "Waiting for Zoho to be connected again.";
  }
}

/** Records a failed try: waits, pauses, or fails for staff to retry. */
function recordFailure(
  { sync }: Claimed,
  error: Exclude<AttemptError, DatabaseError>,
): Effect.Effect<SyncOutcome, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    return yield* withScope({ organizationId: sync.organizationId }, (tx) =>
      Effect.gen(function* () {
        const connection = yield* loadOpenConnection(tx, sync.organizationId);
        const uncounted = { attempts: Math.max(sync.attempts - 1, 0) };
        const update = (values: Partial<AccountingSyncRow>) =>
          query(() =>
            tx
              .update(accountingSyncs)
              .set(values)
              .where(syncWhere(sync.organizationId, sync.id)),
          );

        if (connection?.status !== "active") {
          yield* update({
            ...uncounted,
            nextAttemptAt: new Date(),
            lastError: waitingFor(connection?.status ?? "disconnected"),
          });
          return "paused" as const;
        }
        const lastError = describeFailure(error);
        if (error._tag === "ZohoError" && error.code === "RATE_LIMITED") {
          yield* update({
            ...uncounted,
            nextAttemptAt: new Date(Date.now() + RATE_LIMIT_WAIT_MS),
            lastError,
          });
          return "rate_limited" as const;
        }
        const permanent = error._tag === "CannotPost" && !error.retryable;
        if (permanent || sync.attempts >= MAX_SYNC_ATTEMPTS) {
          yield* update({ status: "failed", lastError });
          yield* audit.record(tx, {
            actor: SYNC_ACTOR,
            organizationId: sync.organizationId,
            action: "accounting_sync.failed",
            entity: { type: ACCOUNTING_SYNC, id: sync.id },
            before: { status: "pending" },
            after: {
              status: "failed",
              attempts: sync.attempts,
              lastError,
              subjectType: sync.subjectType,
              subjectId: sync.subjectId,
            },
          });
          return "failed" as const;
        }
        const wait =
          RETRY_DELAYS_MS[
            Math.min(sync.attempts, RETRY_DELAYS_MS.length) - 1
          ] ?? RETRY_DELAYS_MS[0];
        yield* update({
          nextAttemptAt: new Date(Date.now() + wait),
          lastError,
        });
        return "deferred" as const;
      }),
    );
  });
}

/** Tries one queued item now, if it's due and its connection is active. */
export function syncAccountingItem(
  organizationId: string,
  syncId: string,
): Effect.Effect<SyncOutcome, DatabaseError, SyncDeps> {
  return Effect.gen(function* () {
    const claimed = yield* claimAttempt(organizationId, syncId);
    if (claimed === "paused" || claimed === "skipped") return claimed;
    return yield* attempt(claimed).pipe(
      Effect.catchIf(
        (error): error is Exclude<AttemptError, DatabaseError> =>
          error._tag !== "DatabaseError",
        (error) => {
          console.warn(
            `[zoho-sync] ${claimed.sync.id}: try ${claimed.sync.attempts} failed (${error._tag}): ${describeFailure(error)}`,
          );
          return recordFailure(claimed, error);
        },
      ),
    );
  });
}

interface DueSync extends Record<string, unknown> {
  readonly sync_id: string;
  readonly organization_id: string;
}

export interface SyncRunSummary {
  readonly considered: number;
  readonly outcomes: Partial<Record<SyncOutcome | "error", number>>;
}

/**
 * The job: the oldest due syncs of companies whose connection is active.
 * A company Zoho rate-limits is left alone for the rest of the run.
 */
export function syncDueAccounting(
  batchSize = SYNC_BATCH_SIZE,
): Effect.Effect<SyncRunSummary, DatabaseError, SyncDeps> {
  return Effect.gen(function* () {
    const zoho = yield* Zoho;
    const key = yield* AccountingTokenKey;
    if (!zoho.configured || Option.isNone(key)) {
      return { considered: 0, outcomes: {} };
    }
    const due = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<DueSync>(
          sql`SELECT sync_id, organization_id FROM accounting_syncs_due(${batchSize})`,
        ),
      ),
    ).pipe(Effect.map(({ rows }) => rows));

    const outcomes: Partial<Record<SyncOutcome | "error", number>> = {};
    const rateLimited = new Set<string>();
    for (const { sync_id: syncId, organization_id: organizationId } of due) {
      if (rateLimited.has(organizationId)) continue;
      const outcome = yield* syncAccountingItem(organizationId, syncId).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(`[zoho-sync] ${syncId}: ${error.message}`);
            return "error" as const;
          }),
        ),
      );
      if (outcome === "rate_limited") rateLimited.add(organizationId);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { considered: due.length, outcomes };
  });
}

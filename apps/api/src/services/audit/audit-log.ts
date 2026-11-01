import { Context, Effect, Layer, Option } from "effect";

import type { AuditActorType } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { auditLog } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { RequestMeta } from "../../http/request-meta.js";

export interface AuditActor {
  readonly type: AuditActorType;
  /** users.id, staff_users.id, or the component name for system actors. */
  readonly id: string;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  /** Null for platform-wide actions. */
  readonly organizationId: string | null;
  /** `<entity>.<past-tense verb>`, e.g. `membership.role_changed`. */
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string | null };
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * jsonb columns go through JSON.stringify, which throws on BigInt. Money is
 * bigint, so store it as a decimal string.
 */
function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === "bigint" ? inner.toString() : inner,
    ),
  );
}

export class AuditLog extends Context.Tag("AuditLog")<
  AuditLog,
  {
    /**
     * Writes one entry inside `tx`, the transaction making the change, so
     * the change and its audit entry commit or roll back together.
     */
    readonly record: (
      tx: Transaction,
      entry: AuditEntry,
    ) => Effect.Effect<void, DatabaseError>;
  }
>() {}

export const AuditLogLive: Layer.Layer<AuditLog> = Layer.succeed(AuditLog, {
  record: (tx, entry) =>
    Effect.gen(function* () {
      const request = Option.getOrNull(
        yield* Effect.serviceOption(RequestMeta),
      );
      yield* query(() =>
        tx.insert(auditLog).values({
          actorType: entry.actor.type,
          actorId: entry.actor.id,
          organizationId: entry.organizationId,
          action: entry.action,
          entityType: entry.entity.type,
          entityId: entry.entity.id,
          before: toJson(entry.before),
          after: toJson(entry.after),
          requestId: request?.requestId ?? null,
          ip: request?.ip ?? null,
          userAgent: request?.userAgent ?? null,
        }),
      );
    }),
});

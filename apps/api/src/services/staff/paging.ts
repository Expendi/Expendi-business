import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { BadRequest } from "../../errors.js";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `isoUtc`'s output: Postgres keeps microseconds, and a Date would drop them. */
export const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A timestamptz as ISO 8601 in UTC, to the microsecond; null stays null. */
export function isoUtc(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Where the next keyset page starts: after this sort key and row ID. */
export interface Cursor {
  readonly at: string;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

const staleCursor = new BadRequest({
  message: "This page of results is out of date. Search again.",
});

/** `keyPattern` checks the sort key, e.g. `ISO_MICROS` for a time. */
export function decodeCursor(
  raw: string,
  keyPattern: RegExp = ISO_MICROS,
): Effect.Effect<Cursor, BadRequest> {
  return Effect.try({
    try: (): unknown =>
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    catch: () => staleCursor,
  }).pipe(
    Effect.flatMap((value) =>
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      keyPattern.test(value[0]) &&
      UUID.test(value[1])
        ? Effect.succeed({ at: value[0], id: value[1] })
        : Effect.fail(staleCursor),
    ),
  );
}

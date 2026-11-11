import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pgEnum } from "drizzle-orm/pg-core";

import { PAYEE_CHAINS } from "@expendi-business/shared";

export const payeeChain = pgEnum("payee_chain", PAYEE_CHAINS);

/**
 * Whether `address` has the stored form of an address on `chain`, for a
 * CHECK constraint. Only a Base address is ever lowercased: a NEAR account
 * is lowercase by rule, and a Solana address is case-sensitive. The check
 * can't decode base58, so the API still proves a Solana address is 32 bytes
 * before it saves one.
 */
export function addressMatchesChain(
  chain: AnyPgColumn,
  address: AnyPgColumn,
): SQL {
  return sql`(${chain} = 'base' AND ${address} ~ '^0x[0-9a-f]{40}$') OR (${chain} = 'near' AND length(${address}) BETWEEN 2 AND 64 AND ${address} ~ '^(([a-z0-9]+[-_])*[a-z0-9]+[.])*([a-z0-9]+[-_])*[a-z0-9]+$') OR (${chain} = 'solana' AND ${address} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')`;
}

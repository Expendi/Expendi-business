/**
 * Manages the Expendi team's staff list for the internal admin app (spec
 * §6.15): adds someone, changes their role (re-activating them if they were
 * disabled), or disables them. Each change is audited as the `add-staff`
 * system actor. Runs as the owner role (DATABASE_URL_MIGRATE): the API's
 * role can't write `staff_users`.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/add-staff.ts \
 *        --email ops@expendi.app --role ops_admin|ops_viewer
 *      pnpm --filter @expendi-business/api exec tsx scripts/add-staff.ts \
 *        --email ops@expendi.app --disable
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { Config, Effect, Layer, Redacted } from "effect";
import pg from "pg";

import type { StaffRole } from "@expendi-business/shared";
import { staffRoleSchema } from "@expendi-business/shared";

import type { StaffUserChange } from "./lib/staff-users.js";
import { AuditLogLive } from "../src/services/audit/audit-log.js";
import { normalizeEmail } from "../src/services/auth/authenticate.js";
import {
  addStaffUser,
  disableStaffUser,
  ownerDatabase,
} from "./lib/staff-users.js";

const USAGE = `Usage:
  add-staff.ts --email <email> --role ops_admin|ops_viewer
  add-staff.ts --email <email> --disable`;

type Command =
  | { readonly kind: "add"; readonly email: string; readonly role: StaffRole }
  | { readonly kind: "disable"; readonly email: string };

function parseCommand(): Command | null {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      role: { type: "string" },
      disable: { type: "boolean", default: false },
    },
  });
  const email = normalizeEmail(values.email ?? "");
  if (!email) return null;
  if (values.disable) {
    return values.role === undefined ? { kind: "disable", email } : null;
  }
  const role = staffRoleSchema.safeParse(values.role);
  return role.success ? { kind: "add", email, role: role.data } : null;
}

function describe(change: StaffUserChange): string {
  const who = `${change.email} (${change.role}, ${change.status})`;
  switch (change.outcome) {
    case "added":
      return `Added ${who}`;
    case "updated":
      return `Updated ${who}`;
    case "disabled":
      return `Disabled ${who}`;
    case "unchanged":
      return `No change: ${who}`;
  }
}

const command = parseCommand();
if (!command) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const ownerDatabaseUrl = await Effect.runPromise(
    Config.redacted("DATABASE_URL_MIGRATE"),
  );
  const pool = new pg.Pool({
    connectionString: Redacted.value(ownerDatabaseUrl),
    max: 1,
  });
  const program = (
    command.kind === "add"
      ? addStaffUser(command)
      : disableStaffUser(command.email)
  ).pipe(
    Effect.match({
      onSuccess: (change) => {
        console.log(describe(change));
      },
      onFailure: (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
    }),
    Effect.provide(Layer.merge(ownerDatabase(pool), AuditLogLive)),
  );
  try {
    await Effect.runPromise(program);
  } finally {
    await pool.end();
  }
}

/**
 * Treasury's live QA, through the real services: no Treasury screen exists
 * yet, so this script stands in for the app, as test-payout.ts does for
 * payouts. It calls the same services the Treasury routes call, in process.
 * The admin's passkey is a software passkey kept in a git-ignored, owner-only
 * file under apps/api/.cache/treasury-qa/.
 *
 * It MOVES REAL MONEY on whatever database and secrets it is given. Enrol the
 * passkey for a dedicated QA admin account, never a real person's. Every
 * command starts by printing the company's name and the database host.
 *
 *   enrol    --organization-id <id> --admin-email <email>
 *   status   --organization-id <id>
 *   turn-on  --organization-id <id> --admin-email <email>
 *   preview  --organization-id <id> --direction to_treasury|to_wallet
 *            (--usdc <amount> | --all)
 *   move     --organization-id <id> --admin-email <email>
 *            --direction to_treasury|to_wallet (--usdc <amount> | --all) --yes
 *   moves    --organization-id <id>
 *   inspect  --organization-id <id> --move-id <id>        (read only)
 *   reconcile --organization-id <id>
 *   alerts   --organization-id <id>
 *   return-stranded --organization-id <id> --move-id <id> --yes
 *
 * Amounts are decimal USDC with at most 6 places. `--all` is for a move to
 * the wallet only. The script never steps a move: the station job does, so
 * it can't race it. After `move`, follow it with `inspect`.
 *
 * Run, with the Railway tunnel to the staging database open:
 *   DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
 *     pnpm --filter @expendi-business/api exec tsx scripts/treasury-qa.ts <command> …
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { Effect, Exit } from "effect";

import type { AppDeps } from "../src/layers/main.js";
import type { QaOptions } from "./lib/treasury-qa-commands.js";
import { makeRuntime } from "../src/runtime.js";
import {
  alerts,
  banner,
  describeFailure,
  enrol,
  filePasskeyStore,
  inspect,
  moves,
  parseMoveRequest,
  preview,
  QaUsageError,
  reconcile,
  returnStranded,
  startMove,
  status,
  turnOn,
} from "./lib/treasury-qa-commands.js";
import {
  formatAlerts,
  formatBanner,
  formatEnrolment,
  formatInspection,
  formatMoves,
  formatPreview,
  formatReconciliation,
  formatStartedMove,
  formatStatus,
  formatStranded,
} from "./lib/treasury-qa-format.js";

const PASSKEY_DIR = new URL("../.cache/treasury-qa/", import.meta.url);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "organization-id": { type: "string" },
    "admin-email": { type: "string" },
    direction: { type: "string" },
    usdc: { type: "string" },
    all: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "move-id": { type: "string" },
  },
});
const [command] = positionals;
const organizationId = values["organization-id"];

const moveId = Effect.fromNullable(values["move-id"]).pipe(
  Effect.mapError(() => new QaUsageError({ message: "Pass --move-id" })),
);
const moveRequest = parseMoveRequest({
  direction: values.direction,
  usdc: values.usdc,
  all: values.all,
});

function program(options: QaOptions) {
  const programs: Record<string, Effect.Effect<string[], unknown, AppDeps>> = {
    enrol: Effect.map(enrol(options), formatEnrolment),
    status: Effect.map(status(options), formatStatus),
    "turn-on": Effect.map(turnOn(options), formatStatus),
    preview: Effect.flatMap(moveRequest, (request) =>
      Effect.map(preview(options, request), formatPreview),
    ),
    move: Effect.flatMap(moveRequest, (request) =>
      Effect.map(startMove(options, request, values.yes), formatStartedMove),
    ),
    moves: Effect.map(moves(options), formatMoves),
    inspect: Effect.flatMap(moveId, (id) =>
      Effect.map(inspect(options, id), formatInspection),
    ),
    reconcile: Effect.map(reconcile(options), formatReconciliation),
    alerts: Effect.map(alerts(options), formatAlerts),
    "return-stranded": Effect.flatMap(moveId, (id) =>
      Effect.map(returnStranded(options, id, values.yes), formatStranded),
    ),
  };
  return (
    (command === undefined ? undefined : programs[command]) ??
    Effect.fail(
      new QaUsageError({
        message: `Unknown command "${command ?? ""}": use ${Object.keys(programs).join(", ")}`,
      }),
    )
  );
}

const runtime = makeRuntime();
let exitCode = 0;
try {
  if (!organizationId) {
    console.error("Pass --organization-id");
    exitCode = 1;
  } else {
    const options: QaOptions = {
      organizationId,
      adminEmail: values["admin-email"],
      passkeys: filePasskeyStore(PASSKEY_DIR),
    };
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const where = yield* banner(organizationId);
        console.log(formatBanner(where).join("\n"));
        return yield* program(options);
      }),
    );
    if (Exit.isSuccess(exit)) {
      console.log(exit.value.join("\n"));
    } else {
      console.error(describeFailure(exit.cause));
      exitCode = 1;
    }
  }
} finally {
  await runtime.dispose();
}
process.exitCode = exitCode;

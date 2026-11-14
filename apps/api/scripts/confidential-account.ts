/**
 * Requests an audited balance-home change. Jobs move the money afterwards.
 * Turn-off drains the account, including Expendi's float, before switching.
 *
 * Every command starts by printing the company's name and the database host,
 * then refuses unless all of these hold:
 *   - turn-on: CONFIDENTIAL_ACCOUNTS_ENABLED is true, or the pilot variable
 *     CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID equals --organization-id;
 *   - --company-name is the company's name exactly;
 *   - --yes;
 *   - nothing of the company's is in flight;
 *   - the company's confidential account can be read;
 *   - turn-on: the relayer can cover the float and prior float reservations.
 *
 *   turn-on  --organization-id <id> --company-name <name> --yes
 *   turn-off --organization-id <id> --company-name <name> --yes
 *   status   --organization-id <id> (saved state only)
 *
 * Run, with the Railway tunnel to the staging database open:
 *   DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
 *     pnpm --filter @expendi-business/api exec tsx scripts/confidential-account.ts <command> …
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { Config, Effect, Exit, Option } from "effect";

import type { ConfidentialAccountOptions } from "./lib/confidential-account-commands.js";
import { makeRuntime } from "../src/runtime.js";
import {
  balanceHomeStatus,
  DEMO_ORGANIZATION_ENV,
  turnOff,
  turnOn,
} from "./lib/confidential-account-commands.js";
import {
  banner,
  describeFailure,
  formatUsdc,
  QaUsageError,
} from "./lib/treasury-qa-commands.js";
import { formatBanner } from "./lib/treasury-qa-format.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "organization-id": { type: "string" },
    "company-name": { type: "string" },
    yes: { type: "boolean", default: false },
  },
});
const [command] = positionals;
const organizationId = values["organization-id"];

function program(options: ConfidentialAccountOptions) {
  const programs = {
    "turn-on": turnOn,
    "turn-off": turnOff,
  };
  const run =
    command === "turn-on" || command === "turn-off"
      ? programs[command]
      : undefined;
  return run === undefined
    ? Effect.fail(
        new QaUsageError({
          message: `Unknown command "${command ?? ""}": use ${Object.keys(programs).join(", ")}`,
        }),
      )
    : run(options);
}

const runtime = makeRuntime();
let exitCode = 0;
try {
  if (!organizationId) {
    console.error("Pass --organization-id");
    exitCode = 1;
  } else if (command === "status") {
    const status = await runtime.runPromise(balanceHomeStatus(organizationId));
    console.log(
      JSON.stringify(
        status,
        (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        2,
      ),
    );
  } else {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const where = yield* banner(organizationId);
        console.log(formatBanner(where).join("\n"));
        const demoOrganizationId = yield* Config.option(
          Config.string(DEMO_ORGANIZATION_ENV),
        );
        return yield* program({
          organizationId,
          companyName: values["company-name"],
          confirmed: values.yes,
          demoOrganizationId: Option.getOrUndefined(demoOrganizationId),
        });
      }),
    );
    if (Exit.isSuccess(exit)) {
      const { balanceHome, confidentialUsdc, draining } = exit.value;
      console.log(
        [
          `Balance home: ${balanceHome}`,
          `Confidential account holds ${formatUsdc(confidentialUsdc)} USDC`,
          ...(draining
            ? [
                "Move-out requested. New money operations wait while the job drains the account; run the status command to inspect progress.",
              ]
            : balanceHome === "confidential_account"
              ? [
                  "The move-in job moves the company wallet's USDC on its next run.",
                ]
              : []),
        ].join("\n"),
      );
    } else {
      console.error(describeFailure(exit.cause));
      exitCode = 1;
    }
  }
} finally {
  await runtime.dispose();
}
process.exitCode = exitCode;

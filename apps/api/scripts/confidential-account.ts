/**
 * Turns a company's confidential account on or off, on staging only. It
 * flips `wallets.balance_home` and audits the change; it moves no money. The
 * move-in job (src/station/move-ins.ts) moves the company's USDC into its
 * confidential account on its next run, which is turning the feature on
 * over the whole balance.
 *
 * Every command starts by printing the company's name and the database host,
 * then refuses unless all of these hold:
 *   - CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID equals --organization-id
 *     (set only in the staging configuration);
 *   - --company-name is the company's name exactly;
 *   - --yes;
 *   - nothing of the company's is in flight;
 *   - the company's confidential account can be read, and for turn-off holds
 *     exactly 0 USDC (moving a balance back out to the company wallet isn't
 *     built yet, so a company that holds money there stays on).
 *
 *   turn-on  --organization-id <id> --company-name <name> --yes
 *   turn-off --organization-id <id> --company-name <name> --yes
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
      const { balanceHome, confidentialUsdc } = exit.value;
      console.log(
        [
          `Balance home: ${balanceHome}`,
          `Confidential account holds ${formatUsdc(confidentialUsdc)} USDC`,
          ...(balanceHome === "confidential_account"
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

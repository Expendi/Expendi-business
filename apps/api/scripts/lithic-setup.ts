/**
 * Points Lithic's sandbox at a deployed API (spec §6.25): the event
 * subscription, the purchase check (Auth Stream Access) and the rule blocking
 * cash and gambling across all companies. Safe to run again.
 *
 *   status                        what's set up now
 *   apply --api-url <https://…>   set everything up for that API
 *   webhook-secret                prints only the event signing secret
 *   asa-secret                    prints only the purchase check's secret
 *
 * The two secret commands exist to be piped into Doppler; see
 * `docs/runbooks/lithic-sandbox.md`.
 *
 * Run: doppler run -p expendi-business -c dev -- pnpm --filter
 *      @expendi-business/api exec tsx scripts/lithic-setup.ts <command>
 */
import { parseArgs } from "node:util";
import { z } from "zod";

import { pauseAfterWrite, sandboxCall } from "./lib/lithic-sandbox.js";

const RULE_NAME = "Block cash and gambling";

/** Cash withdrawals and quasi-cash, then betting and lotteries. */
const BLOCKED_MCCS = [
  "6010",
  "6011",
  "6051",
  "4829",
  "7995",
  "7800",
  "7801",
  "7802",
  "9406",
];

const subscriptionsSchema = z.looseObject({
  data: z.array(z.looseObject({ token: z.string(), url: z.string() })),
});

const secretSchema = z.looseObject({ secret: z.string().min(1) });

const rulesSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      token: z.string(),
      name: z.string().nullish(),
      state: z.string().optional(),
    }),
  ),
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "api-url": { type: "string" } },
});

async function subscriptions() {
  const { data } = subscriptionsSchema.parse(
    await sandboxCall("GET", "/v1/event_subscriptions"),
  );
  return data;
}

async function blockRule() {
  const { data } = rulesSchema.parse(
    await sandboxCall("GET", "/v2/auth_rules?page_size=100"),
  );
  return data.find((rule) => rule.name === RULE_NAME);
}

async function status(): Promise<void> {
  const subs = await subscriptions();
  const asa = await sandboxCall(
    "GET",
    "/v1/responder_endpoints?type=AUTH_STREAM_ACCESS",
  );
  const rule = await blockRule();
  console.log(
    JSON.stringify(
      {
        eventSubscriptions: subs.map(({ url }) => url),
        purchaseCheck: asa,
        blockRule: rule ? { state: rule.state } : null,
      },
      null,
      2,
    ),
  );
}

async function apply(apiUrl: string): Promise<void> {
  const base = apiUrl.replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    throw new Error("--api-url must be HTTPS");
  }
  const eventsUrl = `${base}/webhooks/lithic`;
  if ((await subscriptions()).some(({ url }) => url === eventsUrl)) {
    console.log("event subscription: already set");
  } else {
    await sandboxCall("POST", "/v1/event_subscriptions", {
      url: eventsUrl,
      description: "Expendi Business card purchases",
      event_types: ["card_transaction.updated"],
    });
    await pauseAfterWrite();
    console.log(`event subscription: created for ${eventsUrl}`);
  }

  await sandboxCall("POST", "/v1/responder_endpoints", {
    type: "AUTH_STREAM_ACCESS",
    url: `${base}/webhooks/lithic/authorization`,
  });
  await pauseAfterWrite();
  console.log("purchase check: enrolled");

  if (await blockRule()) {
    console.log("cash and gambling rule: already set");
    return;
  }
  const created = await sandboxCall("POST", "/v2/auth_rules", {
    name: RULE_NAME,
    type: "CONDITIONAL_ACTION",
    event_stream: "AUTHORIZATION",
    program_level: true,
    parameters: {
      conditions: [
        { attribute: "MCC", operation: "IS_ONE_OF", value: BLOCKED_MCCS },
      ],
      action: "DECLINE",
    },
  });
  await pauseAfterWrite();
  await sandboxCall(
    "POST",
    `/v2/auth_rules/${String(created.token)}/promote`,
    {},
  );
  await pauseAfterWrite();
  console.log("cash and gambling rule: active");
}

async function webhookSecret(): Promise<void> {
  const [subscription] = await subscriptions();
  if (!subscription) throw new Error("Run apply first");
  const { secret } = secretSchema.parse(
    await sandboxCall(
      "GET",
      `/v1/event_subscriptions/${subscription.token}/secret`,
    ),
  );
  process.stdout.write(secret);
}

async function asaSecret(): Promise<void> {
  const { secret } = secretSchema.parse(
    await sandboxCall("GET", "/v1/auth_stream/secret"),
  );
  process.stdout.write(secret);
}

const [command] = positionals;
if (command === "status") {
  await status();
} else if (command === "apply" && values["api-url"]) {
  await apply(values["api-url"]);
} else if (command === "webhook-secret") {
  await webhookSecret();
} else if (command === "asa-secret") {
  await asaSecret();
} else {
  throw new Error(
    "Use: status | apply --api-url <https://…> | webhook-secret | asa-secret",
  );
}

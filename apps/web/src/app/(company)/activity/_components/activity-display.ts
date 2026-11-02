import type { ActivityEntry } from "@expendi-business/shared";

/**
 * The areas of the audit log a company filters by: each is the start of
 * the actions recorded for it (`<entity>.<verb>`, spec §6.13).
 */
export const ACTIVITY_AREAS: readonly {
  readonly prefix: string;
  readonly label: string;
}[] = [
  { prefix: "expense.", label: "Claims and spending" },
  { prefix: "payout.", label: "Payments and withdrawals" },
  { prefix: "bill.", label: "Bills" },
  { prefix: "recurring_item.", label: "Recurring payments" },
  { prefix: "salary.", label: "Salaries" },
  { prefix: "payroll_run.", label: "Payroll runs" },
  { prefix: "float.", label: "Petty cash" },
  { prefix: "payee.", label: "Payees" },
  { prefix: "membership.", label: "Team" },
  { prefix: "category.", label: "Categories" },
  { prefix: "paid_from_account.", label: "Paid-from accounts" },
  { prefix: "withdrawal_address.", label: "Allowed addresses" },
  { prefix: "wallet.", label: "Wallet" },
  { prefix: "organization.", label: "Company settings" },
  { prefix: "accounting_", label: "Zoho Books" },
  { prefix: "report_export.", label: "Exports" },
];

const words = (identifier: string) => identifier.replaceAll("_", " ").trim();

const capitalised = (text: string) =>
  text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

/** `payroll_run.payment_left_out` → `Payroll run payment left out`. */
export function describeAction(action: string): string {
  const [entity = "", ...verb] = action.split(".");
  return capitalised([words(entity), ...verb.map(words)].join(" "));
}

/** Who did it: a person in the company, Expendi's team, or its systems. */
export function describeActor(actor: ActivityEntry["actor"]): string {
  switch (actor.type) {
    case "user":
      return actor.name ?? "Someone no longer in the company";
    case "staff":
      return "Expendi team";
    case "system":
      return "Expendi (automatic)";
  }
}

type Json = ActivityEntry["after"];

function asFields(value: Json): Readonly<Record<string, Json>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

const MAX_VALUE_LENGTH = 60;

function shown(value: Json | undefined): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = JSON.stringify(value);
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : text;
}

/** `etimsNotRequired` → `Etims not required`. */
function fieldName(key: string): string {
  return capitalised(
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase(),
  );
}

const MAX_LINES = 6;

/**
 * The recorded values in a line each: `Name: Flights → Air tickets` where a
 * field changed, `Name: Flights` where it was only recorded once.
 */
export function describeChanges(before: Json, after: Json): string[] {
  const from = asFields(before);
  const to = asFields(after);
  const keys = [
    ...new Set([...Object.keys(to ?? {}), ...Object.keys(from ?? {})]),
  ];
  return keys.slice(0, MAX_LINES).map((key) => {
    const name = fieldName(key);
    const hadBefore = from !== null && key in from;
    const hasAfter = to !== null && key in to;
    if (hadBefore && hasAfter) {
      const [was, now] = [shown(from[key]), shown(to[key])];
      return was === now ? `${name}: ${now}` : `${name}: ${was} → ${now}`;
    }
    return hasAfter
      ? `${name}: ${shown(to[key])}`
      : `${name} was ${shown(from?.[key])}`;
  });
}

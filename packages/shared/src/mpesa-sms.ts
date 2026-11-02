interface ParsedMpesaSmsBase {
  /** The M-Pesa transaction code, uppercase (`SKL3ABCDEF`). */
  code: string;
  /** Integer KES cents as a string: Ksh1,500.00 is `"150000"`. */
  amountKesCents: string;
  /** The business name, or the recipient's name for Send Money. */
  counterparty: string;
  /** ISO 8601 in Nairobi time, e.g. `2025-05-12T14:15:00+03:00`. */
  occurredAt: string;
  /** The M-Pesa balance after the payment, when the SMS gives it. */
  balanceKesCents?: string;
  /** M-Pesa's fee for the payment, when the SMS gives it. */
  transactionCostKesCents?: string;
}

export interface ParsedBuyGoodsSms extends ParsedMpesaSmsBase {
  kind: "buy_goods";
}

export interface ParsedSendMoneySms extends ParsedMpesaSmsBase {
  kind: "send_money";
  /** The recipient's number in E.164, when the SMS shows it in full. */
  phone?: string;
  /** The recipient's number exactly as shown when Safaricom masks it (`0712***678`). */
  phoneMasked?: string;
}

export interface ParsedPaybillSms extends ParsedMpesaSmsBase {
  kind: "paybill";
  accountReference: string;
}

export type ParsedMpesaSms =
  ParsedBuyGoodsSms | ParsedSendMoneySms | ParsedPaybillSms;

export type MpesaSmsKind = ParsedMpesaSms["kind"];

export type MpesaSmsParseResult =
  | { ok: true; sms: ParsedMpesaSms }
  | { ok: false; reason: "unrecognised" | "empty" };

type Payee =
  | Pick<ParsedBuyGoodsSms, "kind">
  | Pick<ParsedSendMoneySms, "kind" | "phone" | "phoneMasked">
  | Pick<ParsedPaybillSms, "kind" | "accountReference">;

type Groups = Record<string, string | undefined>;

/** M-Pesa shows Nairobi time, which has no daylight saving. */
const NAIROBI_OFFSET = "+03:00";

const KSH_AMOUNT = String.raw`kshs?\.?\s*(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<fraction>\d{1,2}))?`;
const ON_DATE_AT_TIME = String.raw`\s+on\s+(?<day>\d{1,2})/(?<month>\d{1,2})/(?<year>20\d{2}|\d{2})\s+at\s+(?<hour>\d{1,2}):(?<minute>\d{2})\s*(?<meridiem>[ap])\.?\s*m`;
const COUNTERPARTY = String.raw`(?<counterparty>\S.{0,119}?)`;
const FULL_PHONE = String.raw`\+?(?:254|0)\d{9}`;
const MASKED_PHONE = String.raw`\+?(?=[\d*]{9,13}\s)[\d*]*\*[\d*]*`;

const CONFIRMATION_START = /\b[a-z][a-z0-9]{9}\s+confirmed/gi;
const HEADER = new RegExp(
  String.raw`^(?<code>[a-z][a-z0-9]{9})\s+confirmed\.?\s*${KSH_AMOUNT}\s+(?<verb>paid|sent)\s+to\s+`,
  "i",
);
const PAYBILL = new RegExp(
  String.raw`^${COUNTERPARTY}\s+for\s+account\s+(?<account>\S.{0,79}?)${ON_DATE_AT_TIME}`,
  "i",
);
const BUY_GOODS = new RegExp(
  String.raw`^${COUNTERPARTY}\.?${ON_DATE_AT_TIME}`,
  "i",
);
const SEND_MONEY = new RegExp(
  String.raw`^${COUNTERPARTY}(?:\s+(?<phone>${FULL_PHONE}|${MASKED_PHONE}))?${ON_DATE_AT_TIME}`,
  "i",
);
const BALANCE = new RegExp(
  String.raw`m-?pesa\s+balance\s+is\s+${KSH_AMOUNT}`,
  "i",
);
const TRANSACTION_COST = new RegExp(
  String.raw`transaction\s+cost,?\s+${KSH_AMOUNT}`,
  "i",
);
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Read a pasted M-Pesa payment confirmation (spec §6.4): Buy Goods, Send Money
 * or Paybill. Anything else (money received, a failed payment, a Fuliza
 * notice) is `unrecognised`, so the app falls back to manual entry. Never
 * throws.
 *
 * When several messages are pasted together, the first payment confirmation
 * wins; non-payment messages before it are skipped.
 */
export function parseMpesaSms(text: string): MpesaSmsParseResult {
  const normalised = normaliseMpesaSms(text);
  if (normalised === "") return { ok: false, reason: "empty" };

  for (const message of splitAtConfirmations(normalised)) {
    const sms = parseConfirmation(message);
    if (sms) return { ok: true, sms };
  }
  return { ok: false, reason: "unrecognised" };
}

/**
 * The pasted text as the parser reads it: invisible characters dropped and
 * whitespace collapsed, so the same SMS pasted twice is the same string.
 */
export function normaliseMpesaSms(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, "").replace(/\s+/g, " ").trim();
}

function splitAtConfirmations(text: string): string[] {
  const starts = Array.from(
    text.matchAll(CONFIRMATION_START),
    (match) => match.index,
  );
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

function parseConfirmation(message: string): ParsedMpesaSms | null {
  const header = HEADER.exec(message);
  const code = header?.groups?.code;
  const verb = header?.groups?.verb?.toLowerCase();
  const amountKesCents = toKesCents(header);
  if (
    !header ||
    code === undefined ||
    verb === undefined ||
    amountKesCents === undefined ||
    amountKesCents === "0"
  ) {
    return null;
  }

  const rest = message.slice(header[0].length);
  const body =
    PAYBILL.exec(rest) ?? (verb === "paid" ? BUY_GOODS : SEND_MONEY).exec(rest);
  const groups: Groups = body?.groups ?? {};
  const counterparty = groups.counterparty;
  const occurredAt = toNairobiIso(groups);
  if (!body || counterparty === undefined || occurredAt === undefined) {
    return null;
  }

  const trailing = rest.slice(body[0].length);
  const balanceKesCents = toKesCents(BALANCE.exec(trailing));
  const transactionCostKesCents = toKesCents(TRANSACTION_COST.exec(trailing));

  return {
    ...toPayee(groups, verb),
    code: code.toUpperCase(),
    amountKesCents,
    counterparty,
    occurredAt,
    ...(balanceKesCents === undefined ? {} : { balanceKesCents }),
    ...(transactionCostKesCents === undefined
      ? {}
      : { transactionCostKesCents }),
  };
}

function toPayee(groups: Groups, verb: string): Payee {
  if (groups.account !== undefined) {
    return { kind: "paybill", accountReference: groups.account };
  }
  if (verb === "paid") return { kind: "buy_goods" };

  const phone = groups.phone;
  if (phone === undefined) return { kind: "send_money" };
  if (phone.includes("*")) return { kind: "send_money", phoneMasked: phone };
  return { kind: "send_money", phone: `+254${phone.slice(-9)}` };
}

function toKesCents(amount: RegExpExecArray | null): string | undefined {
  const whole = amount?.groups?.whole;
  if (whole === undefined) return undefined;
  const fraction = amount?.groups?.fraction ?? "";
  const cents =
    BigInt(whole.replaceAll(",", "")) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents.toString();
}

function toNairobiIso(groups: Groups): string | undefined {
  const year = 2000 + (Number(groups.year) % 100);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour12 = Number(groups.hour);
  const minute = Number(groups.minute);
  const isRealMoment =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour12 >= 1 &&
    hour12 <= 12 &&
    minute <= 59;
  if (!isRealMoment) return undefined;

  const hour =
    (hour12 % 12) + (groups.meridiem?.toLowerCase() === "p" ? 12 : 0);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${NAIROBI_OFFSET}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

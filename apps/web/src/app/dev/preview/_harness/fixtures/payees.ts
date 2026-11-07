import type { QueryClient } from "@tanstack/react-query";

import type {
  Payee,
  PayeeBanksResponse,
  PayeeDetails,
  PayeeKind,
  WithdrawalAddress,
} from "@expendi-business/shared";

import { ACTIVE_PAYEES, ARCHIVED_PAYEES } from "~/features/payees/payees-api";
import { payeeKeys } from "~/features/payment-keys";
import { OPEN_BILLS, SETTLED_BILLS } from "./bills";
import { ORGANIZATION_ID, sampleId } from "./company";
import { PAYROLL_PERSON_IDS } from "./payroll";

/**
 * docs/mocks/payees.html. Suppliers and vendors share the Bills sample's
 * ids, so "See bills" finds theirs; people share Payroll's. "Now" is
 * 6 Nov 2026, 10:30 in Nairobi.
 */

const NOW = Date.parse("2026-11-06T10:30:00+03:00");
const HOLD_MS = 24 * 60 * 60_000;

export const PAYEE_BANKS: PayeeBanksResponse = [
  { code: "BARCKENX", name: "Absa Bank Kenya" },
  { code: "KCOOKENA", name: "Co-operative Bank of Kenya" },
  { code: "DTKEKENA", name: "Diamond Trust Bank" },
  { code: "EQBLKENA", name: "Equity Bank" },
  { code: "FABLKENA", name: "Family Bank" },
  { code: "IMBLKENA", name: "I&M Bank" },
  { code: "KCBLKENX", name: "KCB Bank Kenya" },
  { code: "CBAFKENX", name: "NCBA Bank Kenya" },
  { code: "SBICKENX", name: "Stanbic Bank Kenya" },
  { code: "SCBLKENX", name: "Standard Chartered Kenya" },
];

const address = (n: number, label: string, hex: string): WithdrawalAddress => ({
  id: sampleId(n),
  address: hex,
  label,
  confirmedAt: "2025-10-20T07:00:00.000Z",
});

export const ALLOWLIST: readonly WithdrawalAddress[] = [
  address(
    2401,
    "Treasury on Coinbase",
    "0x12ab7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99f3c",
  ),
  address(
    2402,
    "Ledger cold storage",
    "0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
  ),
  address(2403, "Figma billing", "0x7f2e4c1a9d03b85e6f21c7a4d9e0b3f86a12b9c4"),
  address(
    2404,
    "Google Workspace billing",
    "0x3c91e2b75f4a08d6c3e19b72f5a4d8c0e6b1a07e",
  ),
  address(2405, "Canva billing", "0x51aa7d3e8c2b4f6091e5d7a3c8b2f4e6a1d709d2"),
];

const addressOf = (label: string): string =>
  ALLOWLIST.find((entry) => entry.label === label)?.address ?? "";

const paybill = (
  paybillNumber: string,
  accountReference: string,
  accountName: string,
): PayeeDetails => ({
  method: "mpesa_paybill",
  paybillNumber,
  accountReference,
  accountName,
});

/** Team memberships from the Team sample. */
const MEMBERS = {
  brian: { id: sampleId(9103), email: "brian@mwangaza.co.ke", confirmed: true },
  faith: { id: sampleId(9102), email: "faith@mwangaza.co.ke", confirmed: true },
  kevin: { id: sampleId(9104), email: "kevin@mwangaza.co.ke", confirmed: true },
  grace: {
    id: sampleId(9105),
    email: "grace@mwangaza.co.ke",
    confirmed: false,
  },
  peter: { id: sampleId(9107), email: "peter@mwangaza.co.ke", confirmed: true },
  amina: { id: sampleId(9108), email: "amina@mwangaza.co.ke", confirmed: true },
} as const;

const billCount = (payeeId: string): number =>
  [...OPEN_BILLS, ...SETTLED_BILLS].filter((bill) => bill.payee.id === payeeId)
    .length;

interface SamplePayee {
  readonly id: string;
  readonly name: string;
  readonly kind: PayeeKind;
  readonly details: PayeeDetails | null;
  /** Nairobi wall-clock time, e.g. "2026-01-12T09:14". */
  readonly changedAt: string | null;
  readonly member?: keyof typeof MEMBERS;
  readonly archived?: boolean;
}

function payee(sample: SamplePayee): Payee {
  const changedAt = sample.changedAt
    ? Date.parse(`${sample.changedAt}:00+03:00`)
    : null;
  const until =
    changedAt !== null && changedAt + HOLD_MS > NOW
      ? new Date(changedAt + HOLD_MS).toISOString()
      : null;
  const member = sample.member ? MEMBERS[sample.member] : null;
  const created = changedAt ?? Date.parse("2025-11-03T08:00:00+03:00");
  return {
    id: sample.id,
    kind: sample.kind,
    name: sample.name,
    membershipId: member?.id ?? null,
    details: sample.details,
    payoutPhoneConfirmed: member ? member.confirmed : null,
    detailsChangedAt: changedAt ? new Date(changedAt).toISOString() : null,
    secondConfirmationUntil: until,
    archived: sample.archived ?? false,
    member: member
      ? { name: sample.name, email: member.email, inTeam: true }
      : null,
    billCount: billCount(sample.id),
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created).toISOString(),
  };
}

const employee = (
  id: string,
  name: string,
  member: keyof typeof MEMBERS,
  details: PayeeDetails,
  changedAt: string,
): SamplePayee => ({ id, name, kind: "employee", member, details, changedAt });

const SAMPLE_PAYEES: readonly SamplePayee[] = [
  {
    id: sampleId(101),
    name: "Kilimani Properties",
    kind: "supplier",
    details: paybill("522522", "KP-1182", "Kilimani Properties Ltd"),
    changedAt: "2026-01-12T09:14",
  },
  {
    id: sampleId(103),
    name: "Safaricom",
    kind: "vendor",
    details: paybill("150501", "7720431", "Safaricom PLC"),
    changedAt: "2025-11-03T11:02",
  },
  {
    id: sampleId(102),
    name: "Securex Guards",
    kind: "supplier",
    details: paybill("880100", "MWZ-22", "Securex Guards Ltd"),
    changedAt: "2026-02-20T15:40",
  },
  {
    id: sampleId(105),
    name: "Zuku",
    kind: "vendor",
    details: paybill("320320", "118-2219", "Wananchi Group Kenya"),
    changedAt: "2026-04-08T10:21",
  },
  {
    id: sampleId(106),
    name: "Twiga Foods",
    kind: "supplier",
    details: paybill("222111", "TF-0091", "Twiga Foods Ltd"),
    changedAt: "2026-11-02T12:10",
  },
  {
    id: sampleId(107),
    name: "KRA",
    kind: "statutory",
    details: paybill("572572", "PRN", "Kenya Revenue Authority"),
    changedAt: "2025-11-03T11:30",
  },
  {
    id: sampleId(108),
    name: "Nairobi Water",
    kind: "supplier",
    details: paybill("444400", "NW-7789", "Nairobi City Water and Sewerage"),
    changedAt: "2025-12-01T08:45",
  },
  {
    id: sampleId(110),
    name: "Kenya Power",
    kind: "supplier",
    details: paybill("888880", "54012339", "Kenya Power and Lighting"),
    changedAt: "2025-11-03T11:18",
  },
  {
    id: sampleId(109),
    name: "Bidco Kenya",
    kind: "supplier",
    details: {
      method: "bank",
      bankCode: "SBICKENX",
      accountNumber: "0100291804321",
      accountName: "Bidco Africa Ltd",
    },
    changedAt: "2026-11-05T16:40",
  },
  {
    id: sampleId(114),
    name: "CarMax Mechanics",
    kind: "supplier",
    details: null,
    changedAt: null,
  },
  {
    id: sampleId(113),
    name: "Hotpoint Appliances",
    kind: "supplier",
    details: { method: "outside" },
    changedAt: null,
  },
  {
    id: sampleId(104),
    name: "Figma",
    kind: "vendor",
    details: { method: "usdc", address: addressOf("Figma billing") },
    changedAt: "2026-05-02T14:26",
  },
  {
    id: sampleId(111),
    name: "Google Workspace",
    kind: "vendor",
    details: { method: "usdc", address: addressOf("Google Workspace billing") },
    changedAt: "2025-11-04T09:50",
  },
  {
    id: sampleId(112),
    name: "Jubilee Health",
    kind: "supplier",
    details: paybill("511000", "JH-77812", "Jubilee Health Insurance"),
    changedAt: "2026-07-01T10:05",
  },
  {
    id: sampleId(116),
    name: "Rubis Ngong Road",
    kind: "supplier",
    details: {
      method: "mpesa_till",
      tillNumber: "552310",
      accountName: "Rubis Ngong Road",
    },
    changedAt: "2026-03-09T17:22",
  },
  {
    id: PAYROLL_PERSON_IDS.moses,
    name: "Moses Kiptoo",
    kind: "personnel",
    details: {
      method: "mpesa_phone",
      phone: "+254722418903",
      accountName: "Moses Kiptoo",
    },
    changedAt: "2026-09-14T08:03",
  },
  employee(
    PAYROLL_PERSON_IDS.brian,
    "Brian Otieno",
    "brian",
    { method: "mpesa_phone", accountName: "Brian Otieno" },
    "2025-11-10T12:00",
  ),
  employee(
    PAYROLL_PERSON_IDS.faith,
    "Faith Wambui",
    "faith",
    {
      method: "bank",
      bankCode: "KCBLKENX",
      accountNumber: "1180274455",
      accountName: "Faith Wambui",
    },
    "2026-08-21T16:12",
  ),
  employee(
    PAYROLL_PERSON_IDS.kevin,
    "Kevin Mwangi",
    "kevin",
    { method: "mpesa_phone", accountName: "Kevin Mwangi" },
    "2025-11-10T12:02",
  ),
  employee(
    PAYROLL_PERSON_IDS.grace,
    "Grace Achieng",
    "grace",
    { method: "mpesa_phone", accountName: "Grace Achieng" },
    "2026-10-28T09:41",
  ),
  employee(
    PAYROLL_PERSON_IDS.peter,
    "Peter Njoroge",
    "peter",
    { method: "mpesa_phone", accountName: "Peter Njoroge" },
    "2025-11-10T12:05",
  ),
  employee(
    PAYROLL_PERSON_IDS.amina,
    "Amina Hassan",
    "amina",
    { method: "mpesa_phone", accountName: "Amina Hassan" },
    "2026-02-03T11:30",
  ),
  {
    id: sampleId(115),
    name: "Canva",
    kind: "vendor",
    details: { method: "usdc", address: addressOf("Canva billing") },
    changedAt: "2025-12-02T10:00",
    archived: true,
  },
  {
    id: sampleId(117),
    name: "Jambo Couriers",
    kind: "supplier",
    details: {
      method: "mpesa_till",
      tillNumber: "300400",
      accountName: "Jambo Couriers Ltd",
    },
    changedAt: "2026-01-18T13:30",
    archived: true,
  },
];

export const PAYEES: readonly Payee[] = SAMPLE_PAYEES.map(payee);

const byName = (a: Payee, b: Payee) => a.name.localeCompare(b.name);

export function seedPayees(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(
    payeeKeys.list(org, ACTIVE_PAYEES),
    PAYEES.filter((entry) => !entry.archived).sort(byName),
  );
  client.setQueryData(
    payeeKeys.list(org, ARCHIVED_PAYEES),
    PAYEES.filter((entry) => entry.archived).sort(byName),
  );
  for (const entry of PAYEES) {
    client.setQueryData(payeeKeys.detail(org, entry.id), entry);
  }
  client.setQueryData(payeeKeys.banks(org), PAYEE_BANKS);
  client.setQueryData(payeeKeys.allowlist(org), ALLOWLIST);
}

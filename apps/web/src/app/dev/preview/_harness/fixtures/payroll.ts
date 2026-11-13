import type { QueryClient } from "@tanstack/react-query";

import type {
  Category,
  PayeeKind,
  PayrollPayment,
  PayrollRun,
  PayrollRunDetail,
  Salary,
} from "@expendi-business/shared";

import { payrollKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { ORGANIZATION_ID, sampleId } from "./company";

/**
 * docs/mocks/payroll.html: personnel are paid on the 10th, staff on the
 * 28th. November's personnel run waits for approval; the rest are paid.
 */

const kes = (shillings: number) => String(Math.round(shillings * 100));

const SALARIES_CATEGORY = { id: sampleId(210), name: "Salaries" };
const SECURITY_CATEGORY = { id: sampleId(205), name: "Security" };

/** The categories a salary can go under; ids match the bills sample. */
export const PAYROLL_CATEGORIES: readonly Category[] = [
  { id: sampleId(209), name: "Airtime & internet", etimsNotRequired: false },
  { id: sampleId(201), name: "Equipment", etimsNotRequired: false },
  { id: sampleId(202), name: "Insurance", etimsNotRequired: false },
  { id: sampleId(203), name: "Rent & utilities", etimsNotRequired: false },
  { id: sampleId(204), name: "Repairs & maintenance", etimsNotRequired: false },
  { ...SALARIES_CATEGORY, etimsNotRequired: true },
  { ...SECURITY_CATEGORY, etimsNotRequired: false },
  { id: sampleId(206), name: "Software", etimsNotRequired: false },
  { id: sampleId(207), name: "Suppliers", etimsNotRequired: false },
  { id: sampleId(208), name: "Taxes", etimsNotRequired: true },
];

type Person = Salary["payee"];

function person(
  n: number,
  name: string,
  kind: PayeeKind,
  method: "mpesa_phone" | "bank",
  last4: string,
  payoutPhoneConfirmed: boolean | null = kind === "employee" ? true : null,
): Person {
  const ownNumber = kind === "employee" && method === "mpesa_phone";
  return {
    id: sampleId(n),
    name,
    kind,
    method,
    archived: false,
    payoutPhoneConfirmed,
    accountEnding: ownNumber ? null : last4,
  };
}

/** Payee ids shared with the Payees sample, so the same people match. */
export const PAYROLL_PERSON_IDS = {
  faith: sampleId(2001),
  brian: sampleId(2003),
  moses: sampleId(2005),
  grace: sampleId(2007),
  kevin: sampleId(2011),
  peter: sampleId(2012),
  amina: sampleId(2014),
} as const;

const PEOPLE = {
  fw: person(2001, "Faith Wambui", "employee", "mpesa_phone", "4127"),
  dk: person(2002, "Daniel Kiprop", "employee", "bank", "0915"),
  bo: person(2003, "Brian Otieno", "employee", "mpesa_phone", "2210"),
  lw: person(2004, "Lilian Wairimu", "employee", "bank", "5562"),
  mk: person(2005, "Moses Kiptoo", "employee", "mpesa_phone", "8804"),
  vn: person(2006, "Victor Ndegwa", "employee", "mpesa_phone", "3371"),
  ga: person(2007, "Grace Achieng", "employee", "mpesa_phone", "6649"),
  sa: person(2008, "Sharon Atieno", "employee", "mpesa_phone", "1185"),
  rc: person(2009, "Ruth Chebet", "employee", "mpesa_phone", "7023"),
  en: person(2010, "Esther Njeri", "employee", "mpesa_phone", "9450"),
  km: person(2011, "Kevin Mwangi", "employee", "mpesa_phone", "5678"),
  pn: person(2012, "Peter Njoroge", "employee", "mpesa_phone", "3016"),
  co: person(2013, "Collins Omondi", "employee", "mpesa_phone", "4492"),
  ah: person(2014, "Amina Hassan", "employee", "mpesa_phone", "8137", false),
  to: person(2015, "Tom Odhiambo", "employee", "mpesa_phone", "2768"),
  jo: person(2016, "Joseph Ouma", "personnel", "mpesa_phone", "4417"),
  ma: person(2017, "Mary Akinyi", "personnel", "mpesa_phone", "9023"),
  aj: person(2018, "Ali Juma", "personnel", "mpesa_phone", "3381"),
  ia: person(2019, "Ibrahim Abdi", "personnel", "mpesa_phone", "7765"),
  sk: person(2020, "Samuel Kariuki", "personnel", "bank", "2290"),
} as const;

type PersonKey = keyof typeof PEOPLE;

interface SampleSalary {
  readonly person: PersonKey;
  readonly shillings: number;
  readonly payDay: 10 | 28;
  readonly startsOn: string;
  readonly state?: Salary["state"];
  readonly endsOn?: string;
  readonly security?: boolean;
}

const SAMPLE_SALARIES: readonly SampleSalary[] = [
  { person: "fw", shillings: 180_000, payDay: 28, startsOn: "2023-02-01" },
  { person: "dk", shillings: 150_000, payDay: 28, startsOn: "2023-02-01" },
  { person: "bo", shillings: 125_000, payDay: 28, startsOn: "2023-06-05" },
  { person: "lw", shillings: 110_000, payDay: 28, startsOn: "2024-01-08" },
  { person: "mk", shillings: 100_000, payDay: 28, startsOn: "2023-09-01" },
  { person: "vn", shillings: 90_000, payDay: 28, startsOn: "2024-04-02" },
  { person: "ga", shillings: 80_000, payDay: 28, startsOn: "2023-02-01" },
  { person: "sa", shillings: 78_000, payDay: 28, startsOn: "2025-02-03" },
  { person: "rc", shillings: 70_000, payDay: 28, startsOn: "2024-08-01" },
  { person: "en", shillings: 65_000, payDay: 28, startsOn: "2025-01-06" },
  { person: "km", shillings: 48_000, payDay: 28, startsOn: "2023-05-02" },
  { person: "pn", shillings: 48_000, payDay: 28, startsOn: "2024-03-04" },
  { person: "co", shillings: 48_000, payDay: 28, startsOn: "2025-06-02" },
  { person: "ah", shillings: 48_000, payDay: 28, startsOn: "2026-11-01" },
  {
    person: "to",
    shillings: 48_000,
    payDay: 28,
    startsOn: "2024-06-03",
    state: "ended",
    endsOn: "2026-10-31",
  },
  { person: "jo", shillings: 26_000, payDay: 10, startsOn: "2025-01-06" },
  { person: "ma", shillings: 18_000, payDay: 10, startsOn: "2025-03-03" },
  { person: "aj", shillings: 22_000, payDay: 10, startsOn: "2025-08-01" },
  {
    person: "ia",
    shillings: 24_000,
    payDay: 10,
    startsOn: "2025-05-12",
    security: true,
  },
  {
    person: "sk",
    shillings: 26_000,
    payDay: 10,
    startsOn: "2024-11-04",
    state: "paused",
  },
];

const categoryOf = (sample: SampleSalary) =>
  sample.security ? SECURITY_CATEGORY : SALARIES_CATEGORY;

export const SALARIES: readonly Salary[] = SAMPLE_SALARIES.map((sample, at) => {
  const state = sample.state ?? "active";
  return {
    id: sampleId(2101 + at),
    state,
    payee: PEOPLE[sample.person],
    category: categoryOf(sample),
    amountKes: kes(sample.shillings),
    payDay: sample.payDay,
    startsOn: sample.startsOn,
    endsOn: sample.endsOn ?? null,
    nextPayDate:
      state === "ended"
        ? null
        : sample.payDay === 28
          ? "2026-11-28"
          : "2026-12-10",
    createdAt: `${sample.startsOn}T06:00:00.000Z`,
    updatedAt: "2026-11-01T06:00:00.000Z",
  };
});

const salaryOf = (key: PersonKey) => {
  const found = SAMPLE_SALARIES.find((sample) => sample.person === key);
  if (!found) throw new Error(`No sample salary for ${key}`);
  return found;
};

const STAFF: readonly PersonKey[] = [
  "fw",
  "dk",
  "bo",
  "lw",
  "mk",
  "vn",
  "ga",
  "sa",
  "rc",
  "en",
  "km",
  "pn",
  "co",
  "to",
];
const PERSONNEL: readonly PersonKey[] = ["jo", "ma", "aj", "ia", "sk"];

interface SampleRun {
  readonly n: number;
  readonly payDate: string;
  readonly people: readonly PersonKey[];
  /** Nairobi time it was approved; null for a draft. */
  readonly approvedAt: string | null;
  readonly changes?: Partial<
    Record<PersonKey, { shillings?: number; reason?: string; leftOut?: string }>
  >;
}

const SAMPLE_RUNS: readonly SampleRun[] = [
  {
    n: 2201,
    payDate: "2026-11-10",
    people: ["jo", "ma", "aj", "ia"],
    approvedAt: null,
    changes: { ma: { shillings: 15_692.31, reason: "Unpaid leave, 3 days" } },
  },
  {
    n: 692,
    payDate: "2026-10-28",
    people: STAFF,
    approvedAt: "2026-10-28T09:58",
  },
  {
    n: 2203,
    payDate: "2026-10-10",
    people: PERSONNEL,
    approvedAt: "2026-10-09T17:12",
  },
  {
    n: 2204,
    payDate: "2026-09-28",
    people: STAFF,
    approvedAt: "2026-09-27T16:40",
    changes: { en: { leftOut: "On unpaid leave in September" } },
  },
  {
    n: 2205,
    payDate: "2026-09-10",
    people: PERSONNEL,
    approvedAt: "2026-09-10T08:05",
  },
  {
    n: 2206,
    payDate: "2026-08-28",
    people: STAFF,
    approvedAt: "2026-08-28T09:15",
  },
  {
    n: 2207,
    payDate: "2026-08-10",
    people: PERSONNEL,
    approvedAt: "2026-08-10T08:30",
  },
];

const nairobiToUtc = (local: string) =>
  new Date(`${local}:00+03:00`).toISOString();

const draftedOn = (payDate: string) =>
  `${new Date(Date.parse(`${payDate}T00:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10)}T06:00:00.000Z`;

function sampleRun(sample: SampleRun): PayrollRunDetail {
  const approved = sample.approvedAt !== null;
  const drafted = sample.people.map((key, at) => {
    const salary = salaryOf(key);
    const change = sample.changes?.[key];
    const leftOut = change?.leftOut ?? null;
    const payment: PayrollPayment = {
      billId: sampleId(sample.n * 100 + at),
      kind: "salary",
      salaryId: sampleId(2101 + SAMPLE_SALARIES.indexOf(salary)),
      payee: PEOPLE[key],
      category: categoryOf(salary),
      amountKes: kes(change?.shillings ?? salary.shillings),
      status: leftOut ? "cancelled" : approved ? "paid" : "upcoming",
      adjustmentReason: change?.reason ?? null,
      note: null,
      leftOut: leftOut
        ? { reason: leftOut, at: draftedOn(sample.payDate) }
        : null,
      paidOn: approved && !leftOut ? sample.payDate : null,
      paymentReceipts: [],
    };
    return { payment, salaryKes: BigInt(kes(salary.shillings)) };
  });
  const payments = drafted.map(({ payment }) => payment);
  const counted = payments.filter((payment) => payment.leftOut === null);
  const salariesKes = drafted.reduce((sum, row) => sum + row.salaryKes, 0n);
  const totalKes = counted.reduce(
    (sum, payment) => sum + BigInt(payment.amountKes),
    0n,
  );
  return {
    id: sampleId(sample.n),
    payDate: sample.payDate,
    status: approved ? "paid" : "draft",
    totalKes: totalKes.toString(),
    salariesKes: salariesKes.toString(),
    capKes: ((salariesKes * 120n) / 100n).toString(),
    people: counted.length,
    leftOut: payments.length - counted.length,
    adjusted: counted.filter((payment) => payment.adjustmentReason !== null)
      .length,
    oneOffs: counted.filter((payment) => payment.kind === "one_off").length,
    progress: {
      paid: approved ? counted.length : 0,
      paying: 0,
      failed: 0,
    },
    createdAt: draftedOn(sample.payDate),
    approvedAt: sample.approvedAt ? nairobiToUtc(sample.approvedAt) : null,
    payments,
  };
}

export const PAYROLL_RUN_DETAILS: readonly PayrollRunDetail[] =
  SAMPLE_RUNS.map(sampleRun);

/** `GET …/payroll-runs`: the list leaves each run's payments out. */
export const PAYROLL_RUNS: readonly PayrollRun[] = PAYROLL_RUN_DETAILS.map(
  ({ payments: _payments, ...run }) => run,
);

export function seedPayroll(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(payrollKeys.runs(org), PAYROLL_RUNS);
  client.setQueryData(payrollKeys.salaries(org), SALARIES);
  client.setQueryData(payrollKeys.margin(org), { marginPct: 20 });
  for (const run of PAYROLL_RUN_DETAILS) {
    client.setQueryData(payrollKeys.run(org, run.id), run);
  }
  if (client.getQueryData(queryKeys.categories(org)) === undefined) {
    client.setQueryData(queryKeys.categories(org), PAYROLL_CATEGORIES);
  }
}

import { describe, expect, it } from "vitest";

import type { Bill } from "@expendi-business/shared";

import {
  OPEN_BILLS,
  SETTLED_BILLS,
} from "~/app/dev/preview/_harness/fixtures/bills";
import {
  DEFAULT_BILL_SORT,
  dueHint,
  filtersFromParams,
  firstSortDir,
  listParams,
  NO_BILL_FILTERS,
  sortBills,
  summaryParams,
  viewFromParam,
  viewOfStatus,
} from "./bill-list";

const PAYEE = "00000000-0000-4000-8000-000000000101";
const reader =
  (params: Record<string, string>) =>
  (name: string): string | null =>
    params[name] ?? null;

const names = (bills: readonly Bill[]) => bills.map((bill) => bill.payee.name);

describe("the Bills list's URL", () => {
  it("reads the tab, and keeps only the filters the tab and the API take", () => {
    // #when
    const open = filtersFromParams(
      "open",
      reader({
        status: "overdue",
        payee: PAYEE,
        category: "not-an-id",
        heading: "salaries",
        method: "none",
        source: "one_off",
      }),
    );
    const history = filtersFromParams("history", reader({ status: "overdue" }));

    // #then
    expect({
      views: [viewFromParam(null), viewFromParam("paying"), viewFromParam("x")],
      open,
      history: history.status,
    }).toEqual({
      views: ["open", "paying", "open"],
      open: {
        status: "overdue",
        payeeId: PAYEE,
        categoryId: null,
        heading: null,
        method: "none",
        source: "one_off",
      },
      history: null,
    });
  });

  it("asks for a tab without salaries, and History for the last six months only", () => {
    // #when
    const open = listParams(
      "open",
      { ...NO_BILL_FILTERS, status: "due", payeeId: PAYEE },
      "2026-11-06",
    );
    const history = listParams("history", NO_BILL_FILTERS, "2026-11-06");

    // #then
    expect({ open, history }).toEqual({
      open: {
        view: "open",
        status: "due",
        payeeId: PAYEE,
        excludePayroll: true,
      },
      history: {
        view: "history",
        settledFrom: "2026-05-10",
        excludePayroll: true,
      },
    });
  });

  it("counts the tabs under the same filters, without the status", () => {
    // #then
    expect(
      summaryParams(
        { ...NO_BILL_FILTERS, status: "due", source: "recurring" },
        "2026-05-10",
      ),
    ).toEqual({ source: "recurring", settledFrom: "2026-05-10" });
  });
});

describe("the Bills list's order", () => {
  it("puts To pay in order of urgency, then by due date and payee", () => {
    // #when
    const toPay = OPEN_BILLS.filter((bill) => bill.status !== "paying");
    const sorted = sortBills(toPay, "open", DEFAULT_BILL_SORT.open, "129");

    // #then
    expect(names(sorted).slice(0, 7)).toEqual([
      "Zuku",
      "Securex Guards",
      "Kilimani Properties",
      "Notion",
      "Figma",
      "Safaricom",
      "KRA",
    ]);
  });

  it("sorts amounts largest first with USD at today's rate, and bills still to enter last", () => {
    // #when
    const sorted = sortBills(
      OPEN_BILLS,
      "open",
      { key: "amount", dir: firstSortDir("amount", "open") },
      "129",
    );

    // #then
    expect({
      first: names(sorted).slice(0, 2),
      last: names(sorted).at(-1),
      figmaBeforeZuku:
        names(sorted).indexOf("Figma") < names(sorted).indexOf("Zuku"),
    }).toEqual({
      first: ["Twiga Foods", "Bidco Kenya"],
      last: "KRA",
      figmaBeforeZuku: true,
    });
  });

  it("shows History by the day each bill was settled, newest first", () => {
    // #when
    const sorted = sortBills(
      SETTLED_BILLS,
      "history",
      DEFAULT_BILL_SORT.history,
      null,
    );

    // #then
    expect(names(sorted)).toEqual([
      "Kenya Power",
      "Google Workspace",
      "Jubilee Health",
      "Vercel",
      "Canva",
      "Kilimani Properties",
      "Nairobi Water",
      "Twiga Foods",
      "Safaricom",
      "Hotpoint Appliances",
    ]);
  });
});

describe("dueHint", () => {
  it("says how late or how soon an unpaid bill is due, for two weeks ahead", () => {
    // #given
    const bills: Pick<Bill, "status" | "dueOn">[] = [
      { status: "overdue", dueOn: "2026-11-01" },
      { status: "overdue", dueOn: "2026-11-05" },
      { status: "due", dueOn: "2026-11-06" },
      { status: "upcoming", dueOn: "2026-11-09" },
      { status: "upcoming", dueOn: "2026-11-21" },
      { status: "paying", dueOn: "2026-11-01" },
    ];

    // #then
    expect(bills.map((bill) => dueHint(bill, "2026-11-06"))).toEqual([
      { text: "5 days late", tone: "late" },
      { text: "1 day late", tone: "late" },
      { text: "Today", tone: "today" },
      { text: "In 3 days", tone: "soon" },
      null,
      null,
    ]);
  });
});

describe("viewOfStatus", () => {
  it("puts a bill under To pay, Being paid or History by its stage", () => {
    // #then
    expect(
      (["overdue", "payout_failed", "paying", "paid_outside"] as const).map(
        viewOfStatus,
      ),
    ).toEqual(["open", "open", "paying", "history"]);
  });
});

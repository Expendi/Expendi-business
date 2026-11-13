import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "@expendi-business/shared";

import {
  areaOf,
  batchCount,
  batchNames,
  datePresets,
  dateRangeLabel,
  describeAction,
  describeActor,
  describeChanges,
  groupRows,
  kesTotalOf,
  parseRecordKey,
  recordLink,
  rowMeta,
  rowTitle,
  showValue,
  summaryOf,
} from "./activity-display";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function entry(
  n: number,
  overrides: Partial<ActivityEntry> & Pick<ActivityEntry, "action">,
): ActivityEntry {
  return {
    id: id(n),
    occurredAt: "2026-11-01T06:00:00.000000Z",
    actor: { type: "user", id: id(90), name: "Wanjiru Kamau" },
    entity: { type: "bill", id: id(100 + n), label: null },
    approvalId: null,
    before: null,
    after: null,
    ...overrides,
  };
}

describe("describeAction", () => {
  it.each([
    ["category.archived", "Category archived"],
    ["payroll_run.payment_left_out", "Payroll run payment left out"],
    ["withdrawal_address.added", "Withdrawal address added"],
    ["staff_signed_in", "Staff signed in"],
    ["payout.paying", "Payment sent"],
    ["payee.restored", "Payee restored"],
    ["treasury.turned_on", "Treasury turned on"],
    ["treasury_move.started", "Treasury move started"],
    ["treasury_move.completed", "Treasury move completed"],
    ["treasury_move.returned", "Treasury move returned to the wallet"],
    ["treasury_move.failed", "Treasury move failed"],
    ["treasury_move.needs_review", "Treasury move needs review"],
    ["treasury_move.return_started", "Treasury move return started"],
  ])("words %s as %j", (action, words) => {
    // #when
    const described = describeAction(action);

    // #then
    expect(described).toBe(words);
  });
});

describe("the Treasury area", () => {
  it("groups Treasury's own actions and its moves under one filter, linking to Accounts", () => {
    // #then
    expect([
      areaOf("treasury.turned_on")?.label,
      areaOf("treasury_move.completed")?.label,
      recordLink(
        { type: "treasury_move", id: id(5), label: null },
        "treasury_move.started",
      )?.page,
    ]).toEqual(["Treasury", "Treasury", "Accounts"]);
  });
});

describe("describeActor", () => {
  it("names a person, and says when it was Expendi", () => {
    // #when
    const actors = [
      describeActor({ type: "user", id: id(1), name: "Wanjiru Kamau" }),
      describeActor({ type: "user", id: id(2), name: null }),
      describeActor({ type: "staff", id: null, name: null }),
      describeActor({ type: "system", id: null, name: null }),
    ];

    // #then
    expect(actors).toEqual([
      "Wanjiru Kamau",
      "Someone no longer in the company",
      "Expendi team",
      "Expendi (automatic)",
    ]);
  });
});

describe("describeChanges", () => {
  it("shows each field's readable name, before and after, and what changed", () => {
    // #when
    const changes = describeChanges(
      entry(1, {
        action: "category.updated",
        entity: { type: "category", id: id(2), label: "Air tickets" },
        before: { name: "Flights", etimsNotRequired: false },
        after: { name: "Air tickets", etimsNotRequired: false },
      }),
    );

    // #then
    expect(changes).toEqual({
      hasBefore: true,
      rows: [
        {
          key: "name",
          label: "Name",
          before: { kind: "text", text: "Flights" },
          after: { kind: "text", text: "Air tickets" },
          changed: true,
        },
        {
          key: "etimsNotRequired",
          label: "eTIMS not required",
          before: { kind: "text", text: "No" },
          after: { kind: "text", text: "No" },
          changed: false,
        },
      ],
    });
  });

  it("leaves IDs to the recorded values and shows money and statuses as they read", () => {
    // #when
    const changes = describeChanges(
      entry(1, {
        action: "bill.payment_approved",
        before: { status: "overdue" },
        after: {
          status: "paying",
          payoutId: id(7),
          approvalId: id(8),
          amountKes: "18600000",
        },
      }),
    );

    // #then
    expect(changes.rows.map((row) => [row.label, row.after])).toEqual([
      ["Status", { kind: "status", label: "Being paid", tone: "moving" }],
      ["Amount", { kind: "money", amount: "18600000", currency: "KES" }],
    ]);
  });

  it("shows a transaction hash as it is written and nothing when there is none", () => {
    // #given
    const hash = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

    // #when
    const shown = [hash, null].map((txHash) =>
      showValue("txHash", txHash, "payout"),
    );

    // #then
    expect(shown).toEqual([
      { kind: "text", text: "9xQeWv…VFin" },
      { kind: "none" },
    ]);
  });

  it("names a field it doesn't know in plain words", () => {
    // #when
    const shown = showValue("invitedAt", null, "membership");
    const changes = describeChanges(
      entry(1, { action: "x.y", after: { someNewField: true } }),
    );

    // #then
    expect({ shown, label: changes.rows[0]?.label }).toEqual({
      shown: { kind: "none" },
      label: "Some new field",
    });
  });
});

describe("rows", () => {
  const approval = id(50);
  const twiga = entry(1, {
    action: "bill.payment_approved",
    approvalId: approval,
    entity: { type: "bill", id: id(11), label: "Twiga Foods, INV-4471" },
    after: { amountKes: "18600000", currency: "kes", approvalId: approval },
  });
  const google = entry(2, {
    action: "bill.payment_approved",
    approvalId: approval,
    entity: { type: "bill", id: id(12), label: "Google Workspace, November" },
    after: {
      amountKes: null,
      amountUsdc: "72000000",
      currency: "usd",
      kesEquivalent: "928800",
      approvalId: approval,
    },
  });
  const payout = entry(3, {
    action: "payout.approved",
    approvalId: approval,
    entity: { type: "payout", id: id(13), label: null },
    after: { approvalId: approval, amountKes: "18600000" },
  });
  const alone = entry(4, { action: "category.created" });

  it("makes one row of everything one passkey approval did, folding in its payments", () => {
    // #when
    const rows = groupRows([twiga, payout, alone, google]);

    // #then
    expect(
      rows.map((row) => ({
        id: row.id,
        entries: row.entries.length,
        subjects: row.subjects.map((subject) => subject.id),
      })),
    ).toEqual([
      { id: twiga.id, entries: 3, subjects: [twiga.id, google.id] },
      { id: alone.id, entries: 1, subjects: [alone.id] },
    ]);
  });

  it("titles, counts and names a batch, with one approximate KES total", () => {
    // #given
    const [batch] = groupRows([twiga, payout, google]);

    // #when
    const shown = batch
      ? {
          title: rowTitle(batch),
          count: batchCount(batch),
          names: batchNames(batch),
          meta: rowMeta(batch),
          total: kesTotalOf(batch.subjects),
        }
      : null;

    // #then
    expect(shown).toEqual({
      title: "Bill payment approved",
      count: "2 bills",
      names: "Twiga Foods and Google Workspace",
      meta: "Twiga Foods and Google Workspace",
      total: { kesCents: "19528800", approximate: true },
    });
  });
});

describe("recordLink", () => {
  it.each([
    [
      { type: "bill", id: id(1), label: null },
      "bill.paid",
      `/bills?billId=${id(1)}`,
    ],
    [
      { type: "recurring_item", id: id(2), label: null },
      "recurring_item.paused",
      `/bills?recurring=${id(2)}`,
    ],
    [
      { type: "recurring_item", id: id(3), label: null },
      "salary.amount_changed",
      `/payroll?salaryId=${id(3)}`,
    ],
    [
      { type: "payroll_run", id: id(4), label: null },
      "payroll_run.status_changed",
      `/payroll?runId=${id(4)}`,
    ],
    [
      { type: "category", id: id(5), label: null },
      "category.updated",
      `/settings?section=categories&category=${id(5)}`,
    ],
    [{ type: "payout", id: id(6), label: null }, "payout.paid", "/wallet"],
  ])("opens %j where it lives now", (entity, action, href) => {
    // #when
    const link = recordLink(entity, action);

    // #then
    expect(link?.href).toBe(href);
  });
});

describe("summaryOf", () => {
  it("says why, who was invited as what, and what a rename was", () => {
    // #when
    const lines = [
      summaryOf(
        entry(1, {
          action: "bill.payout_failed",
          after: { status: "payout_failed", reason: "The paybill refused it." },
        }),
      ),
      summaryOf(
        entry(2, {
          action: "membership.invited",
          after: { role: "accountant", status: "invited" },
        }),
      ),
      summaryOf(
        entry(3, {
          action: "category.updated",
          before: { name: "Phone & internet" },
          after: { name: "Airtime & internet" },
        }),
      ),
    ];

    // #then
    expect(lines).toEqual([
      "The paybill refused it.",
      "Invited as Accountant",
      "Renamed from Phone & internet",
    ]);
  });
});

describe("dates", () => {
  it("offers today, yesterday, the last 7 days and the last three months", () => {
    // #when
    const presets = datePresets("2026-11-06");

    // #then
    expect(
      presets.map((preset) => [preset.label, preset.from, preset.to]),
    ).toEqual([
      ["Today", "2026-11-06", "2026-11-06"],
      ["Yesterday", "2026-11-05", "2026-11-05"],
      ["Last 7 days", "2026-10-31", "2026-11-06"],
      ["November 2026", "2026-11-01", "2026-11-30"],
      ["October 2026", "2026-10-01", "2026-10-31"],
      ["September 2026", "2026-09-01", "2026-09-30"],
    ]);
  });

  it("words a range by its preset, or by its days", () => {
    // #given
    const presets = datePresets("2026-11-06");

    // #when
    const labels = [
      dateRangeLabel("2026-10-01", "2026-10-31", presets),
      dateRangeLabel("2026-10-03", "2026-11-02", presets),
      dateRangeLabel("2025-12-30", "2026-01-02", presets),
      dateRangeLabel("2026-10-03", null, presets),
      dateRangeLabel(null, null, presets),
    ];

    // #then
    expect(labels).toEqual([
      "October 2026",
      "3 Oct to 2 Nov 2026",
      "30 Dec 2025 to 2 Jan 2026",
      "From 3 Oct 2026",
      null,
    ]);
  });
});

describe("parseRecordKey", () => {
  it("reads a record filter and refuses one without a type", () => {
    // #when
    const keys = [
      parseRecordKey(`bill:${id(1)}`),
      parseRecordKey(id(1)),
      parseRecordKey(null),
    ];

    // #then
    expect(keys).toEqual([{ type: "bill", id: id(1) }, null, null]);
  });
});

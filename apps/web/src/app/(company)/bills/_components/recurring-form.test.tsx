import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ActiveWallet,
  CardProgram,
  ExpendiCard,
  RecurringItem,
  WalletResponse,
} from "@expendi-business/shared";

import type { RecurringDraft } from "~/features/recurring/recurring-draft";
import { issueCompanyCardKey } from "~/app/(company)/cards/_components/cards-api";
import { RECURRING_ITEMS } from "~/app/dev/preview/_harness/fixtures/bills";
import {
  CARD_PROGRAM,
  SAMPLE_CARDS,
} from "~/app/dev/preview/_harness/fixtures/cards";
import { billKeys } from "~/features/payment-keys";
import { recurringListKey } from "~/features/recurring/recurring-api";
import {
  blankDraft,
  draftFromItem,
} from "~/features/recurring/recurring-draft";
import { ApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import {
  CompanyHeldCardField,
  IssueCompanyCard,
  issuedCardNote,
} from "./recurring-card-field";
import { payViaChoices, RecurringForm } from "./recurring-form";
import {
  cardNextBillNote,
  RecurringConfirm,
  RecurringDetailBody,
} from "./recurring-sheet";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const rent = RECURRING_ITEMS.find(
  (item) => item.payee.name === "Kilimani Properties",
);

function render(children: ReactNode, wallet?: WalletResponse): string {
  const client = new QueryClient();
  if (wallet) client.setQueryData(billKeys.kesRate(ORG), wallet);
  client.setQueryData(queryKeys.categories(ORG), [
    {
      id: rent?.category.id,
      name: "Rent & utilities",
      etimsNotRequired: false,
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the recurring payment form", () => {
  it("shows what's set once as text when editing, with only what can change as fields", () => {
    // #given
    if (!rent) throw new Error("The sample has Kilimani Properties' rent.");

    // #when
    const html = render(
      <RecurringForm
        organizationId={ORG}
        item={rent}
        initialDraft={draftFromItem(rent)}
        submitLabel="Save changes"
        submitting={false}
        submitError={null}
        footerSlot={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      note: text.includes(
        "Changes apply to the bills still to come. The overview heading follows the payee (Transactions) unless you pick another.",
      ),
      setOnce: text.includes(
        "Pay to Kilimani Properties When Monthly on the 1st Starts 1 Jan 2025 To change who it’s paid to or when, end this payment and set up a new one.",
      ),
      payeeInput: text.includes("Choose a payee"),
      schedule: text.includes("How often"),
      start: text.includes("Start date"),
      amount: html.includes('value="48500.00"'),
      ends: html.includes('value="2027-12-31"'),
      category: text.includes("Rent & utilities"),
      saveDisabled: /<button[^>]*type="submit"[^>]*disabled=""/.test(html),
    }).toEqual({
      note: true,
      setOnce: true,
      payeeInput: false,
      schedule: false,
      start: false,
      amount: true,
      ends: true,
      category: true,
      saveDisabled: true,
    });
  });

  it("asks for the payee, schedule, start date and how it's paid on a new payment, and shows the first due date", () => {
    // #when
    const text = textOf(
      render(
        <RecurringForm
          organizationId={ORG}
          initialDraft={blankDraft("2026-11-06")}
          submitLabel="Set up payment"
          submitting={false}
          submitError={null}
          footerSlot={null}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );

    // #then
    expect(
      [
        "Its first bill is created now and shows in To pay.",
        "Pay to",
        "How often",
        "Start date",
        "Day of the month it’s due (1 to 31)",
        "Due: Monthly on the 6th",
        "First bill due 6 Nov 2026",
        "How it’s paid",
        "Remind admins (days before it’s due)",
        "Set up payment",
      ].filter((part) => !text.includes(part)),
    ).toEqual([]);
  });
});

const LIMITS: ActiveWallet = {
  status: "active",
  address: "company.near",
  chain: "near",
  usdcBalance: "0",
  kesEquivalent: null,
  cashOutLimits: { minKesCents: "2000", maxKesCents: "25000000" },
};

function editing(item: RecurringItem, submitError: unknown = null): string {
  return render(
    <RecurringForm
      organizationId={ORG}
      item={item}
      initialDraft={draftFromItem(item)}
      submitLabel="Save changes"
      submitting={false}
      submitError={submitError}
      footerSlot={null}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
    LIMITS,
  );
}

function itemTo(payee: string): RecurringItem {
  const found = RECURRING_ITEMS.find((item) => item.payee.name === payee);
  if (!found) throw new Error(`The samples pay ${payee}.`);
  return found;
}

describe("the recurring payment form's smallest amount", () => {
  it("shows only for a payment through Expendi to a payee paid by cash-out", () => {
    // #when
    const shown = [
      itemTo("Kilimani Properties"),
      itemTo("Figma"),
      itemTo("Hotpoint Appliances"),
      itemTo("CarMax Mechanics"),
    ].map((item) => editing(item).includes("Smallest amount: KES 20"));

    // #then
    expect(shown).toEqual([true, false, false, false]);
  });

  it("puts the API's refusal of the amount on the amount field, not under the form", () => {
    // #given
    const refused = new ApiError(
      400,
      "BadRequest",
      "The smallest amount that can be sent is KES 20.",
      { field: "amountKes" },
    );

    // #when
    const html = editing(itemTo("Kilimani Properties"), refused);

    // #then
    expect({
      onField:
        /aria-invalid="true"[^>]*value="48500.00"|value="48500.00"[^>]*aria-invalid="true"/.test(
          html,
        ),
      shown:
        textOf(html).split("The smallest amount that can be sent is KES 20.")
          .length - 1,
    }).toEqual({ onField: true, shown: 1 });
  });
});

const SUBSCRIPTIONS = SAMPLE_CARDS.find((card) => card.companyHeld);
if (!SUBSCRIPTIONS) throw new Error("The samples have a company-held card.");
const FROZEN: ExpendiCard = {
  ...SUBSCRIPTIONS,
  id: "00000000-0000-4000-8000-000000009305",
  nickname: "Design tools",
  lastFour: "0005",
  state: "frozen",
  recurringPayments: [],
};
const CLOSED: ExpendiCard = {
  ...SUBSCRIPTIONS,
  id: "00000000-0000-4000-8000-000000009306",
  nickname: "Old tools",
  lastFour: "0006",
  state: "closed",
  recurringPayments: [],
};

function withCards(
  children: ReactNode,
  {
    program = CARD_PROGRAM,
    enrolled = true,
    seed,
  }: {
    program?: CardProgram;
    enrolled?: boolean;
    seed?: (client: QueryClient) => void;
  } = {},
): string {
  const client = new QueryClient();
  seed?.(client);
  client.setQueryData(queryKeys.categories(ORG), [
    {
      id: rent?.category.id,
      name: "Rent & utilities",
      etimsNotRequired: false,
    },
  ]);
  client.setQueryData(queryKeys.cardProgram(ORG), program);
  client.setQueryData(queryKeys.companyHeldCards(ORG), {
    cards: [SUBSCRIPTIONS, FROZEN, CLOSED],
  });
  client.setQueryData(recurringListKey(ORG), RECURRING_ITEMS);
  client.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

const byCard = (changes: Partial<RecurringDraft> = {}): RecurringDraft => ({
  ...blankDraft("2026-11-13"),
  payVia: "card",
  currency: "usd",
  ...changes,
});

function newPayment(draft: RecurringDraft): ReactNode {
  return (
    <RecurringForm
      organizationId={ORG}
      initialDraft={draft}
      submitLabel="Set up payment"
      submitting={false}
      submitError={null}
      footerSlot={null}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />
  );
}

describe("a recurring payment by company-held card", () => {
  it("offers the card, takes an optional USD estimate and asks which card pays it", () => {
    // #when
    const html = withCards(newPayment(byCard()));
    const text = textOf(html);

    // #then
    expect({
      missing: [
        "By company-held card: charged automatically; nobody pays each bill",
        "Estimate (USD, optional)",
        "Each bill takes the actual amount the card is charged.",
        "The card is charged automatically; nobody has to pay each bill.",
        "Which card pays it",
        "Software subscriptions •••• 0004 · Pays Vercel, Notion",
        "Design tools Frozen •••• 0005 · No recurring payments yet",
        "Issue a new card",
      ].filter((part) => !text.includes(part)),
      closed: text.includes("Old tools"),
      variable: text.includes("Variable amount"),
      reminder: text.includes("Remind admins"),
    }).toEqual({
      missing: [],
      closed: false,
      variable: false,
      reminder: false,
    });
  });

  it("says when cards aren't on, with the way to Cards", () => {
    // #when
    const html = withCards(newPayment(byCard()), {
      program: { status: "off" },
    });

    // #then
    expect({
      off: textOf(html).includes("on for this company yet"),
      link: html.includes('href="/cards"'),
      picker: textOf(html).includes("Which card pays it"),
    }).toEqual({ off: true, link: true, picker: false });
  });

  it("says when the chosen card's limit won't cover what its payments can charge in a month", () => {
    // #when
    const low = textOf(
      withCards(newPayment(byCard({ cardId: SUBSCRIPTIONS.id, amount: "40" }))),
    );
    const enough = textOf(
      withCards(newPayment(byCard({ cardId: SUBSCRIPTIONS.id, amount: "25" }))),
    );
    const yearly = textOf(
      withCards(
        newPayment(
          byCard({ cardId: FROZEN.id, amount: "120", schedule: "yearly" }),
        ),
      ),
    );

    // #then
    expect({
      low: low.includes(
        "Its monthly limit is USD 50.00, but its recurring payments, this one included, can charge USD 60.00 in one month. USD 75.00 is suggested.",
      ),
      enough: enough.includes("is suggested"),
      yearly: yearly.includes(
        "Its monthly limit is USD 50.00, but its recurring payments, this one included, can charge USD 120.00 in one month. USD 150.00 is suggested.",
      ),
    }).toEqual({ low: true, enough: false, yearly: true });
  });

  it("issues a new card named after the payee, with a limit of the most it can charge in a month plus 25%", () => {
    // #when
    const html = withCards(
      <IssueCompanyCard
        organizationId={ORG}
        payment={{
          payeeName: "Vercel",
          estimate: "20",
          schedule: "monthly",
          categoryId: rent?.category.id ?? null,
          itemId: null,
        }}
        onIssued={() => undefined}
      />,
    );
    const yearly = withCards(
      <IssueCompanyCard
        organizationId={ORG}
        payment={{
          payeeName: "GitHub",
          estimate: "120",
          schedule: "yearly",
          categoryId: null,
          itemId: null,
        }}
        onIssued={() => undefined}
      />,
    );
    const text = textOf(html);

    // #then
    expect({
      name: html.includes('value="Vercel"'),
      limit: html.includes('value="25.00"'),
      yearlyLimit: yearly.includes('value="150.00"'),
      hint: text.includes(
        "Suggested: the most this payment can charge in one month, plus 25%.",
      ),
      category: new RegExp(
        `value="${rent?.category.id ?? ""}" selected=""`,
      ).test(html),
      passkey: /<button[^>]*type="button"[^>]*>[^]*?Issue with passkey/.test(
        html,
      ),
      disabled: /disabled=""[^>]*>[^]*?Issue with passkey/.test(html),
    }).toEqual({
      name: true,
      limit: true,
      yearlyLimit: true,
      hint: true,
      category: true,
      passkey: true,
      disabled: false,
    });
  });

  it("asks for an approval passkey before issuing without one", () => {
    // #when
    const html = withCards(
      <IssueCompanyCard
        organizationId={ORG}
        payment={{
          payeeName: "Vercel",
          estimate: "",
          schedule: "monthly",
          categoryId: null,
          itemId: null,
        }}
        onIssued={() => undefined}
      />,
      { enrolled: false },
    );

    // #then
    expect({
      callout: textOf(html).includes("Set up your approval passkey first"),
      disabled: /disabled=""[^>]*>[^]*?Issue with passkey/.test(html),
      noSuggestion: html.includes('value="25.00"'),
    }).toEqual({ callout: true, disabled: true, noSuggestion: false });
  });

  it("moves an existing payment only to or from a card", () => {
    // #given
    const vercel = itemTo("Vercel");
    const hotpoint = itemTo("Hotpoint Appliances");

    // #when
    const card = withCards(
      <RecurringForm
        organizationId={ORG}
        item={vercel}
        initialDraft={draftFromItem(vercel)}
        submitLabel="Save changes"
        submitting={false}
        submitError={null}
        footerSlot={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const outside = withCards(
      <RecurringForm
        organizationId={ORG}
        item={hotpoint}
        initialDraft={draftFromItem(hotpoint)}
        submitLabel="Save changes"
        submitting={false}
        submitError={null}
        footerSlot={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // #then
    expect({
      card: payViaOptions(card),
      cardChosen: new RegExp(`checked="" value="${SUBSCRIPTIONS.id}"`).test(
        card,
      ),
      estimate: card.includes('value="20.00"'),
      outside: payViaOptions(outside),
      choices: payViaChoices("expendi"),
    }).toEqual({
      card: ["expendi (disabled)", "outside", "card (selected)"],
      cardChosen: true,
      estimate: true,
      outside: ["outside (selected)", "card"],
      choices: ["expendi", "card"],
    });
  });

  it("puts the API's refusal of the card on the card picker", () => {
    // #given
    const vercel = itemTo("Vercel");
    const refused = new ApiError(
      409,
      "Conflict",
      "Its bill is being paid. Try again once it's paid.",
    );

    // #when
    const html = withCards(
      <RecurringForm
        organizationId={ORG}
        item={vercel}
        initialDraft={draftFromItem(vercel)}
        submitLabel="Save changes"
        submitting={false}
        submitError={refused}
        footerSlot={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // #then
    expect(/role="alert"[^>]*>Its bill is being paid/.test(html)).toBe(true);
  });
});

/** The "How it's paid" options as `value`, marked when disabled or selected. */
function payViaOptions(html: string): string[] {
  const select =
    /<select[^>]*>(?:(?!<\/select>)[^])*?value="card"[^]*?<\/select>/.exec(
      html,
    )?.[0];
  return [...(select ?? "").matchAll(/<option([^>]*)>/g)].map(
    ([, attributes = ""]) => {
      const value = /value="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const flags = [
        attributes.includes('disabled=""') ? "disabled" : null,
        attributes.includes('selected=""') ? "selected" : null,
      ].filter(Boolean);
      return flags.length > 0 ? `${value} (${flags.join(", ")})` : value;
    },
  );
}

describe("a card-paid payment's next step", () => {
  it("asks an admin to enter the card at the payee, with the way to its number", () => {
    // #given
    const vercel = itemTo("Vercel");

    // #when
    const text = textOf(
      withCards(
        <RecurringDetailBody
          organizationId={ORG}
          item={vercel}
          canAct
          cardNextStep
          onOpenBill={() => undefined}
        />,
      ),
    );

    // #then
    expect({
      title: text.includes("Next: enter this card at Vercel"),
      body: text.includes(
        "Add Software subscriptions (•••• 0004) as the payment card in your Vercel account.",
      ),
      number: (text.match(/Show card number/g) ?? []).length,
    }).toEqual({ title: true, body: true, number: 1 });
  });
});

describe("pausing or ending a card-paid payment", () => {
  it("says its merchant will be declined on the card and has to be cancelled too", () => {
    // #given
    const confirm = (item: RecurringItem, kind: "pause" | "end") =>
      textOf(
        withCards(
          <RecurringConfirm
            organizationId={ORG}
            item={item}
            kind={kind}
            footerSlot={null}
            onDone={() => undefined}
            onKeep={() => undefined}
          />,
        ),
      );
    const line =
      "Card purchases from Vercel will be declined on card •••• 0004. Cancel with Vercel too, or it will keep trying.";

    // #then
    expect({
      pause: confirm(itemTo("Vercel"), "pause").includes(line),
      end: confirm(itemTo("Vercel"), "end").includes(line),
      notByCard: confirm(itemTo("Kilimani Properties"), "end").includes(
        "will be declined on card",
      ),
    }).toEqual({ pause: true, end: true, notByCard: false });
  });
});

describe("a card-paid payment's next bill", () => {
  const vercel = itemTo("Vercel");
  const card = vercel.card;
  if (!card) throw new Error("Vercel is paid by a company-held card.");

  it("says the card pays it only while the payment is active and the card is open", () => {
    // #then
    expect({
      active: cardNextBillNote(vercel),
      paused: cardNextBillNote({ ...vercel, state: "paused", active: false }),
      endedWhileActive: cardNextBillNote({
        ...vercel,
        state: "ended",
        nextDueOn: null,
      }),
      endedWhilePaused: cardNextBillNote({
        ...vercel,
        state: "ended",
        active: false,
        nextDueOn: null,
      }),
      frozen: cardNextBillNote({
        ...vercel,
        card: { ...card, state: "frozen" },
      }),
      closed: cardNextBillNote({
        ...vercel,
        state: "ended",
        nextDueOn: null,
        card: { ...card, state: "closed" },
      }),
      notByCard: cardNextBillNote(itemTo("Kilimani Properties")),
    }).toEqual({
      active:
        "Paid automatically when Vercel charges the card. Nobody has to pay each bill.",
      paused:
        "Paused: Card purchases from Vercel are declined. The bill stays owed.",
      endedWhileActive:
        "Ended: the card pays this last bill when Vercel charges it, and nothing after it.",
      endedWhilePaused:
        "Ended: Card purchases from Vercel are declined. The bill stays owed.",
      frozen:
        "Card •••• 0004 is frozen: Card purchases from Vercel are declined until it’s unfrozen. The bill stays owed.",
      closed:
        "Card •••• 0004 is closed: Card purchases from Vercel are declined. The bill stays owed.",
      notByCard: null,
    });
  });

  it("no longer says a paused payment's bill is paid automatically", () => {
    // #when
    const text = textOf(
      withCards(
        <RecurringDetailBody
          organizationId={ORG}
          item={{ ...vercel, state: "paused", active: false }}
          canAct
          onOpenBill={() => undefined}
        />,
      ),
    );

    // #then
    expect({
      paused: text.includes(
        "Paused: Card purchases from Vercel are declined. The bill stays owed.",
      ),
      automatic: text.includes("Paid automatically"),
    }).toEqual({ paused: true, automatic: false });
  });
});

describe("a card-paid payment's estimate", () => {
  it("says what no estimate means, naming the payee once there is one", () => {
    // #when
    const blank = textOf(withCards(newPayment(byCard())));
    const notion = itemTo("Notion");
    const editing = textOf(
      withCards(
        <RecurringForm
          organizationId={ORG}
          item={notion}
          initialDraft={draftFromItem(notion)}
          submitLabel="Save changes"
          submitting={false}
          submitError={null}
          footerSlot={null}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    const typed = textOf(withCards(newPayment(byCard({ amount: "20" }))));

    // #then
    expect({
      blank: blank.includes(
        "No estimate: the bill takes whatever the payee charges, and the Card balance check can’t count it.",
      ),
      notion: editing.includes(
        "No estimate: the bill takes whatever Notion charges, and the Card balance check can’t count it.",
      ),
      typed: typed.includes("No estimate:"),
    }).toEqual({ blank: true, notion: true, typed: false });
  });
});

describe("a card issued from the recurring payment form", () => {
  const ISSUED: ExpendiCard = {
    ...SUBSCRIPTIONS,
    id: "00000000-0000-4000-8000-000000009307",
    nickname: "GitHub",
    lastFour: "1234",
    recurringPayments: [],
  };

  it("says it was issued and picked", () => {
    // #when
    const text = textOf(
      withCards(
        <CompanyHeldCardField
          organizationId={ORG}
          id="card"
          value={ISSUED.id}
          payment={{
            payeeName: "GitHub",
            estimate: "",
            schedule: "monthly",
            categoryId: null,
            itemId: null,
          }}
          issued={ISSUED}
          onChange={() => undefined}
          onIssued={() => undefined}
        />,
      ),
    );

    // #then
    expect({
      selected: text.includes("Card •••• 1234 issued and selected."),
      listed: text.includes("GitHub •••• 1234"),
      kept: issuedCardNote(ISSUED),
    }).toEqual({
      selected: true,
      listed: true,
      kept: "Card •••• 1234 was issued and is on the Cards page.",
    });
  });

  it("holds the form's Save and Cancel while its passkey step is pending", () => {
    // #given
    const pending = (client: QueryClient) => {
      void client
        .getMutationCache()
        .build(client, {
          mutationKey: issueCompanyCardKey(ORG),
          mutationFn: () => new Promise<never>(() => undefined),
        })
        .execute(undefined);
    };

    // #when
    const issuing = withCards(newPayment(byCard()), { seed: pending });
    const idle = withCards(newPayment(byCard()));

    // #then
    expect({
      issuing: [
        /<button[^>]*type="submit"[^>]*disabled=""/.test(issuing),
        /<button[^>]*type="button"[^>]*disabled=""[^>]*>Cancel/.test(issuing),
      ],
      idle: [
        /<button[^>]*type="submit"[^>]*disabled=""/.test(idle),
        /<button[^>]*type="button"[^>]*disabled=""[^>]*>Cancel/.test(idle),
      ],
    }).toEqual({ issuing: [true, true], idle: [false, false] });
  });
});

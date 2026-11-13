import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TreasuryStatus } from "@expendi-business/shared";

import {
  OLDER_TREASURY_MOVES,
  previewFor,
  SHORT_WALLET_OFFER,
  SHORT_WALLET_REFUSAL,
  TREASURY_MOVES,
  TREASURY_STATUSES,
} from "~/app/dev/preview/_harness/fixtures/treasury";
import { LEDGER } from "~/app/dev/preview/_harness/fixtures/wallet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { ApiError } from "~/lib/api";
import {
  approveWithPasskey,
  describeApprovalError,
  treasuryOfferFrom,
} from "~/lib/approval";
import { moveSteps, treasuryKeys, turnOnSteps } from "./treasury-api";
import { TreasuryAccount, TreasuryCard, TreasuryMoves } from "./treasury-card";
import {
  formatDuration,
  formatRate,
  moveFacts,
  MOVES_PER_PAGE,
  pageOfMoves,
  parseMoveAmount,
  prefillFromOffer,
} from "./treasury-display";
import { TreasuryOfferButton, TreasuryOfferProvider } from "./treasury-offer";
import { MoveForm, TURN_ON_ACKNOWLEDGEMENT } from "./treasury-sheets";
import { TxDetails } from "./tx-sheet";
import { signedUsdc, txDetail, txTitle } from "./wallet-display";

vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";

/** 09:30 on 6 November 2026 in Nairobi. */
const NOW = new Date("2026-11-06T06:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("&#x27;", "'");
const plain = (html: string) =>
  html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");

type Shown = Exclude<TreasuryStatus, { status: "unavailable" }>;

function shown(key: keyof typeof TREASURY_STATUSES): Shown {
  const status = TREASURY_STATUSES[key];
  if (status.status === "unavailable") throw new Error("Not shown");
  return status;
}

function card(
  status: Shown,
  {
    canAct = true,
    moves = TREASURY_MOVES,
  }: { canAct?: boolean; moves?: typeof TREASURY_MOVES } = {},
): string {
  return renderToStaticMarkup(
    <TreasuryCard
      status={status}
      moves={moves}
      canAct={canAct}
      onTurnOn={() => undefined}
      onMove={() => undefined}
    />,
  );
}

function account(
  key: keyof typeof TREASURY_STATUSES,
  role: "admin" | "accountant" = "admin",
): string {
  const client = new QueryClient();
  client.setQueryData(treasuryKeys.status(ORG), TREASURY_STATUSES[key]);
  client.setQueryData(treasuryKeys.moves(ORG), TREASURY_MOVES);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <TreasuryAccount organizationId={ORG} canAct={role === "admin"} />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the Treasury account", () => {
  it("is not shown at all while no vault is configured", () => {
    // #when
    const html = account("unavailable");

    // #then
    expect(html).toBe("");
  });

  it("invites an admin to turn it on, with the vault's rate and no figures", () => {
    // #when
    const html = card(shown("off"));
    const page = text(html);

    // #then
    expect({
      invitation: page.includes("Turn on Treasury"),
      rate: page.includes("5.19% a year"),
      warning: page.includes("changes daily, not guaranteed"),
      moveButtons: page.includes("Move to Treasury"),
      value: page.includes("In Treasury"),
    }).toEqual({
      invitation: true,
      rate: true,
      warning: true,
      moveButtons: false,
      value: false,
    });
  });

  it("tells an accountant only admins can turn it on, and says so when there is no rate", () => {
    // #when
    const page = text(
      card({ status: "off", rateBps: null }, { canAct: false }),
    );

    // #then
    expect({
      button: page.includes("Turn on Treasury"),
      note: page.includes("Only admins can turn on Treasury."),
      noRate: page.includes("The rate isn't available right now."),
    }).toEqual({ button: false, note: true, noRate: true });
  });

  it("shows the value in USDC and KES, the yield, and the rate labelled as changing", () => {
    // #when
    const html = card(shown("on"));
    const page = plain(html);

    // #then
    expect({
      value: page.includes("4,215.37"),
      kes: text(html).includes("≈ KES") && page.includes("543,782"),
      yield: page.includes("+15.37"),
      rate: page.includes("5.19%"),
      warning: page.includes("changes daily, not guaranteed"),
      moves:
        page.includes("Move to Treasury") && page.includes("Move to wallet"),
      saved: page.includes("These figures are from"),
      openMove: page.includes("On its way"),
    }).toEqual({
      value: true,
      kes: true,
      yield: true,
      rate: true,
      warning: true,
      moves: true,
      saved: false,
      openMove: false,
    });
  });

  it("shows an open move's direction, amount and plain status, and holds a second one back", () => {
    // #when
    const html = card(shown("move"));
    const page = plain(html);

    // #then
    expect({
      status: page.includes("On its way to Treasury"),
      amount: page.includes("1,000.00 USDC to Treasury"),
      disabled: (html.match(/disabled=""/g) ?? []).length,
      provider: /Privy|Aave|1Click|NEAR Intents|Base/.test(page),
    }).toEqual({
      status: true,
      amount: true,
      disabled: 2,
      provider: false,
    });
  });

  it("says when the figures are saved ones, and from when", () => {
    // #when
    const page = plain(card(shown("saved")));

    // #then
    expect(page).toContain(
      "These figures are from 6 Nov 2026, 00:00. Expendi can't read Treasury's live value right now.",
    );
  });

  it("shows a dash rather than a value when nothing was ever saved", () => {
    // #when
    const page = plain(
      card({
        ...shown("saved"),
        status: "on",
        valueUsdc: null,
        yieldUsdc: null,
        rateBps: null,
        kesEquivalent: null,
        asOf: null,
      } as Shown),
    );

    // #then
    expect(page).toContain("has no saved figures yet");
  });

  it("gives an accountant the figures and the history with no buttons", () => {
    // #when
    const html = account("on", "accountant");
    const page = plain(html);

    // #then
    expect({
      figures: page.includes("4,215.37"),
      history: page.includes("Moved to Treasury"),
      turnOn: page.includes("Turn on"),
      moves:
        page.includes("Move to Treasury") && !page.includes("Move to wallet"),
      // The history's "Show steps" toggles only read; nothing else is a button.
      buttons: /<button(?![^>]*aria-controls)/.test(html),
    }).toEqual({
      figures: true,
      history: true,
      turnOn: false,
      moves: false,
      buttons: false,
    });
  });

  it("lists each move with its title, its badge and what arrived", () => {
    // #when
    const html = card(shown("on"));
    const page = plain(html);

    // #then
    expect({
      titles: [
        page.includes("Moved to wallet"),
        page.includes("Moved to Treasury"),
      ],
      returned: page.includes("Returned to wallet"),
      delivered: page.includes("250.12"),
      folded: !page.includes("Cost") && !page.includes("All of Treasury"),
    }).toEqual({
      titles: [true, true],
      returned: true,
      delivered: true,
      folded: true,
    });
  });

  it("unfolds a move to what it cost, what was asked and whether it was all of Treasury", () => {
    // #when
    const facts = TREASURY_MOVES.map(moveFacts);

    // #then
    expect(facts).toEqual([
      [{ label: "Cost", value: "0.46 USDC" }],
      [{ label: "Cost", value: "0.31 USDC" }],
      [
        { label: "Asked for", value: "5,200.00 USDC" },
        { label: "Cost", value: "0.62 USDC" },
      ],
      [
        { label: "Asked for", value: "All of Treasury" },
        { label: "Cost", value: "0.43 USDC" },
      ],
    ]);
  });

  it("shows five moves at a time, with the page beside the heading", () => {
    // #given twelve moves
    const moves = [...TREASURY_MOVES, ...OLDER_TREASURY_MOVES];

    // #when
    const first = renderToStaticMarkup(
      <TreasuryMoves moves={moves} failed={false} />,
    );
    const last = renderToStaticMarkup(
      <TreasuryMoves moves={moves} failed={false} defaultPage={2} />,
    );
    const rows = (html: string) => html.match(/<li /g)?.length ?? 0;

    // #then
    expect({
      first: [rows(first), plain(first).includes("Page 1 of 3")],
      last: [rows(last), plain(last).includes("Page 3 of 3")],
      previousOff:
        /<button[^>]*disabled=""[^>]*aria-label="Previous page"/.test(first),
      nextOff: /<button[^>]*disabled=""[^>]*aria-label="Next page"/.test(last),
    }).toEqual({
      first: [5, true],
      last: [2, true],
      previousOff: true,
      nextOff: true,
    });
  });

  it("shows no pages for five moves or fewer", () => {
    // #when
    const html = renderToStaticMarkup(
      <TreasuryMoves moves={TREASURY_MOVES} failed={false} />,
    );

    // #then
    expect(html).not.toContain("Next page");
    expect(html.match(/<li /g)).toHaveLength(4);
  });

  it("reads a page past the end as the last one", () => {
    // #given
    const moves = [...TREASURY_MOVES, ...OLDER_TREASURY_MOVES];

    // #when
    const shown = pageOfMoves(moves, 9);

    // #then
    expect({
      page: shown.page,
      pageCount: shown.pageCount,
      rows: shown.rows.length,
      perPage: MOVES_PER_PAGE,
    }).toEqual({ page: 2, pageCount: 3, rows: 2, perPage: 5 });
  });
});

describe("Treasury moves in the wallet history", () => {
  const to = LEDGER[0];
  if (!to) throw new Error("No sample ledger");
  const rows = [
    {
      ...to,
      type: "to_treasury" as const,
      usdcAmount: "-5200000000",
      txHash: null,
      payout: null,
    },
    {
      ...to,
      type: "from_treasury" as const,
      usdcAmount: "999540000",
      txHash: null,
      payout: null,
    },
  ];

  it("reads Moved to Treasury and Moved to wallet, with the amount that left or arrived", () => {
    // #when
    const lines = rows.map((row) => [txTitle(row), txDetail(row)]);
    const amounts = rows.map((row) => signedUsdc(row.usdcAmount));
    const sheet = rows.map((row) =>
      text(
        renderToStaticMarkup(
          <TxDetails item={row} items={LEDGER} today="2026-11-06" rate="129" />,
        ),
      ),
    );

    // #then
    expect(lines).toEqual([
      ["Moved to Treasury", "To Treasury"],
      ["Moved to wallet", "From Treasury"],
    ]);
    expect(amounts).toEqual(["−5,200.00", "+999.54"]);
    expect(sheet.every((details) => details.includes("Chain NEAR"))).toBe(true);
  });
});

describe("turning Treasury on", () => {
  it("asks for the passkey, then sends it back with the challenge", async () => {
    // #given
    const challenge = {
      challengeId: "00000000-0000-4000-8000-000000000001",
      options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
    };
    const assertion = {
      id: "a",
      rawId: "a",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        authenticatorData: "AAAA",
        signature: "c2ln",
      },
      clientExtensionResults: {},
    } as const;
    const post = vi
      .fn<(path: string, body: unknown, schema: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(TREASURY_STATUSES.on);
    const api = { post } as never;

    // #when
    const outcome = await approveWithPasskey(
      turnOnSteps(api, ORG),
      undefined,
      () => Promise.resolve(assertion),
    );

    // #then
    expect(outcome.status).toBe("approved");
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [`/organizations/${ORG}/treasury/confirmations`, undefined],
      [
        `/organizations/${ORG}/treasury`,
        { challengeId: challenge.challengeId, response: assertion },
      ],
    ]);
  });

  it("makes the admin acknowledge the risks in plain words, naming no provider", () => {
    // #when
    const words = TURN_ON_ACKNOWLEDGEMENT.join(" ");

    // #then
    expect({
      notGuaranteed: words.includes("not guaranteed"),
      rateChanges: words.includes("the rate changes"),
      canLoseValue: words.includes("can lose value"),
      thirdParty: words.includes("run by a third party, not by Expendi"),
      delay:
        words.includes("takes a few minutes") &&
        words.includes("short of cash"),
      provider: /Privy|Aave|1Click|NEAR Intents|Base/.test(words),
    }).toEqual({
      notGuaranteed: true,
      rateChanges: true,
      canLoseValue: true,
      thirdParty: true,
      delay: true,
      provider: false,
    });
  });
});

describe("amounts for a move", () => {
  it("turns what was typed into the request, in base units", () => {
    // #then
    expect([
      parseMoveAmount("to_treasury", "25", false),
      parseMoveAmount("to_wallet", "1,052.31".replace(",", ""), false),
      parseMoveAmount("to_wallet", "10", false),
    ]).toEqual([
      {
        ok: true,
        request: { direction: "to_treasury", amountUsdc: "25000000" },
      },
      {
        ok: true,
        request: { direction: "to_wallet", amountUsdc: "1052310000" },
      },
      { ok: true, request: { direction: "to_wallet", amountUsdc: "10000000" } },
    ]);
  });

  it("refuses less than 10 USDC, nothing, too many decimals, and all to Treasury", () => {
    // #then
    expect([
      parseMoveAmount("to_treasury", "9.99", false),
      parseMoveAmount("to_wallet", "0", false),
      parseMoveAmount("to_treasury", "", false),
      parseMoveAmount("to_treasury", "12.1234567", false),
      parseMoveAmount("to_treasury", "", true),
    ]).toEqual([
      { ok: false, error: "The least you can move is 10 USDC." },
      { ok: false, error: "Enter an amount above zero." },
      { ok: false, error: "Enter an amount in USDC." },
      { ok: false, error: "USDC has at most 6 decimal places." },
      { ok: false, error: 'Only a move to your wallet can be "all".' },
    ]);
  });

  it("offers All as its own choice, whatever the amount, for a move to the wallet", () => {
    // #then
    expect(parseMoveAmount("to_wallet", "3", true)).toEqual({
      ok: true,
      request: { direction: "to_wallet", amountUsdc: "all" },
    });
  });

  it("writes the rate to two decimals and the time in plain words", () => {
    // #then
    expect([
      formatRate(519),
      formatRate(500),
      formatRate(7),
      formatDuration(40),
      formatDuration(240),
      formatDuration(7200),
    ]).toEqual([
      "5.19%",
      "5.00%",
      "0.07%",
      "about a minute",
      "about 4 minutes",
      "about 2 hours",
    ]);
  });

  it("opens the wallet sheet from an offer with the suggested amount, or All when that is all there is", () => {
    // #then
    expect([
      prefillFromOffer(SHORT_WALLET_OFFER),
      prefillFromOffer({ ...SHORT_WALLET_OFFER, suggestedUsdc: "4215370000" }),
      prefillFromOffer({
        ...SHORT_WALLET_OFFER,
        inTreasuryUsdc: "7000000",
        suggestedUsdc: "7000000",
      }),
    ]).toEqual([
      { all: false, amount: "412.65" },
      { all: true, amount: "" },
      { all: true, amount: "" },
    ]);
  });
});

describe("starting a move", () => {
  const challenge = {
    challengeId: "00000000-0000-4000-8000-000000000002",
    options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  };
  const assertion = {
    id: "a",
    rawId: "a",
    type: "public-key",
    response: {
      clientDataJSON: "e30",
      authenticatorData: "AAAA",
      signature: "c2ln",
    },
    clientExtensionResults: {},
  } as const;

  it("asks for a passkey bound to the direction and amount, then starts that same move", async () => {
    // #given
    const post = vi
      .fn<(path: string, body: unknown, schema: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(TREASURY_MOVES[0]);
    const steps = moveSteps({ post } as never, ORG);
    const request = {
      direction: "to_treasury",
      amountUsdc: "25000000",
    } as const;

    // #when
    const outcome = await approveWithPasskey(
      {
        request: (variables: typeof request) => steps.request(variables),
        confirm: (signed, response) => steps.confirm(signed, response, request),
      },
      request,
      () => Promise.resolve(assertion),
    );

    // #then
    expect(outcome.status).toBe("approved");
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [`/organizations/${ORG}/treasury/moves/confirmations`, request],
      [
        `/organizations/${ORG}/treasury/moves`,
        {
          direction: "to_treasury",
          amountUsdc: "25000000",
          challengeId: challenge.challengeId,
          response: assertion,
        },
      ],
    ]);
  });

  it("sends all as the word, and sends nothing when the passkey prompt is cancelled", async () => {
    // #given
    const post = vi
      .fn<(path: string, body: unknown, schema: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(challenge);
    const steps = moveSteps({ post } as never, ORG);
    const request = { direction: "to_wallet", amountUsdc: "all" } as const;

    // #when
    const outcome = await approveWithPasskey(
      {
        request: (variables: typeof request) => steps.request(variables),
        confirm: (signed, response) => steps.confirm(signed, response, request),
      },
      request,
      () => Promise.resolve(null),
    );

    // #then
    expect(outcome).toEqual({ status: "cancelled" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      `/organizations/${ORG}/treasury/moves/confirmations`,
      request,
      expect.anything(),
    );
  });
});

describe("the move sheet's form", () => {
  function form(props: Partial<Parameters<typeof MoveForm>[0]> = {}): string {
    return renderToStaticMarkup(
      <MoveForm
        formId="move"
        direction="to_treasury"
        amount="25"
        onAmount={() => undefined}
        all={false}
        onAll={() => undefined}
        amountError={null}
        preview={{ kind: "idle" }}
        rateBps={519}
        onSubmit={() => undefined}
        {...props}
      />,
    );
  }

  it("shows the preview: amount, estimated cost, time and what is available, and hides the parts", () => {
    // #when
    const html = form({
      preview: {
        kind: "ready",
        preview: {
          ...previewFor({ direction: "to_treasury", amountUsdc: "25000000" }),
          parts: 3,
        },
      },
    });
    const page = text(html);

    // #then
    expect({
      amount: page.includes("25.00 USDC"),
      cost: page.includes("About 0.46 USDC"),
      time: page.includes("Arrives in about 4 minutes"),
      available: page.includes("Available in wallet 16,420.80 USDC"),
      parts: /parts|part\b|split/i.test(page),
    }).toEqual({
      amount: true,
      cost: true,
      time: true,
      available: true,
      parts: false,
    });
  });

  it("warns that the rate changes before a move to Treasury, and offers All only for a move to the wallet", () => {
    // #when
    const toTreasury = text(form());
    const toWallet = text(
      form({
        direction: "to_wallet",
        preview: {
          kind: "ready",
          preview: previewFor({ direction: "to_wallet", amountUsdc: "all" }),
        },
        all: true,
        amount: "",
      }),
    );

    // #then
    expect({
      warning: toTreasury.includes(
        "Treasury pays 5.19% a year now. The rate changes daily, not guaranteed.",
      ),
      allToTreasury: toTreasury.includes(" All "),
      allToWallet: toWallet.includes(" All "),
      inTreasury: toWallet.includes("In Treasury 4,215.37 USDC"),
      isAll: toWallet.includes("(all of Treasury)"),
      noWarningToWallet: toWallet.includes("Treasury pays"),
    }).toEqual({
      warning: true,
      allToTreasury: false,
      allToWallet: true,
      inTreasury: true,
      isAll: true,
      noWarningToWallet: false,
    });
  });

  it.each([
    "The least you can move is 10 USDC.",
    "Treasury holds nothing to move.",
    "A Treasury move is already open. Wait for it to end before starting another.",
    "Payouts are paused, so Treasury moves can't start. Nothing moved.",
    "Treasury isn't available yet.",
    "That's more than the wallet has available.",
  ])("shows the API's own refusal: %s", (message) => {
    // #given
    const refusal = new ApiError(409, "Conflict", message);

    // #when
    const html = form({
      preview: { kind: "refused", message: describeApprovalError(refusal) },
    });

    // #then
    expect(plain(html)).toContain(message);
    expect(html).toContain('role="alert"');
  });

  it("shows the least-amount error under the field", () => {
    // #when
    const html = form({
      amount: "5",
      amountError: "The least you can move is 10 USDC.",
    });

    // #then
    expect(plain(html)).toContain("The least you can move is 10 USDC.");
    expect(html).toContain('aria-invalid="true"');
  });
});

describe("when the wallet is short", () => {
  const plainConflict = new ApiError(
    409,
    "Conflict",
    "The wallet is too short to pay this. Top up KES 53,231.85, then approve again. Nothing was sent.",
    { shortfallUsdc: "412650000", topUpKes: "5323185" },
  );

  function offer(error: unknown, role: "admin" | "accountant" = "admin") {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardProvider
          company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
        >
          <TreasuryOfferProvider>
            <TreasuryOfferButton error={error} />
          </TreasuryOfferProvider>
        </DashboardProvider>
      </QueryClientProvider>,
    );
  }

  it("finds the offer only on a 409 that carries one", () => {
    // #then
    expect([
      treasuryOfferFrom(SHORT_WALLET_REFUSAL),
      treasuryOfferFrom(plainConflict),
      treasuryOfferFrom(
        new ApiError(400, "BadRequest", "No", {
          treasuryOffer: SHORT_WALLET_OFFER,
        }),
      ),
      treasuryOfferFrom(
        new ApiError(409, "Conflict", "No", {
          treasuryOffer: { action: "move_to_wallet" },
        }),
      ),
      treasuryOfferFrom(new Error("offline")),
    ]).toEqual([SHORT_WALLET_OFFER, null, null, null, null]);
  });

  it("shows the API's message with the offer, and the top-up line without it", () => {
    // #then
    expect([
      describeApprovalError(SHORT_WALLET_REFUSAL),
      describeApprovalError(plainConflict),
    ]).toEqual([
      SHORT_WALLET_REFUSAL.message,
      "Top up KES 53,231.85, then approve again. Nothing was sent.",
    ]);
  });

  it("offers Move to wallet beside a refusal with the offer, and nothing beside one without", () => {
    // #then
    expect({
      withOffer: text(offer(SHORT_WALLET_REFUSAL)).includes("Move to wallet"),
      without: offer(plainConflict),
      offline: offer(new Error("offline")),
      accountant: offer(SHORT_WALLET_REFUSAL, "accountant"),
    }).toEqual({ withOffer: true, without: "", offline: "", accountant: "" });
  });
});

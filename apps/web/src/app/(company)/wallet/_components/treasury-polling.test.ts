import type { QueryKey, QueryObserverOptions } from "@tanstack/react-query";
import {
  focusManager,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  TreasuryStatus,
  WalletHistoryResponse,
  WalletResponse,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { TREASURY_STATUSES } from "~/app/dev/preview/_harness/fixtures/treasury";
import {
  ACCOUNTS_WALLET,
  LEDGER,
} from "~/app/dev/preview/_harness/fixtures/wallet";
import { followTreasuryMoves, treasuryStatusQuery } from "./treasury-api";
import { companyWalletQuery, walletHistoryQuery } from "./wallet-api";

// TanStack Query never polls on a server, which it decides from `window`
// once, when it loads; so this file runs as a browser would.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

const ORG = "00000000-0000-4000-8000-0000000000aa";

const BEFORE_THE_MOVE = "11580400";
const AFTER_THE_MOVE = "1580400";

if (ACCOUNTS_WALLET.status !== "active") {
  throw new Error("The sample wallet isn't active");
}
const WALLET = ACCOUNTS_WALLET;

const wallet = (usdcBalance: string): WalletResponse => ({
  ...WALLET,
  usdcBalance,
});

const NOTHING_MOVING = TREASURY_STATUSES.on;
const ON_ITS_WAY = TREASURY_STATUSES.move;
if (NOTHING_MOVING.status !== "on") {
  throw new Error("The sample Treasury isn't on");
}
const ARRIVED: TreasuryStatus = { ...NOTHING_MOVING, valueUsdc: "9995579" };

/** No payout on its way, so the history has no reason of its own to ask again. */
const SETTLED_HISTORY = LEDGER.filter(
  (item) => item.payout?.status === "paid",
).slice(0, 2);

/** What the API answers now; a test changes it as the move goes on. */
interface Server {
  treasury: TreasuryStatus;
  wallet: WalletResponse;
  history: WalletHistoryResponse;
}

const serverWith = (treasury: TreasuryStatus, usdcBalance: string): Server => ({
  treasury,
  wallet: wallet(usdcBalance),
  history: { items: SETTLED_HISTORY, nextCursor: null },
});

function fakeApi(server: Server): {
  api: ApiClient;
  asked: (about: "treasury" | "wallet" | "history") => number;
} {
  const paths: string[] = [];
  const refuse = () => Promise.reject(new Error("Not asked in this test"));
  const api: ApiClient = {
    get: (path, schema) => {
      paths.push(path);
      const answer = path.endsWith("/treasury")
        ? server.treasury
        : path.includes("/wallet/history")
          ? server.history
          : server.wallet;
      return Promise.resolve(schema.parse(answer));
    },
    post: refuse,
    put: refuse,
    patch: refuse,
    delete: refuse,
  };
  const matches = {
    treasury: (path: string) => path.endsWith("/treasury"),
    wallet: (path: string) => path.endsWith("/wallet"),
    history: (path: string) => path.includes("/wallet/history"),
  };
  return {
    api,
    asked: (about) => paths.filter(matches[about]).length,
  };
}

/** As the app sets it: an answer under a minute old isn't asked for again on its own. */
const appQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });

/** The Accounts page as mounted: Treasury, the balance and the history, kept in step. */
function openAccounts(server: Server, client = appQueryClient()) {
  const { api, asked } = fakeApi(server);
  const follow = <T, K extends QueryKey>(
    options: QueryObserverOptions<T, Error, T, T, K>,
  ) => {
    const observer = new QueryObserver(client, options);
    const stop = observer.subscribe(() => undefined);
    return { data: () => observer.getCurrentResult().data, stop };
  };
  const stopFollowing = followTreasuryMoves(client, ORG);
  const treasury = follow(treasuryStatusQuery(api, ORG));
  const balance = follow(companyWalletQuery(api, ORG));
  const stopHistory = new InfiniteQueryObserver(
    client,
    walletHistoryQuery(api, ORG),
  ).subscribe(() => undefined);
  return {
    asked,
    shownBalance: () => {
      const shown = balance.data();
      return shown?.status === "active" ? shown.usdcBalance : undefined;
    },
    shownTreasury: () => {
      const shown = treasury.data();
      return shown?.status === "on" ? shown.valueUsdc : undefined;
    },
    close: () => {
      stopFollowing();
      treasury.stop();
      balance.stop();
      stopHistory();
    },
  };
}

/** The next Treasury answer, and whatever it sets off. */
async function nextTreasuryAnswer(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T06:02:00Z"));
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("the Accounts page while money moves to Treasury", () => {
  it("shows the wallet's balance without the money once it has left, while the move is still open", async () => {
    // #given
    const server = serverWith(ON_ITS_WAY, BEFORE_THE_MOVE);
    const page = openAccounts(server);
    await vi.advanceTimersByTimeAsync(0);
    const before = page.shownBalance();
    const historyAsksBefore = page.asked("history");

    // #when the wallet's send runs
    server.wallet = wallet(AFTER_THE_MOVE);
    await nextTreasuryAnswer();

    // #then
    expect({
      before,
      after: page.shownBalance(),
      historyAskedAgain: page.asked("history") > historyAsksBefore,
    }).toEqual({
      before: BEFORE_THE_MOVE,
      after: AFTER_THE_MOVE,
      historyAskedAgain: true,
    });
    page.close();
  });

  it("never shows the money in both the wallet and Treasury once the move has ended, and stops asking", async () => {
    // #given
    const server = serverWith(ON_ITS_WAY, BEFORE_THE_MOVE);
    const page = openAccounts(server);
    await vi.advanceTimersByTimeAsync(0);

    // #when
    server.treasury = ARRIVED;
    server.wallet = wallet(AFTER_THE_MOVE);
    await nextTreasuryAnswer();
    const asks = () => ({
      wallet: page.asked("wallet"),
      history: page.asked("history"),
      treasury: page.asked("treasury"),
    });
    const whenItEnded = asks();
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({
      wallet: page.shownBalance(),
      treasury: page.shownTreasury(),
      aMinuteLater: asks(),
    }).toEqual({
      wallet: AFTER_THE_MOVE,
      treasury: "9995579",
      aMinuteLater: whenItEnded,
    });
    page.close();
  });

  it("catches up when the move ends just after the admin comes back to the page", async () => {
    // #given
    const server = serverWith(ON_ITS_WAY, BEFORE_THE_MOVE);
    const client = appQueryClient();
    const firstVisit = openAccounts(server, client);
    await vi.advanceTimersByTimeAsync(0);
    firstVisit.close();
    await vi.advanceTimersByTimeAsync(20_000);
    const page = openAccounts(server, client);
    await vi.advanceTimersByTimeAsync(0);

    // #when
    server.treasury = ARRIVED;
    server.wallet = wallet(AFTER_THE_MOVE);
    await nextTreasuryAnswer();

    // #then
    expect({
      wallet: page.shownBalance(),
      treasury: page.shownTreasury(),
    }).toEqual({ wallet: AFTER_THE_MOVE, treasury: "9995579" });
    page.close();
  });

  it("doesn't ask about the wallet again while nothing is moving", async () => {
    // #given
    const server = serverWith(NOTHING_MOVING, BEFORE_THE_MOVE);
    const page = openAccounts(server);
    await vi.advanceTimersByTimeAsync(0);

    // #when
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({
      treasury: page.asked("treasury"),
      wallet: page.asked("wallet"),
      history: page.asked("history"),
    }).toEqual({ treasury: 1, wallet: 1, history: 1 });
    page.close();
  });
});

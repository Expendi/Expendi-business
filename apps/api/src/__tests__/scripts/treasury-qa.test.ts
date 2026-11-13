import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PasskeyStore } from "../../../scripts/lib/treasury-qa-commands.js";
import type { Database } from "../../db/client.js";
import type { AppDeps } from "../../layers/main.js";
import type { TestUser } from "../helpers/db.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import {
  alerts,
  banner,
  describeFailure,
  enrol,
  filePasskeyStore,
  inspect,
  moves,
  parseMoveRequest,
  parseUsdc,
  preview,
  reconcile,
  returnStranded,
  startMove,
  status,
  turnOn,
} from "../../../scripts/lib/treasury-qa-commands.js";
import { DatabaseService } from "../../db/client.js";
import { advanceTreasuryMove } from "../../services/treasury/advance.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
} from "../helpers/near-payouts.js";
import { USDC, VAULT_ID } from "../helpers/treasury-moves.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime } = world;
let db: Database;
let paying: NearPayingCompany;
let qaAdmin: TestUser;

const memoryPasskeys = (): PasskeyStore => {
  const keys = new Map<string, SoftwarePasskey>();
  return {
    save: (userId, key) => {
      keys.set(userId, key);
      return Promise.resolve();
    },
    load: (userId) => Promise.resolve(keys.get(userId) ?? null),
  };
};

const passkeys = memoryPasskeys();
const options = () => ({
  organizationId: paying.company.organizationId,
  adminEmail: qaAdmin.email,
  passkeys,
});

const failureOf = async (effect: Effect.Effect<unknown, unknown, never>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  return exit.cause;
};
const refusal = async (effect: Effect.Effect<unknown, unknown, AppDeps>) => {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  return describeFailure(exit.cause);
};

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  paying = await createNearPayingCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
  // The company's own admin already has the passkey the helper enrolled; the
  // QA admin is a second admin whose passkey the script enrols itself.
  qaAdmin = await createUser(db);
  await addMember(db, paying.company, qaAdmin, { role: "admin" });
});

afterAll(async () => {
  await runtime.dispose();
});

describe("amounts", () => {
  it("reads decimal USDC with up to six places as base units", () => {
    expect(parseUsdc("10")).toBe(10_000_000n);
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "abc", "1.0000001", "-5", "1e3", ".5", "5.", "0"]) {
      expect(parseUsdc(bad), bad).toBeNull();
    }
  });

  it("needs a direction and exactly one of an amount or --all", async () => {
    const parse = (input: Parameters<typeof parseMoveRequest>[0]) =>
      Effect.runPromiseExit(parseMoveRequest(input));
    expect(
      await parse({ direction: "to_treasury", usdc: "10", all: false }),
    ).toEqual(
      Exit.succeed({ direction: "to_treasury", amountUsdc: 10_000_000n }),
    );
    expect(
      await parse({ direction: "to_wallet", usdc: undefined, all: true }),
    ).toEqual(Exit.succeed({ direction: "to_wallet", amountUsdc: "all" }));
    for (const bad of [
      { direction: undefined, usdc: "10", all: false },
      { direction: "sideways", usdc: "10", all: false },
      { direction: "to_wallet", usdc: undefined, all: false },
      { direction: "to_wallet", usdc: "10", all: true },
      { direction: "to_wallet", usdc: "1.2.3", all: false },
    ]) {
      expect(Exit.isFailure(await parse(bad)), JSON.stringify(bad)).toBe(true);
    }
  });
});

describe("the passkey file store", () => {
  it("keeps keys owner-only and loads what it saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "treasury-qa-"));
    try {
      const store = filePasskeyStore(
        pathToFileURL(join(directory, "keys") + "/"),
      );
      const key = SoftwarePasskey.create();
      expect(await store.load("someone")).toBeNull();
      await store.save("someone", key);
      expect((await store.load("someone"))?.credentialId).toBe(
        key.credentialId,
      );
      expect((await stat(join(directory, "keys"))).mode & 0o777).toBe(0o700);
      expect(
        (await stat(join(directory, "keys", "passkey-someone.json"))).mode &
          0o777,
      ).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the QA flow", () => {
  it("says which company and database it is talking to, without credentials", async () => {
    const where = await runtime.runPromise(
      banner(paying.company.organizationId),
    );
    expect(where.companyName).toBe(paying.company.name);
    expect(where.databaseHost).toMatch(/^[^@/]+$/);
  });

  it("refuses a company that doesn't exist", async () => {
    expect(
      await refusal(banner("00000000-0000-4000-8000-000000000000")),
    ).toMatch(/No company/);
  });

  it("turns on, previews, moves and shows the move", async () => {
    expect(await runtime.runPromise(status(options()))).toEqual({
      status: "off",
    });

    await runtime.runPromise(enrol(options()));
    const turnedOn = await runtime.runPromise(turnOn(options()));
    expect(turnedOn.status).toBe("on");
    if (turnedOn.status !== "on") throw new Error("not on");
    expect(turnedOn.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const request = {
      direction: "to_treasury",
      amountUsdc: 10n * USDC,
    } as const;
    const quoted = await runtime.runPromise(preview(options(), request));
    expect(quoted).toMatchObject({
      direction: "to_treasury",
      amountUsdc: (10n * USDC).toString(),
      parts: 1,
    });
    expect(await runtime.runPromise(moves(options()))).toEqual({ moves: [] });

    const started = await runtime.runPromise(
      startMove(options(), request, true),
    );
    expect(started).toMatchObject({
      direction: "to_treasury",
      status: "open",
      requestedUsdc: (10n * USDC).toString(),
    });

    // The station job's work, which the driver never does itself.
    await runtime.runPromise(
      advanceTreasuryMove(
        { organizationId: paying.company.organizationId, moveId: started.id },
        { retryDelayMs: 0 },
      ),
    );

    const inspection = await runtime.runPromise(inspect(options(), started.id));
    expect(inspection.move.id).toBe(started.id);
    expect(inspection.quotes).toHaveLength(1);
    expect(inspection.quotes[0]).toMatchObject({
      purpose: "to_treasury",
      amountIn: 10n * USDC,
    });
    expect(inspection.quotes[0]?.depositAddress).toBeTruthy();

    const listed = await runtime.runPromise(moves(options()));
    expect(listed.moves.map((move) => move.id)).toEqual([started.id]);

    const reconciliation = await runtime.runPromise(reconcile(options()));
    expect(reconciliation.ledgerUsdc).toBeGreaterThan(0n);
    expect(reconciliation.nearUsdc).not.toBeNull();
    expect(reconciliation.baseUsdc).not.toBeNull();
    expect(reconciliation.inFlight.join(" ")).toMatch(/Treasury move/);

    expect(await runtime.runPromise(alerts(options()))).toEqual([]);

    expect(await refusal(startMove(options(), request, true))).toMatch(
      /already open/,
    );
  });

  it("refuses to move without --yes, and saves nothing", async () => {
    const before = await runtime.runPromise(moves(options()));
    expect(
      await refusal(
        startMove(
          options(),
          { direction: "to_treasury", amountUsdc: 10n * USDC },
          false,
        ),
      ),
    ).toMatch(/--yes/);
    expect(await runtime.runPromise(moves(options()))).toEqual(before);
  });

  it("returns a stranded deposit only for a move in needs_review, and with --yes", async () => {
    const [open] = (await runtime.runPromise(moves(options()))).moves;
    if (!open) throw new Error("the flow above should have left a move");
    expect(await refusal(returnStranded(options(), open.id, false))).toMatch(
      /--yes/,
    );
    expect(await refusal(returnStranded(options(), open.id, true))).toMatch(
      /isn't waiting for review/,
    );
  });

  it("describes an unexpected failure rather than hiding it", async () => {
    const cause = await failureOf(Effect.die(new Error("boom")));
    expect(Option.isNone(Cause.failureOption(cause))).toBe(true);
    expect(describeFailure(cause)).toMatch(/Failed unexpectedly/);
  });
});

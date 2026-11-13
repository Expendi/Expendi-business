import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import {
  treasuryMoves,
  treasuryReturnApprovals,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmTreasuryAction,
  prepareTreasuryAction,
} from "../../services/staff/treasury-actions.js";
import { advanceTreasuryMove } from "../../services/treasury/advance.js";
import {
  resumeToWalletReturn,
  returnStrandedDeposit,
} from "../../services/treasury/stranded.js";
import { makeNearPayoutWorld, updateQuote } from "../helpers/near-payouts.js";
import { createStaff } from "../helpers/staff.js";
import {
  createTreasuryCompany,
  creditDeliveries,
  deliverSentParts,
  fundVault,
  readActions,
  readMove,
  returnQuotes,
  setBaseBalance,
  settleSentReturns,
  startMove,
  startMoveToWallet,
  treasuryWalletUsdc,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy } = world;
let db: Database;
let owner: pg.Pool;
let company: TreasuryCompany;
let settled: Set<string>;
let credited: Set<string>;
let delivered: Set<string>;
let staff: Awaited<ReturnType<typeof createStaff>>;
let otherStaff: Awaited<ReturnType<typeof createStaff>>;

const NO_DELAY = { retryDelayMs: 0 } as const;
const IN_VAULT = 70n * USDC;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  staff = await createStaff(owner, { role: "ops_admin" });
  otherStaff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  settled = new Set();
  credited = new Set();
  delivered = new Set();
  privy.state.resetEarn();
  privy.state.sends.length = 0;
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
  fundVault(world, company, IN_VAULT);
});

const organizationId = () => company.tenant.organizationId;
const scope = () => ({ organizationId: organizationId() });
const advance = (moveId: string) =>
  runtime.runPromise(advanceTreasuryMove({ ...scope(), moveId }, NO_DELAY));

/** Runs the job, 1Click delivering and the watcher crediting, until the move leaves `open`. */
async function drive(moveId: string) {
  for (let round = 0; round < 80; round += 1) {
    await deliverSentParts(world, db, company, delivered);
    await settleSentReturns(world, db, company, settled);
    await creditDeliveries(world, db, company, credited);
    await advance(moveId);
    const move = await readMove(db, company, moveId);
    if (move.status !== "open") return move;
  }
  throw new Error(`move ${moveId} still open`);
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  return failure && typeof failure === "object" && "_tag" in failure
    ? String(failure._tag)
    : String(failure);
};

/** A move to Treasury whose vault deposit Privy rejected until it went to review. */
async function strandedMove() {
  privy.state.nextEarnCalls("rejected", "rejected", "rejected");
  const move = await startMove(world, company, 20n * USDC);
  const reviewed = await drive(move.id);
  expect(reviewed.status).toBe("needs_review");
  return move;
}

/**
 * A move to the wallet whose withdrawal delivered `amount` but whose return
 * went to review: Privy refuses the Treasury wallet's `refuseAfter`th
 * transfer, so that many parts went out and were credited first.
 */
async function stuckReturn(amount: bigint, sentFirst = 0) {
  privy.state.nextSends(
    ...Array.from({ length: sentFirst }, () => "sent" as const),
    "policy_violation",
  );
  const move = await startMoveToWallet(world, company, amount);
  const reviewed = await drive(move.id);
  expect(reviewed.status).toBe("needs_review");
  return move;
}

const actor = { type: "system", id: "staff-test" } as const;
const resume = (moveId: string) =>
  runtime.runPromise(
    resumeToWalletReturn({ organizationId: organizationId(), moveId, actor }),
  );

const sentBack = async () =>
  (await returnQuotes(db, company))
    .filter((quote) => quote.status !== "failed")
    .reduce((sum, quote) => sum + quote.amountIn, 0n);

const approvalRows = async () => {
  const rows = await runInScope(db, scope(), (tx) =>
    tx
      .select()
      .from(treasuryReturnApprovals)
      .orderBy(treasuryReturnApprovals.createdAt),
  );
  return rows.map((row) => ({
    approved_usdc: row.approvedUsdc,
    approved_by: row.approvedBy,
    reason: row.reason,
    consumed_at: row.consumedAt,
  }));
};

/** An approval for `approved`, written as the confirm step would, to test the job against a state staff didn't see. */
async function plantApproval(moveId: string, approved: bigint) {
  const prepared = await prepare("resume_return", moveId);
  expect(prepared.token).toBeTruthy();
  const {
    rows: [confirmation],
  } = await owner.query<{ id: string }>(
    "SELECT id FROM staff_confirmations WHERE staff_user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [staff.staffUserId],
  );
  await runInScope(db, scope(), async (tx) => {
    await tx
      .update(treasuryMoves)
      .set({ status: "open" })
      .where(eq(treasuryMoves.id, moveId));
    await tx.insert(treasuryReturnApprovals).values({
      organizationId: organizationId(),
      treasuryMoveId: moveId,
      kind: "resume_return",
      approvedUsdc: approved,
      approvedBy: staff.staffUserId,
      reason: "Planted for a test.",
      confirmationId: confirmation?.id ?? "",
    });
  });
}

/** What staff's confirm step may leave behind: the move open and an approval, but no quote and no send. */
const afterConfirm = async (moveId: string) => ({
  status: (await readMove(db, company, moveId)).status,
  quotes: (await returnQuotes(db, company)).length,
  sends: privy.state.sends.length,
  oneClick: world.oneClick.state.quoteRequests.length,
});

const returnAudit = async () => {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_type, actor_id, after FROM audit_log WHERE organization_id = $1 AND action = 'treasury_move.return_started' ORDER BY occurred_at, id",
    [organizationId()],
  );
  return rows;
};

describe("resuming a move to the wallet's return", () => {
  it("sends back what the withdrawal delivered, reopens the move and completes it", async () => {
    // #given a delivery whose only part Privy refused to send
    const move = await stuckReturn(20n * USDC);
    expect(treasuryWalletUsdc(company)).toBe(20n * USDC);

    // #when staff resume it and the job runs
    const started = await resume(move.id);
    const reopened = await readMove(db, company, move.id);
    const done = await drive(move.id);

    // #then
    expect({
      owed: started.amountUsdc,
      reopened: reopened.status,
      done: done.status,
      sent: await sentBack(),
      left: treasuryWalletUsdc(company),
      audit: (await returnAudit()).map((row) => row.after.resumedReturn),
    }).toEqual({
      owed: 20n * USDC,
      reopened: "open",
      done: "completed",
      sent: 20n * USDC,
      left: 0n,
      audit: [true],
    });
  });

  it("never sends more than the withdrawal delivered less what was sent, whatever the Treasury wallet holds", async () => {
    // #given 70 USDC delivered in parts of about 23.3, the first sent and credited, the second refused
    const move = await stuckReturn(IN_VAULT, 1);
    const [first] = await returnQuotes(db, company);
    const afterFirst = first?.amountIn ?? 0n;
    expect(afterFirst).toBeGreaterThan(0n);
    // and 50 USDC of a stranger's in the same wallet
    setBaseBalance(
      world,
      company.treasuryAddress,
      treasuryWalletUsdc(company) + 50n * USDC,
    );

    // #when
    const started = await resume(move.id);
    const done = await drive(move.id);

    // #then every part together is exactly the delivery, and the stranger's USDC stays
    expect({
      owed: started.amountUsdc,
      done: done.status,
      sent: await sentBack(),
      stranger: treasuryWalletUsdc(company),
    }).toEqual({
      owed: IN_VAULT - afterFirst,
      done: "completed",
      sent: IN_VAULT,
      stranger: 50n * USDC,
    });
  });

  it("is safe to ask twice: one quote, one send", async () => {
    // #given
    const move = await stuckReturn(20n * USDC);

    // #when
    const first = await resume(move.id);
    const second = await resume(move.id);
    await drive(move.id);

    // #then
    expect({
      same: first.quoteId === second.quoteId,
      sends: privy.state.sends.length,
    }).toEqual({ same: true, sends: 1 });
  });

  it("picks up a quote an earlier attempt took but never reopened the move for", async () => {
    // #given a refused part, and a fresh quote that was never paid
    const move = await stuckReturn(20n * USDC);
    const first = await resume(move.id);
    await owner.query(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );

    // #when
    const again = await resume(move.id);
    const done = await drive(move.id);

    // #then it reuses that quote rather than owing twice
    expect({
      same: again.quoteId === first.quoteId,
      done: done.status,
      sent: await sentBack(),
    }).toEqual({ same: true, done: "completed", sent: 20n * USDC });
  });

  it.each([
    [
      "a move that is still open",
      async () => (await startMoveToWallet(world, company, 20n * USDC)).id,
      "Conflict",
    ],
    [
      "a move to Treasury",
      async () => (await startMove(world, company, 20n * USDC)).id,
      "BadRequest",
    ],
    [
      "a move that completed",
      async () => {
        const move = await startMoveToWallet(world, company, 20n * USDC);
        await drive(move.id);
        return move.id;
      },
      "Conflict",
    ],
  ])("is refused for %s", async (_name, makeMove, tag) => {
    // #given
    const moveId = await makeMove();

    // #then
    expect(
      failureOf(
        await runtime.runPromiseExit(
          resumeToWalletReturn({
            organizationId: organizationId(),
            moveId,
            actor,
          }),
        ),
      ),
    ).toBe(tag);
  });

  it("is refused while a part of the return is unclear, or when nothing is owed", async () => {
    // #given a return whose last part's outcome is unclear
    const move = await stuckReturn(20n * USDC);
    const [quote] = await returnQuotes(db, company);
    await updateQuote(db, company.company, quote?.id ?? "", {
      status: "needs_review",
      settledAt: null,
    });

    // #when
    const unclear = await runtime.runPromiseExit(
      resumeToWalletReturn({
        organizationId: organizationId(),
        moveId: move.id,
        actor,
      }),
    );

    // #then
    expect(failureOf(unclear)).toBe("Conflict");

    // #given the same part counted as delivered, so nothing is owed
    await updateQuote(db, company.company, quote?.id ?? "", {
      status: "succeeded",
      settledAt: new Date(),
    });
    const nothingOwed = await runtime.runPromiseExit(
      resumeToWalletReturn({
        organizationId: organizationId(),
        moveId: move.id,
        actor,
      }),
    );
    expect(failureOf(nothingOwed)).toBe("Conflict");
  });

  it("is refused when the withdrawal's delivery was never confirmed", async () => {
    // #given a move in review before its withdrawal was read
    const move = await startMoveToWallet(world, company, 20n * USDC);
    await owner.query(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );

    // #then
    expect(
      failureOf(
        await runtime.runPromiseExit(
          resumeToWalletReturn({
            organizationId: organizationId(),
            moveId: move.id,
            actor,
          }),
        ),
      ),
    ).toBe("Conflict");
    expect(await readActions(db, company)).toEqual([]);
  });
});

const prepare = (
  action: "return_stranded_deposit" | "resume_return",
  moveId: string,
  who = staff,
) =>
  runtime.runPromise(
    prepareTreasuryAction(who, {
      action,
      organizationId: organizationId(),
      moveId,
      reason: "Checked the Treasury wallet and the vault in Privy.",
    }),
  );

const confirm = (
  action: "return_stranded_deposit" | "resume_return",
  moveId: string,
  token: string,
  who = staff,
  forOrganization = organizationId(),
) =>
  runtime.runPromiseExit(
    confirmTreasuryAction(who, {
      action,
      organizationId: forOrganization,
      moveId,
      token,
    }),
  );

describe("the staff actions on a move under review", () => {
  it("returns a stranded deposit after a second confirmation, audited under the staff member", async () => {
    // #given
    const move = await strandedMove();

    // #when
    const prepared = await prepare("return_stranded_deposit", move.id);
    const stillReviewing = (await readMove(db, company, move.id)).status;
    const quotesBefore = world.oneClick.state.quoteRequests.length;
    const sendsBefore = privy.state.sends.length;
    const confirmed = await confirm(
      "return_stranded_deposit",
      move.id,
      prepared.token,
    );
    const left = await afterConfirm(move.id);
    expect({
      ...left,
      oneClick: left.oneClick - quotesBefore,
      sends: left.sends - sendsBefore,
      approvals: (await approvalRows()).map((row) => [
        row.approved_by,
        row.reason,
        row.consumed_at,
      ]),
    }).toEqual({
      status: "open",
      quotes: 0,
      sends: 0,
      oneClick: 0,
      approvals: [
        [
          staff.staffUserId,
          "Checked the Treasury wallet and the vault in Privy.",
          null,
        ],
      ],
    });
    const done = await drive(move.id);

    // #then nothing changed until the second step
    expect({
      before: stillReviewing,
      confirmed: Exit.isSuccess(confirmed),
      done: done.status,
      audit: (await returnAudit()).map(({ actor_type, actor_id, after }) => ({
        actor: [actor_type, actor_id],
        via: after.via,
        note: after.note,
      })),
    }).toEqual({
      before: "needs_review",
      confirmed: true,
      done: "returned",
      audit: [
        {
          actor: ["staff", staff.staffUserId],
          via: "admin-app",
          note: "Checked the Treasury wallet and the vault in Privy.",
        },
      ],
    });
  });

  it("resumes a return after a second confirmation, for exactly what was prepared", async () => {
    // #given
    const move = await stuckReturn(20n * USDC);

    // #when
    const prepared = await prepare("resume_return", move.id);
    const quotesBefore = (await returnQuotes(db, company)).length;
    const confirmed = await confirm("resume_return", move.id, prepared.token);
    const left = await afterConfirm(move.id);
    expect([left.status, left.quotes - quotesBefore]).toEqual(["open", 0]);
    const done = await drive(move.id);

    // #then
    expect({
      owed: prepared.amountUsdc,
      confirmed: Exit.isSuccess(confirmed),
      done: done.status,
      sent: await sentBack(),
    }).toEqual({
      owed: (20n * USDC).toString(),
      confirmed: true,
      done: "completed",
      sent: 20n * USDC,
    });
  });

  it.each([
    [
      "resume_return",
      "a move to Treasury",
      () => startMove(world, company, 20n * USDC),
    ],
    [
      "return_stranded_deposit",
      "a move to the wallet in review",
      () => stuckReturn(20n * USDC),
    ],
    [
      "return_stranded_deposit",
      "a move to Treasury that is still open",
      () => startMove(world, company, 20n * USDC),
    ],
    [
      "resume_return",
      "a move to the wallet that is still open",
      () => startMoveToWallet(world, company, 20n * USDC),
    ],
  ] as const)("refuses to prepare %s for %s", async (action, _name, make) => {
    // #given
    const move = await make();

    // #when
    const exit = await runtime.runPromiseExit(
      prepareTreasuryAction(staff, {
        action,
        organizationId: organizationId(),
        moveId: move.id,
        reason: "Checked the Treasury wallet and the vault in Privy.",
      }),
    );

    // #then
    expect(["Conflict", "BadRequest"]).toContain(failureOf(exit));
    expect(await returnAudit()).toEqual([]);
  });

  it("refuses a confirmation prepared by another staff member, and keeps it usable", async () => {
    // #given
    const move = await stuckReturn(20n * USDC);
    const prepared = await prepare("resume_return", move.id);

    // #when
    const stolen = await confirm(
      "resume_return",
      move.id,
      prepared.token,
      otherStaff,
    );
    const mine = await confirm("resume_return", move.id, prepared.token);

    // #then
    expect([failureOf(stolen), failureOf(mine)]).toEqual([
      "Forbidden",
      "succeeded",
    ]);
  });

  it("refuses a confirmation prepared for another move, another action or another company", async () => {
    // #given a stranded move's token, and a resumable move's token
    const stranded = await strandedMove();
    const strandedToken = (
      await prepare("return_stranded_deposit", stranded.id)
    ).token;

    // #when it is used for the other action, or for a company it wasn't prepared for
    const asResume = await confirm("resume_return", stranded.id, strandedToken);
    const elsewhere = await createTreasuryCompany(world, db);
    const forOtherCompany = await confirm(
      "return_stranded_deposit",
      stranded.id,
      strandedToken,
      staff,
      elsewhere.tenant.organizationId,
    );
    const otherMove = await confirm(
      "return_stranded_deposit",
      "00000000-0000-4000-8000-000000000000",
      strandedToken,
    );

    // #then none applies, and the move is still waiting
    expect([
      failureOf(asResume),
      failureOf(forOtherCompany),
      failureOf(otherMove),
    ]).toEqual(["BadRequest", "BadRequest", "BadRequest"]);
    expect((await readMove(db, company, stranded.id)).status).toBe(
      "needs_review",
    );
  });

  it("uses a confirmation once", async () => {
    // #given
    const move = await stuckReturn(20n * USDC);
    const prepared = await prepare("resume_return", move.id);
    await confirm("resume_return", move.id, prepared.token);
    await owner.query(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );

    // #when
    const again = await confirm("resume_return", move.id, prepared.token);

    // #then
    expect(failureOf(again)).toBe("Gone");
  });

  it("refuses to confirm when what is owed changed since it was prepared, and keeps the confirmation", async () => {
    // #given a resume prepared for 70 USDC, after which a part is sent and credited some other way
    const move = await stuckReturn(IN_VAULT);
    const prepared = await prepare("resume_return", move.id);
    await resume(move.id);
    await owner.query(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );
    await owner.query(
      "UPDATE intent_quotes SET status = 'succeeded', settled_at = now() WHERE treasury_move_id = $1 AND purpose = 'from_treasury' AND status = 'quoted'",
      [move.id],
    );

    // #when
    const exit = await confirm("resume_return", move.id, prepared.token);

    // #then
    expect(failureOf(exit)).toBe("Conflict");
  });
});

describe("the job carrying out an approval", () => {
  const approve = async (
    action: "return_stranded_deposit" | "resume_return",
    moveId: string,
  ) => {
    const prepared = await prepare(action, moveId);
    expect(Exit.isSuccess(await confirm(action, moveId, prepared.token))).toBe(
      true,
    );
  };

  it("executes an approved return once, however often it is stepped", async () => {
    // #given
    const move = await stuckReturn(20n * USDC);
    await approve("resume_return", move.id);

    // #when it is stepped twice before anything settles, then to the end
    await advance(move.id);
    await advance(move.id);
    const quotesAfterTwo = (await returnQuotes(db, company)).length;
    const done = await drive(move.id);

    // #then
    expect({
      quotesAfterTwo,
      done: done.status,
      sent: await sentBack(),
      sends: privy.state.sends.length,
      used: (await approvalRows()).map((row) => row.consumed_at !== null),
    }).toEqual({
      quotesAfterTwo: 2,
      done: "completed",
      sent: 20n * USDC,
      sends: 1,
      used: [true],
    });
  });

  it("never sends more than what is owed, with a stranger's USDC in the wallet", async () => {
    // #given
    const move = await stuckReturn(IN_VAULT, 1);
    setBaseBalance(
      world,
      company.treasuryAddress,
      treasuryWalletUsdc(company) + 50n * USDC,
    );
    await approve("resume_return", move.id);

    // #when
    const done = await drive(move.id);

    // #then
    expect([
      done.status,
      await sentBack(),
      treasuryWalletUsdc(company),
    ]).toEqual(["completed", IN_VAULT, 50n * USDC]);
  });

  it("sends the move back to review, sending nothing, when more is owed than was approved", async () => {
    // #given an approval that was for less than is owed by the time the job runs
    const move = await stuckReturn(20n * USDC);
    await plantApproval(move.id, 5n * USDC);
    const quotesBefore = (await returnQuotes(db, company)).length;

    // #when
    await advance(move.id);

    // #then
    const reviewed = await readMove(db, company, move.id);
    expect({
      status: reviewed.status,
      failure: reviewed.failure,
      quotes: (await returnQuotes(db, company)).length - quotesBefore,
      sends: privy.state.sends.length,
      used: (await approvalRows()).map((row) => row.consumed_at !== null),
    }).toEqual({
      status: "needs_review",
      failure: expect.stringContaining("more than was approved") as string,
      quotes: 0,
      sends: 0,
      used: [true],
    });
  });

  it("sends the move back to review, sending nothing, when the state changed after approval", async () => {
    // #given an approved return, and then a part of the return turns out unclear
    const move = await stuckReturn(20n * USDC);
    await approve("resume_return", move.id);
    const [failed] = await returnQuotes(db, company);
    await updateQuote(db, company.company, failed?.id ?? "", {
      status: "needs_review",
      settledAt: null,
    });

    // #when
    await advance(move.id);

    // #then
    const reviewed = await readMove(db, company, move.id);
    expect({
      status: reviewed.status,
      failure: reviewed.failure,
      sends: privy.state.sends.length,
    }).toEqual({
      status: "needs_review",
      failure: expect.stringContaining("Nothing was sent") as string,
      sends: 0,
    });
  });

  it("returns an approved stranded deposit, and no more than was undeposited", async () => {
    // #given
    const move = await strandedMove();
    setBaseBalance(
      world,
      company.treasuryAddress,
      treasuryWalletUsdc(company) + 6n * USDC,
    );
    await approve("return_stranded_deposit", move.id);

    // #when
    const done = await drive(move.id);

    // #then
    expect({
      done: done.status,
      sent: await sentBack(),
      stranger: treasuryWalletUsdc(company),
    }).toEqual({
      done: "returned",
      sent: expect.any(BigInt) as bigint,
      stranger: 6n * USDC,
    });
    expect(await sentBack()).toBeLessThanOrEqual(20n * USDC);
  });
});

describe("returning a stranded deposit (T4's action), through the same service", () => {
  it("still refuses a move to Treasury that Privy never rejected a deposit of", async () => {
    // #given a move in review for another reason: its deposit's outcome is unclear
    const move = await startMove(world, company, 20n * USDC);
    await owner.query(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );

    // #then
    expect(
      failureOf(
        await runtime.runPromiseExit(
          returnStrandedDeposit({
            organizationId: organizationId(),
            moveId: move.id,
            actor,
          }),
        ),
      ),
    ).toBe("Conflict");
  });
});

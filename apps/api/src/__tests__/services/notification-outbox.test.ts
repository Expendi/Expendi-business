import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { ClaimFlow } from "../helpers/claim-flow.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { withScope } from "../../db/scope.js";
import { notify } from "../../services/notification/notify.js";
import { claimFlow, makePayable } from "../helpers/claim-flow.js";
import { registerDevice } from "../helpers/devices.js";
import {
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { makeFakePushSender } from "../helpers/push.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Only what events queue: nothing here runs the sending job, which sweeps
// every company (see push-delivery.serial.test.ts).

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const push = makeFakePushSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: PayingCompany;
let flow: ClaimFlow;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    fileStorage: storage.layer,
    pushSender: push.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  push.state.reset();
  paying = await createPayingCompany(runtime, db);
  flow = claimFlow({ app, db, storage, paycrest }, paying);
});

interface QueuedRow {
  readonly kind: string;
  readonly audience: string;
  readonly recipient_membership_id: string | null;
  readonly except_membership_id: string | null;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
  readonly sent_at: Date | null;
}

async function queued(organizationId = paying.company.organizationId) {
  const { rows } = await owner.query<QueuedRow>(
    "SELECT kind, audience, recipient_membership_id, except_membership_id, title, body, data, sent_at FROM notification_outbox WHERE organization_id = $1 ORDER BY created_at, kind, audience",
    [organizationId],
  );
  return rows;
}

const kindsQueued = async () =>
  (await queued()).map(({ kind, audience }) => `${kind} → ${audience}`);

describe("what each claim event queues (spec §6.10)", () => {
  it("tells the admins a claim was submitted, leaving out the claimant", async () => {
    // #given
    const { user, membershipId } = await flow.employee("Jane Wanjiku");

    // #when
    const claim = await flow.submit(user);

    // #then
    expect(await queued()).toEqual([
      {
        kind: "claim_submitted",
        audience: "admins",
        recipient_membership_id: null,
        except_membership_id: membershipId,
        title: "New claim to approve",
        body: "Jane Wanjiku claimed KES 1,500.50 at Java House Westlands.",
        data: {
          type: "claim_submitted",
          organizationId: paying.company.organizationId,
          claimId: claim.id,
        },
        sent_at: null,
      },
    ]);
  });

  it("leaves an admin out of the news of their own claim", async () => {
    // #given
    await makePayable(db, paying.company.admin, "Achieng Odhiambo");

    // #when
    await flow.submit(paying.company.admin);

    // #then
    expect((await queued())[0]?.except_membership_id).toBe(
      paying.company.adminMembershipId,
    );
  });

  it("tells the employee their claim was rejected, with the reason", async () => {
    // #given
    const { user, membershipId } = await flow.employee();
    const claim = await flow.submit(user, "1,500");

    // #when
    await flow.reject(claim.id, "The receipt is for a different day");

    // #then
    expect((await queued()).at(-1)).toMatchObject({
      kind: "claim_rejected",
      audience: "member",
      recipient_membership_id: membershipId,
      title: "Claim rejected",
      body: "Your claim for KES 1,500 at Java House Westlands was rejected: The receipt is for a different day",
    });
  });

  it("tells the admins again when a rejected claim is resubmitted", async () => {
    // #given
    const { user } = await flow.employee();
    const claim = await flow.submit(user);
    await flow.reject(claim.id, "Wrong amount on the claim");

    // #when
    await flow.edit(user, claim.id, { amountKes: "1,450" });

    // #then
    expect(await kindsQueued()).toEqual([
      "claim_submitted → admins",
      "claim_rejected → member",
      "claim_submitted → admins",
    ]);
  });

  it("queues nothing for an edit to a claim still waiting", async () => {
    // #given
    const { user } = await flow.employee();
    const claim = await flow.submit(user);

    // #when
    await flow.edit(user, claim.id, { amountKes: "1,450" });

    // #then
    expect(await kindsQueued()).toEqual(["claim_submitted → admins"]);
  });

  it("tells the employee their claim was paid", async () => {
    // #given
    const { user, membershipId } = await flow.employee();
    const claim = await flow.submit(user, "1,500");

    // #when
    await flow.pay(claim.id);

    // #then
    expect((await queued()).at(-1)).toMatchObject({
      kind: "claim_paid",
      audience: "member",
      recipient_membership_id: membershipId,
      title: "Claim paid",
      body: "Your claim for KES 1,500 at Java House Westlands was paid.",
      data: {
        type: "claim_paid",
        organizationId: paying.company.organizationId,
        claimId: claim.id,
      },
    });
  });

  it("tells the employee and the other admins when the payout fails", async () => {
    // #given
    const { user, membershipId } = await flow.employee("Jane Wanjiku");
    const claim = await flow.submit(user, "1,500");

    // #when
    await flow.failPayout(claim.id);

    // #then
    expect(
      (await queued())
        .filter(({ kind }) => kind === "claim_payout_failed")
        .map(
          ({
            audience,
            recipient_membership_id,
            except_membership_id,
            body,
          }) => ({
            audience,
            recipient_membership_id,
            except_membership_id,
            body,
          }),
        ),
    ).toEqual([
      {
        audience: "member",
        recipient_membership_id: membershipId,
        except_membership_id: null,
        body: "Your claim for KES 1,500 at Java House Westlands couldn't be paid. An admin will look into it.",
      },
      {
        audience: "admins",
        recipient_membership_id: null,
        except_membership_id: membershipId,
        body: "Jane Wanjiku's claim for KES 1,500 at Java House Westlands couldn't be paid. Open it to try again.",
      },
    ]);
  });
});

describe("when notifications go out", () => {
  it("queues and sends nothing when the event's transaction rolls back", async () => {
    // #given
    const { user } = await flow.employee();
    await registerDevice(app, user);
    const claim = await flow.submit(user);
    const before = (await queued()).length;

    // #when
    await runtime.runPromiseExit(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        notify(tx, {
          kind: "claim_paid",
          organizationId: paying.company.organizationId,
          claimId: claim.id,
        }).pipe(Effect.zipRight(Effect.fail("the payout's change failed"))),
      ),
    );

    // #then
    expect({
      queued: (await queued()).length - before,
      handedToExpo: push.state.attempted.length,
    }).toEqual({ queued: 0, handedToExpo: 0 });
  });

  it("never holds up the request: the claim is saved while Expo is stuck", async () => {
    // #given
    const release = push.state.hold();
    const { user } = await flow.employee();

    // #when
    const claim = await flow.submit(user);
    release();

    // #then
    expect({
      saved: claim.status,
      handedToExpo: push.state.attempted.length,
      waiting: (await queued()).map(({ sent_at }) => sent_at),
    }).toEqual({ saved: "submitted", handedToExpo: 0, waiting: [null] });
  });
});

describe("notification_outbox", () => {
  it("isolates companies with an unfiltered SELECT", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    for (const company of [fixture.companyA, fixture.companyB]) {
      const theirs = claimFlow(
        { app, db, storage, paycrest },
        { ...paying, company },
      );
      const { user } = await theirs.employee();
      await theirs.submit(user);
    }

    // #then
    await expectTableIsolation(fixture, "notification_outbox");
  });
});

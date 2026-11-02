import { readdirSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { StationJob } from "../../station/scheduler.js";
import type { ClaimFlow } from "../helpers/claim-flow.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { notificationOutbox } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  checkPushReceipts,
  NOTIFICATION_MAX_AGE_MS,
  sendPendingNotifications,
} from "../../services/notification/delivery.js";
import { pushNotificationsJob } from "../../station/push-notifications.js";
import { IDLE } from "../../station/scheduler.js";
import { claimFlow } from "../helpers/claim-flow.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { registerDevice } from "../helpers/devices.js";
import {
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import { SRC_DIR } from "../helpers/module-graph.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { makeFakePushSender } from "../helpers/push.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: the sending job sweeps every company's outbox, so run beside
// other files it would send their notifications too.

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const push = makeFakePushSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

/** Company A: two admins and an employee, each with a phone. */
let paying: PayingCompany;
let flow: ClaimFlow;
let admin: { user: TestUser; device: string };
let secondAdmin: { user: TestUser; device: string; membershipId: string };
let employee: { user: TestUser; device: string; membershipId: string };
/** Company B: its own admin, with a phone. */
let other: { company: TestCompany; device: string };

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

const deliver = () => runtime.runPromise(sendPendingNotifications(10_000));

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  push.state.reset();
  // Whatever earlier serial files queued goes to people without phones.
  await deliver();

  paying = await createPayingCompany(runtime, db);
  flow = claimFlow({ app, db, storage, paycrest }, paying);
  admin = {
    user: paying.company.admin,
    device: await registerDevice(app, paying.company.admin),
  };
  const secondAdminUser = await createUser(db);
  secondAdmin = {
    user: secondAdminUser,
    membershipId: await addMember(db, paying.company, secondAdminUser, {
      role: "admin",
    }),
    device: await registerDevice(app, secondAdminUser),
  };
  const hired = await flow.employee("Jane Wanjiku");
  employee = { ...hired, device: await registerDevice(app, hired.user) };
  const otherCompany = await createCompany(db);
  other = {
    company: otherCompany,
    device: await registerDevice(app, otherCompany.admin),
  };
});

const titlesOn = (device: string) =>
  push.state.deliveredTo(device).map(({ title }) => title);

function removeMember(membershipId: string): Promise<Response> {
  return sendJson(
    app,
    `/organizations/${paying.company.organizationId}/members/${membershipId}`,
    paying.company.admin,
    { method: "DELETE" },
  );
}

async function outboxRow(claimId: string) {
  const { rows } = await owner.query<{
    id: string;
    attempts: number;
    last_error: string | null;
    sent_at: Date | null;
    abandoned_at: Date | null;
    device_count: number | null;
    receipts_checked_at: Date | null;
  }>(
    "SELECT id, attempts, last_error, sent_at, abandoned_at, device_count, receipts_checked_at FROM notification_outbox WHERE data->>'claimId' = $1 ORDER BY created_at",
    [claimId],
  );
  return rows;
}

function isStationJob(value: unknown): value is StationJob {
  return (
    typeof value === "object" &&
    value !== null &&
    "lockKey" in value &&
    typeof value.lockKey === "number" &&
    "run" in value
  );
}

function stationJobsIn(module: unknown): StationJob[] {
  if (typeof module !== "object" || module === null) return [];
  return Object.values(module).filter(isStationJob);
}

/** The company's notifications about `claimId`, as if queued or sent earlier. */
async function backdate(
  claimId: string,
  changes: { readonly createdAt?: Date; readonly sentAt?: Date },
): Promise<void> {
  await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .update(notificationOutbox)
        .set(changes)
        .where(sql`${notificationOutbox.data}->>'claimId' = ${claimId}`),
  );
}

async function tokenDisabled(token: string): Promise<boolean> {
  const { rows } = await owner.query<{ disabled_at: Date | null }>(
    "SELECT disabled_at FROM push_tokens WHERE token = $1",
    [token],
  );
  return rows[0]?.disabled_at instanceof Date;
}

describe("each event reaches the right people (spec §6.10)", () => {
  it("tells every admin's phone about a new claim, and nobody else", async () => {
    // #given
    await flow.submit(employee.user);

    // #when
    await deliver();

    // #then
    expect({
      admin: titlesOn(admin.device),
      secondAdmin: titlesOn(secondAdmin.device),
      employee: titlesOn(employee.device),
      otherCompany: titlesOn(other.device),
    }).toEqual({
      admin: ["New claim to approve"],
      secondAdmin: ["New claim to approve"],
      employee: [],
      otherCompany: [],
    });
  });

  it("sends the claim to open, in its company, with the message", async () => {
    // #given
    const claim = await flow.submit(employee.user);

    // #when
    await deliver();

    // #then
    expect(push.state.deliveredTo(admin.device)).toEqual([
      {
        to: admin.device,
        title: "New claim to approve",
        body: "Jane Wanjiku claimed KES 1,500.50 at Java House Westlands.",
        data: {
          type: "claim_submitted",
          organizationId: paying.company.organizationId,
          claimId: claim.id,
        },
      },
    ]);
  });

  it("tells only the employee their claim was rejected, with the reason", async () => {
    // #given
    const claim = await flow.submit(employee.user, "1,500");
    await deliver();
    push.state.reset();
    await flow.reject(claim.id, "The receipt is for a different day");

    // #when
    await deliver();

    // #then
    expect(push.state.delivered.map(({ to, body }) => ({ to, body }))).toEqual([
      {
        to: employee.device,
        body: "Your claim for KES 1,500 at Java House Westlands was rejected: The receipt is for a different day",
      },
    ]);
  });

  it("tells only the employee their claim was paid", async () => {
    // #given
    const claim = await flow.submit(employee.user, "1,500");
    await deliver();
    push.state.reset();
    await flow.pay(claim.id);

    // #when
    await deliver();

    // #then
    expect(push.state.delivered.map(({ to, body }) => ({ to, body }))).toEqual([
      {
        to: employee.device,
        body: "Your claim for KES 1,500 at Java House Westlands was paid.",
      },
    ]);
  });

  it("tells the employee and every admin when the payout fails", async () => {
    // #given
    const claim = await flow.submit(employee.user, "1,500");
    await deliver();
    push.state.reset();
    await flow.failPayout(claim.id);

    // #when
    await deliver();

    // #then
    expect({
      employee: titlesOn(employee.device),
      admin: titlesOn(admin.device),
      secondAdmin: titlesOn(secondAdmin.device),
      otherCompany: titlesOn(other.device),
    }).toEqual({
      employee: ["Claim payment failed"],
      admin: ["Payment failed"],
      secondAdmin: ["Payment failed"],
      otherCompany: [],
    });
  });

  it("reaches every phone a person has signed in on", async () => {
    // #given
    const tablet = await registerDevice(app, employee.user, undefined, "ios");
    const claim = await flow.submit(employee.user);
    await flow.reject(claim.id, "Please attach the eTIMS invoice");

    // #when
    await deliver();

    // #then
    expect({
      phone: titlesOn(employee.device),
      tablet: titlesOn(tablet),
    }).toEqual({ phone: ["Claim rejected"], tablet: ["Claim rejected"] });
  });
});

describe("who gets nothing", () => {
  it("leaves out an admin removed after the claim came in", async () => {
    // #given
    await flow.submit(employee.user);
    expect((await removeMember(secondAdmin.membershipId)).status).toBe(200);

    // #when
    await deliver();

    // #then
    expect({
      removed: titlesOn(secondAdmin.device),
      stillAdmin: titlesOn(admin.device),
    }).toEqual({ removed: [], stillAdmin: ["New claim to approve"] });
  });

  it("leaves out an employee removed after their claim was rejected", async () => {
    // #given
    const claim = await flow.submit(employee.user);
    await flow.reject(claim.id, "Not a business expense");
    expect((await removeMember(employee.membershipId)).status).toBe(200);

    // #when
    await deliver();

    // #then
    expect(titlesOn(employee.device)).toEqual([]);
  });

  it("tells someone only about the company where they hold the role", async () => {
    // #given an admin of company B who is only an employee of company A
    const dual = await createUser(db);
    await addMember(db, paying.company, dual);
    await addMember(db, other.company, dual, { role: "admin" });
    const dualDevice = await registerDevice(app, dual);

    // #when
    await flow.submit(employee.user);
    await deliver();

    // #then
    expect({
      dual: titlesOn(dualDevice),
      otherCompany: titlesOn(other.device),
    }).toEqual({ dual: [], otherCompany: [] });
  });

  it("marks a notification for people with no phone as sent to none", async () => {
    // #given
    const quiet = await flow.employee("Otieno Kamau");
    const claim = await flow.submit(quiet.user);
    await flow.reject(claim.id, "Duplicate of an earlier claim");

    // #when
    await deliver();

    // #then
    const rejected = (await outboxRow(claim.id)).at(-1);
    expect({
      sent: rejected?.sent_at instanceof Date,
      devices: rejected?.device_count,
    }).toEqual({ sent: true, devices: 0 });
  });
});

describe("sending exactly once", () => {
  it("sends once when the job runs twice", async () => {
    // #given
    await flow.submit(employee.user);

    // #when
    await deliver();
    await deliver();

    // #then
    expect(titlesOn(admin.device)).toEqual(["New claim to approve"]);
  });

  it("sends once when two runs overlap", async () => {
    // #given
    await flow.submit(employee.user);
    const release = push.state.hold();

    // #when
    const first = deliver();
    const second = deliver();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([first, second]);

    // #then
    expect(titlesOn(admin.device)).toEqual(["New claim to approve"]);
  });

  it("sends each once when the run crashes partway through and runs again", async () => {
    // #given three claims, and a crash while sending the second's notification
    const claims = [
      await flow.submit(employee.user, "100"),
      await flow.submit(employee.user, "200"),
      await flow.submit(employee.user, "300"),
    ];
    push.state.crashOnSend(2);

    // #when
    await deliver();
    const beforeRetry = push.state.deliveredTo(admin.device).length;
    await deliver();

    // #then
    expect({
      beforeRetry,
      bodies: push.state
        .deliveredTo(admin.device)
        .map(({ data }) => data.claimId)
        .sort(),
    }).toEqual({
      beforeRetry: 1,
      bodies: claims.map(({ id }) => id).sort(),
    });
  });

  it("keeps a notification Expo couldn't take, and sends it on the next run", async () => {
    // #given
    const claim = await flow.submit(employee.user);
    push.state.failNext();

    // #when
    await deliver();
    const afterFailure = (await outboxRow(claim.id))[0];
    await deliver();

    // #then
    expect({
      attempts: afterFailure?.attempts,
      error: afterFailure?.last_error,
      sent: afterFailure?.sent_at,
      delivered: titlesOn(admin.device),
    }).toEqual({
      attempts: 1,
      error: "fake Expo unreachable",
      sent: null,
      delivered: ["New claim to approve"],
    });
  });

  it("drops a notification more than a day old instead of sending it", async () => {
    // #given
    const claim = await flow.submit(employee.user);
    await backdate(claim.id, {
      createdAt: new Date(Date.now() - NOTIFICATION_MAX_AGE_MS - 60_000),
    });

    // #when
    await deliver();

    // #then
    expect({
      abandoned: (await outboxRow(claim.id))[0]?.abandoned_at instanceof Date,
      delivered: push.state.delivered.length,
    }).toEqual({ abandoned: true, delivered: 0 });
  });
});

describe("Expo saying an app is gone (DeviceNotRegistered)", () => {
  it("stops sending to a token Expo refuses as gone", async () => {
    // #given
    push.state.goneOnSend(admin.device);
    const refused = await flow.submit(employee.user);
    await deliver();

    // #when
    await flow.submit(employee.user, "200");
    await deliver();

    // #then
    expect({
      disabled: await tokenDisabled(admin.device),
      handedToExpo: push.state
        .attemptedTo(admin.device)
        .map(({ data }) => data.claimId),
    }).toEqual({ disabled: true, handedToExpo: [refused.id] });
  });

  it("stops sending to a token whose receipt says the app is gone", async () => {
    // #given
    push.state.goneOnReceipt(employee.device);
    const claim = await flow.submit(employee.user);
    await flow.reject(claim.id, "Missing receipt photo");
    await deliver();
    await backdate(claim.id, { sentAt: new Date(Date.now() - 16 * 60_000) });
    await owner.query(
      "UPDATE push_tokens SET last_seen_at = now() - interval '20 minutes' WHERE token = $1",
      [employee.device],
    );

    // #when
    await runtime.runPromise(checkPushReceipts(10_000));

    // #then
    expect({
      disabled: await tokenDisabled(employee.device),
      checked: (await outboxRow(claim.id)).every(
        ({ receipts_checked_at }) => receipts_checked_at instanceof Date,
      ),
    }).toEqual({ disabled: true, checked: true });
  });

  it("keeps a token the app registered again after the message was sent", async () => {
    // #given
    push.state.goneOnReceipt(employee.device);
    const claim = await flow.submit(employee.user);
    await flow.reject(claim.id, "Missing receipt photo");
    await deliver();
    await backdate(claim.id, { sentAt: new Date(Date.now() - 16 * 60_000) });
    await owner.query(
      "UPDATE push_tokens SET last_seen_at = now() - interval '20 minutes' WHERE token = $1",
      [employee.device],
    );
    await registerDevice(app, employee.user, employee.device);

    // #when
    await runtime.runPromise(checkPushReceipts(10_000));

    // #then
    expect(await tokenDisabled(employee.device)).toBe(false);
  });

  it("doesn't ask for receipts before Expo has them", async () => {
    // #given
    const claim = await flow.submit(employee.user);
    await deliver();

    // #when
    await runtime.runPromise(checkPushReceipts(10_000));

    // #then
    expect({
      asked: push.state.receiptRequests.length,
      checked: (await outboxRow(claim.id))[0]?.receipts_checked_at,
    }).toEqual({ asked: 0, checked: null });
  });
});

describe("a phone that changes hands", () => {
  it("sends to whoever signed in on it last, not the person before", async () => {
    // #given the second admin signs in on the employee's phone
    await registerDevice(app, secondAdmin.user, employee.device);
    const claim = await flow.submit(employee.user);
    await flow.reject(claim.id, "Wrong category");

    // #when
    await deliver();

    // #then
    expect(titlesOn(employee.device)).toEqual(["New claim to approve"]);
  });
});

describe("the station jobs", () => {
  it("each take their own advisory lock", async () => {
    // #given every job in src/station, whoever added it
    const stationDir = path.join(SRC_DIR, "station");
    const jobs: StationJob[] = [];
    for (const file of readdirSync(stationDir)) {
      if (!file.endsWith(".ts")) continue;
      const exported: unknown = await import(path.join(stationDir, file));
      jobs.push(...stationJobsIn(exported));
    }
    const keys = jobs.map((job) => job.lockKey);

    // #then
    expect(jobs.length).toBeGreaterThan(5);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns idle when nothing is waiting, so the station doesn't log it", async () => {
    // #given
    await deliver();

    // #when
    const result = await runtime.runPromise(pushNotificationsJob.run);

    // #then
    expect(result).toBe(IDLE);
  });

  it("leaves a sent notification's row as the record of it", async () => {
    // #given
    const claim = await flow.submit(employee.user);

    // #when
    await deliver();

    // #then
    const id = (await outboxRow(claim.id))[0]?.id ?? "";
    const [row] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({
            deviceCount: notificationOutbox.deviceCount,
            attempts: notificationOutbox.attempts,
          })
          .from(notificationOutbox)
          .where(eq(notificationOutbox.id, id)),
    );
    expect(row).toEqual({ deviceCount: 2, attempts: 1 });
  });
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { DatabaseService } from "../../db/client.js";
import { webauthnChallenges } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startApproval,
  startPasskeyEnrolment,
  verifyApproval,
} from "../../services/approval/passkeys.js";
import { createCompany } from "../helpers/db.js";
import { TEST_ORIGIN } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let passkey: SoftwarePasskey;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

async function enrol(userId: string, key: SoftwarePasskey): Promise<void> {
  const options = await runtime.runPromise(startPasskeyEnrolment(userId));
  await runtime.runPromise(
    finishPasskeyEnrolment(userId, key.register(options, TEST_ORIGIN)),
  );
}

async function challengeFor(intentHash = "intent-a", userId?: string) {
  return runtime.runPromise(
    startApproval({
      organizationId: company.organizationId,
      userId: userId ?? company.admin.id,
      purpose: "approve_payouts",
      intentHash,
      payoutIds: [randomUUID()],
    }),
  );
}

function verify(
  challengeId: string,
  response: ReturnType<SoftwarePasskey["sign"]>,
  userId = company.admin.id,
) {
  return runtime.runPromiseExit(
    verifyApproval({
      organizationId: company.organizationId,
      userId,
      purpose: "approve_payouts",
      challengeId,
      response,
    }),
  );
}

const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? (
        Option.getOrNull(Cause.failureOption(exit.cause)) as {
          _tag?: string;
        } | null
      )?._tag
    : "succeeded";

beforeEach(async () => {
  company = await createCompany(db);
  passkey = SoftwarePasskey.create();
  await enrol(company.admin.id, passkey);
});

describe("approval passkeys", () => {
  it("approves with the enrolled passkey and returns what was approved", async () => {
    // #given
    const { challengeId, options } = await challengeFor("intent-a");

    // #when
    const exit = await verify(challengeId, passkey.sign(options, TEST_ORIGIN));

    // #then
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      approvalId: challengeId,
      intentHash: "intent-a",
    });
  });

  it("can't use a challenge twice", async () => {
    // #given
    const { challengeId, options } = await challengeFor();
    await verify(challengeId, passkey.sign(options, TEST_ORIGIN));

    // #when
    const again = await verify(challengeId, passkey.sign(options, TEST_ORIGIN));

    // #then
    expect(failureTag(again)).toBe("Forbidden");
  });

  it("spends the challenge even when the signature is bad", async () => {
    // #given
    const { challengeId, options } = await challengeFor();
    const impostor = SoftwarePasskey.restore({
      ...SoftwarePasskey.create().toJSON(),
      credentialId: passkey.credentialId,
    });
    await verify(challengeId, impostor.sign(options, TEST_ORIGIN));

    // #when the real passkey tries the same challenge
    const retry = await verify(challengeId, passkey.sign(options, TEST_ORIGIN));

    // #then
    expect(failureTag(retry)).toBe("Forbidden");
  });

  it("rejects a signature from a different key under the same credential ID", async () => {
    // #given
    const { challengeId, options } = await challengeFor();
    const impostor = SoftwarePasskey.restore({
      ...SoftwarePasskey.create().toJSON(),
      credentialId: passkey.credentialId,
    });

    // #when
    const exit = await verify(challengeId, impostor.sign(options, TEST_ORIGIN));

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("rejects a signature over a different challenge", async () => {
    // #given
    const first = await challengeFor("intent-a");
    const second = await challengeFor("intent-b");

    // #when the first challenge is presented with a signature for the second
    const exit = await verify(
      first.challengeId,
      passkey.sign(second.options, TEST_ORIGIN),
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("rejects an expired challenge", async () => {
    // #given
    const { challengeId, options } = await challengeFor();
    await runInScope(
      db,
      { organizationId: company.organizationId, userId: company.admin.id },
      (tx) =>
        tx
          .update(webauthnChallenges)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(webauthnChallenges.id, challengeId)),
    );

    // #when
    const exit = await verify(challengeId, passkey.sign(options, TEST_ORIGIN));

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("rejects a signature made for another origin", async () => {
    // #given
    const { challengeId, options } = await challengeFor();

    // #when
    const exit = await verify(
      challengeId,
      passkey.sign(options, "https://evil.example"),
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("rejects a cloned authenticator whose counter went backwards", async () => {
    // #given a copy taken before the real passkey was used
    const clone = SoftwarePasskey.restore(passkey.toJSON());
    const first = await challengeFor();
    await verify(first.challengeId, passkey.sign(first.options, TEST_ORIGIN));
    const second = await challengeFor();

    // #when
    const exit = await verify(
      second.challengeId,
      clone.sign(second.options, TEST_ORIGIN),
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("won't let another user use the admin's challenge", async () => {
    // #given
    const other = await createCompany(db);
    const otherKey = SoftwarePasskey.create();
    await enrol(other.admin.id, otherKey);
    const { challengeId, options } = await challengeFor();

    // #when
    const exit = await verify(
      challengeId,
      otherKey.sign(options, TEST_ORIGIN),
      other.admin.id,
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("refuses to start an approval for someone without a passkey", async () => {
    // #given
    const fresh = await createCompany(db);

    // #when
    const exit = await runtime.runPromiseExit(
      startApproval({
        organizationId: fresh.organizationId,
        userId: fresh.admin.id,
        purpose: "approve_payouts",
        intentHash: "intent",
        payoutIds: [randomUUID()],
      }),
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("enrols only a first passkey; a second needs support", async () => {
    // #when
    const exit = await runtime.runPromiseExit(
      startPasskeyEnrolment(company.admin.id),
    );

    // #then
    expect(failureTag(exit)).toBe("Forbidden");
  });

  it("stores challenges only for their own user", async () => {
    // #given
    await challengeFor();
    const other = await createCompany(db);

    // #when
    const visible = await runInScope(
      db,
      { organizationId: company.organizationId, userId: other.admin.id },
      (tx) =>
        tx
          .select({ id: webauthnChallenges.id })
          .from(webauthnChallenges)
          .where(
            and(eq(webauthnChallenges.organizationId, company.organizationId)),
          ),
    );

    // #then
    expect(visible).toEqual([]);
  });
});

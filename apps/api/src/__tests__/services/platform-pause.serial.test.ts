import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { makeFakePaycrest, makeFakePrivyWallets } from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The platform-wide pause stops every company's payouts, so this runs
 * apart from the main suite (vitest.serial.config.ts).
 */
const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await owner.query("UPDATE platform_settings SET payouts_paused = false");
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
});

describe("the platform-wide payout pause", () => {
  it("rejects every company's payouts, with no order created", async () => {
    // #given
    await owner.query("UPDATE platform_settings SET payouts_paused = true");

    try {
      // #when
      const attempt = payClaims(runtime, db, paying, [claimRequest()]);

      // #then
      await expect(attempt).rejects.toThrow("Payouts are paused");
      expect(paycrest.state.created).toHaveLength(0);
    } finally {
      await owner.query("UPDATE platform_settings SET payouts_paused = false");
    }
  });

  it("pays again once lifted", async () => {
    // #when
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);

    // #then
    expect(payout?.status).toBe("paying");
  });
});

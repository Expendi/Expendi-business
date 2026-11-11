import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PayeeChain } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { NewPayee } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { payees, withdrawalAddresses } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { createCompany } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

const baseAddress = () => `0x${randomBytes(20).toString("hex")}`;
const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const VALID: readonly (readonly [string, PayeeChain, string])[] = [
  ["a Base address in lowercase", "base", `0x${"ab".repeat(20)}`],
  ["a NEAR implicit account", "near", "ab".repeat(32)],
  ["a named NEAR account", "near", "payroll.acme-ltd.near"],
  ["the shortest NEAR account", "near", "ab"],
  ["a Solana address", "solana", SOLANA_ADDRESS],
  ["a Solana address of 32 zero bytes", "solana", "1".repeat(32)],
];

const INVALID: readonly (readonly [string, PayeeChain, string])[] = [
  ["a Base address in mixed case", "base", `0x${"aB".repeat(20)}`],
  ["a Base address that is too short", "base", `0x${"ab".repeat(19)}`],
  ["a NEAR account filed under Base", "base", "acme.near"],
  ["a NEAR account with a capital", "near", "Acme.near"],
  ["a NEAR account of one character", "near", "a"],
  ["a NEAR account of 65 characters", "near", "a".repeat(65)],
  ["a NEAR account with two dots", "near", "acme..near"],
  ["a NEAR account with a line break after it", "near", "acme.near\n"],
  ["a Solana address filed under NEAR", "near", SOLANA_ADDRESS],
  ["a Solana address with a 0 in it", "solana", `0${SOLANA_ADDRESS.slice(1)}`],
  ["a Solana address that is too long", "solana", "2".repeat(45)],
  ["a Base address filed under Solana", "solana", `0x${"ab".repeat(20)}`],
];

function allow(
  company: TestCompany,
  chain: PayeeChain,
  address: string,
  removedAt: Date | null = null,
) {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .insert(withdrawalAddresses)
      .values({
        organizationId: company.organizationId,
        chain,
        address,
        label: "Treasury",
        addedBy: company.admin.id,
        confirmedAt: new Date(),
        removedAt,
      })
      .returning(),
  );
}

function usdcPayee(
  company: TestCompany,
  overrides: Partial<NewPayee> = {},
): NewPayee {
  return {
    organizationId: company.organizationId,
    kind: "vendor",
    name: "Cloud host",
    method: "usdc",
    usdcChain: "base",
    usdcAddress: baseAddress(),
    detailsChangedAt: new Date(),
    ...overrides,
  };
}

const insertPayee = (company: TestCompany, row: NewPayee) =>
  runInScope(
    db,
    { organizationId: company.organizationId, role: "admin" },
    (tx) => tx.insert(payees).values(row).returning(),
  );

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("withdrawal_addresses", () => {
  it.each(VALID)("lists %s", async (_name, chain, address) => {
    // #given
    const company = await createCompany(db);

    // #when
    const [row] = await allow(company, chain, address);

    // #then
    expect(row).toMatchObject({ chain, address });
  });

  it.each(INVALID)("rejects %s", async (_name, chain, address) => {
    // #given
    const company = await createCompany(db);

    // #when
    const insert = allow(company, chain, address);

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "withdrawal_addresses_address_matches_chain" },
    });
  });

  it("lists an address once per chain", async () => {
    // #given
    const company = await createCompany(db);
    await allow(company, "near", "acme.near");

    // #when
    const again = allow(company, "near", "acme.near");

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "withdrawal_addresses_active_unique" },
    });
  });

  it("lists the same characters again on another chain", async () => {
    // #given a 0x address is also a valid NEAR account ID
    const company = await createCompany(db);
    const address = baseAddress();
    await allow(company, "base", address);

    // #when
    const [onNear] = await allow(company, "near", address);

    // #then
    expect(onNear).toMatchObject({ chain: "near", address });
  });

  it("lists two Solana addresses that differ only by case", async () => {
    // #given
    const company = await createCompany(db);
    await allow(company, "solana", SOLANA_ADDRESS);

    // #when
    const [other] = await allow(
      company,
      "solana",
      SOLANA_ADDRESS.toLowerCase().replaceAll("l", "L"),
    );

    // #then
    expect(other?.address).not.toBe(SOLANA_ADDRESS);
  });

  it("lists an address again once it was removed", async () => {
    // #given
    const company = await createCompany(db);
    await allow(company, "near", "acme.near", new Date());

    // #when
    const [again] = await allow(company, "near", "acme.near");

    // #then
    expect(again?.removedAt).toBeNull();
  });
});

describe("a USDC payee's address", () => {
  it.each(VALID)("saves %s", async (_name, usdcChain, usdcAddress) => {
    // #given
    const company = await createCompany(db);

    // #when
    const [payee] = await insertPayee(
      company,
      usdcPayee(company, { usdcChain, usdcAddress }),
    );

    // #then
    expect(payee).toMatchObject({ usdcChain, usdcAddress });
  });

  it.each(INVALID)("rejects %s", async (_name, usdcChain, usdcAddress) => {
    // #given
    const company = await createCompany(db);

    // #when
    const insert = insertPayee(
      company,
      usdcPayee(company, { usdcChain, usdcAddress }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "payees_usdc_address_matches_chain" },
    });
  });

  it("rejects an address without its chain", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const insert = insertPayee(
      company,
      usdcPayee(company, { usdcChain: null }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "payees_usdc_chain_with_address" },
    });
  });

  it("rejects a chain on a payee who isn't paid in USDC", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const insert = insertPayee(company, {
      organizationId: company.organizationId,
      kind: "supplier",
      name: "Mama Mboga",
      method: "mpesa_till",
      tillNumber: "123456",
      accountName: "Mama Mboga",
      usdcChain: "near",
      detailsChangedAt: new Date(),
    });

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "payees_usdc_chain_with_address" },
    });
  });

  it("rejects a USDC payee with no address", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const insert = insertPayee(
      company,
      usdcPayee(company, { usdcChain: null, usdcAddress: null }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "payees_usdc_details" },
    });
  });
});

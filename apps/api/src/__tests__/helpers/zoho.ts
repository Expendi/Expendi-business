import { randomUUID } from "node:crypto";

import type { ZohoMapping } from "@expendi-business/shared";
import { zohoConnectLinkResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { TestCompany } from "./db.js";
import type { makeFakeZoho } from "./fakes.js";
import type { TestStaff } from "./staff.js";
import { FAKE_ZOHO_ACCOUNTS_SERVER } from "./fakes.js";
import { bearer } from "./runtime.js";

/** The fake's KES organization. */
export const ZOHO_KES_ORGANIZATION = "60001";

type FakeZoho = ReturnType<typeof makeFakeZoho>;

export const zohoStaffPath = (company: TestCompany, suffix = ""): string =>
  `/internal/companies/${company.organizationId}/zoho${suffix}`;

export async function staffRequest(
  app: App,
  staff: Pick<TestStaff, "privyUserId">,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly data: unknown }> {
  const response = await app.request(path, {
    method,
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json()) as { data?: unknown };
  return { status: response.status, data: parsed.data ?? null };
}

async function expectStatus(
  reply: Promise<{ readonly status: number }>,
  expected: number,
  what: string,
): Promise<void> {
  const { status } = await reply;
  if (status !== expected) throw new Error(`${what} answered ${status}`);
}

/**
 * Staff send a connect link and its owner finishes the Zoho sign-in, as
 * T30 does it. A connection that already has an organization comes back
 * `active` (a reconnect); a new one stays `pending` until one is chosen.
 */
export async function signInToZoho(
  app: App,
  staff: TestStaff,
  company: TestCompany,
): Promise<void> {
  const link = await staffRequest(
    app,
    staff,
    "POST",
    zohoStaffPath(company, "/connect-link"),
  );
  if (link.status !== 201) {
    throw new Error(`connect link answered ${link.status}`);
  }
  const { url } = zohoConnectLinkResponseSchema.parse(link.data);
  const opened = await app.request(
    `/integrations/zoho/connect?${new URL(url).searchParams.toString()}`,
  );
  const location = opened.headers.get("location");
  const state = location ? new URL(location).searchParams.get("state") : null;
  if (!state) throw new Error(`connect page answered ${opened.status}`);
  const callback = await app.request(
    `/integrations/zoho/callback?${new URLSearchParams({
      code: `1000.${randomUUID()}`,
      state,
      location: "eu",
      "accounts-server": FAKE_ZOHO_ACCOUNTS_SERVER,
    }).toString()}`,
  );
  if (callback.status !== 200) {
    throw new Error(`Zoho callback answered ${callback.status}`);
  }
}

/** Picks the KES organization and saves the account mapping. */
export async function finishZohoSetUp(
  app: App,
  staff: TestStaff,
  company: TestCompany,
  mapping: ZohoMapping,
): Promise<void> {
  await expectStatus(
    staffRequest(app, staff, "POST", zohoStaffPath(company, "/organization"), {
      externalOrganizationId: ZOHO_KES_ORGANIZATION,
    }),
    200,
    "choosing the organization",
  );
  await expectStatus(
    staffRequest(
      app,
      staff,
      "PUT",
      zohoStaffPath(company, "/mapping"),
      mapping,
    ),
    200,
    "saving the mapping",
  );
}

export async function connectZoho(
  app: App,
  staff: TestStaff,
  company: TestCompany,
  mapping: ZohoMapping,
): Promise<void> {
  await signInToZoho(app, staff, company);
  await finishZohoSetUp(app, staff, company, mapping);
}

/** The person revokes Expendi's access in Zoho: every token stops working. */
export function revokeZohoAccess(zoho: FakeZoho): void {
  for (const token of zoho.state.issuedRefreshTokens) {
    zoho.state.revokedTokens.add(token);
  }
  for (const token of zoho.state.issuedAccessTokens) {
    zoho.state.refusedAccessTokens.add(token);
  }
}

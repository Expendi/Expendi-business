/** DEV PREVIEW — the signed-in people and company the fixtures belong to. */
import type { MembershipRole, MeResponse } from "@expendi-business/shared";

import type {
  Company,
  CompanyContextValue,
} from "~/features/company/company-provider";

export const PREVIEW_ORG_ID = "0b6f6a4e-3c1d-4d7e-9a51-2f7c8e1d0a01";

const PEOPLE: Record<"admin" | "member", MeResponse["user"]> = {
  admin: {
    id: "6a0c1f8e-2b7d-4e59-8c3a-1d9e7f5b2a01",
    email: "wanjiru@mawingulabs.co.ke",
    phone: "+254712000111",
    fullName: "Wanjiru Kamau",
  },
  member: {
    id: "6a0c1f8e-2b7d-4e59-8c3a-1d9e7f5b2a02",
    email: "brian@mawingulabs.co.ke",
    phone: "+254712345418",
    fullName: "Brian Otieno",
  },
};

export function previewSession(role: MembershipRole): CompanyContextValue {
  const user = role === "admin" ? PEOPLE.admin : PEOPLE.member;
  const company: Company = {
    organizationId: PREVIEW_ORG_ID,
    name: "Mawingu Labs Ltd",
    role,
  };
  const me: MeResponse = {
    user,
    memberships: [
      {
        id: "9d2e4c1a-7b3f-4a6e-8d5c-0f1e2a3b4c01",
        organizationId: PREVIEW_ORG_ID,
        organizationName: company.name,
        role,
        status: "active",
      },
    ],
  };
  return {
    state: { status: "ready", me, companies: [company], company },
    selectCompany: () => undefined,
    retry: () => undefined,
  };
}

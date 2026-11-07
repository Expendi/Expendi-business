import type { QueryClient } from "@tanstack/react-query";

import type { MembersResponse, MeResponse } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { COMPANY_NAME, ORGANIZATION_ID, sampleId, VIEWER } from "./company";

/** Wanjiru's membership: the `/me` id that marks "You" on Team. */
export const VIEWER_MEMBERSHIP_ID = sampleId(9101);

/** `GET …/members`, as in docs/mocks/team.html. Removed people aren't listed. */
export const MEMBERS: MembersResponse = [
  {
    id: VIEWER_MEMBERSHIP_ID,
    name: "Wanjiru Kamau",
    email: "wanjiru@mwangaza.co.ke",
    role: "admin",
    status: "active",
    invitedAt: null,
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9102),
    name: "Faith Wambui",
    email: "faith@mwangaza.co.ke",
    role: "admin",
    status: "active",
    invitedAt: "2026-03-09T06:05:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9103),
    name: "Brian Otieno",
    email: "brian@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-03-09T06:12:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9104),
    name: "Kevin Mwangi",
    email: "kevin@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-03-09T06:14:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9105),
    name: "Grace Achieng",
    email: "grace@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-03-10T05:40:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9106),
    name: "Daniel Kiprop",
    email: "daniel@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-04-02T07:00:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9107),
    name: "Peter Njoroge",
    email: "peter@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-06-15T08:25:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: sampleId(9108),
    name: "Amina Hassan",
    email: "amina@mwangaza.co.ke",
    role: "employee",
    status: "active",
    invitedAt: "2026-10-27T08:20:00.000Z",
    payoutPhoneConfirmed: false,
  },
  {
    id: sampleId(9109),
    name: "Lucy Mutua",
    email: "lucy@mutuaassociates.co.ke",
    role: "accountant",
    status: "active",
    invitedAt: "2026-03-12T09:30:00.000Z",
    payoutPhoneConfirmed: false,
  },
  {
    id: sampleId(9110),
    name: "Mercy Chebet",
    email: "mercy@mwangaza.co.ke",
    role: "employee",
    status: "invited",
    invitedAt: "2026-11-04T07:12:00.000Z",
    payoutPhoneConfirmed: false,
  },
  {
    id: sampleId(9111),
    name: "Samuel Ouma",
    email: "samuel.ouma@gmail.com",
    role: "employee",
    status: "invited",
    invitedAt: "2026-10-21T13:40:00.000Z",
    payoutPhoneConfirmed: false,
  },
];

/** `GET /me` for the preview's signed-in admin. */
export const ME: MeResponse = {
  user: {
    id: VIEWER.userId,
    email: VIEWER.email,
    phone: null,
    fullName: VIEWER.name,
  },
  memberships: [
    {
      id: VIEWER_MEMBERSHIP_ID,
      organizationId: ORGANIZATION_ID,
      organizationName: COMPANY_NAME,
      role: "admin",
      status: "active",
    },
  ],
};

export function seedTeam(client: QueryClient): void {
  client.setQueryData(queryKeys.members(ORGANIZATION_ID), MEMBERS);
  client.setQueryData(queryKeys.me("preview"), ME);
}

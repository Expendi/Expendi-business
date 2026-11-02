import { z } from "zod";

import {
  MEMBERSHIP_ROLES,
  membershipRoleSchema,
  membershipStatusSchema,
} from "./membership.js";

export const MEMBER_NAME_MAX_LENGTH = 120;

const enterName = "Enter the person's full name.";

export const inviteMemberRequestSchema = z.object({
  email: z
    .string({ error: "Enter the person's email address." })
    .trim()
    .toLowerCase()
    .pipe(z.email("That isn't a valid email address.")),
  /** Paycrest needs the recipient's name to pay them (spec §6.2). */
  fullName: z
    .string({ error: enterName })
    .trim()
    .min(1, enterName)
    .max(
      MEMBER_NAME_MAX_LENGTH,
      `Keep the name to ${MEMBER_NAME_MAX_LENGTH} characters or fewer.`,
    ),
  role: z.enum(MEMBERSHIP_ROLES, {
    error: "Pick a role: admin, employee or accountant.",
  }),
});

/** What the app sends; the API trims both fields and lowercases the email. */
export type InviteMemberRequest = z.input<typeof inviteMemberRequestSchema>;

/** An accountant stays an accountant; only these roles can be switched. */
export const ASSIGNABLE_ROLES = ["admin", "employee"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const updateMemberRequestSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES, {
    error: "Pick a role: admin or employee.",
  }),
});

export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

export const memberSchema = z.object({
  /** The membership's ID, used in `/members/:membershipId`. */
  id: z.uuid(),
  /** Null when nobody has given this person's name yet. */
  name: z.string().nullable(),
  email: z.string(),
  role: membershipRoleSchema,
  status: membershipStatusSchema,
  /** The latest invite; null for the admin who created the company. */
  invitedAt: z.iso.datetime().nullable(),
  /** Whether they've confirmed an M-Pesa payout number; the number itself is never shown. */
  payoutPhoneConfirmed: z.boolean(),
});

export type Member = z.infer<typeof memberSchema>;

/** The company's active and invited people. */
export const membersResponseSchema = z.array(memberSchema);

export type MembersResponse = z.infer<typeof membersResponseSchema>;

export const inviteMemberResponseSchema = z.object({
  member: memberSchema,
  /**
   * Whether the invite email went out: the app's install link, or for an
   * accountant the web dashboard's link (`WEB_DASHBOARD_URL`). False when
   * sending failed: the invite stands either way.
   */
  emailSent: z.boolean(),
  /**
   * The app's install link (`APP_INSTALL_URL`), for the admin to share when
   * the email didn't go out; null when the API has none configured.
   */
  installUrl: z.url().nullable(),
});

export type InviteMemberResponse = z.infer<typeof inviteMemberResponseSchema>;

import { z } from "zod";

import {
  passkeyAssertionSchema,
  passkeyRequestOptionsSchema,
} from "./approval.js";

/** Who a payee is (spec §6.19). Employee payees are linked to their membership. */
export const PAYEE_KINDS = [
  "employee",
  "personnel",
  "supplier",
  "vendor",
  "statutory",
] as const;
export const payeeKindSchema = z.enum(PAYEE_KINDS, {
  error:
    "Pick who this payee is: employee, personnel, supplier, vendor or statutory body.",
});
export type PayeeKind = z.infer<typeof payeeKindSchema>;

/**
 * How a payee is paid (spec §6.19). `outside` is for payees Expendi can't
 * pay, such as card-only subscriptions: they get reminders only.
 */
export const PAYEE_METHODS = [
  "mpesa_phone",
  "mpesa_till",
  "mpesa_paybill",
  "bank",
  "usdc",
  "outside",
] as const;
export const payeeMethodSchema = z.enum(PAYEE_METHODS, {
  error: "Choose how this payee is paid.",
});
export type PayeeMethod = z.infer<typeof payeeMethodSchema>;

/**
 * Employees are paid only to their confirmed M-Pesa number, or to a bank
 * account an admin adds for them (spec §6.19).
 */
export const EMPLOYEE_PAYEE_METHODS = [
  "mpesa_phone",
  "bank",
  "outside",
] as const satisfies readonly PayeeMethod[];

/**
 * After a payee's payment details change, paying them needs a second
 * confirmation for this long (spec §6.19, §7).
 */
export const PAYEE_CHANGE_HOLD_HOURS = 24;

export const PAYEE_NAME_MAX_LENGTH = 120;
export const PAYEE_ACCOUNT_NAME_MAX_LENGTH = 160;
export const PAYBILL_ACCOUNT_REFERENCE_MAX_LENGTH = 30;

const withoutSpaces = (value: string) => value.replace(/\s+/g, "");

const enterName = "Enter the payee's name.";
const payeeName = z
  .string({ error: enterName })
  .trim()
  .min(1, enterName)
  .max(
    PAYEE_NAME_MAX_LENGTH,
    `Keep the name to ${PAYEE_NAME_MAX_LENGTH} characters or fewer.`,
  );

/** Paycrest needs the account holder's name for every KES payment. */
const enterAccountName = "Enter the name on the account.";
const accountName = z
  .string({ error: enterAccountName })
  .trim()
  .min(1, enterAccountName)
  .max(
    PAYEE_ACCOUNT_NAME_MAX_LENGTH,
    `Keep the account name to ${PAYEE_ACCOUNT_NAME_MAX_LENGTH} characters or fewer.`,
  );

const shortCode = (label: string) =>
  z
    .string({ error: `Enter the ${label} number.` })
    .overwrite(withoutSpaces)
    .regex(/^\d{5,7}$/, `A ${label} number is 5 to 7 digits.`);

const enterAccountReference = "Enter the Paybill account number.";

/**
 * A payee's payment details, by method. The API normalises them further:
 * an M-Pesa number to E.164, a USDC address to lowercase, and it checks
 * the bank against Paycrest's list and the address against the company's
 * allowlist.
 */
export const payeeDetailsSchema = z.discriminatedUnion(
  "method",
  [
    z.object({
      method: z.literal("mpesa_phone"),
      /**
       * Left out for employees: they're paid to the number they confirmed
       * by SMS (spec §6.18), looked up when they're paid.
       */
      phone: z
        .string({ error: "Enter the M-Pesa number." })
        .trim()
        .min(1, "Enter the M-Pesa number.")
        .optional(),
      accountName,
    }),
    z.object({
      method: z.literal("mpesa_till"),
      tillNumber: shortCode("Till"),
      accountName,
    }),
    z.object({
      method: z.literal("mpesa_paybill"),
      paybillNumber: shortCode("Paybill"),
      accountReference: z
        .string({ error: enterAccountReference })
        .trim()
        .min(1, enterAccountReference)
        .max(
          PAYBILL_ACCOUNT_REFERENCE_MAX_LENGTH,
          `A Paybill account number is at most ${PAYBILL_ACCOUNT_REFERENCE_MAX_LENGTH} characters.`,
        ),
      accountName,
    }),
    z.object({
      method: z.literal("bank"),
      /** A `code` from `GET /organizations/:id/payees/banks`. */
      bankCode: z
        .string({ error: "Choose the bank." })
        .trim()
        .min(1, "Choose the bank."),
      accountNumber: z
        .string({ error: "Enter the bank account number." })
        .overwrite(withoutSpaces)
        .regex(
          /^[0-9A-Za-z]{5,20}$/,
          "A bank account number is 5 to 20 letters and digits.",
        ),
      accountName,
    }),
    z.object({
      method: z.literal("usdc"),
      /** A Base address already on the company's allowlist. */
      address: z
        .string({ error: "Enter the Base address." })
        .trim()
        .regex(/^0x[0-9a-fA-F]{40}$/, "That isn't a Base address."),
    }),
    z.object({ method: z.literal("outside") }),
  ],
  { error: "Choose how this payee is paid." },
);

export type PayeeDetails = z.output<typeof payeeDetailsSchema>;
export type PayeeDetailsInput = z.input<typeof payeeDetailsSchema>;

export const createPayeeRequestSchema = z.object({
  kind: payeeKindSchema,
  name: payeeName,
  /** Employees only: their membership in this company. */
  membershipId: z.uuid("Choose the employee.").optional(),
  /** Leave out to add the payee now and its payment details later. */
  details: payeeDetailsSchema.nullish(),
});

export type CreatePayeeRequest = z.input<typeof createPayeeRequestSchema>;

/** Name and kind only; payment details change through `/details`. */
export const updatePayeeRequestSchema = z
  .object({
    name: payeeName.optional(),
    kind: payeeKindSchema.optional(),
  })
  .refine(
    (update) => update.name !== undefined || update.kind !== undefined,
    "Change the name or the kind.",
  );

export type UpdatePayeeRequest = z.input<typeof updatePayeeRequestSchema>;

export const changePayeeDetailsRequestSchema = z.object({
  details: payeeDetailsSchema,
});

export type ChangePayeeDetailsRequest = z.input<
  typeof changePayeeDetailsRequestSchema
>;

/** What the admin's passkey confirms: a new payee, or new payment details. */
export const payeeChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    payee: createPayeeRequestSchema,
  }),
  z.object({
    action: z.literal("change_details"),
    payeeId: z.uuid(),
    details: payeeDetailsSchema,
  }),
]);

export type PayeeChange = z.output<typeof payeeChangeSchema>;

/**
 * `POST …/payees/changes/:challengeId/confirm`: the change exactly as the
 * challenge returned it, with the approval passkey's assertion.
 */
export const confirmPayeeChangeRequestSchema = z.object({
  change: payeeChangeSchema,
  response: passkeyAssertionSchema,
});

export type ConfirmPayeeChangeRequest = z.input<
  typeof confirmPayeeChangeRequestSchema
>;

export const payeeSchema = z.object({
  id: z.uuid(),
  kind: payeeKindSchema,
  name: z.string(),
  /** Employee payees' membership; null for everyone else. */
  membershipId: z.uuid().nullable(),
  /** Null until payment details are added. */
  details: payeeDetailsSchema.nullable(),
  /**
   * Employee payees only: whether they've confirmed an M-Pesa number. The
   * number itself is never shown. Null for other payees.
   */
  payoutPhoneConfirmed: z.boolean().nullable(),
  detailsChangedAt: z.iso.datetime().nullable(),
  /**
   * Until this time, paying the payee needs a second confirmation because
   * its details changed recently; null when it doesn't.
   */
  secondConfirmationUntil: z.iso.datetime().nullable(),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Payee = z.infer<typeof payeeSchema>;

export const payeesResponseSchema = z.array(payeeSchema);

export type PayeesResponse = z.infer<typeof payeesResponseSchema>;

/** `GET …/payees` filters; archived payees are left out unless asked for. */
export const listPayeesQuerySchema = z.object({
  kind: payeeKindSchema.optional(),
  method: payeeMethodSchema.optional(),
  archived: z
    .enum(["true", "false"], { error: "archived is true or false." })
    .transform((value) => value === "true")
    .optional(),
});

export type ListPayeesQuery = z.input<typeof listPayeesQuerySchema>;

/** A passkey confirmation the admin must give before the change applies. */
export const payeeChangeChallengeSchema = z.object({
  status: z.literal("confirmation_required"),
  challengeId: z.uuid(),
  options: passkeyRequestOptionsSchema,
  /** Send this back unchanged with the passkey's response. */
  change: payeeChangeSchema,
});

export type PayeeChangeChallenge = z.infer<typeof payeeChangeChallengeSchema>;

/**
 * `POST …/payees`: created at once without payment details or when paid
 * outside Expendi; otherwise waiting for the admin's passkey.
 */
export const createPayeeResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), payee: payeeSchema }),
  payeeChangeChallengeSchema,
]);

export type CreatePayeeResponse = z.infer<typeof createPayeeResponseSchema>;

/** Kenyan banks Paycrest can pay, for the bank picker. */
export const payeeBanksResponseSchema = z.array(
  z.object({ code: z.string(), name: z.string() }),
);

export type PayeeBanksResponse = z.infer<typeof payeeBanksResponseSchema>;

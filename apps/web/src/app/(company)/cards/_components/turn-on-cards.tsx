"use client";

import type { HTMLInputTypeAttribute, JSX, ReactNode } from "react";
import { useId, useState } from "react";

import type { TurnOnCardsFields } from "@expendi-business/shared";
import { turnOnCardsRequestSchema } from "@expendi-business/shared";

import type { FieldErrors } from "~/app/(company)/payroll/_components/sheet-parts";
import {
  errorsByField,
  focusFirstError,
} from "~/app/(company)/payroll/_components/sheet-parts";
import { Banner } from "~/components/data/banner";
import { Callout, SectionLabel } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { FieldRow, FormField, SheetForm } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { useTurnOnCards } from "./cards-api";

type FieldName = keyof TurnOnCardsFields;

interface FieldSpec {
  readonly name: FieldName;
  readonly label: string;
  readonly help?: string;
  readonly type?: HTMLInputTypeAttribute;
  readonly autoComplete: string;
  readonly placeholder?: string;
}

const phoneHelp = "With its country code.";

/** Each inner list is one row of the form; two fields share a row. */
const COMPANY_ROWS: readonly (readonly FieldSpec[])[] = [
  [
    {
      name: "legalName",
      label: "Registered company name",
      autoComplete: "organization",
    },
  ],
  [
    {
      name: "kraPin",
      label: "KRA PIN",
      autoComplete: "off",
      placeholder: "P051234567X",
    },
    {
      name: "phone",
      label: "Company phone",
      type: "tel",
      autoComplete: "tel",
      placeholder: "+254712345678",
      help: phoneHelp,
    },
  ],
  [
    {
      name: "addressLine1",
      label: "Street address",
      autoComplete: "street-address",
    },
  ],
  [
    { name: "city", label: "City", autoComplete: "address-level2" },
    { name: "postalCode", label: "Postal code", autoComplete: "postal-code" },
  ],
];

const CONTACT_ROWS: readonly (readonly FieldSpec[])[] = [
  [
    {
      name: "contactFirstName",
      label: "First name",
      autoComplete: "given-name",
    },
    {
      name: "contactLastName",
      label: "Last name",
      autoComplete: "family-name",
    },
  ],
  [
    {
      name: "contactEmail",
      label: "Email",
      type: "email",
      autoComplete: "email",
    },
    {
      name: "contactPhone",
      label: "Phone",
      type: "tel",
      autoComplete: "tel",
      placeholder: "+254712345678",
      help: phoneHelp,
    },
  ],
];

const ALL_FIELDS = [...COMPANY_ROWS, ...CONTACT_ROWS].flat();

const NO_DRAFT: Readonly<Record<FieldName, string>> = {
  legalName: "",
  kraPin: "",
  addressLine1: "",
  city: "",
  postalCode: "",
  phone: "",
  contactFirstName: "",
  contactLastName: "",
  contactEmail: "",
  contactPhone: "",
};

/**
 * "Turn on cards" (spec §6.25): one form, once per company. It registers
 * the business with Lithic's sandbox and sets up the Card balance's account.
 */
export function TurnOnCards({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const turnOn = useTurnOnCards(organizationId);
  const formId = useId();
  const [draft, setDraft] = useState(NO_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const fieldId = (name: FieldName) => `${formId}-${name}`;

  function submit() {
    const parsed = turnOnCardsRequestSchema.safeParse(draft);
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(
        found,
        Object.fromEntries(ALL_FIELDS.map(({ name }) => [name, fieldId(name)])),
      );
      return;
    }
    setErrors({});
    turnOn.mutate(parsed.data);
  }

  function renderField(spec: FieldSpec): JSX.Element {
    const id = fieldId(spec.name);
    const error = errors[spec.name];
    return (
      <FormField
        key={spec.name}
        id={id}
        label={spec.label}
        help={spec.help}
        error={error}
      >
        <Input
          id={id}
          name={spec.name}
          type={spec.type ?? "text"}
          autoComplete={spec.autoComplete}
          placeholder={spec.placeholder}
          value={draft[spec.name]}
          disabled={turnOn.isPending}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, [spec.name]: value }));
            setErrors((current) => ({ ...current, [spec.name]: undefined }));
          }}
        />
      </FormField>
    );
  }

  function renderRow(row: readonly FieldSpec[], at: number): ReactNode {
    return row.length > 1 ? (
      <FieldRow key={at}>{row.map(renderField)}</FieldRow>
    ) : (
      row.map(renderField)
    );
  }

  return (
    <section
      aria-labelledby={`${formId}-title`}
      className="mt-6 max-w-[640px] rounded-xl border border-border bg-card p-6 shadow-xs [animation-delay:60ms] motion-safe:animate-rise max-[600px]:p-4"
    >
      <h2
        id={`${formId}-title`}
        className="text-lg leading-[26px] font-(--w-title) text-card-foreground"
      >
        Turn on cards
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Issue virtual cards that spend from a Card balance you load yourself.
        You do this once for the company.
      </p>
      <div className="mt-4">
        <Banner role="note" title="Sandbox: no real money moves">
          These are test cards. Nothing is charged and no USDC leaves the
          wallet.
        </Banner>
      </div>
      <div className="mt-5">
        <SheetForm id={formId} label="Turn on cards" onSubmit={submit}>
          <SectionLabel>The company</SectionLabel>
          {COMPANY_ROWS.map(renderRow)}
          <SectionLabel>Who&apos;s responsible</SectionLabel>
          {CONTACT_ROWS.map(renderRow)}
          {turnOn.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(turnOn.error)}</p>
              </Callout>
            </div>
          ) : null}
          <div>
            <Button type="submit" disabled={turnOn.isPending}>
              {turnOn.isPending ? "Turning on…" : "Turn on cards"}
            </Button>
          </div>
        </SheetForm>
      </div>
    </section>
  );
}

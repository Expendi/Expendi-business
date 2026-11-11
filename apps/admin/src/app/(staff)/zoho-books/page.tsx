"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageHeader } from "~/components/data/page-header";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a company's Zoho Books page by its ID. Each company's page lives at
 * /companies/<id>/zoho, so the company views can link straight to it.
 */
export default function ZohoBooksPage() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState("");
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = companyId.trim();
    if (!UUID.test(id)) {
      setInvalid(true);
      return;
    }
    router.push(`/companies/${id}/zoho`);
  }

  return (
    <section className="flex max-w-xl flex-col gap-6">
      <PageHeader
        title="Zoho Books"
        subtitle="Send a company's accountant a connect link, pick the Zoho organization and map categories to Zoho accounts."
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Open a company connection</h2>
          </CardTitle>
          <CardDescription>
            Find the company ID on its company page or in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="zoho-company-id">Company ID</FieldLabel>
              <Input
                id="zoho-company-id"
                value={companyId}
                onChange={(event) => {
                  setCompanyId(event.target.value);
                  setInvalid(false);
                }}
                placeholder="e.g. 3f0c…"
                aria-invalid={invalid}
                aria-describedby={invalid ? "zoho-company-error" : undefined}
                className="font-mono"
              />
              {invalid ? (
                <FieldError id="zoho-company-error">
                  Enter the company&apos;s ID, as shown on the company page or
                  in the audit log.
                </FieldError>
              ) : null}
            </Field>
            <Button type="submit" className="mt-4">
              Open connection
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

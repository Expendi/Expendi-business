"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">Zoho Books</h1>
      <p className="mt-1 text-sm text-stone-600">
        Send a company&apos;s accountant a connect link, pick the Zoho
        organization and map categories to Zoho accounts.
      </p>
      <form
        onSubmit={onSubmit}
        className="mt-6 rounded-lg border border-stone-200 bg-white p-4"
      >
        <label className="block text-sm">
          Company ID
          <input
            value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setInvalid(false);
            }}
            placeholder="e.g. 3f0c…"
            aria-invalid={invalid}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 font-mono text-sm focus:border-brand-600 focus:outline-none"
          />
        </label>
        {invalid ? (
          <p role="alert" className="mt-2 text-sm text-error-700">
            Enter the company&apos;s ID, as shown on the company page or in the
            audit log.
          </p>
        ) : null}
        <button
          type="submit"
          className="mt-4 rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        >
          Open
        </button>
      </form>
    </section>
  );
}

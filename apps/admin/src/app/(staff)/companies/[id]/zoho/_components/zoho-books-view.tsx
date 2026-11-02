"use client";

import type { FormEvent, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import type {
  ZohoConnection,
  ZohoConnectLinkResponse,
  ZohoStatusResponse,
} from "@expendi-business/shared";
import { ZOHO_REQUIRED_CURRENCY } from "@expendi-business/shared";

import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

const inputClass =
  "mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none disabled:bg-stone-100";
const primaryButton =
  "rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50";
const secondaryButton =
  "rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50";

/** The company's Zoho Books connection (spec §6.15, §6.17). */
export function ZohoBooksView({ companyId }: { companyId: string }) {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const status = useQuery({
    queryKey: queryKeys.zoho(companyId),
    queryFn: () => api.zoho.status(companyId),
  });

  return (
    <section className="max-w-3xl">
      <p className="text-sm">
        <Link
          href="/zoho-books"
          className="text-stone-600 underline-offset-4 hover:underline"
        >
          Zoho Books
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold">Zoho Books</h1>
      <p className="mt-1 text-sm break-all text-stone-600">
        Company {companyId}
      </p>
      {canAct ? null : (
        <p className="mt-2 text-sm text-stone-500">
          You can look but not change anything: that needs an ops admin.
        </p>
      )}

      {status.isPending ? (
        <p className="mt-6 text-sm text-stone-500">Loading…</p>
      ) : status.isError ? (
        <p role="alert" className="mt-6 text-sm text-error-700">
          {describeApiError(status.error)}
        </p>
      ) : (
        <ZohoBooksPanels
          companyId={companyId}
          status={status.data}
          canAct={canAct}
        />
      )}
    </section>
  );
}

function ZohoBooksPanels({
  companyId,
  status,
  canAct,
}: {
  companyId: string;
  status: ZohoStatusResponse;
  canAct: boolean;
}) {
  const { connection, configured } = status;
  const signedIn =
    connection !== null &&
    connection.connectedAt !== null &&
    connection.status !== "needs_reconnect";

  return (
    <div className="mt-6 space-y-6">
      {configured ? null : (
        <Notice>
          Zoho isn&apos;t set up on this API yet: it needs ZOHO_CLIENT_ID,
          ZOHO_CLIENT_SECRET, ZOHO_REDIRECT_URI and ACCOUNTING_TOKEN_KEY.
        </Notice>
      )}

      <StatusPanel connection={connection} />

      {canAct && configured ? (
        <ConnectLinkPanel companyId={companyId} connection={connection} />
      ) : null}

      {connection && signedIn ? (
        <OrganizationPanel
          companyId={companyId}
          connection={connection}
          canAct={canAct}
        />
      ) : null}

      {connection?.status === "active" ? (
        <MappingPanel
          key={mappingKey(connection)}
          companyId={companyId}
          connection={connection}
          canAct={canAct}
        />
      ) : null}

      {canAct && connection ? <DisconnectPanel companyId={companyId} /> : null}
    </div>
  );
}

/** Resets the mapping form whenever the saved mapping changes. */
function mappingKey(connection: ZohoConnection): string {
  return JSON.stringify([
    connection.organization?.id,
    connection.paidThroughAccountId,
    connection.defaultAccountId,
    connection.categoryAccounts,
  ]);
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-3 text-sm">{children}</div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-stone-200 bg-stone-100 px-3 py-2 text-sm text-stone-700">
      {children}
    </p>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <p role="alert" className="mt-3 text-sm text-error-700">
      {describeApiError(error)}
    </p>
  );
}

function statusLabel(connection: ZohoConnection | null): string {
  if (!connection) return "Not connected";
  switch (connection.status) {
    case "pending":
      return connection.connectedAt
        ? "Signed in: choose the organization"
        : "Waiting for the Zoho sign-in";
    case "active":
      return "Connected";
    case "needs_reconnect":
      return "Needs reconnecting: Zoho rejected Expendi's access";
    case "disconnected":
      return "Disconnected";
  }
}

function StatusPanel({ connection }: { connection: ZohoConnection | null }) {
  return (
    <Panel title="Status">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
        <dt className="text-stone-500">Connection</dt>
        <dd className="font-medium">{statusLabel(connection)}</dd>
        {connection ? (
          <>
            <dt className="text-stone-500">Organization</dt>
            <dd>
              {connection.organization
                ? `${connection.organization.name} (${connection.organization.id})`
                : "Not chosen"}
            </dd>
            <dt className="text-stone-500">Last sign-in</dt>
            <dd>
              {connection.connectedAt
                ? formatNairobiTime(connection.connectedAt)
                : "Never"}
            </dd>
            <dt className="text-stone-500">Zoho data centre</dt>
            <dd>{connection.apiDomain ?? "Not known until sign-in"}</dd>
            <dt className="text-stone-500">Connect link</dt>
            <dd>
              {connection.connectLink
                ? `${connection.connectLink.expired ? "Expired" : "Unused, expires"} ${formatNairobiTime(connection.connectLink.expiresAt)}`
                : "None waiting"}
            </dd>
          </>
        ) : null}
      </dl>
    </Panel>
  );
}

function ConnectLinkPanel({
  companyId,
  connection,
}: {
  companyId: string;
  connection: ZohoConnection | null;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [link, setLink] = useState<ZohoConnectLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.zoho.createConnectLink(companyId),
    onSuccess: async (created) => {
      setLink(created);
      setCopied(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.zoho(companyId),
      });
    },
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const reconnecting = connection?.connectedAt != null;

  return (
    <Panel title="Connect link">
      <p className="text-stone-600">
        Send the link to whoever owns the company&apos;s Zoho login, usually the
        accountant. It works once and expires after 7 days.
        {reconnecting
          ? " Signing in again keeps the organization and the mapping."
          : ""}
      </p>
      {link ? (
        <div className="mt-4">
          <label className="block">
            <span className="font-medium">
              Copy it now: it won&apos;t be shown again.
            </span>
            <input
              readOnly
              value={link.url}
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} font-mono`}
            />
          </label>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void copy(link.url)}
              className={secondaryButton}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <span className="text-stone-500">
              Expires {formatNairobiTime(link.expiresAt)}
            </span>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        disabled={create.isPending}
        onClick={() => create.mutate()}
        className={`mt-4 ${primaryButton}`}
      >
        {connection?.connectLink || link
          ? "Create a new link (replaces the last one)"
          : "Create connect link"}
      </button>
      {create.isError ? <ErrorText error={create.error} /> : null}
    </Panel>
  );
}

function OrganizationPanel({
  companyId,
  connection,
  canAct,
}: {
  companyId: string;
  connection: ZohoConnection;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(connection.organization?.id ?? "");
  const organizations = useQuery({
    queryKey: queryKeys.zohoOrganizations(companyId),
    queryFn: () => api.zoho.organizations(companyId),
  });
  const choose = useMutation({
    mutationFn: (externalOrganizationId: string) =>
      api.zoho.chooseOrganization(companyId, { externalOrganizationId }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.zoho(companyId), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.zohoAccounts(companyId),
      });
    },
  });

  const picked = organizations.data?.find(({ id }) => id === selected);
  const pickedIsKes = picked?.currencyCode === ZOHO_REQUIRED_CURRENCY;
  const switching =
    connection.organization !== null && selected !== connection.organization.id;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (picked && pickedIsKes) choose.mutate(picked.id);
  }

  return (
    <Panel title="Zoho organization">
      {organizations.isPending ? (
        <p className="text-stone-500">Loading the organizations…</p>
      ) : organizations.isError ? (
        <ErrorText error={organizations.error} />
      ) : organizations.data.length === 0 ? (
        <p className="text-stone-600">
          The Zoho login that signed in can&apos;t see any Zoho Books
          organization.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset disabled={!canAct || choose.isPending}>
            <legend className="text-stone-600">
              Only an organization whose base currency is{" "}
              {ZOHO_REQUIRED_CURRENCY} can be connected.
            </legend>
            <div className="mt-3 space-y-2">
              {organizations.data.map((organization) => {
                const isKes =
                  organization.currencyCode === ZOHO_REQUIRED_CURRENCY;
                return (
                  <label key={organization.id} className="flex gap-2">
                    <input
                      type="radio"
                      name="organization"
                      value={organization.id}
                      checked={selected === organization.id}
                      onChange={() => setSelected(organization.id)}
                    />
                    <span>
                      {organization.name}{" "}
                      <span className="text-stone-500">
                        ({organization.currencyCode})
                      </span>
                      {isKes ? null : (
                        <span className="block text-error-700">
                          Can&apos;t be connected: its base currency is{" "}
                          {organization.currencyCode}, not{" "}
                          {ZOHO_REQUIRED_CURRENCY}.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            {switching ? (
              <p className="mt-3 text-stone-600">
                Switching organization clears the account mapping below.
              </p>
            ) : null}
            {canAct ? (
              <button
                type="submit"
                disabled={
                  !picked ||
                  !pickedIsKes ||
                  (selected === connection.organization?.id &&
                    connection.status === "active")
                }
                className={`mt-4 ${primaryButton}`}
              >
                Use this organization
              </button>
            ) : null}
          </fieldset>
          {choose.isError ? <ErrorText error={choose.error} /> : null}
        </form>
      )}
    </Panel>
  );
}

const USE_DEFAULT = "";

function MappingPanel({
  companyId,
  connection,
  canAct,
}: {
  companyId: string;
  connection: ZohoConnection;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [categoryAccounts, setCategoryAccounts] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      connection.categoryAccounts.map(({ categoryId, accountId }) => [
        categoryId,
        accountId ?? USE_DEFAULT,
      ]),
    ),
  );
  const [paidThroughAccountId, setPaidThroughAccountId] = useState(
    connection.paidThroughAccountId ?? "",
  );
  const [defaultAccountId, setDefaultAccountId] = useState(
    connection.defaultAccountId ?? "",
  );
  const accounts = useQuery({
    queryKey: queryKeys.zohoAccounts(companyId),
    queryFn: () => api.zoho.accounts(companyId),
  });
  const save = useMutation({
    mutationFn: () =>
      api.zoho.saveMapping(companyId, {
        categoryAccounts: Object.fromEntries(
          Object.entries(categoryAccounts).map(([categoryId, accountId]) => [
            categoryId,
            accountId === USE_DEFAULT ? null : accountId,
          ]),
        ),
        paidThroughAccountId,
        defaultAccountId,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.zoho(companyId), updated);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  if (accounts.isPending) {
    return (
      <Panel title="Account mapping">
        <p className="text-stone-500">Loading the chart of accounts…</p>
      </Panel>
    );
  }
  if (accounts.isError) {
    return (
      <Panel title="Account mapping">
        <ErrorText error={accounts.error} />
      </Panel>
    );
  }

  const { expenseAccounts, paidThroughAccounts } = accounts.data;
  const accountOptions = (list: typeof expenseAccounts) =>
    list.map((account) => (
      <option key={account.id} value={account.id}>
        {account.code ? `${account.code} · ` : ""}
        {account.name}
      </option>
    ));

  return (
    <Panel title="Account mapping">
      <form onSubmit={onSubmit}>
        <fieldset disabled={!canAct || save.isPending} className="space-y-4">
          <label className="block">
            Paid Through account
            <span className="block text-stone-500">
              Where the money came from, e.g. a bank account called
              &ldquo;Expendi Wallet&rdquo;.
            </span>
            <select
              required
              value={paidThroughAccountId}
              onChange={(event) => setPaidThroughAccountId(event.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Choose an account
              </option>
              {accountOptions(paidThroughAccounts)}
            </select>
          </label>
          <label className="block">
            Default expense account
            <span className="block text-stone-500">
              For categories without their own account.
            </span>
            <select
              required
              value={defaultAccountId}
              onChange={(event) => setDefaultAccountId(event.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Choose an account
              </option>
              {accountOptions(expenseAccounts)}
            </select>
          </label>

          <div>
            <p className="font-medium">Categories</p>
            {connection.categoryAccounts.length === 0 ? (
              <p className="mt-1 text-stone-500">
                This company has no categories yet.
              </p>
            ) : (
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {connection.categoryAccounts.map(
                  ({ categoryId, categoryName }) => (
                    <label key={categoryId} className="block">
                      {categoryName}
                      <select
                        value={categoryAccounts[categoryId] ?? USE_DEFAULT}
                        onChange={(event) =>
                          setCategoryAccounts((current) => ({
                            ...current,
                            [categoryId]: event.target.value,
                          }))
                        }
                        className={inputClass}
                      >
                        <option value={USE_DEFAULT}>Default account</option>
                        {accountOptions(expenseAccounts)}
                      </select>
                    </label>
                  ),
                )}
              </div>
            )}
          </div>

          {canAct ? (
            <button type="submit" className={primaryButton}>
              Save mapping
            </button>
          ) : null}
        </fieldset>
        {save.isError ? <ErrorText error={save.error} /> : null}
        {save.isSuccess ? (
          <p role="status" className="mt-3 text-stone-600">
            Mapping saved.
          </p>
        ) : null}
      </form>
    </Panel>
  );
}

function DisconnectPanel({ companyId }: { companyId: string }) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api.zoho.disconnect(companyId),
    onSuccess: (updated) => {
      setConfirming(false);
      queryClient.setQueryData(queryKeys.zoho(companyId), updated);
      queryClient.removeQueries({
        queryKey: queryKeys.zohoOrganizations(companyId),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.zohoAccounts(companyId),
      });
    },
  });

  return (
    <Panel title="Disconnect">
      <p className="text-stone-600">
        Revokes Expendi&apos;s access in Zoho and forgets the stored token.
        Nothing already in Zoho changes. Reconnecting needs a new connect link.
      </p>
      {confirming ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="font-medium">Disconnect Zoho Books?</span>
          <button
            type="button"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
            className="rounded-md bg-error-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Yes, disconnect
          </button>
          <button
            type="button"
            disabled={disconnect.isPending}
            onClick={() => setConfirming(false)}
            className={secondaryButton}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`mt-4 ${secondaryButton}`}
        >
          Disconnect
        </button>
      )}
      {disconnect.isError ? <ErrorText error={disconnect.error} /> : null}
    </Panel>
  );
}

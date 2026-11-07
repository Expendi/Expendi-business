"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import {
  BookOpenIcon,
  Building2Icon,
  KeyRoundIcon,
  LandmarkIcon,
  LockIcon,
  TagIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PageHeader } from "~/components/data/page-header";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { ApprovalPasskeySettings } from "./approval-passkey-settings";
import { CategorySettings } from "./category-settings";
import { PaidFromAccounts } from "./paid-from-accounts";
import { useCompanyDetails, useZohoStatus } from "./settings-api";
import {
  KeyValue,
  KeyValues,
  PanelError,
  PanelFoot,
  PanelSkeleton,
  SettingsPanel,
} from "./settings-panel";
import { ZohoSettings } from "./zoho-settings";

type SettingsParam = "section" | "category" | "account";

export type SectionId =
  "company" | "passkey" | "categories" | "accounts" | "zoho";

interface Section {
  readonly id: SectionId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly adminOnly?: boolean;
}

export const SECTIONS: readonly Section[] = [
  { id: "company", label: "Company", icon: Building2Icon },
  {
    id: "passkey",
    label: "Approval passkey",
    icon: KeyRoundIcon,
    adminOnly: true,
  },
  { id: "categories", label: "Categories", icon: TagIcon },
  { id: "accounts", label: "Paid-from accounts", icon: LandmarkIcon },
  { id: "zoho", label: "Zoho Books", icon: BookOpenIcon },
];

/**
 * Settings (spec §6.14, §6.17, §6.23): the company's details, the admin's
 * approval passkey, the categories people pick, the accounts company
 * spending is paid from, and the Zoho Books connection. A section list
 * beside the panels jumps between them; every change opens in the side
 * sheet. Accountants read everything but the passkey.
 */
export function SettingsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanySettings
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanySettings({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [param, setParams] = useDeepLinkParams<SettingsParam>();
  const sections = SECTIONS.filter((section) => canAct || !section.adminOnly);

  return (
    <section>
      <PageHeader
        title="Settings"
        subtitle={
          canAct
            ? "The company's details, your approval passkey, the categories people pick when they record spending, and the accounts company spending is paid from."
            : "The company's details, the categories people pick when they record spending, and the accounts company spending is paid from. Only admins change them."
        }
      />
      <div className="@container/settings mt-6 motion-safe:animate-rise [animation-delay:60ms]">
        <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-8 max-[900px]:grid-cols-[minmax(0,1fr)] max-[900px]:gap-4 @max-[760px]/settings:grid-cols-[minmax(0,1fr)] @max-[760px]/settings:gap-4">
          <SectionNav
            organizationId={organizationId}
            canAct={canAct}
            sections={sections}
            linked={
              param("section") ??
              (param("category")
                ? "categories"
                : param("account")
                  ? "accounts"
                  : null)
            }
            onGo={(section) => setParams({ section })}
          />
          <div className="flex min-w-0 flex-col gap-6">
            <CompanyDetails organizationId={organizationId} />
            {canAct ? <ApprovalPasskeySettings /> : null}
            <CategorySettings
              organizationId={organizationId}
              canAct={canAct}
              openId={param("category")}
              onOpen={(category) =>
                setParams(
                  category
                    ? { section: "categories", category, account: null }
                    : { category: null },
                )
              }
            />
            <PaidFromAccounts
              organizationId={organizationId}
              canAct={canAct}
              openId={param("account")}
              onOpen={(account) =>
                setParams(
                  account
                    ? { section: "accounts", account, category: null }
                    : { account: null },
                )
              }
            />
            <ZohoSettings organizationId={organizationId} />
          </div>
        </div>
      </div>
    </section>
  );
}

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The section whose panel top has passed the line under the nav. */
function sectionInView(
  ids: readonly string[],
  nav: HTMLElement | null,
): string | undefined {
  const line =
    nav !== null && getComputedStyle(nav).flexDirection === "row"
      ? nav.getBoundingClientRect().bottom + 48
      : 120;
  let found = ids[0];
  for (const id of ids) {
    const panel = document.getElementById(id);
    if (panel && panel.getBoundingClientRect().top <= line) found = id;
  }
  const atBottom =
    window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - 2;
  return atBottom ? ids.at(-1) : found;
}

/**
 * Jumps to a panel and follows the scroll. A jump pins the chosen section
 * until the person scrolls themselves, so a short last panel still shows
 * as current.
 */
function SectionNav({
  organizationId,
  canAct,
  sections,
  linked,
  onGo,
}: {
  organizationId: string;
  canAct: boolean;
  sections: readonly Section[];
  linked: string | null;
  onGo: (id: SectionId) => void;
}): JSX.Element {
  const passkey = useApprovalPasskeyStatus(canAct);
  const zoho = useZohoStatus(organizationId);
  const navRef = useRef<HTMLElement>(null);
  const pinned = useRef<string | null>(null);
  const [current, setCurrent] = useState<string>(
    sections.find((section) => section.id === linked)?.id ?? "company",
  );
  const idsKey = sections.map((section) => section.id).join(" ");

  useEffect(() => {
    const ids = idsKey.split(" ");
    const onScroll = () => {
      if (pinned.current) return;
      const found = sectionInView(ids, navRef.current);
      if (found) setCurrent(found);
    };
    const unpin = () => {
      pinned.current = null;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", unpin, { passive: true });
    window.addEventListener("touchstart", unpin, { passive: true });
    window.addEventListener("keydown", unpin);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", unpin);
      window.removeEventListener("touchstart", unpin);
      window.removeEventListener("keydown", unpin);
    };
  }, [idsKey]);

  const firstLinked = useRef(linked);
  useEffect(() => {
    const id = firstLinked.current;
    if (!id || !idsKey.split(" ").includes(id)) return;
    pinned.current = id;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [idsKey]);

  useEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>(`[data-section="${current}"]`);
    if (!nav || !link || nav.scrollWidth <= nav.clientWidth) return;
    const box = nav.getBoundingClientRect();
    const spot = link.getBoundingClientRect();
    if (spot.left < box.left || spot.right > box.right) {
      nav.scrollLeft += spot.left - box.left - 16;
    }
  }, [current]);

  function go(id: SectionId) {
    const panel = document.getElementById(id);
    if (!panel) return;
    pinned.current = id;
    setCurrent(id);
    onGo(id);
    panel.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    document.getElementById(`${id}-title`)?.focus({ preventScroll: true });
  }

  const flags: Partial<Record<SectionId, string>> = {
    ...(passkey.data && !passkey.data.enrolled
      ? { passkey: "Not set up yet" }
      : {}),
    ...(zoho.data?.status === "needs_reconnect"
      ? { zoho: "Needs reconnecting" }
      : {}),
  };

  return (
    <nav
      ref={navRef}
      aria-label="Settings sections"
      className="sticky top-6 flex flex-col gap-0.5 [scrollbar-width:none] max-[900px]:top-14 max-[900px]:z-20 max-[900px]:flex-row max-[900px]:gap-1 max-[900px]:overflow-x-auto max-[900px]:border-b max-[900px]:border-gray-200 max-[900px]:bg-background max-[900px]:py-2 @max-[760px]/settings:z-20 @max-[760px]/settings:flex-row @max-[760px]/settings:gap-1 @max-[760px]/settings:overflow-x-auto @max-[760px]/settings:border-b @max-[760px]/settings:border-gray-200 @max-[760px]/settings:bg-background @max-[760px]/settings:py-2 min-[901px]:@max-[760px]/settings:top-0 [&::-webkit-scrollbar]:hidden"
    >
      {sections.map((section) => {
        const flag = flags[section.id];
        const Icon = section.icon;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            data-section={section.id}
            aria-current={section.id === current ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              go(section.id);
            }}
            className="group/link flex h-9 flex-none items-center gap-2.5 rounded-control px-2.5 whitespace-nowrap text-gray-700 no-underline transition-colors duration-150 hover:bg-gray-100 aria-[current=true]:bg-brand-50 aria-[current=true]:font-(--w-ui) aria-[current=true]:text-brand-800"
          >
            <Icon
              aria-hidden="true"
              className="size-4 text-gray-400 group-aria-[current=true]/link:text-brand-700"
            />
            {section.label}
            {flag ? (
              <span title={flag} className="ml-auto inline-flex pl-1">
                <TriangleAlertIcon
                  aria-hidden="true"
                  className="size-3.5 text-warn-600"
                />
                <span className="sr-only">, {flag.toLowerCase()}</span>
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/** Read-only: set when the company signed up. */
function CompanyDetails({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const details = useCompanyDetails(organizationId);
  return (
    <SettingsPanel id="company" title="Company" busy={details.isPending}>
      {details.isPending ? (
        <PanelSkeleton lines={3} />
      ) : details.isError ? (
        <PanelError
          title="Company details didn't load"
          message={describeApiError(details.error)}
          onRetry={() => void details.refetch()}
        />
      ) : (
        <>
          <KeyValues>
            <KeyValue label="Name">{details.data.name}</KeyValue>
            <KeyValue label="KRA PIN">
              {details.data.kraPin ?? (
                <span className="text-gray-500">Not given</span>
              )}
            </KeyValue>
            <KeyValue label="Your role">
              {ROLE_LABELS[details.data.role]}
            </KeyValue>
          </KeyValues>
          <PanelFoot icon={LockIcon}>
            Set when the company signed up. They can&apos;t be changed here.
          </PanelFoot>
        </>
      )}
    </SettingsPanel>
  );
}

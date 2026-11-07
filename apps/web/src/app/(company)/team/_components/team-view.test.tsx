import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  InviteMemberResponse,
  Member,
  MeResponse,
} from "@expendi-business/shared";

import type * as DetailSheetModule from "~/components/data/detail-sheet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { InviteBanner } from "./member-sheet";
import {
  daysSince,
  readTeamFilters,
  sortMembers,
  teamStats,
} from "./team-display";
import { TeamView } from "./team-view";

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/team",
  useSearchParams: () => search,
}));
vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/components/data/detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof DetailSheetModule>();
  return {
    ...actual,
    DetailSheet: ({
      open,
      eyebrow,
      title,
      headerExtra,
      footer,
      children,
    }: ComponentProps<typeof actual.DetailSheet>) =>
      open ? (
        <aside data-sheet="">
          <p>{eyebrow}</p>
          <h2>{title}</h2>
          {headerExtra}
          <div>{children}</div>
          <footer>{footer}</footer>
        </aside>
      ) : null,
  };
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ME = id(1);

const members: Member[] = [
  {
    id: ME,
    name: "Wanjiru Kamau",
    email: "wanjiru@example.com",
    role: "admin",
    status: "active",
    invitedAt: null,
    payoutPhoneConfirmed: true,
  },
  {
    id: id(2),
    name: "Faith Wambui",
    email: "faith@example.com",
    role: "admin",
    status: "active",
    invitedAt: "2026-03-09T06:05:00.000Z",
    payoutPhoneConfirmed: true,
  },
  {
    id: id(3),
    name: "Amina Hassan",
    email: "amina@example.com",
    role: "employee",
    status: "active",
    invitedAt: "2026-10-27T08:20:00.000Z",
    payoutPhoneConfirmed: false,
  },
  {
    id: id(4),
    name: "Lucy Mutua",
    email: "lucy@example.com",
    role: "accountant",
    status: "active",
    invitedAt: "2026-03-12T09:30:00.000Z",
    payoutPhoneConfirmed: false,
  },
  {
    id: id(5),
    name: "Mercy Chebet",
    email: "mercy@example.com",
    role: "employee",
    status: "invited",
    invitedAt: "2026-11-04T07:12:00.000Z",
    payoutPhoneConfirmed: false,
  },
];

const me: MeResponse = {
  user: {
    id: id(90),
    email: "wanjiru@example.com",
    phone: null,
    fullName: "Wanjiru Kamau",
  },
  memberships: [
    {
      id: ME,
      organizationId: ORG,
      organizationName: "Acme Ltd",
      role: "admin",
      status: "active",
    },
  ],
};

function render({
  role = "admin",
  query = "",
  team = members,
  failed = false,
}: {
  role?: "admin" | "accountant";
  query?: string;
  team?: Member[];
  failed?: boolean;
} = {}): string {
  search = new URLSearchParams(query);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  queryClient.setQueryData(queryKeys.me("did:privy:test"), me);
  if (failed) {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: queryKeys.members(ORG) })
      .setState({ status: "error", error: new Error("Offline") });
  } else {
    queryClient.setQueryData(queryKeys.members(ORG), team);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <TeamView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;

describe("the team", () => {
  it("shows the team's numbers, its tabs and everyone in one sortable list, marking you", () => {
    // #when
    const html = render();

    // #then
    expect({
      breakdown: html.includes("2 admins, 1 employee, 1 accountant"),
      oldestInvite: html.includes("Oldest sent"),
      unpaid: html.includes("Can&#x27;t be paid until they confirm it"),
      tabs: ["Everyone", "Active", "Invited"].every((tab) =>
        html.includes(`>${tab}<`),
      ),
      chips:
        html.includes("Filter by role") &&
        html.includes("Filter by m-pesa number"),
      sorted: html.includes('aria-sort="ascending"'),
      people: members.every((member) => html.includes(member.email)),
      you: count(html, ">You<") > 0,
      invite: html.includes("Invite someone"),
      inviteSent: html.includes("Sent 4 Nov 2026, 10:12"),
    }).toEqual({
      breakdown: true,
      oldestInvite: true,
      unpaid: true,
      tabs: true,
      chips: true,
      sorted: true,
      people: true,
      you: true,
      invite: true,
      inviteSent: true,
    });
  });

  it("follows the tab and the chips in the URL", () => {
    // #when
    const html = render({ query: "view=active&memberRole=employee" });

    // #then
    expect({
      amina: html.includes("amina@example.com"),
      mercy: html.includes("mercy@example.com"),
      faith: html.includes("faith@example.com"),
      clearAll: html.includes("Clear all"),
      chip: html.includes("Role: Employee. Change"),
    }).toEqual({
      amina: true,
      mercy: false,
      faith: false,
      clearAll: true,
      chip: true,
    });
  });

  it("says when no one matches the filters", () => {
    // #when
    const html = render({ query: "memberRole=accountant&mpesa=confirmed" });

    // #then
    expect(html).toContain("No one matches these filters");
  });

  it("opens a person's details from the link, with the admin's actions", () => {
    // #when
    const html = render({ query: `memberId=${id(5)}` });

    // #then
    expect({
      title: html.includes("<h2>Mercy Chebet</h2>"),
      inviteSent: html.includes("Invite sent"),
      joins: html.includes("They join when they first sign in"),
      resend: html.includes("Resend invite"),
      changeRole: html.includes("Change role"),
      remove: html.includes(">Remove<"),
      readOnly: html.includes("View only"),
    }).toEqual({
      title: true,
      inviteSent: true,
      joins: true,
      resend: true,
      changeRole: true,
      remove: true,
      readOnly: false,
    });
  });

  it("warns when an active person can't be paid yet", () => {
    // #when
    const html = render({ query: `memberId=${id(3)}` });

    // #then
    expect(html).toContain("Can&#x27;t be paid until they confirm their");
  });

  it("keeps an accountant's role as it is", () => {
    // #when
    const html = render({ query: `memberId=${id(4)}` });

    // #then
    expect({
      note: html.includes("An accountant&#x27;s role can&#x27;t be changed."),
      changeRole: html.includes("Change role"),
      remove: html.includes(">Remove<"),
    }).toEqual({ note: true, changeRole: false, remove: true });
  });

  it("shows an accountant the team and details with no actions", () => {
    // #when
    const html = render({ role: "accountant", query: `memberId=${ME}` });

    // #then
    expect({
      invite: html.includes("Invite someone"),
      eyebrow: html.includes("Admin · You"),
      readOnly: html.includes("View only. Only admins change the team."),
      position: /\d of 5/.test(html),
      resend: html.includes("Resend invite"),
      remove: html.includes(">Remove<"),
    }).toEqual({
      invite: false,
      eyebrow: true,
      readOnly: true,
      position: true,
      resend: false,
      remove: false,
    });
  });

  it("invites more people when it's just you", () => {
    // #when
    const html = render({ team: members.slice(0, 1) });

    // #then
    expect(html).toContain("Just you so far");
  });

  it("offers to try again when the team doesn't load", () => {
    // #when
    const html = render({ failed: true });

    // #then
    expect({
      title: html.includes("The team didn&#x27;t load"),
      retry: html.includes("Try again"),
      invite: html.includes("Invite someone"),
    }).toEqual({ title: true, retry: true, invite: false });
  });
});

describe("the invite result", () => {
  const mercy: Member = {
    id: id(5),
    name: "Mercy Chebet",
    email: "mercy@example.com",
    role: "employee",
    status: "invited",
    invitedAt: "2026-11-04T07:12:00.000Z",
    payoutPhoneConfirmed: false,
  };
  const result = (emailSent: boolean): InviteMemberResponse => ({
    member: mercy,
    emailSent,
    installUrl: "https://example.com/install",
    inviteLink: "https://example.com/install",
  });

  it("confirms an invite that went out", () => {
    // #when
    const html = renderToStaticMarkup(
      <InviteBanner result={result(true)} onDone={() => undefined} />,
    );

    // #then
    expect(html).toContain("Invite sent to Mercy Chebet at mercy@example.com.");
  });

  it("offers the link to copy when the email didn't go out", () => {
    // #when
    const html = renderToStaticMarkup(
      <InviteBanner result={result(false)} onDone={() => undefined} />,
    );

    // #then
    expect({
      title: html.includes("the email didn&#x27;t go out"),
      link: html.includes("https://example.com/install"),
      copy: html.includes("Copy link"),
    }).toEqual({ title: true, link: true, copy: true });
  });
});

describe("team display", () => {
  it("counts active people by role, open invites and who can't be paid", () => {
    // #when
    const stats = teamStats(members, new Date("2026-11-06T06:30:00Z"));

    // #then
    expect(stats).toEqual({
      active: 4,
      breakdown: "2 admins, 1 employee, 1 accountant",
      invited: 1,
      oldestInvite: "Oldest sent 2 days ago",
      withoutPayout: 1,
    });
  });

  it("counts days in Nairobi time", () => {
    // #when
    const days = daysSince(
      "2026-11-05T21:30:00Z",
      new Date("2026-11-06T06:30:00Z"),
    );

    // #then
    expect(days).toBe(0);
  });

  it("sorts by status with open invites first, then by name", () => {
    // #when
    const order = sortMembers(members, { key: "status", dir: "asc" }).map(
      (member) => member.name,
    );

    // #then
    expect(order).toEqual([
      "Mercy Chebet",
      "Amina Hassan",
      "Faith Wambui",
      "Lucy Mutua",
      "Wanjiru Kamau",
    ]);
  });

  it("ignores filters it doesn't know", () => {
    // #given
    const params = new URLSearchParams(
      "view=removed&memberRole=owner&mpesa=none",
    );

    // #when
    const filters = readTeamFilters((name) => params.get(name));

    // #then
    expect(filters).toEqual({ view: "all", role: null, mpesa: "none" });
  });
});

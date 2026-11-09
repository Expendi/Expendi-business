import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import nextConfig from "../../../../next.config.js";
import { CardFields, CardReveal, RevealUnavailable } from "./card-reveal";

vi.mock("./card-embed", () => ({ mountCardEmbed: vi.fn() }));

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

function fields(props: {
  ready: boolean;
  revealed: boolean;
  toggling?: boolean;
}): string {
  return renderToStaticMarkup(
    <CardFields
      pan={createRef()}
      cvv={createRef()}
      expMonth={createRef()}
      expYear={createRef()}
      toggling={false}
      onToggle={vi.fn()}
      {...props}
    />,
  );
}

describe("the card reveal page", () => {
  it("renders with no chrome and no session until the page is live", () => {
    // #when
    const html = renderToStaticMarkup(<CardReveal />);

    // #then
    expect({
      heading: html.includes("Card details"),
      sandbox: html.includes(">Sandbox<"),
      loading: html.includes('aria-busy="true"'),
      noNav: html.includes("Main navigation"),
      noSession: html.includes("session="),
    }).toEqual({
      heading: true,
      sandbox: true,
      loading: true,
      noNav: false,
      noSession: false,
    });
  });

  it("says plainly when the session is missing or expired", () => {
    // #when
    const page = text(renderToStaticMarkup(<RevealUnavailable />));

    // #then
    expect(page.includes("This link has expired or isn't valid.")).toBe(true);
  });

  it("keeps details masked until the reveal action, then offers to hide", () => {
    // #when
    const loading = fields({ ready: false, revealed: false });
    const masked = fields({ ready: true, revealed: false });
    const shown = fields({ ready: true, revealed: true });

    // #then
    expect({
      labels: ["Card number", "Expires", "CVV"].every((label) =>
        masked.includes(label),
      ),
      loadingDisabled: /<button[^>]*disabled=""/.test(loading),
      maskedAction: masked.includes(">Show details</button>"),
      shownAction: shown.includes(">Hide details</button>"),
    }).toEqual({
      labels: true,
      loadingDisabled: true,
      maskedAction: true,
      shownAction: true,
    });
  });
});

describe("the route's privacy settings", () => {
  it("sends no referrer and isn't indexed", async () => {
    // #given
    const { metadata } = await import("../page");
    const headers = (await nextConfig.headers?.()) ?? [];
    const route = headers.find(
      (rule: { source: string }) => rule.source === "/card-reveal",
    );

    // #then
    expect({
      robots: metadata.robots,
      referrer: metadata.referrer,
      header: route?.headers,
    }).toEqual({
      robots: { index: false, follow: false },
      referrer: "no-referrer",
      header: [{ key: "Referrer-Policy", value: "no-referrer" }],
    });
  });
});

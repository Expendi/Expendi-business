import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Providers } from "./providers";

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));
vi.mock("~/env", () => ({
  readPublicEnv: () => ({
    ok: true,
    env: {
      NEXT_PUBLIC_API_URL: "https://api.test",
      NEXT_PUBLIC_PRIVY_APP_ID: "app",
      NEXT_PUBLIC_PRIVY_CLIENT_ID: "client",
    },
  }),
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => (
    <div data-privy="">{children}</div>
  ),
}));
vi.mock("~/contexts/auth-context", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("~/contexts/company-context", () => ({
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function render(pathname: string): string {
  navigation.pathname = pathname;
  return renderToStaticMarkup(
    <Providers>
      <p>page</p>
    </Providers>,
  );
}

describe("Providers", () => {
  beforeEach(() => {
    navigation.pathname = "/";
  });

  it("keeps Privy and every provider off the card reveal page", () => {
    expect({
      reveal: render("/card-reveal").includes("data-privy"),
      dashboard: render("/cards").includes("data-privy"),
    }).toEqual({ reveal: false, dashboard: true });
  });
});

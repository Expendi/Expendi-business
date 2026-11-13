import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StaffTreasuryMove } from "@expendi-business/shared";
import { STAFF_TREASURY_ACTIONS } from "@expendi-business/shared";

import {
  TREASURY_ACTION_COPY,
  TreasuryActionFlow,
} from "./treasury-action-flow";

vi.mock("~/contexts/staff-auth-context", () => ({
  useStaffAuth: () => ({ api: {} }),
}));

const MOVE = {
  id: "00000000-0000-4000-8000-000000000001",
} as StaffTreasuryMove;

const render = (kind: (typeof STAFF_TREASURY_ACTIONS)[number]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TreasuryActionFlow
        organizationId="00000000-0000-4000-8000-000000000002"
        move={MOVE}
        action={{ kind, amountUsdc: "20000000" }}
      />
    </QueryClientProvider>,
  );

describe("TreasuryActionFlow", () => {
  it.each(STAFF_TREASURY_ACTIONS)(
    "offers %s with what it does, before anything is asked",
    (kind) => {
      // #when
      const html = render(kind);

      // #then
      expect(html).toContain(TREASURY_ACTION_COPY[kind].button);
      expect(html).toContain(
        TREASURY_ACTION_COPY[kind].hint.replaceAll("'", "&#x27;"),
      );
      expect(html).not.toContain("Reason");
    },
  );

  it("words the two actions differently", () => {
    // #then
    expect(
      new Set(
        STAFF_TREASURY_ACTIONS.map(
          (kind) => TREASURY_ACTION_COPY[kind].confirm,
        ),
      ).size,
    ).toBe(STAFF_TREASURY_ACTIONS.length);
  });
});

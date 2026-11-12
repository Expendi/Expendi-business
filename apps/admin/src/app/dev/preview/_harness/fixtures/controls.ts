import type { CashOutProviderControl } from "@expendi-business/shared";

import { minutesAgo } from "./ids";

/** Paycrest active and Pretium ready: the Controls preview's default. */
export const CASH_OUT_PROVIDER: CashOutProviderControl = {
  activeProvider: "paycrest",
  changedAt: null,
  providers: [
    { provider: "paycrest", active: true, ready: true, problems: [] },
    { provider: "pretium", active: false, ready: true, problems: [] },
  ],
};

export const CASH_OUT_PROVIDER_PRETIUM_ACTIVE: CashOutProviderControl = {
  activeProvider: "pretium",
  changedAt: minutesAgo(95),
  providers: [
    { provider: "paycrest", active: false, ready: true, problems: [] },
    { provider: "pretium", active: true, ready: true, problems: [] },
  ],
};

export const CASH_OUT_PROVIDER_PRETIUM_NOT_READY: CashOutProviderControl = {
  activeProvider: "paycrest",
  changedAt: minutesAgo(60 * 24 * 3),
  providers: [
    { provider: "paycrest", active: true, ready: true, problems: [] },
    {
      provider: "pretium",
      active: false,
      ready: false,
      problems: [
        "Pretium didn't answer a request for its rate.",
        "Pretium's Base USDC settlement address is 0x1111111111111111111111111111111111111111, not 0x8005ee53e57ab11e11eaa4efe07ee3835dc02f98 where Expendi sends cash-out USDC. Don't send cash-outs through Pretium until someone checks this.",
      ],
    },
  ],
};

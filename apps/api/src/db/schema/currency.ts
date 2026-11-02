import { pgEnum } from "drizzle-orm/pg-core";

import { BILL_CURRENCIES } from "@expendi-business/shared";

/**
 * What a bill or recurring payment's amount is in (spec §6.19). Its own
 * module so bills and recurring items can share it without an import cycle.
 */
export const billCurrency = pgEnum("bill_currency", BILL_CURRENCIES);

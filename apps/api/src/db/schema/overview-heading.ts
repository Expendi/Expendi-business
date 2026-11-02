import { pgEnum } from "drizzle-orm/pg-core";

import { OVERVIEW_HEADINGS } from "@expendi-business/shared";

/**
 * The spending overview's four headings (spec §5, §6.24). Its own module so
 * expenses can reference bills, which also use it, without an import cycle.
 */
export const overviewHeading = pgEnum("overview_heading", OVERVIEW_HEADINGS);

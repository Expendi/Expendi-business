/** DEV PREVIEW — every area's fixtures and screens, in tab order. */
import type { PreviewArea, PreviewRoute, PreviewScreen } from "./types";
import { AUTH_AREA } from "./areas/auth";
import { BILLS_AREA } from "./areas/bills";
import { COMPANY_AREA } from "./areas/company";
import { EXPENSES_AREA } from "./areas/expenses";
import { HOME_AREA } from "./areas/home";
import { PAYROLL_AREA } from "./areas/payroll";
import { REVIEW_AREA } from "./areas/review";

const AREAS: readonly PreviewArea[] = [
  HOME_AREA,
  REVIEW_AREA,
  BILLS_AREA,
  EXPENSES_AREA,
  PAYROLL_AREA,
  COMPANY_AREA,
  AUTH_AREA,
];

export const PREVIEW_SCREENS: readonly PreviewScreen[] = AREAS.flatMap(
  (area) => area.screens,
);

/** A screen's own routes win over every area's shared fixtures. */
export function previewRoutes(screen: PreviewScreen): readonly PreviewRoute[] {
  return [...(screen.routes ?? []), ...AREAS.flatMap((area) => area.routes)];
}

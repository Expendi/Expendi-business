/**
 * DEV PREVIEW — renders real screens against fixture data on the simulator,
 * without signing in. Dev builds only; never imported by app code.
 */
import type { JSX } from "react";

import type { MembershipRole } from "@expendi-business/shared";

/** The request never answers, so the screen stays in its loading state. */
export const PREVIEW_PENDING = "__preview_pending__";
/** The request fails as if the phone were offline. */
export const PREVIEW_FAIL = "__preview_fail__";

export interface PreviewRoute {
  /** Matched against the GET path, query string included. */
  path: RegExp;
  /** Parsed with the screen's own schema, so stale fixtures fail loudly. */
  data: unknown;
}

export interface PreviewScreen {
  key: string;
  name: string;
  role: MembershipRole;
  /** The tab route it belongs to; omit for a pushed screen with no tab bar. */
  tab?: string;
  /** Checked before the area's routes, to show one state (empty, error…). */
  routes?: readonly PreviewRoute[];
  render: () => JSX.Element;
}

export interface PreviewArea {
  routes: readonly PreviewRoute[];
  screens: readonly PreviewScreen[];
}

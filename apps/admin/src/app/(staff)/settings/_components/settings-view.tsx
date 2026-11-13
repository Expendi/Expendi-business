import type { JSX } from "react";

import { PageHeader } from "~/components/data/page-header";
import { AppearanceSettings } from "./appearance-settings";

/** Each staff member's own settings; nothing here changes a company. */
export function SettingsView(): JSX.Element {
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Settings"
        subtitle="How the admin looks for you. Nothing here changes a company or what other staff see."
      />
      <AppearanceSettings />
    </section>
  );
}

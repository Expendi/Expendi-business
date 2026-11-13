import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PREFERENCE_DEFAULTS } from "~/lib/preferences/preferences-config";
import { PreferencesStoreProvider } from "~/stores/preferences/preferences-provider";
import { SettingsView } from "./settings-view";

describe("settings", () => {
  it("lets a staff member set how the admin looks in their browser", () => {
    // #when
    const html = renderToStaticMarkup(
      <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS} sidebarOpen>
        <SettingsView />
      </PreferencesStoreProvider>,
    );

    // #then
    expect({
      rows: [
        "Theme",
        "Colours",
        "Font",
        "Page width",
        "Header",
        "Sidebar style",
        "Collapsed sidebar",
      ].every((row) => html.includes(`>${row}<`)),
      fullWidth: /aria-checked="true"[^>]*>Full width</.test(html),
      restore: html.includes("Restore defaults"),
      scope: html.includes("Saved in this browser."),
    }).toEqual({ rows: true, fullWidth: true, restore: true, scope: true });
  });
});

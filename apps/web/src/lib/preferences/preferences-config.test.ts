import { describe, expect, it } from "vitest";

import { parsePreferences, PREFERENCE_DEFAULTS } from "./preferences-config";

describe("layout preferences", () => {
  it("starts a new browser on the brand look, full width", () => {
    // #when
    const values = parsePreferences(() => undefined);

    // #then
    expect(values).toEqual({
      theme_mode: "light",
      theme_preset: "default",
      font: "outfit",
      content_layout: "full-width",
      navbar_style: "sticky",
      sidebar_variant: "inset",
      sidebar_collapsible: "icon",
    });
  });

  it("keeps a saved choice and drops one it doesn't know", () => {
    // #given
    const saved: Record<string, string> = {
      content_layout: "centered",
      font: "comic-sans",
    };

    // #when
    const values = parsePreferences((key) => saved[key]);

    // #then
    expect(values).toEqual({
      ...PREFERENCE_DEFAULTS,
      content_layout: "centered",
    });
  });
});

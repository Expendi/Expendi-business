import type { CardEmbed, Styles } from "lithic-embed";
import LithicEmbed, { Environment } from "lithic-embed";

export interface CardFieldElements {
  readonly pan: Element;
  readonly cvv: Element;
  readonly expMonth: Element;
  readonly expYear: Element;
}

/** The embed's iframes can't load this site's font; the rest syncs from the page. */
const EMBED_STYLES: Styles = {
  "font-family": "system-ui, -apple-system, 'Segoe UI', sans-serif",
};

/**
 * Lithic's sandbox only: this app has no production card path. Details stay
 * masked until `toggleMasking`, and the session goes nowhere but the embed.
 */
export function mountCardEmbed(
  session: string,
  fields: CardFieldElements,
): { readonly embed: CardEmbed; readonly mounted: Promise<void> } {
  const embed = new LithicEmbed(Environment.SANDBOX).card(session);
  return {
    embed,
    mounted: embed.mount({
      pan: { element: fields.pan, styles: EMBED_STYLES },
      cvv: { element: fields.cvv, styles: EMBED_STYLES },
      expMonth: { element: fields.expMonth, styles: EMBED_STYLES },
      expYear: { element: fields.expYear, styles: EMBED_STYLES },
    }),
  };
}

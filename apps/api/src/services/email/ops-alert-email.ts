import type { OpsAlertDetail } from "../../db/schema/index.js";
import type { EmailMessage } from "./email-sender.js";
import { escapeHtml, oneLine } from "./invite-email.js";

export interface OpsAlertEmailInput {
  readonly to: string;
  readonly alertId: string;
  readonly title: string;
  readonly details: readonly OpsAlertDetail[];
  readonly openedAt: Date;
}

const FOOTER =
  "This alert emails once until it's resolved. Check it in the internal admin app.";

/**
 * An alert to the Expendi team (spec §6.16). Its idempotency key makes a
 * retried send after a crash deliver it once.
 */
export function opsAlertEmail(input: OpsAlertEmailInput): EmailMessage {
  const title = oneLine(input.title);
  const lines = [
    ...input.details.map(
      ({ label, value }) => `${oneLine(label)}: ${oneLine(value)}`,
    ),
    `Opened: ${input.openedAt.toISOString()}`,
  ];
  return {
    to: input.to,
    subject: `Expendi alert: ${title}`,
    text: `${title}\n\n${lines.join("\n")}\n\n${FOOTER}\n`,
    html: [
      `<p><strong>${escapeHtml(title)}</strong></p>`,
      `<p>${lines.map(escapeHtml).join("<br>")}</p>`,
      `<p>${escapeHtml(FOOTER)}</p>`,
    ].join("\n"),
    idempotencyKey: `ops-alert/${input.alertId}/${input.to}`,
  };
}

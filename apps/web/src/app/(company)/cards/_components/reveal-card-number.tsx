"use client";

import type { JSX } from "react";
import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import type { RevealSession } from "./cards-api";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldError } from "~/components/ui/field";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { useCardReveal } from "./cards-api";

/**
 * "Show card number" on a company-held card (spec §6.25): any admin, with a
 * fresh passkey. The number shows on the card details page in a new tab,
 * never in the dashboard. The passkey prompt uses up the click, so the
 * browser would block opening the tab itself: the admin opens it.
 */
export function RevealCardNumber({
  organizationId,
  cardId,
}: {
  organizationId: string;
  cardId: string;
}): JSX.Element {
  const [session, setSession] = useState<RevealSession | null>(null);
  const reveal = useCardReveal(organizationId, setSession);
  const passkey = useApprovalPasskeyStatus();
  const enrolled = passkey.data?.enrolled === true;

  if (session) {
    return (
      <div className="flex flex-col items-start gap-1.5" role="status">
        <Button asChild size="md">
          <a
            href={session.url}
            target="_blank"
            rel="noreferrer"
            onClick={() => setSession(null)}
          >
            <ExternalLinkIcon aria-hidden="true" />
            Open the card number
          </a>
        </Button>
        <FieldDescription>
          It opens in a new tab. The link works until{" "}
          {formatNairobiDateTime(session.expiresAt)}.
        </FieldDescription>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="md"
        disabled={reveal.isPending || !enrolled}
        onClick={() => {
          reveal.reset();
          reveal.mutate(cardId);
        }}
      >
        {reveal.isPending ? (
          "Waiting for your passkey…"
        ) : (
          <>
            <KeyRoundIcon aria-hidden="true" />
            Show card number
          </>
        )}
      </Button>
      {passkey.data?.enrolled === false ? (
        <FieldDescription>
          Seeing the number needs your approval passkey. Set it up in the
          Expendi Business app first.
        </FieldDescription>
      ) : null}
      {reveal.data?.status === "cancelled" ? (
        <FieldDescription>Cancelled. Nothing was shown.</FieldDescription>
      ) : null}
      {reveal.isError ? (
        <FieldError>{describeApprovalError(reveal.error)}</FieldError>
      ) : null}
    </div>
  );
}

"use client";

import type { JSX, ReactNode } from "react";
import { createContext, useContext, useState } from "react";

import type { TreasuryOffer } from "@expendi-business/shared";

import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import { treasuryOfferFrom } from "~/lib/approval";
import { prefillFromOffer } from "./treasury-display";
import { MoveSheet } from "./treasury-sheets";

type OpenOffer = (offer: TreasuryOffer) => void;

const TreasuryOfferContext = createContext<OpenOffer | null>(null);

interface Opened {
  /** New for each opening, so the sheet starts from the offer rather than the last move. */
  readonly nonce: number;
  readonly offer: TreasuryOffer;
}

/**
 * Lets any page that approves a payment offer "Move to wallet" when the API
 * refuses it for a short wallet (spec §5, "When the wallet is short"). The
 * sheet opens prefilled with the suggested amount and moves nothing until
 * the admin confirms it with their passkey. Only admins are offered it.
 */
export function TreasuryOfferProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { company, canAct } = useDashboard();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [open, setOpen] = useState(false);

  function openOffer(offer: TreasuryOffer) {
    setOpened((current) => ({ nonce: (current?.nonce ?? 0) + 1, offer }));
    setOpen(true);
  }

  return (
    <TreasuryOfferContext.Provider value={canAct ? openOffer : null}>
      {children}
      {canAct && opened ? (
        <MoveSheet
          key={opened.nonce}
          open={open}
          organizationId={company.organizationId}
          direction="to_wallet"
          rateBps={null}
          prefill={prefillFromOffer(opened.offer)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </TreasuryOfferContext.Provider>
  );
}

/**
 * "Move to wallet" beside a payment refusal that carries the API's offer;
 * nothing for any other refusal, or when the page can't offer it.
 */
export function TreasuryOfferButton({
  error,
}: {
  error: unknown;
}): JSX.Element | null {
  const openOffer = useContext(TreasuryOfferContext);
  const offer = treasuryOfferFrom(error);
  if (!offer || !openOffer) return null;
  return (
    <Button
      variant="outline"
      size="md"
      aria-haspopup="dialog"
      onClick={() => openOffer(offer)}
    >
      Move to wallet
    </Button>
  );
}

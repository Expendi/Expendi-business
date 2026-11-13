"use client";

import type { JSX } from "react";
import { DownloadIcon, PrinterIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { FundInChain, PublicInvoice } from "@expendi-business/shared";

import type { PayApiResult } from "./pay-api";
import type { PayState } from "./pay-panel";
import { ErrorState, Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { InvoiceDocument } from "./invoice-document";
import { createQuote, fetchInvoice, fetchQuote } from "./pay-api";
import { PayPanel } from "./pay-panel";

export type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; invoice: PublicInvoice }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

const POLL_INTERVAL_MS = 10_000;

function toLoadState(result: PayApiResult<PublicInvoice>): LoadState {
  if (result.ok) return { kind: "ready", invoice: result.data };
  return result.status === 404
    ? { kind: "not_found" }
    : { kind: "failed", message: result.message };
}

/** What the page shows for a given load and payment state. */
export function PayContent({
  publicId,
  load,
  pay,
  paidOnPage,
  onChoose,
  onRetry,
  onPrint,
}: {
  publicId: string;
  load: LoadState;
  pay: PayState;
  paidOnPage: boolean;
  onChoose: (chain: FundInChain) => void;
  onRetry: () => void;
  onPrint: () => void;
}): JSX.Element {
  return (
    <main className="min-h-dvh bg-gray-50 px-4 py-6 sm:py-10 print:bg-white print:p-0">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <Body
          publicId={publicId}
          load={load}
          pay={pay}
          paidOnPage={paidOnPage}
          onChoose={onChoose}
          onRetry={onRetry}
          onPrint={onPrint}
        />
      </div>
    </main>
  );
}

function Body({
  publicId,
  load,
  pay,
  paidOnPage,
  onChoose,
  onRetry,
  onPrint,
}: Parameters<typeof PayContent>[0]): JSX.Element {
  switch (load.kind) {
    case "loading":
      return (
        <div aria-busy="true" className="flex flex-col gap-4">
          <Skel width="100%" height={320} />
          <Skel width="100%" height={120} />
        </div>
      );
    case "not_found":
      return (
        <div className="rounded-panel border border-gray-200 bg-surface shadow-panel">
          <ErrorState title="This invoice link isn't valid">
            Check that you copied the whole link from the email, or ask the
            sender to send it again.
          </ErrorState>
        </div>
      );
    case "failed":
      return (
        <div className="rounded-panel border border-gray-200 bg-surface shadow-panel">
          <ErrorState title="Couldn't load this invoice" onRetry={onRetry}>
            {load.message}
          </ErrorState>
        </div>
      );
    case "ready":
      break;
  }

  const { invoice } = load;
  const paidHere = pay.kind === "quote" && pay.quote.status === "paid";
  const showPayPanel =
    (invoice.status === "open" && invoice.canPay) || paidHere;

  return (
    <>
      <InvoiceDocument
        invoice={invoice}
        receiptEmail={paidOnPage || paidHere ? invoice.billTo.email : undefined}
      />
      {showPayPanel ? (
        <PayPanel
          invoice={invoice}
          state={pay}
          receiptEmail={invoice.billTo.email}
          onChoose={onChoose}
        />
      ) : null}
      {invoice.status === "open" && !invoice.canPay ? (
        <p
          role="status"
          className="rounded-panel border border-gray-200 bg-surface p-5 text-sm text-gray-700 shadow-panel print:hidden"
        >
          {invoice.from.name} can&apos;t take payments through this link right
          now. Contact them to pay.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-center gap-2 print:hidden">
        <Button asChild variant="ghost">
          <a href={`/pay/${publicId}/pdf`}>
            <DownloadIcon aria-hidden="true" />
            Download PDF
          </a>
        </Button>
        <Button variant="ghost" onClick={onPrint}>
          <PrinterIcon aria-hidden="true" />
          Print or save as PDF
        </Button>
      </div>
    </>
  );
}

export function PayPage({ publicId }: { publicId: string }): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [pay, setPay] = useState<PayState>({ kind: "idle" });
  const [paidOnPage, setPaidOnPage] = useState(false);

  const reloadInvoice = useCallback(async (): Promise<void> => {
    setLoad(toLoadState(await fetchInvoice(publicId)));
  }, [publicId]);

  useEffect(() => {
    let active = true;
    void fetchInvoice(publicId).then((result) => {
      if (active) setLoad(toLoadState(result));
    });
    return () => {
      active = false;
    };
  }, [publicId]);

  useEffect(() => {
    if (load.kind === "ready") {
      document.title = `Invoice ${load.invoice.number}`;
    }
  }, [load]);

  const quote = pay.kind === "quote" ? pay.quote : null;
  const quoteId = quote?.id;
  const polling =
    quote?.status === "awaiting_deposit" || quote?.status === "processing";

  useEffect(() => {
    if (quoteId === undefined || !polling) return;
    let active = true;
    const timer = setInterval(() => {
      void fetchQuote(publicId, quoteId).then((result) => {
        if (!active || !result.ok) return;
        setPay({ kind: "quote", quote: result.data });
        if (result.data.status === "paid") {
          setPaidOnPage(true);
          void reloadInvoice();
        }
      });
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [publicId, quoteId, polling, reloadInvoice]);

  const choose = useCallback(
    async (chain: FundInChain): Promise<void> => {
      setPay({ kind: "creating", chain });
      const result = await createQuote(publicId, chain);
      setPay(
        result.ok
          ? { kind: "quote", quote: result.data }
          : { kind: "failed", chain, message: result.message },
      );
    },
    [publicId],
  );

  return (
    <PayContent
      publicId={publicId}
      load={load}
      pay={pay}
      paidOnPage={paidOnPage}
      onChoose={(chain) => void choose(chain)}
      onRetry={() => {
        setLoad({ kind: "loading" });
        void reloadInvoice();
      }}
      onPrint={() => window.print()}
    />
  );
}

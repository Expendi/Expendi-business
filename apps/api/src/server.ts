import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ConfigService } from "./config.js";
import { makeRuntime } from "./runtime.js";
import { alertChecksJob } from "./station/alert-checks.js";
import { billStatusJob } from "./station/bill-status.js";
import { cardReceiptRemindersJob } from "./station/card-receipt-reminders.js";
import { closeCardsJob } from "./station/close-cards.js";
import { confirmOnchainJob } from "./station/confirm-onchain.js";
import { fundInReturnsJob } from "./station/fund-in-returns.js";
import { fundInsJob } from "./station/fund-ins.js";
import { monthlyExportJob } from "./station/monthly-export.js";
import { nearDepositsJob } from "./station/near-deposits.js";
import {
  outboundQuotesJob,
  sweepTransitWalletsJob,
} from "./station/outbound-quotes.js";
import { payrollDraftsJob } from "./station/payroll-drafts.js";
import {
  pushNotificationsJob,
  pushReceiptsJob,
} from "./station/push-notifications.js";
import { reconcileLithicJob } from "./station/reconcile-lithic.js";
import { reconcilePaycrestJob } from "./station/reconcile-paycrest.js";
import { reconcilePretiumJob } from "./station/reconcile-pretium.js";
import { recurringBillsJob } from "./station/recurring-bills.js";
import { spendingRemindersJob } from "./station/reminders.js";
import { startStation } from "./station/scheduler.js";
import { treasuryMovesJob } from "./station/treasury-moves.js";
import { treasurySnapshotsJob } from "./station/treasury-snapshots.js";
import { zohoSyncJob } from "./station/zoho-sync.js";

const runtime = makeRuntime();
// The first run builds every layer: loads config (incl. Privy), connects to
// the database and runs its role check, all before accepting traffic.
const config = await runtime.runPromise(ConfigService);

const app = createApp({ runtime });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[server] Expendi Business API listening on port ${info.port}`);
});

const stopStation = startStation(
  runtime,
  [
    reconcilePaycrestJob,
    reconcilePretiumJob,
    confirmOnchainJob,
    billStatusJob,
    recurringBillsJob,
    payrollDraftsJob,
    monthlyExportJob,
    spendingRemindersJob,
    pushNotificationsJob,
    pushReceiptsJob,
    zohoSyncJob,
    alertChecksJob,
    closeCardsJob,
    reconcileLithicJob,
    cardReceiptRemindersJob,
    nearDepositsJob,
    fundInsJob,
    fundInReturnsJob,
    outboundQuotesJob,
    sweepTransitWalletsJob,
    treasuryMovesJob,
    treasurySnapshotsJob,
  ],
  config.databaseUrl,
);

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[server] ${signal} received, shutting down`);
  server.close((closeError) => {
    if (closeError) console.error("[server] close failed", closeError);
    stopStation()
      .then(() => runtime.dispose())
      .then(
        () => process.exit(closeError ? 1 : 0),
        (disposeError: unknown) => {
          console.error("[server] runtime dispose failed", disposeError);
          process.exit(1);
        },
      );
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

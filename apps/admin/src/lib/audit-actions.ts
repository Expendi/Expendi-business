/**
 * What the audit log's action codes mean, for the actions staff look for
 * most. An action with no label here is shown as its code alone.
 */
const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "treasury.turned_on": "Treasury turned on",
  "treasury_move.started": "Treasury move started",
  "treasury_move.completed": "Treasury move completed",
  "treasury_move.returned": "Treasury move returned to the company wallet",
  "treasury_move.failed": "Treasury move failed",
  "treasury_move.needs_review": "Treasury move needs review",
  "treasury_move.return_started": "Treasury return started",
  "wallet.treasury_returned": "Treasury USDC credited to the company wallet",
  "card_simulation.made": "Sandbox Card purchase made as the merchant",
  "card_simulation.outcome_unknown":
    "Sandbox Card purchase tried; Lithic didn't answer, so whether it was made is unknown",
};

export function auditActionLabel(action: string): string | null {
  return AUDIT_ACTION_LABELS[action] ?? null;
}

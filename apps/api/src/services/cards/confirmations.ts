import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";

import type { CardAction } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Card } from "../../db/schema/index.js";
import type {
  BadRequest,
  Conflict,
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
  ConfirmationPurpose,
} from "../approval/passkeys.js";
import type { Lithic } from "../lithic/lithic-client.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { CardLoadView, CardView } from "./views.js";
import { withScope } from "../../db/scope.js";
import { Forbidden } from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { checkIssueCompanyCard, issueCompanyCard } from "./company-held.js";
import { checkIssue, issueCard } from "./issue.js";
import { issuerFailure, requireIssuer } from "./issuer.js";
import { checkLoad, loadCardBalance } from "./loads.js";
import {
  checkRaise,
  checkUnfreeze,
  raiseCardLimit,
  readCardRow,
  refuseIfClosed,
  unfreezeCard,
  userActor,
} from "./manage.js";

/**
 * Card actions that need a passkey (spec §6.25, §7.3). Every action goes
 * through both steps: `start` checks it can happen and issues a challenge
 * bound to exactly this action; `confirm` is sent the same action with the
 * signature, recomputes the hash and refuses anything but what was signed,
 * and checks again before doing it.
 */

type ConfirmError =
  | BadRequest
  | Forbidden
  | NotFound
  | Conflict
  | ServiceUnavailable
  | DatabaseError;

type ConfirmDeps =
  DatabaseService | AuditLog | ApprovalSettings | Lithic | Paycrest | Pretium;

export type CardActionResultView =
  | {
      readonly type:
        "issue_card" | "issue_company_card" | "raise_limit" | "unfreeze_card";
      readonly card: CardView;
    }
  | { readonly type: "load_balance"; readonly load: CardLoadView }
  | {
      readonly type: "reveal_card";
      readonly revealUrl: string;
      readonly expiresAt: Date;
    };

const PURPOSES = {
  issue_card: "manage_cards",
  issue_company_card: "manage_cards",
  raise_limit: "manage_cards",
  unfreeze_card: "manage_cards",
  load_balance: "load_card_balance",
  reveal_card: "reveal_card",
} as const satisfies Record<CardAction["type"], ConfirmationPurpose>;

const adminsOnly = new Forbidden({
  message: "Your role in this company can't do this",
});
const notWhatWasConfirmed = new Forbidden({
  message: "That isn't what you confirmed. Confirm again.",
});
const holderOnly = new Forbidden({
  message: "Only the person holding this card can see its details.",
});
const companyAdminsOnly = new Forbidden({
  message: "Only an admin can see a company-held card's details.",
});

export function cardIntentHash(tenant: Tenant, action: CardAction): string {
  return sha256Hex(
    canonicalJson({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action,
    }),
  );
}

function refuseUnlessAllowed(
  tenant: Tenant,
  action: CardAction,
): Effect.Effect<void, Forbidden> {
  return action.type !== "reveal_card" && tenant.role !== "admin"
    ? Effect.fail(adminsOnly)
    : Effect.void;
}

/**
 * Only the holder, or any admin for a company-held card, which nobody
 * holds; never a card that's closed or on its way there.
 */
function checkReveal(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<
  Card,
  Forbidden | NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Lithic
> {
  return Effect.gen(function* () {
    yield* requireIssuer;
    const card = yield* readCardRow(tenant, cardId);
    if (card.companyHeld && tenant.role !== "admin") {
      return yield* Effect.fail(companyAdminsOnly);
    }
    if (!card.companyHeld && card.membershipId !== tenant.membershipId) {
      return yield* Effect.fail(holderOnly);
    }
    yield* refuseIfClosed(card);
    return card;
  });
}

function check(
  tenant: Tenant,
  action: CardAction,
): Effect.Effect<
  void,
  ConfirmError,
  DatabaseService | Lithic | Paycrest | Pretium
> {
  switch (action.type) {
    case "issue_card":
      return Effect.asVoid(checkIssue(tenant, action));
    case "issue_company_card":
      return Effect.asVoid(checkIssueCompanyCard(tenant, action));
    case "raise_limit":
      return Effect.asVoid(
        Effect.zipRight(requireIssuer, checkRaise(tenant, action)),
      );
    case "unfreeze_card":
      return Effect.asVoid(
        Effect.zipRight(requireIssuer, checkUnfreeze(tenant, action)),
      );
    case "load_balance":
      return Effect.zipRight(requireIssuer, checkLoad(tenant, action));
    case "reveal_card":
      return Effect.asVoid(checkReveal(tenant, action.cardId));
  }
}

export function startCardConfirmation(
  tenant: Tenant,
  action: CardAction,
): Effect.Effect<ApprovalChallenge, ConfirmError, ConfirmDeps> {
  return Effect.gen(function* () {
    yield* refuseUnlessAllowed(tenant, action);
    yield* check(tenant, action);
    return yield* startApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: PURPOSES[action.type],
      intentHash: cardIntentHash(tenant, action),
    });
  });
}

/** The session stays out of the audit entry: it opens the card's number. */
function revealCard(
  tenant: Tenant,
  cardId: string,
  approvalId: string,
): Effect.Effect<
  Extract<CardActionResultView, { type: "reveal_card" }>,
  Forbidden | NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  return Effect.gen(function* () {
    const card = yield* checkReveal(tenant, cardId);
    const lithic = yield* requireIssuer;
    const audit = yield* AuditLog;
    const { session, expiresAt } = yield* lithic
      .createEmbedSession(card.lithicCardToken)
      .pipe(
        Effect.catchTag("LithicError", (error) =>
          Effect.fail(issuerFailure(error)),
        ),
      );
    yield* withScope(tenant, (tx) =>
      audit.record(tx, {
        actor: userActor(tenant),
        organizationId: tenant.organizationId,
        action: "card.details_revealed",
        entity: { type: "card", id: card.id },
        after: { approvalId },
      }),
    );
    return {
      type: "reveal_card",
      revealUrl: `${lithic.revealOrigin}/card-reveal#session=${encodeURIComponent(session)}`,
      expiresAt,
    };
  });
}

function perform(
  tenant: Tenant,
  action: CardAction,
  approvalId: string,
): Effect.Effect<
  CardActionResultView,
  ConfirmError,
  DatabaseService | AuditLog | Lithic | Paycrest | Pretium
> {
  switch (action.type) {
    case "issue_card":
      return issueCard(tenant, action, approvalId).pipe(
        Effect.map((card) => ({ type: action.type, card })),
      );
    case "issue_company_card":
      return issueCompanyCard(tenant, action, approvalId).pipe(
        Effect.map((card) => ({ type: action.type, card })),
      );
    case "raise_limit":
      return raiseCardLimit(tenant, action, approvalId).pipe(
        Effect.map((card) => ({ type: action.type, card })),
      );
    case "unfreeze_card":
      return unfreezeCard(tenant, action, approvalId).pipe(
        Effect.map((card) => ({ type: action.type, card })),
      );
    case "load_balance":
      return loadCardBalance(tenant, action, approvalId).pipe(
        Effect.map((load) => ({ type: action.type, load })),
      );
    case "reveal_card":
      return revealCard(tenant, action.cardId, approvalId);
  }
}

export function confirmCardAction(
  tenant: Tenant,
  input: {
    readonly challengeId: string;
    readonly action: CardAction;
    readonly response: AuthenticationResponseJSON;
  },
): Effect.Effect<CardActionResultView, ConfirmError, ConfirmDeps> {
  const { action } = input;
  return Effect.gen(function* () {
    yield* refuseUnlessAllowed(tenant, action);
    const approval = yield* verifyApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: PURPOSES[action.type],
      challengeId: input.challengeId,
      response: input.response,
    });
    if (cardIntentHash(tenant, action) !== approval.intentHash) {
      return yield* Effect.fail(notWhatWasConfirmed);
    }
    return yield* perform(tenant, action, approval.approvalId);
  });
}

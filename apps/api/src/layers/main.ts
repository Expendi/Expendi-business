import type { ConfigError } from "effect";
import { Layer } from "effect";

import type { ConfigService } from "../config.js";
import type { DatabaseService } from "../db/client.js";
import type { DatabaseError } from "../errors.js";
import type { AlchemyWebhook } from "../services/alchemy/alchemy-webhook.js";
import type { ApprovalSettings } from "../services/approval/passkeys.js";
import type { AuditLog } from "../services/audit/audit-log.js";
import type { PrivyAuth } from "../services/auth/privy-auth.js";
import type { BaseRpc } from "../services/chain/base-rpc.js";
import type { Paycrest } from "../services/paycrest/paycrest-client.js";
import type { WalletSettings } from "../services/wallet/company-wallet.js";
import type { PrivyWallets } from "../services/wallet/privy-wallets.js";
import { ConfigLive } from "../config.js";
import { DatabaseLive } from "../db/client.js";
import { AlchemyWebhookLive } from "../services/alchemy/alchemy-webhook.js";
import { ApprovalSettingsLive } from "../services/approval/passkeys.js";
import { AuditLogLive } from "../services/audit/audit-log.js";
import { PrivyAuthLive } from "../services/auth/privy-auth.js";
import { BaseRpcLive } from "../services/chain/base-rpc.js";
import { PaycrestLive } from "../services/paycrest/paycrest-client.js";
import { WalletSettingsLive } from "../services/wallet/company-wallet.js";
import { PrivyWalletsLive } from "../services/wallet/privy-wallets.js";

export type AppDeps =
  | ConfigService
  | DatabaseService
  | AuditLog
  | PrivyAuth
  | PrivyWallets
  | WalletSettings
  | AlchemyWebhook
  | BaseRpc
  | Paycrest
  | ApprovalSettings;
export type AppLayerError = ConfigError.ConfigError | DatabaseError;

/** Everything outside the API and its database. Tests swap in fakes. */
export interface ExternalLayers {
  readonly privyAuth: Layer.Layer<PrivyAuth, AppLayerError>;
  readonly privyWallets: Layer.Layer<PrivyWallets, AppLayerError>;
  readonly walletSettings: Layer.Layer<WalletSettings, AppLayerError>;
  readonly alchemyWebhook: Layer.Layer<AlchemyWebhook, AppLayerError>;
  readonly baseRpc: Layer.Layer<BaseRpc, AppLayerError>;
  readonly paycrest: Layer.Layer<Paycrest, AppLayerError>;
  readonly approvalSettings: Layer.Layer<ApprovalSettings, AppLayerError>;
}

export const LiveExternalLayers: ExternalLayers = {
  privyAuth: PrivyAuthLive,
  privyWallets: PrivyWalletsLive,
  walletSettings: WalletSettingsLive,
  alchemyWebhook: AlchemyWebhookLive,
  baseRpc: BaseRpcLive,
  paycrest: PaycrestLive,
  approvalSettings: ApprovalSettingsLive,
};

export function makeAppLayer(
  external: ExternalLayers,
): Layer.Layer<AppDeps, AppLayerError> {
  return Layer.mergeAll(
    DatabaseLive,
    AuditLogLive,
    external.privyAuth,
    external.privyWallets,
    external.walletSettings,
    external.alchemyWebhook,
    external.baseRpc,
    external.paycrest,
    external.approvalSettings,
  ).pipe(Layer.provideMerge(ConfigLive));
}

export const MainLayer: Layer.Layer<AppDeps, AppLayerError> =
  makeAppLayer(LiveExternalLayers);

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
import type { EmailSender } from "../services/email/email-sender.js";
import type { ReceiptExtractor } from "../services/extraction/receipt-extractor.js";
import type { Paycrest } from "../services/paycrest/paycrest-client.js";
import type { OtpProvider } from "../services/phone-verification/otp-provider.js";
import type { FileStorage } from "../services/storage/file-storage.js";
import type { WalletSettings } from "../services/wallet/company-wallet.js";
import type { PrivyWallets } from "../services/wallet/privy-wallets.js";
import type { ZohoAccessTokens } from "../services/zoho/access-tokens.js";
import type { AccountingTokenKey } from "../services/zoho/token-crypto.js";
import type { Zoho } from "../services/zoho/zoho-client.js";
import { ConfigLive } from "../config.js";
import { DatabaseLive } from "../db/client.js";
import { AlchemyWebhookLive } from "../services/alchemy/alchemy-webhook.js";
import { ApprovalSettingsLive } from "../services/approval/passkeys.js";
import { AuditLogLive } from "../services/audit/audit-log.js";
import { PrivyAuthLive } from "../services/auth/privy-auth.js";
import { BaseRpcLive } from "../services/chain/base-rpc.js";
import { EmailSenderLive } from "../services/email/email-sender.js";
import { ReceiptExtractorLive } from "../services/extraction/receipt-extractor.js";
import { PaycrestLive } from "../services/paycrest/paycrest-client.js";
import { OtpProviderLive } from "../services/phone-verification/telnyx-verify.js";
import { FileStorageLive } from "../services/storage/r2.js";
import { WalletSettingsLive } from "../services/wallet/company-wallet.js";
import { PrivyWalletsLive } from "../services/wallet/privy-wallets.js";
import { ZohoAccessTokensLive } from "../services/zoho/access-tokens.js";
import { AccountingTokenKeyLive } from "../services/zoho/token-crypto.js";
import { ZohoLive } from "../services/zoho/zoho-client.js";

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
  | ApprovalSettings
  | EmailSender
  | OtpProvider
  | FileStorage
  | ReceiptExtractor
  | Zoho
  | ZohoAccessTokens
  | AccountingTokenKey;
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
  readonly emailSender: Layer.Layer<EmailSender, AppLayerError>;
  readonly otpProvider: Layer.Layer<OtpProvider, AppLayerError>;
  readonly fileStorage: Layer.Layer<FileStorage, AppLayerError>;
  readonly receiptExtractor: Layer.Layer<ReceiptExtractor, AppLayerError>;
  readonly zoho: Layer.Layer<Zoho, AppLayerError>;
}

export const LiveExternalLayers: ExternalLayers = {
  privyAuth: PrivyAuthLive,
  privyWallets: PrivyWalletsLive,
  walletSettings: WalletSettingsLive,
  alchemyWebhook: AlchemyWebhookLive,
  baseRpc: BaseRpcLive,
  paycrest: PaycrestLive,
  approvalSettings: ApprovalSettingsLive,
  emailSender: EmailSenderLive,
  otpProvider: OtpProviderLive,
  fileStorage: FileStorageLive,
  receiptExtractor: ReceiptExtractorLive,
  zoho: ZohoLive,
};

export function makeAppLayer(
  external: ExternalLayers,
): Layer.Layer<AppDeps, AppLayerError> {
  return Layer.mergeAll(
    DatabaseLive,
    AuditLogLive,
    ZohoAccessTokensLive,
    AccountingTokenKeyLive,
    external.privyAuth,
    external.privyWallets,
    external.walletSettings,
    external.alchemyWebhook,
    external.baseRpc,
    external.paycrest,
    external.approvalSettings,
    external.emailSender,
    external.otpProvider,
    external.fileStorage,
    external.receiptExtractor,
    external.zoho,
  ).pipe(Layer.provideMerge(ConfigLive));
}

export const MainLayer: Layer.Layer<AppDeps, AppLayerError> =
  makeAppLayer(LiveExternalLayers);

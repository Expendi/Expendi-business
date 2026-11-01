import { randomBytes } from "node:crypto";

import type { TransactionReceipt } from "../../services/chain/base.js";
import {
  ERC20_TRANSFER_TOPIC,
  USDC_BASE_ADDRESS,
} from "../../services/chain/base.js";

export const randomTxHash = (): string =>
  `0x${randomBytes(32).toString("hex")}`;

const topicFor = (address: string): string =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

const word = (amount: bigint): string =>
  `0x${amount.toString(16).padStart(64, "0")}`;

export interface TransferLogInput {
  readonly to: string;
  readonly amount: bigint;
  readonly from?: string;
  readonly contract?: string;
  readonly logIndex?: number;
}

/** A Base receipt with one ERC-20 Transfer log per entry. */
export function transferReceipt(
  transfers: readonly TransferLogInput[],
  options: { readonly txHash?: string; readonly status?: string } = {},
): TransactionReceipt {
  return {
    transactionHash: options.txHash ?? randomTxHash(),
    status: options.status ?? "0x1",
    blockNumber: "0x1b4",
    logs: transfers.map((transfer, index) => ({
      address: transfer.contract ?? USDC_BASE_ADDRESS,
      topics: [
        ERC20_TRANSFER_TOPIC,
        topicFor(transfer.from ?? `0x${"ab".repeat(20)}`),
        topicFor(transfer.to),
      ],
      data: word(transfer.amount),
      logIndex: `0x${(transfer.logIndex ?? index).toString(16)}`,
    })),
  };
}

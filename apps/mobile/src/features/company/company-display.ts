import type { FloatSummary, WalletResponse } from "@expendi-business/shared";
import { spendableUsdc } from "@expendi-business/shared";

import { formatKesCents, formatUsdc } from "../../lib/money";
import { openFloatLeft } from "../overview/overview-display";

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** Active people and invites still waiting, from the member list. */
export function memberCounts(members: readonly { status: string }[]): {
  active: number;
  invited: number;
} {
  return {
    active: members.filter((member) => member.status === "active").length,
    invited: members.filter((member) => member.status === "invited").length,
  };
}

/** "9 members · 1 invite pending". */
export function teamMeta(counts: { active: number; invited: number }): string {
  const people = plural(counts.active, "member", "members");
  return counts.invited === 0
    ? people
    : `${people} · ${plural(counts.invited, "invite", "invites")} pending`;
}

/** "Admin · 9 members", or just the role until the members arrive. */
export function companyCardMeta(
  roleLabel: string,
  activeMembers: number | null,
): string {
  return activeMembers === null
    ? roleLabel
    : `${roleLabel} · ${plural(activeMembers, "member", "members")}`;
}

/** "2 open · 13,620.00 with staff", or that nothing is out. */
export function floatsMeta(
  floats: readonly Pick<FloatSummary, "status" | "leftKes">[],
): string {
  const open = floats.filter((row) => row.status === "open").length;
  if (open === 0) return "No open floats";
  return `${String(open)} open · ${formatKesCents(openFloatLeft(floats))} with staff`;
}

/** "3,412.58 USDC · KES 440,222.82", or why there is no KES figure. */
export function walletMeta(wallet: WalletResponse): string {
  if (wallet.status === "creating") return "Setting up";
  const usdc = `${formatUsdc(spendableUsdc(wallet))} USDC`;
  return wallet.kesEquivalent
    ? `${usdc} · KES ${formatKesCents(wallet.kesEquivalent.kesCents)}`
    : `${usdc} · KES rate unavailable`;
}

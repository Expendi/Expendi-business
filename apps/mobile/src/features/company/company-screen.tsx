import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Banknote,
  Contact,
  CreditCard,
  Download,
  ReceiptText,
  Users,
  Wallet,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import type { MeResponse } from "@expendi-business/shared";

import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { useCompanyWallet } from "~/features/wallet/use-company-wallet";
import { useFloats } from "~/features/petty-cash/use-floats";
import { useMembers } from "~/features/team/use-members";
import { usePayees } from "~/features/payees/use-payees";
import { AccountSection } from "./account-section";
import { CompanyCard } from "./company-card";
import {
  floatsMeta,
  memberCounts,
  teamMeta,
  walletMeta,
} from "./company-display";
import type { Company } from "./company-provider";

const ACTIVE_PAYEES = { kind: null, method: null, archived: false } as const;

/**
 * The admin's Company tab: the company, where its money and people are
 * managed, the admin's own work, and their account.
 */
export function CompanyScreen({
  me,
  company,
  canSwitch,
  onSignOut,
}: {
  me: MeResponse;
  company: Company;
  canSwitch: boolean;
  onSignOut: () => Promise<void>;
}): JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const orgId = company.organizationId;
  const wallet = useCompanyWallet(orgId);
  const floats = useFloats(orgId, { mine: false });
  const members = useMembers(orgId);
  const payees = usePayees(orgId, ACTIVE_PAYEES);
  const [refreshing, setRefreshing] = useState(false);
  const { refetch: refetchWallet } = wallet;
  const { refetch: refetchFloats } = floats;
  const { refetch: refetchMembers } = members;
  const { refetch: refetchPayees } = payees;
  useFocusEffect(
    useCallback(() => {
      void refetchWallet();
      void refetchFloats();
      void refetchMembers();
      void refetchPayees();
    }, [refetchWallet, refetchFloats, refetchMembers, refetchPayees]),
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId],
      });
    } finally {
      setRefreshing(false);
    }
  }

  const counts = members.data ? memberCounts(members.data) : null;

  return (
    <TabScreen
      title="Company"
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    >
      <CompanyCard
        company={company}
        memberCount={counts?.active ?? null}
        canSwitch={canSwitch}
      />

      <View className="mt-7">
        <SectionHeader title="Money" />
        <SoftGroup>
          <ItemRow
            title="Wallet"
            meta={wallet.data ? walletMeta(wallet.data) : undefined}
            icon={Wallet}
            onPress={() => router.push("/wallet")}
          />
          <ItemRow
            title="Petty cash floats"
            meta={floats.data ? floatsMeta(floats.data.floats) : undefined}
            icon={Banknote}
            onPress={() => router.push("/petty-cash/floats")}
          />
          <ItemRow
            title="Monthly export"
            meta="Share reports and receipts"
            icon={Download}
            onPress={() => router.push("/export")}
          />
        </SoftGroup>
      </View>

      <View className="mt-7">
        <SectionHeader title="People" />
        <SoftGroup>
          <ItemRow
            title="Team"
            meta={counts ? teamMeta(counts) : "Invitations and company roles"}
            icon={Users}
            onPress={() => router.push("/team")}
          />
          <ItemRow
            title="Payees"
            meta={
              payees.data
                ? `${String(payees.data.length)} ${payees.data.length === 1 ? "payee" : "payees"}`
                : "Suppliers and payment details"
            }
            icon={Contact}
            onPress={() => router.push("/payees")}
          />
        </SoftGroup>
      </View>

      <View className="mt-7">
        <SectionHeader title="Your work" />
        <SoftGroup>
          <ItemRow
            title="Reimbursements"
            meta="Everyone’s, and your own"
            icon={ReceiptText}
            onPress={() => router.push("/claims")}
          />
          <ItemRow
            title="My Expendi cards"
            meta="Your cards, purchases and receipts"
            icon={CreditCard}
            onPress={() => router.push("/cards")}
          />
          <ItemRow
            title="My petty cash"
            meta="Your float balance and spending"
            icon={Wallet}
            onPress={() => router.push("/petty-cash")}
          />
          <ItemRow
            title="My salary payments"
            meta="Your pay from this company"
            icon={Banknote}
            onPress={() => router.push("/salary-payments")}
          />
        </SoftGroup>
      </View>

      <View className="mt-7">
        <AccountSection me={me} showPerson onSignOut={onSignOut} />
      </View>
    </TabScreen>
  );
}

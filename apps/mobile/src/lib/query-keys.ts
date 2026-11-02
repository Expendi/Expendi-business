export const queryKeys = {
  me: (privyUserId: string | null) => ["me", privyUserId] as const,
  allMe: ["me"] as const,
  selectedCompany: (userId: string | undefined) =>
    ["selected-company", userId] as const,
  /** Prefix of the balance and the history, so one invalidation refreshes both. */
  wallet: (organizationId: string) =>
    ["organizations", organizationId, "wallet"] as const,
  walletHistory: (organizationId: string) =>
    ["organizations", organizationId, "wallet", "history"] as const,
  withdrawalAddresses: (organizationId: string) =>
    ["organizations", organizationId, "withdrawal-addresses"] as const,
  approvalPasskey: ["approval-passkey"] as const,
  members: (organizationId: string) =>
    ["organizations", organizationId, "members"] as const,
  organization: (organizationId: string) =>
    ["organizations", organizationId, "details"] as const,
  categories: (organizationId: string) =>
    ["organizations", organizationId, "categories"] as const,
  /** Prefix of every claim list and claim, so one invalidation refreshes both. */
  claims: (organizationId: string) =>
    ["organizations", organizationId, "claims"] as const,
  claimList: (organizationId: string) =>
    ["organizations", organizationId, "claims", "list"] as const,
  claim: (organizationId: string, claimId: string) =>
    ["organizations", organizationId, "claims", "detail", claimId] as const,
  /** Prefix of every payee list and payee, so one invalidation refreshes both. */
  payees: (organizationId: string) =>
    ["organizations", organizationId, "payees"] as const,
  payeeList: (
    organizationId: string,
    filters: {
      readonly kind: string | null;
      readonly method: string | null;
      readonly archived: boolean;
    },
  ) => ["organizations", organizationId, "payees", "list", filters] as const,
  payee: (organizationId: string, payeeId: string) =>
    ["organizations", organizationId, "payees", "detail", payeeId] as const,
  payeeBanks: (organizationId: string) =>
    ["organizations", organizationId, "payee-banks"] as const,
  /** Prefix of every bill list and bill, so one invalidation refreshes both. */
  bills: (organizationId: string) =>
    ["organizations", organizationId, "bills"] as const,
  billList: (organizationId: string, view: "open" | "history") =>
    ["organizations", organizationId, "bills", "list", view] as const,
  bill: (organizationId: string, billId: string) =>
    ["organizations", organizationId, "bills", "detail", billId] as const,
  /** Prefix of the recurring payment list and each one, so one invalidation refreshes both. */
  recurringItems: (organizationId: string) =>
    ["organizations", organizationId, "recurring-items"] as const,
  recurringItemList: (organizationId: string) =>
    ["organizations", organizationId, "recurring-items", "list"] as const,
  recurringItem: (organizationId: string, itemId: string) =>
    [
      "organizations",
      organizationId,
      "recurring-items",
      "detail",
      itemId,
    ] as const,
};

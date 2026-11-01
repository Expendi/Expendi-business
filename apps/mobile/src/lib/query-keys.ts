export const queryKeys = {
  me: (privyUserId: string | null) => ["me", privyUserId] as const,
  allMe: ["me"] as const,
  selectedCompany: (userId: string | undefined) =>
    ["selected-company", userId] as const,
  wallet: (organizationId: string) =>
    ["organizations", organizationId, "wallet"] as const,
  members: (organizationId: string) =>
    ["organizations", organizationId, "members"] as const,
};

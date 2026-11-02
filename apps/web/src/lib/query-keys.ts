export const queryKeys = {
  me: (privyUserId: string) => ["me", privyUserId] as const,
};

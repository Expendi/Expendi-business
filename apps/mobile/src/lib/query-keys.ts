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
  fundIns: (organizationId: string) =>
    ["organizations", organizationId, "wallet", "fund-ins"] as const,
  fundIn: (organizationId: string, fundInId: string) =>
    ["organizations", organizationId, "wallet", "fund-ins", fundInId] as const,
  withdrawalAddresses: (organizationId: string) =>
    ["organizations", organizationId, "withdrawal-addresses"] as const,
  approvalPasskey: ["approval-passkey"] as const,
  members: (organizationId: string) =>
    ["organizations", organizationId, "members"] as const,
  organization: (organizationId: string) =>
    ["organizations", organizationId, "details"] as const,
  categories: (organizationId: string) =>
    ["organizations", organizationId, "categories"] as const,
  /** Prefix of the admin's overview for every month. */
  overview: (organizationId: string) =>
    ["organizations", organizationId, "overview"] as const,
  overviewMonth: (organizationId: string, month: string) =>
    ["organizations", organizationId, "overview", month] as const,
  /** Prefix of every claim list and claim, so one invalidation refreshes both. */
  claims: (organizationId: string) =>
    ["organizations", organizationId, "claims"] as const,
  claimList: (organizationId: string) =>
    ["organizations", organizationId, "claims", "list"] as const,
  /** The admin's queue: one status, under `claimList` so its invalidation covers it. */
  claimQueue: (organizationId: string, status: string) =>
    ["organizations", organizationId, "claims", "list", status] as const,
  /** Preparing Approve & pay; outside `claims` so refreshing claims never prepares again. */
  claimPayment: (organizationId: string, claimId: string, retry: boolean) =>
    ["organizations", organizationId, "claim-payment", claimId, retry] as const,
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
  /** Preparing Pay / Pay all; outside `bills` so refreshing bills never prepares again. */
  billPayment: (
    organizationId: string,
    billIds: string,
    retry: boolean,
    secondConfirmation: boolean,
  ) =>
    [
      "organizations",
      organizationId,
      "bill-payment",
      billIds,
      retry,
      secondConfirmation,
    ] as const,
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
  /** Prefix of every company spending list and record, so one invalidation refreshes both. */
  companySpending: (organizationId: string) =>
    ["organizations", organizationId, "company-spending"] as const,
  companySpendingList: (
    organizationId: string,
    filters: { readonly heading: string | null },
  ) =>
    [
      "organizations",
      organizationId,
      "company-spending",
      "list",
      filters,
    ] as const,
  companySpendingItem: (organizationId: string, spendingId: string) =>
    [
      "organizations",
      organizationId,
      "company-spending",
      "detail",
      spendingId,
    ] as const,
  /** Prefix of both paid-from account lists. */
  paidFromAccounts: (organizationId: string) =>
    ["organizations", organizationId, "paid-from-accounts"] as const,
  paidFromAccountList: (organizationId: string, archived: boolean) =>
    ["organizations", organizationId, "paid-from-accounts", archived] as const,
  /** Prefix of salaries and payroll runs: a salary change can draft a run. */
  payroll: (organizationId: string) =>
    ["organizations", organizationId, "payroll"] as const,
  salaryList: (organizationId: string) =>
    ["organizations", organizationId, "payroll", "salaries"] as const,
  salary: (organizationId: string, salaryId: string) =>
    ["organizations", organizationId, "payroll", "salaries", salaryId] as const,
  payrollRunList: (organizationId: string) =>
    ["organizations", organizationId, "payroll", "runs"] as const,
  payrollRun: (organizationId: string, runId: string) =>
    ["organizations", organizationId, "payroll", "runs", runId] as const,
  /** Preparing Approve & pay all or one person's retry; outside `payroll` so refreshing never prepares again. */
  payrollPayment: (
    organizationId: string,
    runId: string,
    retryBillId: string | null,
    secondConfirmation: boolean,
  ) =>
    [
      "organizations",
      organizationId,
      "payroll-payment",
      runId,
      retryBillId,
      secondConfirmation,
    ] as const,
  payrollMargin: (organizationId: string) =>
    ["organizations", organizationId, "payroll-margin"] as const,
  mySalaryPayments: (organizationId: string) =>
    ["organizations", organizationId, "my-salary-payments"] as const,
  /** Prefix of every float list and float, so one invalidation refreshes both. */
  floats: (organizationId: string) =>
    ["organizations", organizationId, "floats"] as const,
  floatList: (organizationId: string, mine: boolean) =>
    ["organizations", organizationId, "floats", "list", mine] as const,
  float: (organizationId: string, floatId: string) =>
    ["organizations", organizationId, "floats", "detail", floatId] as const,
  /** Prefix of cards and their purchases, so one invalidation refreshes both. */
  cards: (organizationId: string) =>
    ["organizations", organizationId, "cards"] as const,
  myCards: (organizationId: string) =>
    ["organizations", organizationId, "cards", "mine"] as const,
  /** Prefix of every loaded purchase list. */
  cardPurchaseLists: (organizationId: string) =>
    ["organizations", organizationId, "cards", "purchases", "list"] as const,
  cardPurchaseList: (
    organizationId: string,
    filters: {
      readonly cardId: string | null;
      readonly needsReceipt: boolean;
    },
  ) =>
    [
      "organizations",
      organizationId,
      "cards",
      "purchases",
      "list",
      filters,
    ] as const,
  cardPurchase: (organizationId: string, purchaseId: string) =>
    [
      "organizations",
      organizationId,
      "cards",
      "purchases",
      "detail",
      purchaseId,
    ] as const,
  /** Preparing a float payment; outside `floats` so refreshing floats never prepares again. */
  floatPayment: (organizationId: string, floatId: string, movementId: string) =>
    [
      "organizations",
      organizationId,
      "float-payment",
      floatId,
      movementId,
    ] as const,
};

import type { CashOutProvider } from "./provider.js";

export interface CashOutBank {
  /**
   * The code payees store: Paycrest's KES institution code, e.g. EQBLKENA.
   */
  readonly code: string;
  readonly name: string;
  /** Pretium's code for the bank; null when Pretium can't pay it. */
  readonly pretiumCode: string | null;
}

/**
 * Expendi's own list of banks a cash-out can reach, so a payee's bank
 * doesn't depend on any one provider's list. Taken from Paycrest's
 * `GET /v2/institutions/KES` (type "bank"), names as Paycrest gives them
 * unless customers know the bank by another (I&M Bank).
 * Pretium's codes come from its `POST /v1/banks/KES`, matched to these by
 * SWIFT code; a bank with no confirmed match stays null, since a guessed
 * code would send shillings to the wrong bank.
 */
export const CASH_OUT_BANKS: readonly CashOutBank[] = [
  { code: "KCBLKENX", name: "Kenya Commercial Bank", pretiumCode: "522522" },
  { code: "SCBLKENX", name: "Standard Chartered Kenya", pretiumCode: "329329" },
  { code: "CITIKENA", name: "Citi Bank", pretiumCode: "100229" },
  { code: "DTKEKENA", name: "Diamond Trust Bank", pretiumCode: "516600" },
  { code: "BARCKENX", name: "ABSA Bank Kenya", pretiumCode: "303030" },
  { code: "MIEKKENA", name: "Middle East Bank", pretiumCode: null },
  { code: "EQBLKENA", name: "Equity Bank", pretiumCode: "247247" },
  { code: "BARBKENA", name: "Bank of Baroda", pretiumCode: "902363" },
  { code: "AFRIKENX", name: "Bank of Africa", pretiumCode: null },
  { code: "SBICKENX", name: "Stanbic Bank Kenya", pretiumCode: "600100" },
  {
    code: "ABCLKENA",
    name: "African Bank Corporation Limited",
    pretiumCode: null,
  },
  { code: "ECOCKENA", name: "Ecobank Transnational Inc.", pretiumCode: null },
  { code: "CRMFKENA", name: "Caritas Microfinance Bank", pretiumCode: null },
  { code: "PAUTKENA", name: "Paramount Bank", pretiumCode: null },
  { code: "CIFIKENA", name: "Kingdom Bank Limited", pretiumCode: null },
  {
    code: "GTBIKENA",
    name: "Guaranty Trust Holding Company PLC",
    pretiumCode: "910200",
  },
  { code: "FABLKENA", name: "Family Bank", pretiumCode: "222111" },
  {
    code: "CBAFKENX",
    name: "National Commercial Bank of Africa",
    pretiumCode: "880100",
  },
  { code: "CONKKENA", name: "Consolidated Bank Kenya", pretiumCode: "508400" },
  { code: "HFCOKENA", name: "Housing finance Company", pretiumCode: null },
  {
    code: "MYBKKENA",
    name: "Commercial International Bank Kenya Limited",
    pretiumCode: "961610",
  },
  { code: "GAFRKENA", name: "Gulf African Bank", pretiumCode: "985050" },
  { code: "FCBAKEPC", name: "First Community Bank", pretiumCode: null },
  { code: "DUIBKENA", name: "Dubai Islamic Bank", pretiumCode: null },
  {
    code: "KWMIKENX",
    name: "Kenya Women Microfinance Bank",
    pretiumCode: "101200",
  },
  { code: "FAUMKENA", name: "Faulu Bank", pretiumCode: null },
  { code: "PRIEKENX", name: "Prime Bank Limited", pretiumCode: null },
  { code: "CRBTKENA", name: "Credit Bank Limited", pretiumCode: null },
  { code: "UNAIKEPC", name: "Unaitas Sacco", pretiumCode: null },
  { code: "GUARKENA", name: "Guardian Bank Limited", pretiumCode: null },
  { code: "IMBLKENA", name: "I&M Bank", pretiumCode: "542542" },
  { code: "SIDNKENA", name: "Sidian Bank", pretiumCode: null },
  { code: "UNAFKENA", name: "United Bank for Africa", pretiumCode: "559900" },
  {
    code: "KCOOKENA",
    name: "Cooperative Bank of Kenya",
    pretiumCode: "400200",
  },
  {
    code: "CHFIKENX",
    name: "Choice Microfinance Bank Kenya Limited",
    pretiumCode: null,
  },
  { code: "STIMKEPC", name: "Stima SACCO", pretiumCode: null },
  { code: "VICMKENA", name: "Victoria Commercial Bank", pretiumCode: null },
  {
    code: "MORBKENA",
    name: "Oriental Commercial Bank Limited",
    pretiumCode: null,
  },
  { code: "SBMKKENA", name: "SBM Bank Kenya", pretiumCode: "552800" },
  { code: "NBKEKENX", name: "National Bank of Kenya", pretiumCode: "547700" },
];

const BY_CODE = new Map(CASH_OUT_BANKS.map((bank) => [bank.code, bank]));

export function listCashOutBanks(): readonly {
  readonly code: string;
  readonly name: string;
}[] {
  return CASH_OUT_BANKS.map(({ code, name }) => ({ code, name }));
}

export function bankByCode(code: string): CashOutBank | null {
  return BY_CODE.get(code) ?? null;
}

/** The code `provider` knows the bank by, or null if it can't pay it. */
export function providerBankCode(
  provider: CashOutProvider,
  code: string,
): string | null {
  const bank = bankByCode(code);
  if (bank === null) return null;
  switch (provider) {
    case "paycrest":
      return bank.code;
    case "pretium":
      return bank.pretiumCode;
  }
}

export function providerCanPayBank(
  provider: CashOutProvider,
  code: string,
): boolean {
  return providerBankCode(provider, code) !== null;
}

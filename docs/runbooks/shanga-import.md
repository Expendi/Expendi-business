# Shanga spreadsheet onboarding

## Source inspection — 2026-11-02

Inspected all six TSV exports and all six sheets of `docs/shanga/Copy of Shanga Labs 2026 Accounts Q2.xlsx`, including formulas and cached values. No populated expense transactions were found. The workbook agrees with the TSV exports; it does not contain a separate set of hidden transaction sheets.

| Sheet                   | Findings                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy of infrastructure  | Column headings only.                                                                                                                                                        |
| Engineering - Money Out | Blank rows, repeated headings and a placeholder `Column 1`–`Column 9` row.                                                                                                   |
| Miscellaneous           | Blank rows and repeated headings.                                                                                                                                            |
| Personel                | Blank rows and repeated headings; later sections rename placeholder columns to Days in, price, per diem total and Total.                                                     |
| Subscriptions           | Blank transaction rows and repeated headings. Unnamed columns contain `10941-`, 10941 and summary formulas with cached values 10941 or 0. These are not individual payments. |
| Money In                | Blank rows and repeated income headings. Income is not an expense import kind.                                                                                               |

Ask the client for a populated export. Keep the originals unchanged and prepare a working copy with consistent column headings. Do not invent vendors, dates, owners or transactions from summary values.

## Ops workflow

1. Open the target company → **Import spreadsheet**.
2. Choose **Shanga expense sheets** under Spreadsheet layout.
3. Choose **Paid history**, **Unpaid claims**, or **bill**. Upload one UTF-8 CSV or TSV expense sheet per record type. Excel workbooks must first be exported one sheet at a time.
4. Check the suggested mappings. The preview reports original source line numbers, including gaps for blank lines and quoted multiline cells. Repeated headings, placeholder-only rows and summary-only cells outside named columns are reported as skipped. A headings-only file produces a “No transaction rows found” message.
5. Review the preview and totals with the founder before confirming.

Limits remain 512 KB and 500 non-empty records after the first header (including template/summary rows). The backend performs the same parsing and checks as Ops; preview does not write records, and commit remains transactional and deduplicated.

## Preparation and mapping decisions

| Source                                   | Destination / required decision                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expense Category                         | An existing active company category. Create categories first.                                                                                                                                                          |
| Vendor                                   | Merchant for history/claims; an existing payee for bills.                                                                                                                                                              |
| Item Description                         | Description.                                                                                                                                                                                                           |
| Date Purchased                           | Spending date for history/claims. Bills need a separate, confirmed Due Date column.                                                                                                                                    |
| Cost / Total / per diem totals           | Final transaction amount in decimal KES. Where Total or placeholder columns exist, no amount is selected automatically. Normalize personnel section headings first; do not assume a unit price is a transaction total. |
| Purchased By                             | Preserve as source information. Add Member Email matching an invited company employee/admin for history/claims; do not guess membership from a name.                                                                   |
| Status                                   | Confirm and normalize to `paid` or `unpaid`, then split files by record type. In Shanga mode the backend checks the original Status column even if it is not mapped. Blank/unknown status blocks import.               |
| Receipt Attached / Drive Link to Receipt | Source information only; these do not upload evidence or prove that a payment happened.                                                                                                                                |
| Payment Method                           | Source information only; it does not configure payment destinations or paid-from accounting accounts.                                                                                                                  |

Unpaid supplier liabilities belong in bills; employee reimbursements belong in claims. A personnel expense is not enough to establish a salary schedule. A historical subscription payment is not enough to establish a recurring payment instruction. Prepare those schedules separately using the standard importer and confirmed payees, dates and cadence.

Unmapped cells on transaction rows remain part of the source deduplication identity, including unnamed columns. Avoid changing source metadata between repeat imports; review duplicate warnings and reconcile against prior runs.

## Outstanding before client cutover

- Populated transaction exports and target company ID.
- Confirm currency, final amount, paid/unpaid meanings, member emails, vendors/categories, due dates and any intended schedules.
- Reconcile the history date range: the customer-import release removes the three-month cutoff for both Ops and customer imports; Q2 and earlier financial periods are supported. Future spending is still rejected.
- Founder reconciliation and explicit import confirmation.
- The original Shanga release `c45ea94` is deployed to Railway and Ops; see `docs/runbooks/customer-imports.md` for the subsequent self-service release.

No client records were imported during implementation. Anthropic receipt reading remains disabled. Company admins can import paid company expenses and unpaid bills in the customer-import release; claims, floats and schedules remain Ops-only. Imported history does not create payouts or sync to Zoho. The existing separate limitation for imported claims paid later (Zoho currently restricts claim sync to app-origin claims) is unchanged.

Customer paid-expense imports are recorded as company spending attributed to the importing admin, so they do not need Member Email. Ops historical claim imports retain their original member-email attribution. Use one workflow consistently for each dataset: changing record semantics between Ops and customer imports is not an update to an earlier import.

The customer importer can now preview and create missing categories and bill suppliers on confirmation. Leave **Create missing suppliers and categories when I confirm** enabled and review the proposed names. Existing active names are reused; archived and ambiguous matches require correction. Ops preparation requirements above still apply. See `customer-imports.md` for details.

## Verification

- Shared suite: 186 tests passed.
- API importer parser/routes: 20 tests passed against the dedicated local import-test database, including preview without writes, TSV commit, repeated-import deduplication, original source lines and payment-status rejection.
- All six supplied TSVs checked with the new parser: five report no transaction rows; Money In reports unsupported income.
- Shared/API/admin builds, API/admin typechecks and changed-file ESLint passed.

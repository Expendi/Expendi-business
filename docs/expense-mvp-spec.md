# Expendi Business: MVP Spec

**Status:** agreed 2026-11-01. For MVP scope this replaces Part 1 of the [implementation guide](implementation-guide.md); section 15 lists what changed.

**Changes since first agreed (all 2026-11-01):**

- **Zoho Books sync** (section 6.17), because the pilot's accountant keeps the books in Zoho Books.
- **Scope widened from staff claims to all company spending.** The pilot asked to see, at any moment, where money is going, what's paid, what's outstanding and what's due next, across petty cash, transactions, salaries and subscriptions. Expendi also pays these, because selling Expendi's payment infrastructure to businesses is core to the product.
  - New: sections 6.19–6.24
  - Updated: sections 1–7 and 9–15

---

## 1. What we're building

One app where a Kenyan startup sees and pays all of its spending:

- staff claims
- petty cash
- supplier payments
- subscriptions
- salaries

The company keeps its money as USD in a USDC wallet that Expendi holds. Expendi pays out in KES to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts, or in USDC to wallets.

At any moment the founder can see where the money is going, what has been paid, what is outstanding and what needs to be paid next (section 6.24).

**Why payments run through Expendi:** selling Expendi's payment infrastructure to businesses is core to what we're building. Tracking shows a company what it owes, and Expendi's payment rails are how it pays. Every payment made through the wallet also lands in the records automatically, so keeping the records costs the company no extra work.

The app serves many companies from day one: any company can sign up. One pilot company goes live first.

**Customer:** Kenyan startups with 5–50 staff that earn in USD and KES and pay staff and suppliers in KES. The founder or one ops person runs finance.

**How the pilot company works today:**

- Staff pay with personal M-Pesa and send a screenshot on WhatsApp. The founder approves informally and reimburses them by M-Pesa at month end.
- Petty cash, company transactions, salaries and subscriptions are all tracked in a spreadsheet.
- Their pain is chasing receipts and reconciling for the accountant.

The founder asked for something lightweight that shows, at any moment, where the money is going, what has been paid, what is outstanding and what needs to be paid next, including when each payment is due.

---

## 2. Goals

**Live** means the first real claim has been paid to an employee's M-Pesa through the app.

**Pilot success at 30 days:**

| Measure                  | Target                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spreadsheet              | Retired: petty cash, transactions, salaries and subscriptions are all tracked in the app                                                              |
| Due dates                | Every recurring payment (salaries, subscriptions, regular suppliers) is set up with its due date                                                      |
| Payments through Expendi | Salaries, petty cash and staff claims are paid through Expendi in the first month; the share of all money out paid through Expendi is measured weekly |
| Overview                 | The founder confirms that the overview's paid, outstanding and due-next figures match reality                                                         |
| Submit → paid            | Median under 24 hours (today it's month end)                                                                                                          |
| Accountant               | Accepts the monthly export and the Zoho Books entries without rework                                                                                  |
| eTIMS                    | Baseline measured: share of claims with an eTIMS receipt attached                                                                                     |

---

## 3. Scope

### In the MVP

**What the company sees and records**

- Self-serve company sign-up, with staff invited by email
- An Expo app for every role
- **A web dashboard** at business.expendi.app for admins and accountants (section 6.14). Added to the MVP on 2026-11-02.
- **Spending overview:** where money is going, what's paid, what's outstanding and what's due next (section 6.24)
- **Staff claims:**
  - capture by photo, M-Pesa screenshot, pasted M-Pesa SMS or eTIMS QR scan
  - receipt reading with an AI vision model
  - the employee confirms the fields
- **Petty cash floats** issued to staff, with spending recorded against them (section 6.22)
- **Bills and recurring payments** for suppliers, subscriptions and statutory payments, with due dates and reminders (section 6.20)
- **Salaries:** payroll runs that pay each person's net pay (section 6.21)
- **Company spending** made outside Expendi, recorded after the fact (section 6.23)
- **Payees** with M-Pesa, Till, Paybill, bank or USDC payment details (section 6.19)
- Rules: receipt required, duplicate check, age warning
- eTIMS capture and labelling (no automatic verification)

**How it pays**

- **One payout engine:** KES to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts through Paycrest, and USDC to allowlisted wallets
- A USDC wallet on Base for each company, funded by USDC deposit, with admin withdrawals to allowlisted addresses
- Payout failure handling

**Records and notifications**

- Push and email notifications, including due-date reminders
- A monthly export for the accountant
- One-way sync of paid spending, with receipts, to the company's Zoho Books (section 6.17)

**For the Expendi team**

- A one-time spreadsheet import, run by the Expendi team from the internal admin app
- An internal admin web app for the Expendi team (section 6.15)
- A system-wide, append-only audit log (section 6.13)
- Alerts to the Expendi team (section 6.16)

### Right after go-live

- KES top-ups through Qadi
- Automatic eTIMS verification through DigiTax
- Expense capture through a WhatsApp bot
- Connecting the company's own wallet
- The DigiTax supplier-invoice feed
- Importing M-Pesa and bank statements to record company spending automatically

### Later

Company cards, including paying card-only subscriptions · approval chains · budgets and spending limits · automatic payment on the due date · payroll tax calculation (PAYE, NSSF, SHIF, Housing Levy), payslips and statutory filings · QuickBooks/Xero sync · mileage and per diem · invoicing · countries other than Kenya · currencies other than KES · Slack alerts

---

## 4. Users and roles

| Role           | What they can do                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**      | Everything in their company: the spending overview, approve & pay, reject, payees, bills and recurring payments, salaries and payroll runs, petty cash floats, recording company spending, wallet, withdrawals, team, settings, export. Whoever creates the company is its first admin.               |
| **Employee**   | Submit, edit and track their own claims; record spending from their petty cash float and see what's left; see their own salary payments                                                                                                                                                               |
| **Accountant** | A view-only login to the web dashboard (section 6.14). They see everything in the company, salaries included, and can't change anything. They receive the monthly export by email and connect the company's Zoho Books through an emailed link (section 6.17). They have no access in the mobile app. |

- **One level of approval.** Any admin can approve, including their own claims. Self-approvals are flagged in the audit log and the export. There are no approval chains and no auto-approval.
- **Login** is email plus a one-time code the first time, then a passkey (fingerprint/face) on that device (Privy). The same passkey confirms every money action (section 7).
- **Payout number.** The employee's M-Pesa number is not part of login. It is entered separately and confirmed with an SMS code before any payout can go to it (section 6.18).
- A person can belong to several companies, with a different role in each.
- **Salaries are private.** Only admins and the company's accountants (view-only, section 6.14) see salaries and payroll runs. Employees see only their own salary payments. The accountant's export and the Zoho entries include salaries (section 6.21).

---

## 5. How money moves

### Kinds of money out

The overview groups spending under the four headings the pilot already uses: **Petty cash**, **Transactions**, **Salaries & personnel** and **Subscriptions**.

| Kind             | Overview heading              | Example                                              | Who records it                                         | How it's paid                                                                         |
| ---------------- | ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Staff claim      | Petty cash                    | A client lunch paid with the employee's own M-Pesa   | Employee                                               | Admin taps Approve & pay; KES goes to the employee's M-Pesa (below)                   |
| Petty cash float | Petty cash                    | KES 10,000 for office supplies                       | Admin issues it; the employee records spending from it | The float is paid to the employee's M-Pesa through Expendi (section 6.22)             |
| Bill             | Transactions or Subscriptions | Supplier invoice, rent, internet, software, KRA PAYE | Admin; recurring bills are set up once                 | Paid through Expendi on or before the due date, or marked paid outside (section 6.20) |
| Salary           | Salaries & personnel          | Monthly net pay                                      | Admin sets each salary up once                         | Payroll run: Approve & pay all (section 6.21)                                         |
| Company spending | Transactions                  | A supplier paid from the company's bank account      | Admin                                                  | Already paid outside Expendi; recorded only (section 6.23)                            |

### Staff claims

1. The employee pays with their own M-Pesa.
2. In the app they add a photo, an M-Pesa screenshot or the pasted M-Pesa SMS. They scan the eTIMS QR code if the receipt has one, then confirm the extracted fields and submit.
3. The app runs the rules: receipt present, duplicate check, age warning. It also records the eTIMS status.
4. An admin opens the claim, taps **Approve & pay** and confirms with their passkey (fingerprint/face).
5. Paycrest sends the exact KES amount to the employee's verified M-Pesa number from the company's USDC wallet, and the claim is marked **Paid**.
6. The claim appears in that month's accountant export and, if the company has connected Zoho Books, is pushed there as an expense.

### Claim statuses

| Status          | Meaning                                                                                                    | Next                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `submitted`     | Waiting for an admin                                                                                       | `paying`, `rejected`                           |
| `rejected`      | Rejected with a reason                                                                                     | `submitted` (the employee edits and resubmits) |
| `paying`        | Approved; the payout is in progress                                                                        | `paid`, `payout_failed`                        |
| `paid`          | KES delivered to M-Pesa                                                                                    | (final)                                        |
| `payout_failed` | Payout failed and the USDC is back in the wallet                                                           | `paying` (admin retries)                       |
| `paid_outside`  | Imported from the spreadsheet; paid before Expendi; read-only                                              | (final)                                        |
| `recorded`      | Petty cash spending or company spending: already paid and recorded with its receipt; no approval or payout | (final)                                        |

Each claim is paid on its own. There are no expense reports. Bills have their own statuses (section 6.20).

---

## 6. Requirements

### 6.1 Company sign-up

1. The user signs in with their email, sets up a passkey and taps **Create a company**.
2. They enter the company name and KRA PIN. Validate the PIN format: letter, 9 digits, letter (e.g. `P051234567X`).
3. The backend creates the company, makes the creator its admin, and creates the company's wallet (section 7).
4. The app shows the wallet's deposit address with a clear warning: **send USDC on Base only**.
5. The company starts with a default category list, which admins can edit.

### 6.2 Inviting staff

- The admin adds staff by email and name and picks a role.
- Each invitee gets an email with the install link (Resend). An accountant's invite instead links to the web dashboard; it stays invited until they first sign in.
- When the invited email signs in, the membership activates automatically.
- Before their first payout, each employee adds and confirms their M-Pesa number (section 6.18).
- Paycrest needs the recipient's name, so collect each employee's full name when they're invited or at first sign-in.
- Removing a person ends their access. Their unpaid claims can still be paid.

### 6.3 Submitting a claim

- **Inputs:** camera photo, image upload (M-Pesa screenshot or paper receipt), pasted M-Pesa SMS text, eTIMS QR scan.
- **Fields:** merchant, amount (KES), date, category, short description, M-Pesa transaction code, and eTIMS invoice number and supplier PIN where they exist.
- The employee always sees a review screen with the extracted fields before submitting.
- Shrink images on the phone before upload, because staff may be on cheap phones and slow data.

### 6.4 Reading receipts

- **Photos and screenshots:** one call to a Claude vision model that returns structured fields. There is no OCR vendor and no receipt templates. Choose the model by testing accuracy and cost on about 50 real pilot receipts.
- **Pasted M-Pesa SMS:** parse it with fixed rules, not AI. Handle the three formats: Buy Goods (`paid to`), Send Money (`sent to <name> <phone>`) and Paybill (`sent to <name> for account <ref>`). Extract the code, amount, counterparty, date and time.
- **eTIMS QR:** decode it with the Expo camera's barcode scanner and store the raw payload along with the invoice number.
- The app can't read SMS from the phone directly: iOS doesn't allow it and Google Play restricts it.

### 6.5 Rules (amounts in KES)

| Check                                                   | Result                     |
| ------------------------------------------------------- | -------------------------- |
| No receipt, screenshot or SMS attached                  | Can't submit               |
| Same M-Pesa code already in this company                | Blocked as duplicate       |
| Same eTIMS invoice number already in this company       | Blocked as duplicate       |
| Same image already uploaded in this company (file hash) | Blocked as duplicate       |
| Same employee, same amount, date within ±1 day          | Warning shown to the admin |
| Expense date more than 60 days ago                      | Warning shown to the admin |

These rules apply to claims, petty cash spending and company spending. Duplicate checks include imported `paid_outside` history. There are no budgets, daily spending limits or blocked merchant types.

### 6.6 eTIMS

- The app shows the company's **KRA PIN** so staff can give it at the till and receive an eTIMS invoice issued to the company.
- The `etims_status` field on each claim takes one of these values:
  - `attached`: an invoice number was captured
  - `not_required`: the category is exempt (e.g. airline tickets)
  - `none`
- **What the QR holds:** an eTIMS receipt QR links to KRA's check page with the supplier's PIN, branch and a signature, but not the invoice number. Older TIMS (ETR) receipts' QRs carry the invoice number. So for eTIMS receipts the scan fills the supplier PIN, and the invoice number comes from reading the photo or is typed.
- There is **no automatic verification at go-live**. The QR code lets anyone check the invoice with KRA by hand. Automatic DigiTax verification comes right after go-live.

### 6.7 Approve & pay

1. The admin sees the receipt, the extracted fields and any warnings.
2. Before confirming, they see the **KES the employee will receive**, the **USDC debited**, the **Paycrest fee** and the **total cost**.
3. They confirm with their passkey (fingerprint/face). The signed confirmation is bound to this payout and produces a one-time approval token (the approval-token pattern from `backend/`).
4. The backend checks that the employee has a confirmed payout number (section 6.18), the balance and the daily cap. If the balance is short, it blocks the payout and shows "Top up KES X".
5. It creates a payout with a stable idempotency key, then creates a Paycrest order (Sender API) for the employee's confirmed M-Pesa number:
   - The payout amount is the claim rounded **up** to the next whole shilling, because M-Pesa only moves whole shillings (KES 1,499.50 → 1,500).
   - The USDC amount is worked out from Paycrest's rate quote and rounded **up** to 6 decimals. If that amount falls in a different rate band, quote once more.
   - Paycrest returns a one-time deposit address and the exact USDC to send. Check them with the same rules as the consumer backend's `order-safety.ts` (Base, USDC, not the refund address, not expired), then send exactly that amount.
6. The claim moves to `paying`. A signed Paycrest webhook or the reconciliation job moves it to `paid` or `payout_failed`.
7. Store the Paycrest order ID, the transaction hash and the M-Pesa reference on the payout.

The same payout engine also pays:

- bills (section 6.20)
- payroll runs (section 6.21)
- petty cash floats (section 6.22)

They all use the same passkey confirmation, idempotency key, `order-safety` checks, rounding and failure handling. Only the recipient and the cap differ (section 7).

### 6.8 Payout failures

- **Refunded, expired or failed order:** the USDC returns to the company wallet, the claim moves to `payout_failed`, and the employee and admins are notified. The admin can retry with one tap, which creates a new payout.
- **Unclear outcome** (e.g. a timeout after the USDC was sent): mark the payout `needs_review`. Never re-send automatically. A person resolves it against Paycrest's records.
- **Reconciliation job:** every minute, compare open payouts with Paycrest's order status. It only reads and updates records; it never creates orders or sends funds.
- **Model:** copy the safeguards from the existing Qadi integration (`backend/docs/qadi-ramps.md`). Paycrest has never run in production for Expendi, and the consumer backend's webhook fix (`fix/paycrest-webhook-v1`) was never merged.

### 6.9 Wallet

- One wallet per company: USDC on Base. Expendi pays the gas.
- **Funding:** at go-live, only USDC sent to the deposit address. KES top-ups through Qadi come right after go-live.
- **Withdrawals:** admin only, only to addresses the admin allowlisted earlier, confirmed with the admin's passkey.
- **Display:** balance in USDC with the KES equivalent at the current Paycrest rate, and full transaction history (deposits, payouts, refunds, withdrawals).

### 6.10 Notifications

Notifications are sent by push through Expo. Due-date reminders, low-balance warnings and payee changes also go by email (Resend).

| Event                                                                        | Who gets it                              |
| ---------------------------------------------------------------------------- | ---------------------------------------- |
| Claim submitted                                                              | Admins                                   |
| Claim rejected (with reason)                                                 | Employee                                 |
| Claim paid                                                                   | Employee (M-Pesa also sends its own SMS) |
| Payout failed                                                                | Employee and admins                      |
| Bill due soon (3 days before by default, or the bill's own reminder setting) | Admins                                   |
| Bill due today                                                               | Admins                                   |
| Bill overdue (sent once)                                                     | Admins                                   |
| Payroll run ready to review                                                  | Admins                                   |
| Wallet short for payments due in the next 7 days                             | Admins                                   |
| Salary paid                                                                  | The employee                             |
| Petty cash float issued or topped up                                         | The employee                             |
| A payee's payment details added or changed                                   | Every admin, by email                    |

### 6.11 Accountant export

- Monthly Excel/CSV. An admin can generate any month in the app and share it. It's also emailed automatically to the company's accountants on the 1st.
- **What's in it:** all money out in the month:
  - claims
  - petty cash float issues and spending
  - bills, whether paid through Expendi or marked paid outside
  - salaries, per person
  - company spending
- **Columns:**
  - what: date, kind (claim, float, bill, salary, company), overview heading, payee or employee, merchant, category, amount (KES)
  - state: status, source (app or import), approved by, self-approved (yes/no)
  - references: M-Pesa code, eTIMS invoice number, eTIMS status, receipt file, payout reference (Paycrest order ID plus the M-Pesa or bank reference, or the transaction hash)
- **Outstanding:** a second sheet lists bills that are due or overdue at month end, so the accountant can see what's owed.
- **Receipts:** the export carries no receipt URLs. Each month comes with a zip of that month's receipts, and the "receipt file" column names the matching file in the zip (e.g. `2026-11-03_jane-wanjiku_java-house_1500.jpg`). The monthly email links to the zip; the link expires after 30 days, and an admin can regenerate it from the app at any time.
- **Retention:** keep receipts for at least 5 years, matching KRA's record-keeping period.

### 6.12 Spreadsheet import (one-time, per company)

- The Expendi team runs it from the internal admin app during setup (section 6.15). Customers don't see it.
- The pilot's spreadsheet tracks petty cash, transactions, salaries and subscriptions, so the import brings in each:
  - **Staff and suppliers** become payees (section 6.19). An admin still has to confirm their payment details before anything is paid to them.
  - **Salaries** become recurring salary items with their pay day (section 6.21).
  - **Subscriptions and regular suppliers** become recurring bills with their next due date (section 6.20).
  - **Unpaid bills** become bills with their due date.
  - **Unpaid staff claims** become `submitted` claims. The admin clears them with Approve & pay, and the first one paid is the go-live moment.
  - **Open petty cash floats** come in with what was issued and what's left.
  - **Paid rows from the last 3 months** come in as `paid_outside` history, so the overview has a starting picture. They're read-only and get no eTIMS status. The duplicate check, the overview and the export use them.
- Rows with no M-Pesa code still import; for those, the duplicate check falls back to the warning rule.
- Staff map the spreadsheet's columns for each company. A dry run produces a report for the founder to review before anything is written, and re-running is safe (keyed on a hash of each source row).
- **Switch-over:** any day. The spreadsheet is frozen that day: no new rows.

### 6.13 Audit log

One system-wide, append-only log.

- **Whose actions:** company users (admins and employees), Expendi staff in the internal admin app, and the system itself (webhooks, the reconciliation job, other jobs).
- **Which actions:** everything that changes money, access or settings:
  - claims submitted, edited, approved or rejected
  - bills, recurring payments, salaries and payroll runs created, changed, paid or cancelled
  - payees and their payment details added or changed
  - petty cash floats issued, topped up, returned or closed
  - payouts created, retried or resolved
  - deposits and withdrawals
  - allowlist changes
  - invites, role changes and removals
  - settings and cap changes
  - payout pauses
  - imports
  - staff sign-ins
- **Each entry records:** the actor type and ID, the company, the action, the record, the values before and after, the time, and the request ID, IP and device.
- **Append-only:** the database role the app uses can only insert into the log. Updates and deletes are blocked in the database itself.
- **Self-approvals** are flagged.
- **Who can read it:** Expendi staff see everything in the internal admin app. Company admins and accountants see their own company's entries in the web dashboard (section 6.14).
- **Retention:** 5 years.

### 6.14 Web dashboard

In the MVP since 2026-11-02 (Dennis). Employees use only the app. Admins can use either; the dashboard is for doing the same work on a bigger screen.

- **Where:**
  - A Next.js app (`apps/web`) on Vercel at `https://business.expendi.app`.
  - The same site serves the passkey association files the app needs (`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`), so the passkey domain and the dashboard are one site.
- **Sign-in:**
  - The same Privy accounts as the app: an email code, then a passkey in the browser.
  - A person in several companies picks one, the same as in the app.
  - An employee who signs in is told to use the app.
- **Admin:**
  - the spending overview (section 6.24)
  - the approval queue, with the receipt beside each claim. **Approve & pay for several claims at once:** one passkey confirmation pays up to 20 claims, each as its own payout.
  - bills, recurring payments, payees and payroll runs: everything the app can do, including **Pay** and **Pay all** for bills and **Approve & pay all** for payroll
  - all expenses (claims, petty cash, company spending), filterable by employee, kind, category, month and eTIMS status
  - wallet: balance, deposit address ("send USDC on Base only"), history, withdrawals and allowed addresses. KES top-ups come after go-live with Qadi.
  - team: invite, change roles, remove; including accountants
  - activity: the company's own audit log entries, read-only (section 6.13)
  - settings:
    - company details
    - the category list: add, rename, archive, and mark eTIMS-exempt (section 6.1)
    - the admin's approval passkey
- **Passkeys in the browser:**
  - Money actions use the admin's same approval passkey as in the app (section 7). It works in the browser because the passkey belongs to `business.expendi.app`.
  - A passkey kept on the admin's phone can be used from a desktop browser through its "use a phone or tablet" option.
  - An admin who has never set one up can set it up in the browser, under the same rules as the app: one passkey per admin, a recent sign-in required, and every admin emailed.
- **Accountant:**
  - **View-only:** they see everything an admin sees, salaries and payroll runs included (the monthly export already contains them), and can't trigger any action. This is enforced in the API, not just hidden in the screens.
  - **Downloads:** the monthly export and the receipts zip (section 6.11), for any month.
  - **eTIMS report:** each expense in a month with its eTIMS status, invoice number and supplier PIN, as a CSV.
  - **Switching:** between client companies, since an accountant can be on several.
- **Security:**
  - The API allows browser requests only from the dashboard's own origin, and every role rule stays in the API.
  - Passkey checks accept `https://business.expendi.app` as an origin alongside the app.

### 6.15 Internal admin app (Expendi team)

A Next.js web app in `apps/admin`, for Expendi staff only. Staff sign in with their email through Privy and must be on the staff list. There are two roles: **ops admin**, who can act, and **ops viewer**, who can only look.

| Area          | What staff can do                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companies     | List and search companies; see members, wallet balance, daily cap, unpaid claims and recent payouts                                                                                                                                                              |
| Payouts       | See payouts (claims, bills, payroll runs and floats) that need review or have failed, with the Paycrest order, transaction hash and M-Pesa or bank reference; re-fetch status from Paycrest; resolve a stuck payout as settled or refunded, with a required note |
| Imports       | Upload a company's spreadsheet, map columns, run a dry run, review the report, then import                                                                                                                                                                       |
| Controls      | Pause payouts for all companies or for one company                                                                                                                                                                                                               |
| System health | See when the reconciliation job last ran, recent webhook failures and open alerts                                                                                                                                                                                |
| Audit log     | Search every entry across all companies                                                                                                                                                                                                                          |
| Zoho Books    | Send a connect link, pick the Zoho organization, map categories to Zoho accounts, see each company's sync status, retry a failed sync, disconnect (section 6.17)                                                                                                 |

**Rules:**

- **Staff never move a company's money.** They can view, pause, re-fetch and resolve, but every payout and withdrawal still needs that company's admin.
- **Resolving a stuck payout or pausing payouts** needs a second confirmation and a written reason.
- **Every staff action** goes to the audit log.

### 6.16 Alerts

Alerts are emailed to the Expendi team's alert list and also appear in the internal admin app. Slack comes later. Send at most one email per alert for the same payout or company until it's resolved, so a stuck job doesn't flood the inbox.

| Alert                     | Fires when                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Payout needs review       | A payout is marked `needs_review`                                                                      |
| Payout failed             | A payout ends as refunded, expired or failed                                                           |
| Webhook signature failure | A Paycrest webhook fails signature verification                                                        |
| Reconciliation stopped    | The reconciliation job hasn't finished a run in 5 minutes                                              |
| Low company balance       | A company's wallet holds less than its unpaid claims plus the bills and payroll due in the next 7 days |
| Zoho sync failing         | A claim's sync runs out of retries, or Zoho rejects a company's connection                             |

### 6.17 Zoho Books sync

Paid spending goes straight into the company's Zoho Books. The monthly export (section 6.11) stays as the accountant's backup and the receipts archive.

- **What syncs** (proposed; confirm with the accountant, section 14):
  - each paid claim, each piece of petty cash spending, each paid bill (through Expendi or marked paid outside) and each piece of company spending, as one Zoho expense
  - salaries as **one expense per payroll run**, posted to a salaries account; the per-person detail stays in the export
  - **Paid Through** account:
    - petty cash spending: a petty cash account the accountant chooses
    - company spending: the account it was paid from, picked when it's recorded from a list the accountant maps

- **Direction:** one way, Expendi → Zoho. Expendi creates one Zoho expense for each paid item listed under **What syncs**, attaches the receipt where there is one, and never updates or deletes it afterwards. Changes the accountant makes in Zoho stay in Zoho.
- **Not synced:**
  - imported `paid_outside` history, which is already in the books
  - anything not yet paid
  - float issues and top-ups, which move money between the company's own accounts
  - wallet deposits, withdrawals and Paycrest fees The accountant records wallet movements from the wallet history.
- **Connecting** (during setup, like the spreadsheet import):
  1. Expendi staff send a one-time connect link from the internal admin app to whoever owns the company's Zoho login, usually the accountant. The link expires after 7 days.
  2. That person signs in to Zoho and approves access. Expendi asks only for what it needs: read organizations and the chart of accounts, and create and read expenses.
  3. Staff pick the Zoho organization. Its base currency must be KES, or connecting is refused.
  4. With the accountant, staff map each category to a Zoho expense account and choose a **Paid Through** account (e.g. a bank account called "Expendi Wallet" that the accountant creates) and a default expense account for unmapped categories.
- **Each Zoho expense:**
  - date: the expense date
  - amount: the claim amount in KES, posted gross with no VAT split
  - expense account: the category's mapped account, or the default
  - paid through: the chosen account
  - reference: the claim's Expendi ID
  - description: merchant, the employee's description, employee name, M-Pesa code, and the eTIMS invoice number and supplier PIN where they exist
  - receipt: the claim's photo or screenshot. Zoho accepts images and PDFs only, so an SMS-only claim attaches nothing.
- **Retries:** a background job syncs each claim and retries failed calls with backoff. Zoho has no idempotency key, so before retrying a create the job searches Zoho for the claim's reference and reuses the expense if it's there. A retry never creates a duplicate. When retries run out, the sync is marked `failed`, the "Zoho sync failing" alert fires, and staff can retry it from the internal admin app once the cause is fixed.
- **Lost access:** if Zoho rejects the stored token, the connection is marked `needs_reconnect`, syncing pauses and the alert fires. Claims paid in the meantime sync after reconnecting.
- **Tokens:** the Zoho refresh token is stored encrypted, with the key in Doppler, and no endpoint returns it. Zoho runs several data centres, so store the accounts server and API domain returned at sign-in and use them for every call.
- **Audit:** connecting, disconnecting, choosing the organization and changing the account mapping are audited as settings changes. Each claim's sync outcome is recorded in `accounting_syncs`.
- **Later:** self-serve connecting from the web dashboard, and QuickBooks and Xero on the same tables.

### 6.18 Payout phone number

Login is by email, so the M-Pesa number that claims are paid to is captured separately. Whoever controls this number receives the money, so it is confirmed before use and guarded after.

- The employee enters their M-Pesa number in the app. It is normalised to E.164 (`07xx…`/`01xx…` → `+2547xx…`/`+2541xx…`). Kenyan numbers only, because payouts go to M-Pesa.
- They confirm it with a one-time SMS code sent through **Telnyx Verify**, the same flow as the consumer backend's phone verification (`backend/src/services/phone-verification/`): codes expire, attempts are limited, and resends have a cooldown.
- Only a confirmed number is stored on the user, and payouts go only to it. A claim can be submitted before the number is confirmed, but **Approve & pay** is blocked until it is.
- Changing the number repeats the SMS check. Every set or change is audited, and the employee gets an email about it.
- One number belongs to one person. Numbers get recycled, so if someone else confirms a number that is already in use, it moves to them and the previous holder must confirm a new one. Both changes are audited.

### 6.19 Payees

A payee is anyone the company pays through Expendi other than a staff claim.

- **Kinds:**
  - employee, linked to their membership
  - other personnel without an app login, e.g. casual workers
  - supplier
  - subscription vendor
  - statutory body (KRA, NSSF, SHA)
- **Payment methods:**

  | Method                  | Details stored                                 | Paid by                                 |
  | ----------------------- | ---------------------------------------------- | --------------------------------------- |
  | M-Pesa number           | E.164 phone, account name                      | Paycrest                                |
  | M-Pesa Till (Buy Goods) | Till number, business name                     | Paycrest                                |
  | M-Pesa Paybill          | Business number, account number, business name | Paycrest                                |
  | Kenyan bank account     | Bank, account number, account name             | Paycrest                                |
  | USDC wallet             | Base address                                   | Direct transfer from the company wallet |
  | Paid outside Expendi    | Nothing (e.g. a card-only subscription)        | Not paid by Expendi; reminders only     |

- **Employees** are paid only to their confirmed M-Pesa number (section 6.18), or to a bank account an admin adds for them.
- **Changing payment details:** adding or changing a payee's payment details needs the admin's passkey, is audited and emails every admin. Swapped payment details are a common route for payment fraud, so paying a payee whose details changed in the last 24 hours shows a warning and needs a second confirmation.
- **USDC addresses** go on the company's allowlist, the same list that withdrawals use (section 7).
- **USDC payments are an exact USDC amount** (built in T33). A USDC payee is paid exactly what's entered; Expendi pays the gas. Its KES equivalent at Paycrest's current rate is recorded for the daily cap and reports. A bill to a USDC payee is entered in USD and paid exactly that USDC (decided 2026-11-02); its KES equivalent at the payment-day rate counts for the cap, the overview and the export.
- **Account name:** Paycrest needs one for every KES payout, so store it with the payee.

### 6.20 Bills and recurring payments

A bill is money the company owes a payee, with a due date. Bills cover the pilot's **Transactions** (suppliers, rent, utilities) and **Subscriptions**, plus statutory payments.

- **Fields:**
  - payee, amount (KES), due date
  - overview heading (Transactions or Subscriptions, editable), category
  - reference, e.g. an invoice number or a KRA payment registration number
  - notes, and an optional invoice photo or PDF
  - Supplier invoices go through the same receipt reading and eTIMS QR capture as claims (sections 6.4 and 6.6).
- **One-off bills** are entered by hand.
- **Recurring payments** are set up once, with:
  - a payee
  - an amount: fixed, or _variable_, entered each cycle (e.g. electricity or PAYE)
  - a schedule: weekly, monthly on a given day, quarterly or yearly, with a start date and an optional end date
  - how it's paid: through Expendi, or outside Expendi
  - a reminder lead time, 3 days by default

  Each recurring payment always has its next bill created, so it always shows in "what's due next".

- **Statuses:**

  | Status          | Meaning                                                                |
  | --------------- | ---------------------------------------------------------------------- |
  | `upcoming`      | Due date is in the future                                              |
  | `due`           | Due today                                                              |
  | `overdue`       | Past the due date and unpaid                                           |
  | `paying`        | Payment in progress through Expendi                                    |
  | `paid`          | Paid through Expendi                                                   |
  | `payout_failed` | Payment failed and the USDC is back in the wallet; the admin can retry |
  | `paid_outside`  | Marked paid by an admin, optionally with proof                         |
  | `cancelled`     | Won't be paid (e.g. a cancelled subscription), with a reason           |

- **Paying:** the admin taps **Pay** on one bill, or selects several due bills and taps **Pay all**.
  - The preview shows each payee, the KES they receive, the USDC debited, the fees and the total.
  - One passkey confirmation covers the batch.
  - Each bill becomes its own payout, so one failure doesn't block the others.
- **Variable bills** can't be paid until the amount, and the reference if the payee needs one, is entered.
- **No automatic payment on the due date** in the MVP. Admins get reminders before the due date, on it, and once when it's overdue (section 6.10). Automatic payment comes later.
- **Card-only subscriptions** (most foreign software) can't be paid through Expendi until cards exist. Set them up as _paid outside_, so they still show in the overview and send reminders. The admin marks each one paid.

### 6.21 Salaries

This covers the pilot's **Salaries & personnel**. Expendi pays the net pay the admin enters; it doesn't calculate tax.

- **Setup:** each person on payroll has a salary with:
  - a payee: an employee, or other personnel
  - monthly net pay in KES
  - a pay day, e.g. the 28th
  - a payment method: their confirmed M-Pesa number or a bank account
- **Payroll run:** 5 days before pay day, Expendi creates a draft run listing everyone due and notifies admins. For this run only, the admin can:
  - change one person's amount, e.g. for a bonus or unpaid leave, with a reason
  - leave someone out, with a reason
  - add a one-off payment to someone
- **Approve & pay all:**
  - The admin reviews the total and each person, then confirms with their passkey.
  - Each person becomes their own payout. A failure is retried for that person without paying anyone else again.
  - The run shows how many payments are paid, paying and failed.
- **Statutory payments** (PAYE, NSSF, SHIF, Housing Levy) are not calculated. The admin sets each up as a variable recurring bill to the right Paybill and enters the amount and reference every month (section 6.20).
- **Visibility:** only admins see salaries and payroll runs. Each employee sees only their own salary payments. The overview shows the total due and each person's amount.
- **Not in the MVP:** tax calculation, payslips, P9 forms and statutory filings.

### 6.22 Petty cash floats

This covers the pilot's **Petty cash** where money is handed out before it's spent. Staff paying from their own pocket stays a claim (section 5).

- **Issuing:** the admin gives an employee a float (e.g. KES 10,000). It's paid to the employee's confirmed M-Pesa through Expendi, with the admin's passkey. An office cash box is a float held by whoever keeps the box.
- **Spending:** the employee records each purchase in the app as **Paid from petty cash**. It uses the same capture flow and receipt rules as a claim, but needs no approval and creates no payout. Its status is `recorded`.
- **Balance:** issued + top-ups − recorded spending − returns.
  - The employee sees what's left.
  - Admins see every float: issued, spent, left, and any spending without a receipt.
- **Top-up:** the admin sends more, with their passkey.
- **Return and close:** the employee hands back what's left outside the app, and the admin records the return and closes the float.
- **Overspend:** spending beyond the float's balance becomes a claim for the extra, submitted for approval like any other claim.

### 6.23 Company spending

Company spending is money the company already spent outside Expendi, e.g. a supplier paid from the company's bank account or the founder's company card.

- Admins record it with the same capture flow: receipt, amount, date, payee or merchant, category, and the account it was paid from (from a list the accountant maps for Zoho, section 6.17).
- Its overview heading is **Transactions** unless the admin picks another. Its status is `recorded`.
- Receipt rules apply, but an admin can save without a receipt by giving a reason. It's then flagged "no receipt".
- Marking a bill _paid outside_ (section 6.20) records it here automatically.

### 6.24 Spending overview

This is the admin's home screen in the app. It answers the pilot's four questions at any moment. Month boundaries use Africa/Nairobi time.

| Question                    | What the screen shows                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Where is the money going?   | This month's money out by heading (Petty cash, Transactions, Salaries & personnel, Subscriptions) and by category, compared with last month |
| What has been paid?         | Recent payments, through Expendi and outside it                                                                                             |
| What is outstanding?        | Overdue bills, bills due today, claims waiting for approval, and petty cash spending without a receipt                                      |
| What needs to be paid next? | Bills and payroll runs due in the next 30 days in date order, overdue first, each with **Pay**                                              |

- **Cash check:** at the top, the wallet balance in USDC and KES, compared with everything due in the next 30 days: "Covered" or "Short by KES X".
- **Per person:** tapping a person shows their salary, payments, claims and float.
- **Employees' home screen** shows only their claims, their float balance and their own salary payments.

---

## 7. Money safety

Expendi holds each company's USDC, so these controls are required for launch:

1. **One wallet per company.** Funds are never pooled.
2. **Named purposes only.** The backend can move funds only to:
   - pay an approved claim
   - issue or top up a petty cash float
   - pay a bill to a saved payee
   - pay an approved payroll run
   - make an admin-confirmed withdrawal to an allowlisted address

   Each one needs that company's admin. Nothing pays automatically.

3. **Confirmation.** Every action that moves money needs a fresh passkey confirmation (fingerprint/face) from the admin, bound to that action.
4. **Caps.**
   - **Daily cap** for claims, floats and bills: KES 200,000 by default per company. An admin can change it with a second confirmation.
   - **Payroll cap** per run: the total of the active salaries plus 20%, so a run can't pay far more than the payroll that's set up. Changing a salary or this margin needs a second confirmation, is audited and emails every admin.
5. **Enforced at the wallet.** Privy wallet policies allow only USDC transfers, up to a per-transaction maximum, so a backend bug can't send other tokens or large amounts.
   - **Payout recipients:** Paycrest gives a new deposit address for every order, so the policy can't list allowed recipients. The backend checks each one with the `order-safety` rules instead (section 6.7).
   - **Withdrawals and USDC payees:** addresses are checked against the company's allowlist (section 6.19).
   - **Per-transaction maximum:** 3,100 USDC by default, just above Paycrest's largest KES order (about 3,000 USDC). A larger payment, such as a big salary, is split into several orders. Ops can raise a company's cap with Expendi's management key.
   - **Build check (settled 2026-11-01, T5):** Privy policies can limit a wallet to USDC `transfer` on Base under a maximum amount, so payouts stay on Paycrest's Sender API. Each wallet is owned by an Expendi management key the API never holds. The API signs as an additional signer that can't change the policy or export the key. See `docs/decisions/privy-wallet-policies.md`.
6. **Payout pause.** The Expendi team can pause all payouts, or one company's payouts, from the internal admin app. Pausing never moves money.
7. **Confirmed payout numbers.** Claims, floats and salaries to M-Pesa are paid only to a number the employee confirmed by SMS code (section 6.18).
8. **Guarded payee details.** Adding or changing a payee's payment details needs the admin's passkey, is audited and emails every admin. Paying a payee within 24 hours of a change needs a second confirmation (section 6.19).

The consumer backend's wallet audit findings (`backend/docs/privy-backend-security-deep-dive.md`) must not carry over. In particular, every signing request must be bound to the wallet of the company that owns the action.

---

## 8. Serving many companies (multi-tenancy)

- One backend, one Postgres database, many companies.
- Every company-owned table has `organization_id`. Every request runs with the caller's company, checked against their membership.
- **Postgres row-level security** is the safety net: a query that forgets its filter returns nothing rather than another company's data.
- Each company has its own wallet, KRA PIN, categories, daily cap and settings.
- **Tests:** an automated test confirms that a user in company A gets no data from company B on every endpoint.

---

## 9. Architecture

| Part                               | Choice                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                               | `expendi-business` as a Turbo + pnpm monorepo: `apps/api`, `apps/mobile`, `apps/admin` (internal), `apps/web` (dashboard, later), `packages/shared` (schemas and types). Code from the consumer repos (Paycrest client, Privy setup) is copied in, not shared. |
| Backend                            | New service on the same stack and design as `backend/`: TypeScript, Hono, Effect, Drizzle, Postgres, Postgres-backed jobs, Railway                                                                                                                             |
| Auth                               | Privy: email one-time code the first time, then a passkey (fingerprint/face). Passkey approval tokens for money actions.                                                                                                                                       |
| Payout phone check                 | Telnyx Verify SMS codes, ported from `backend/src/services/phone-verification/` (section 6.18)                                                                                                                                                                 |
| Wallets                            | Privy server wallets with policies, on Base, holding USDC                                                                                                                                                                                                      |
| Cash-out                           | Paycrest (USDC on Base → KES to M-Pesa numbers, Tills, Paybills and Kenyan banks). USDC payees are paid by direct transfer from the company wallet.                                                                                                            |
| Top-ups (after go-live)            | Qadi (KES via M-Pesa → USDC on Base)                                                                                                                                                                                                                           |
| eTIMS verification (after go-live) | DigiTax                                                                                                                                                                                                                                                        |
| Receipt reading                    | Claude vision model with structured output                                                                                                                                                                                                                     |
| App                                | Expo, private test releases, EAS Update for over-the-air fixes                                                                                                                                                                                                 |
| Receipt storage                    | Cloudflare R2: private bucket, expiring links only, one folder per company (`org/<id>/`), 5-year retention                                                                                                                                                     |
| Internal admin                     | Next.js app in `apps/admin` (section 6.15)                                                                                                                                                                                                                     |
| Web dashboard                      | Next.js app in `apps/web` on Vercel at business.expendi.app, for admins and accountants (section 6.14). It also serves the passkey association files.                                                                                                          |
| Email                              | Resend (new: the consumer backend has no email provider). Used for invites (section 6.2), alerts (section 6.16) and the monthly accountant export (section 6.11).                                                                                              |
| Alerts                             | Email to the team's alert list now, Slack later (section 6.16)                                                                                                                                                                                                 |
| Scheduling                         | Postgres-backed jobs create the next recurring bills, draft payroll runs and due-date reminders every day, on Africa/Nairobi time                                                                                                                              |
| Accounting sync                    | Zoho Books API with OAuth 2.0, one-way push of paid spending (section 6.17)                                                                                                                                                                                    |

---

## 10. Data model

Money is stored as integers only: KES in cents, USDC in 6-decimal base units.

| Table                           | Key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`                 | id, name, kra_pin, daily_payout_cap_kes, payroll_cap_margin_pct, payouts_paused, created_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `users`                         | id, privy_user_id, email (login, lowercased), phone (E.164 M-Pesa payout number, null until confirmed), phone_verified_at, full_name                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `phone_verification_challenges` | id, user_id, phone, provider_ref, status (`pending`/`approved`/`verified`/`expired`), attempts, send_count, last_sent_at, expires_at                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memberships`                   | id, organization_id, user_id (required for every role; names and emails live on `users`), role (`admin`/`employee`/`accountant`), status (`invited`/`active`/`removed`), invited_by, invited_at                                                                                                                                                                                                                                                                                                                                                                                     |
| `wallets`                       | id, organization_id, chain, address, privy_wallet_id, policy_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `withdrawal_addresses`          | id, organization_id, address, label, added_by, confirmed_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `categories`                    | id, organization_id, name, etims_not_required, accounting_account_id, archived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expenses`                      | id, organization_id, membership_id, kind (`claim`/`float`/`company`), overview_heading, float_id, paid_from_account_id (FK paid_from_accounts), bill_id (company spending from a bill paid outside), no_receipt_reason, category_id, merchant, amount_kes, spent_on, description, source (`app`/`import`), status, mpesa_code, etims_invoice_number, etims_supplier_pin, etims_qr_payload, etims_status, extraction (jsonb), warnings, rejected_reason, approved_by, approved_at, self_approved, payout_id, overspend_claim_id (float spending whose extra became a claim), paid_at |
| `receipt_files`                 | id, organization_id, expense_id, bill_id, storage_key, kind (`photo`/`screenshot`/`sms_text`/`pdf`), bill_role (`invoice`/`proof`), sms_text (inline), extraction (jsonb), sha256, uploaded_by                                                                                                                                                                                                                                                                                                                                                                                      |
| `payouts`                       | id, organization_id, subject_type (`claim`/`bill`/`float`/`withdrawal`), subject_id, subject_part (several orders for one salary above Paycrest's per-order maximum), payroll_run_id, idempotency_key, provider (`paycrest`/`onchain`), provider_order_id, amount_kes, usdc_amount, fee_usdc, rate, method, recipient (snapshot of the payee's details at payment time), tx_hash, gateway_order_id (Paycrest Gateway order, links refunds), provider_reference (M-Pesa or bank), status, failure_reason, needs_review                                                               |
| `wallet_transactions`           | id, organization_id, type (`deposit`/`payout`/`refund`/`withdrawal`/`topup`), usdc_amount, tx_hash, payout_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `payees`                        | id, organization_id, kind (`employee`/`personnel`/`supplier`/`vendor`/`statutory`), name, membership_id, method (nullable until details are added; `mpesa_phone`/`mpesa_till`/`mpesa_paybill`/`bank`/`usdc`/`outside`), phone, till_number, paybill_number, account_reference, bank_code, bank_account_number, account_name (not for USDC), usdc_address, details_changed_at, archived                                                                                                                                                                                              |
| `recurring_items`               | id, organization_id, payee_id, overview_heading (`transactions`/`subscriptions`/`salaries`), category_id, currency (`kes`/`usd`, from the payee: USDC payees are USD), amount_kes or amount_usdc (null = variable), schedule (`weekly`/`monthly`/`quarterly`/`yearly`), schedule_day, starts_on, ends_on, pay_via (`expendi`/`outside`), reminder_days, active, next_due_on. Salaries are recurring items with the `salaries` heading.                                                                                                                                              |
| `bills`                         | id, organization_id, payee_id, recurring_item_id, payroll_run_id, overview_heading, category_id, amount_kes (null while variable), variable, currency (`kes`/`usd`), amount_usdc (USD bills to USDC payees, section 6.19), reference, due_on, status, adjustment_reason, cancelled_reason, paid_at, paid_on, marked_paid_by, paid_outside_note, cancelled_by, cancelled_at, payout_id                                                                                                                                                                                               |
| `payroll_runs`                  | id, organization_id, pay_date, status (`draft`/`paying`/`paid`/`partly_failed`), total_kes, salaries_kes, cap_kes (salaries_kes × (100 + margin)%), unique per (organization, pay_date), approved_by, approved_at                                                                                                                                                                                                                                                                                                                                                                   |
| `paid_from_accounts`            | id, organization_id, name, kind (`bank`/`card`/`mobile_money`/`cash`/`other`), accounting_account_id (Zoho Paid Through), archived                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `floats`                        | id, organization_id, membership_id, status (`open`/`closed`), opened_at, closed_at, closed_by (balance is computed from movements and spending, never stored)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `float_movements`               | id, organization_id, float_id, type (`issue`/`top_up`/`return`/`write_off`), status (`pending`/`paid`/`failed`/`recorded`), amount_kes, payout_id, note, paid_at, recorded_by                                                                                                                                                                                                                                                                                                                                                                                                       |
| `push_tokens`                   | id, user_id, token, platform, last_seen_at, disabled_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `notification_outbox`           | id, organization_id, kind, recipients, payload, status, attempts, sent_at (push notifications queued in the event's transaction, sent by a job)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `audit_log`                     | id, occurred_at, actor_type (`user`/`staff`/`system`), actor_id, organization_id (null for platform-wide actions), action, entity_type, entity_id, before, after, request_id, ip, user_agent                                                                                                                                                                                                                                                                                                                                                                                        |
| `staff_users`                   | id, email, role (`ops_admin`/`ops_viewer`), status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `staff_confirmations`           | id, staff_user_id, purpose, target, params_hash, token_hash, expires_at, used_at (single-use second confirmations for staff actions)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `platform_settings`             | payouts_paused (all companies), updated_by, updated_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `import_runs`                   | id, organization_id, staff_user_id, file_key, column_mapping, dry_run, rows_total, rows_imported, rows_skipped, report                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `accounting_connections`        | id, organization_id, provider (`zoho_books`), external_organization_id, external_organization_name, accounts_server, api_domain, refresh_token_encrypted, paid_through_account_id, default_account_id, status (`pending`/`active`/`needs_reconnect`/`disconnected`), connect_token_hash, connect_token_expires_at, connect_token_used_at, connected_at                                                                                                                                                                                                                              |
| `accounting_syncs`              | id, organization_id, subject_type (`expense`/`bill`/`payroll_run`), subject_id, provider, external_id, status (`pending`/`synced`/`failed`), attempts, last_error, receipt_attached, synced_at                                                                                                                                                                                                                                                                                                                                                                                      |

**Unique indexes per company:** `(organization_id, mpesa_code)`, `(organization_id, etims_invoice_number)`, `(organization_id, receipt sha256)`, `(organization_id, subject_type, subject_id)` on `accounting_syncs`. Each recurring item has at most one unpaid future bill. A company has at most one connection that isn't `disconnected`.

---

## 11. Fees and pricing

| Cost                    | Who pays                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Paycrest conversion fee | The company, passed through at cost for every KES payment (claims, floats, bills, and each person in a payroll run) and shown before paying |
| Gas on Base             | Expendi                                                                                                                                     |
| Expendi fee             | Pilot: none for the first 3 months, with the paid price agreed before it starts. Other companies: none for the first month.                 |

---

## 12. Distribution

- TestFlight (iOS) and Google Play testing tracks (Android). Both support invite links, so other early companies can join without a public store listing.
- EAS Update ships fixes the same day.
- Check which phones the pilot's staff use. If they're all on Android, skip Apple for the pilot.

---

## 13. Go-live checklist

1. 5 real KES payouts through Paycrest end to end, including one forced failure that refunds correctly.
2. The cross-company isolation test passes on every endpoint.
3. Wallet safety is proven:
   - the Privy policy blocks non-USDC and over-limit transfers
   - the `order-safety` checks reject a bad Paycrest order
   - the daily cap holds
4. Payout pause works for all companies and for one company.
5. Every alert in section 6.16 fires in a test and reaches the alert email list.
6. Staff actions in the internal admin app appear in the audit log, and the database rejects updates and deletes to the log.
7. The pilot is ready:
   - company created, USDC on Base deposited
   - staff invited, with the app installed and their payout numbers confirmed
   - spreadsheet import dry-run reviewed with the founder, including payees, salaries and recurring bills
   - every payee's payment details confirmed by an admin
   - spreadsheet frozen
8. The accountant has received a sample export and accepted the format.
9. Zoho Books is connected to the pilot's organization and every category is mapped. The accountant has approved how a synced expense looks, using a test Zoho organization.
10. Push notifications work on every platform the pilot uses.
11. One real payment of each other kind works end to end: an M-Pesa Till, a Paybill with an account number, a Kenyan bank account, and a USDC transfer to an allowlisted payee.
12. A payroll run with at least 3 people is paid end to end. One person's payment fails and is retried without paying the others again.
13. A petty cash float is issued, spent from, topped up, overspent (creating a claim for the extra) and closed.
14. Reminders fire before, on and after a test bill's due date, and a recurring payment creates its next bill.
15. The founder checks the overview against the imported spreadsheet, and the paid, outstanding and due-next figures match.
16. Changing a payee's payment details needs a passkey and emails every admin. Paying that payee within 24 hours asks for a second confirmation.
17. The web dashboard works at business.expendi.app:
    - an admin approves and pays several claims at once with a passkey from a desktop browser
    - the accountant signs in, sees everything read-only, can't change anything, and downloads the export and the eTIMS report
    - the passkey association files are served there, and passkeys work in the app
18. The first real claim is paid. **Live.**

---

## 14. Open items

### Product decisions from the scope change

Dennis confirmed 1–5, 8 and 9 on 2026-11-01. Expendi is **not offering an API to other businesses for now**. Still open: 6 (to confirm with the accountant) and 7 (pricing).

1. **Payroll cap:** a run's total is capped at the active salaries plus 20% (section 7).
2. **No automatic payment on due dates** in the MVP. Admins pay with one tap after reminders (section 6.20).
3. **Draft payroll runs** are created 5 days before pay day (section 6.21).
4. **Payee change protection:** a second confirmation to pay within 24 hours of a change (section 6.19).
5. **Who records what:** admins record company spending; employees record claims and petty cash spending (sections 6.22 and 6.23).
6. **Zoho posting:** salaries as one expense per run, and petty cash spending through a petty cash account (section 6.17). Confirm with the accountant.
7. **Pricing after the free period:** a subscription, a fee on payment volume, or both? Payments running through Expendi are core to the business.
8. **"Selling Expendi infra":** this means companies making their payments through Expendi's wallet and payouts. Offering Expendi's payment API to other businesses is not planned for now.
9. **KES top-ups through Qadi** are still after go-live. Salaries are paid in KES and the pilot also earns KES, so check the pilot can keep enough USDC on hand. If it can't, top-ups move into the MVP.

### To settle

- **Paycrest limits and channels** (checked during T7, 2026-11-01; details in the Phase 1 handoff notes):
  - **Maximum per order:** set per provider, not by Paycrest. The two KES providers allowed 1,500 and 3,000 USDC (about KES 386,000 at 128.68), and a 20,000 USDC rate request found no provider. The minimum is 0.5 USDC. A salary above the largest provider's maximum needs several orders (T39).
  - **Settlement time per channel:** not documented. Measure each channel in the Checkpoint B live payouts.
  - **Name checks:** Paycrest's account check returns only "OK" for KES M-Pesa, with no name, so it doesn't confirm who receives the money. Every order carries the name Expendi has for the payee. Whether banks return a name is checked at Checkpoint B.

- ~~**Privy policies:** confirm which conditions they can enforce on ERC-20 transfers (section 7).~~ Settled by T5: they can cap USDC transfer amounts (`docs/decisions/privy-wallet-policies.md`). Dennis decided the rest on 2026-11-01: the default per-transaction maximum is 3,100 USDC, and he holds the management key, ops-only.
- ~~**Passkey approvals:** confirm whether the backend can verify a passkey signature against the passkey Privy registered (Privy exposes its public key), or whether money approvals need their own WebAuthn credential, as in the consumer backend (T8).~~ **Decided (Dennis, 2026-11-01): Expendi's own WebAuthn credential.** Each admin enrols an approval passkey once, and the backend verifies it with `@simplewebauthn/server`, as the consumer backend does. Privy's passkey is unproven for this: passkeys are off in the app, and its `public_key` is optional and undocumented. It can be imported into the same table later.

### Owner to-dos

**Before go-live**

1. Send the pilot's spreadsheet, with the header and 3 sample rows from each part (petty cash, transactions, salaries, subscriptions), to map the import.
2. Agree the post-pilot price with the pilot company.
3. Check which phones the pilot's staff use. Passkeys need iOS 16+ or Android 9+ with a screen lock.
4. Confirm the pilot can send USDC on Base.
5. Create the Expendi Business Privy app with email login and passkeys, and host the domain files passkeys need (`apple-app-site-association` for iOS, `assetlinks.json` for Android).
6. Set up a Telnyx Verify profile for Expendi Business and put its keys in Doppler.
7. Register Expendi as a server-based client in Zoho's API console with Multi-DC on, and put the client ID and secret in Doppler.
8. Get from the pilot's accountant: their Zoho expense accounts for the category mapping, the Paid Through account to use, and whether posting eTIMS expenses gross (no VAT split) works for them.

**Start now, needed after go-live**

1. Email DigiTax (info@namiri.tech): can one account serve many companies, and how does the License Key work? Which buyer PIN is checked? What does a check cost? How often does the purchases feed update, and can it include supplier PIN, VAT and totals?
2. Start Meta's WhatsApp business verification.
3. Agree a USDC float with Qadi for top-ups, and brief Qadi on the B2B use (`backend/docs/qadi-partner-brief.md` currently says Expendi is not a B2B payments platform).

---

## 15. Changes from the implementation guide (Part 1)

| Guide                                                 | MVP                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Expense reports group expenses                        | No reports; each claim is paid on its own                                                                                              |
| 3-tier OCR (templates → Mindee/Taggun → LLM)          | One Claude vision call, a QR scan and an SMS parser                                                                                    |
| Submit & close / submit & approve / advanced approval | One level of approval, any admin                                                                                                       |
| 7 policy checks, including daily limits and budgets   | Receipt required, duplicate check, age warning                                                                                         |
| Yellow Card / Kotani Pay off-ramp                     | Paycrest cash-out; Qadi top-ups after go-live                                                                                          |
| Reimburse by converting USD back to local currency    | Pay the exact KES spent                                                                                                                |
| Onchain `bucketId` spending buckets                   | Removed                                                                                                                                |
| Corporate card import                                 | Removed (cards come later)                                                                                                             |
| QuickBooks / Xero sync in Phase 2                     | Monthly export plus one-way Zoho Books sync, because the pilot's accountant uses Zoho; QuickBooks and Xero later                       |
| Mobile apps in Phase 6                                | Expo app at go-live                                                                                                                    |
| eTIMS only for outgoing invoices                      | eTIMS capture on expenses; DigiTax verification after go-live                                                                          |
| Expense management first; payroll in Part 3           | All company spending in the MVP: claims, petty cash floats, bills, subscriptions and net-pay salaries. Payroll tax and payslips later. |
| Off-ramp used only for reimbursements                 | One payout engine for claims, floats, bills and payroll: M-Pesa numbers, Tills, Paybills, Kenyan banks and USDC wallets                |
| Multi-currency (KES/NGN/GHS/USD)                      | KES only                                                                                                                               |

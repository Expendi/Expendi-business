# Phase 4 Handoff: Pilot launch

**Linear:** milestone "Phase 4 · Pilot launch"

- EXP-284 (T28) Getting the app to staff
- EXP-300 (T29) Pilot go-live

**Goal:** get the app onto the pilot's phones and pay the first real claim. That moment is **Live**. Then track the 30-day success measures.

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in all earlier phase handoffs (look for known issues), then `docs/handoffs/phase-4-pilot-launch.md`. Work through T28, then the go-live checklist with me.

## Read first

- **Spec:** §2 (goals and success measures), §12 (distribution), §13 (go-live checklist)
- **Build plan:** Tasks 28–29
- **Every earlier phase's Handoff notes:** any known issue still open must be fixed or accepted by Dennis before go-live

## Inputs needed from Dennis

1. Apple Developer and App Store Connect access, and Google Play Console access
2. Which phones the pilot's staff use (Android only? any iPhones?)
3. The pilot company's USDC on Base, ready to deposit
4. The accountant's email address, and their Zoho Books account mapping (spec §6.17)
5. The post-pilot price, agreed with the pilot company. The pilot is free for 3 months; other companies get 1 free month.

## Tasks

### T28 · EXP-284: Getting the app to staff

- Make production EAS builds and set up the EAS Update production channel.
- **iOS:**
  - External TestFlight testing needs Apple's beta review, which usually takes about a day.
  - Give Apple a way to log in: a Privy test email account with a fixed code.
  - Submit **a week before go-live**.
- **Android:** use a Play internal or closed testing track, adding testers by email.
- If every pilot staff member uses Android, skip iOS for the pilot.

### T29 · EXP-300: Pilot go-live

Work through the checklist below with the pilot company.

**If something goes wrong:** pause payouts from the internal admin app, for the pilot company or for everyone. Claims stay where they are. Fix the problem, then unpause.

---

## QA and go-live checklist

**Before go-live**

- [ ] The QA checklists for Phases 0–3 have passed, and the results are recorded in their Handoff notes
- [ ] Production environment variables are set, and the production Paycrest key is in place
- [ ] A test alert reaches the alert email list
- [ ] Pilot staff have installed the app on every platform they use
- [ ] A test over-the-air update reached their phones
- [ ] The pilot company is created, USDC on Base is deposited, and the daily cap is KES 200,000
- [ ] Staff are invited and signed in with the right roles, and the accountant's email is set
- [ ] The spreadsheet import dry run has been reviewed with the founder and the import has run
- [ ] **The spreadsheet is frozen** on switch-over day: no new rows
- [ ] The accountant has received a sample export and accepted the format
- [ ] Zoho Books is connected to the pilot's organization, every category is mapped, and the accountant has approved a synced expense from the test organization
- [ ] Payees, salaries and recurring bills are imported and checked with the founder, and an admin has confirmed every payee's payment details
- [ ] One real payment each to a Till, a Paybill, a Kenyan bank and a USDC payee has worked (spec §13 item 11)
- [ ] A payroll run of 3, the full petty cash float cycle and due-date reminders have passed on staging (items 12–14)
- [ ] The founder has checked the overview against the spreadsheet, and the figures match (item 15)
- [ ] Payee-change protection works (item 16)

**Go-live**

- [ ] The founder taps Approve & pay on the first real claim, and the employee's M-Pesa receives the exact amount. **Live.** Record the date, claim ID and M-Pesa reference below.
- [ ] The first paid claim appears in the pilot's Zoho Books, and the accountant confirms it's posted correctly

**First 30 days**

- [ ] **Daily:** check the alerts inbox and the payout queue in the internal admin app
- [ ] **Weekly:**
  - median time from submit to paid (target under 24 hours)
  - share of money out paid through Expendi (salaries, petty cash and claims should all go through it in month 1)
  - whether the founder says the overview matches reality
  - share of claims with an eTIMS receipt attached
  - issues reported by staff
- [ ] **Day 30:**
  - Is the spreadsheet retired?
  - Did the accountant accept the export and the Zoho entries without rework?
  - Write the success review below

---

## Handoff notes

- **Status:**
- **Go-live date, first claim ID, M-Pesa reference:**
- **Platforms shipped (iOS / Android):**
- **Known issues at launch:**
- **Weekly measures (submit to paid, eTIMS share):**
- **Day-30 review:**

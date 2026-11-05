# Play Store listing

Copy for Play Console → **Grow users → Store presence → Main store listing**, plus draft answers for **Policy → App content**. Every claim below matches a shipped feature. Receipt reading by AI is left out because it stays off until `ANTHROPIC_API_KEY` is set (see `pilot-release.md`).

## App details

| Field                      | Value                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| App name (30 max)          | Expendi Business                                                                                 |
| Short description (80 max) | Track and pay staff claims, petty cash, bills and salaries in one app.                           |
| App category               | Business                                                                                         |
| Contact email              | team@expendi.app (confirm it's monitored; it's shown publicly)                                   |
| Website                    | https://business.expendi.app                                                                     |
| Privacy policy             | **Missing.** No page exists yet; Play requires a public URL, e.g. `business.expendi.app/privacy` |

### Full description (4,000 max)

```text
Expendi Business shows your company where its money is going and pays what's due, from one app.

See your spending at a glance
• What's paid, what's outstanding and what's due next, across all company spending
• Due-date reminders for salaries, subscriptions and regular suppliers

Staff claims without WhatsApp screenshots
• Snap a receipt, scan an eTIMS QR code, or attach an M-Pesa screenshot or SMS
• Admins approve and pay in a tap, straight to the employee's M-Pesa

Petty cash, bills and salaries
• Issue petty cash floats to staff and track spending against each float
• Keep supplier bills, subscriptions and recurring payments on schedule
• Run payroll and pay each person's net pay

Pay anyone in Kenya
• M-Pesa numbers, Till and Paybill numbers, and Kenyan bank accounts, in KES
• USDC wallets for payees abroad
• Changes to a payee's payment details need passkey confirmation

Records your accountant will accept
• Every payment made through Expendi is recorded automatically
• Monthly exports and Zoho Books sync

Built for teams
• Invite staff by email; employees, admins and accountants each see what they need
• Sign in with your email and a passkey
• A web dashboard at business.expendi.app for admins and accountants

Expendi Business is for Kenyan startups and growing teams. To sign in, accept an invite from your company admin, or set up your company in the app.
```

## Graphics

| Asset             | Spec                               | File                                          |
| ----------------- | ---------------------------------- | --------------------------------------------- |
| App icon          | 512 × 512 PNG                      | `apps/mobile/assets/play-store-icon.png`      |
| Feature graphic   | 1024 × 500 PNG, no transparency    | `apps/mobile/assets/play-feature-graphic.png` |
| Phone screenshots | 2–8, 9:16, 1080 × 1920 recommended | `apps/mobile/assets/play-screenshots/01–05`   |

The five screenshots are real captures of the demo company "Kilima Studio" on the dev API, framed with captions: spending overview, recording spending with a receipt, the review step, a saved payment with its receipt, and recent payments. Bills, approvals and payroll aren't shown yet: adding payees needs an approval passkey, which a local debug build can't create. Capture those from a Play-installed build once passkeys work there.

## App content (draft answers)

| Section            | Answer                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Privacy policy     | URL from above, once published                                                                                        |
| App access         | All functionality needs sign-in. Give reviewers a Privy test email with a fixed login code (keep the code out of git) |
| Ads                | No ads                                                                                                                |
| Content rating     | Questionnaire: no violence, sexual content, gambling or user-to-public communication                                  |
| Target audience    | 18 and over                                                                                                           |
| News app           | No                                                                                                                    |
| Financial features | Complete the declaration for the app's payment and wallet features                                                    |
| Data safety        | See below                                                                                                             |

### Data safety

No analytics, ads or crash-reporting SDKs ship in the app. Data goes to the Expendi API over HTTPS. Providers that process it on Expendi's behalf (Privy for sign-in, payout providers, Zoho Books when a company connects it) count as service providers, not sharing.

| Data type                                                        | Why it's collected                    | Required |
| ---------------------------------------------------------------- | ------------------------------------- | -------- |
| Name, email address                                              | Account management, app functionality | Yes      |
| Phone number (M-Pesa)                                            | App functionality (payouts)           | Yes      |
| Financial info: payment info, purchase history, other (salaries) | App functionality                     | Yes      |
| Photos (receipts, M-Pesa screenshots)                            | App functionality                     | Optional |
| Device or other IDs (push token)                                 | App functionality (notifications)     | Optional |

- Encrypted in transit: yes.
- Account deletion: **gap.** Play requires apps that let users create accounts to offer in-app account deletion and a web link to request it. Company sign-up exists (`(onboarding)/create-company.tsx`), but neither deletion path does yet.

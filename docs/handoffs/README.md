# Build Handoffs

The expense MVP is built across several sessions. Each phase has a handoff document that a new session can start from without any earlier conversation. Each one has a QA checklist that must pass before the next phase starts.

| Phase | Handoff                                                                 | Linear milestone                      |
| ----- | ----------------------------------------------------------------------- | ------------------------------------- |
| 0     | [Foundation](phase-0-foundation.md)                                     | Phase 0 · Foundation                  |
| 1     | [Money path](phase-1-money-path.md)                                     | Phase 1 · Money path                  |
| 2     | [Claim flow](phase-2-claim-flow.md)                                     | Phase 2 · Claim flow                  |
| 2B    | [Spending & payments](phase-2b-spending-and-payments.md)                | Phase 2B · Spending & payments        |
| 3     | [Accountant & internal tools](phase-3-accountant-and-internal-tools.md) | Phase 3 · Accountant & internal tools |
| 3B    | [Web dashboard](phase-3b-web-dashboard.md)                              | Phase 3B · Web dashboard              |
| 4     | [Pilot launch](phase-4-pilot-launch.md)                                 | Phase 4 · Pilot launch                |

**Sources of truth:**

- [Spec](../expense-mvp-spec.md): what we're building and why. Section references like "§7" point here.
- [Build plan](../expense-mvp-build-plan.md): all 51 tasks with their acceptance criteria.
- Linear project **Expendi Business**: issue status. Each phase handoff lists its exact issue IDs.
  - T1–T29: EXP-272 to EXP-300
  - T30 and T31 (Zoho Books): EXP-301 and EXP-302
  - T32: EXP-303
  - T33: EXP-304
  - T34–T44 (added when the scope widened to all company spending): EXP-305 to EXP-315, not in task order
  - T45–T51 (web dashboard, added to the MVP on 2026-11-02): EXP-316 to EXP-322

---

## How to run a session

**Start.** Open a new session in `expendi-business` and paste the start prompt from the phase's handoff. A session should read:

1. this file
2. the phase handoff
3. the **Handoff notes** at the bottom of the previous phase's handoff
4. the spec sections the handoff lists

**During.**

- Work one Linear issue at a time, in the order the handoff gives.
- Move each issue to In Progress, then to Done once its acceptance criteria pass.

**End of every session**, even partway through a phase:

- Fill in **Handoff notes** at the bottom of the phase handoff: what was built, what's left, anything that changed.

**End of a phase.**

1. Run the phase's full QA checklist.
2. Record the results in Handoff notes.
3. Review the checkpoint with Dennis before starting the next phase.

---

## Rules for every session

1. **Money is integers only.** KES is stored in cents and USDC in 6-decimal base units. Floats never touch money.
2. **Company isolation.** Every company-owned table has `organization_id` and Postgres row-level security. Every new route gets a test with the isolation helper.
3. **Audit everything that matters.** Every change to money, access or settings writes an audit entry in the same transaction.
4. **Never re-send money automatically.** An unclear outcome marks the payout `needs_review`, and a person resolves it.
5. **Staff never move a company's money.** Only that company's admin can trigger payouts and withdrawals.
6. **Follow the consumer backend's conventions:** Effect services and layers, Hono routes, Drizzle schema, Vitest. Copy code from the consumer repos; never import from them.
7. **Keep type checks honest:**
   - no `as any`, `@ts-ignore` or `@ts-expect-error`
   - no empty `catch` blocks
8. **Secrets live in Doppler**, not in Railway variables. The API loads them into its environment at startup (`SECRETS_MANAGER=doppler`). Railway holds only the Doppler token. Never commit `.env` files or keys.
9. **No silent changes to the spec.** If something has to differ, update the spec and write down the reason in Handoff notes.
10. **Commit only when Dennis asks.**

The consumer repos are under `/Users/chizaa/Documents/projects/expendi/`. The ones to port from are `backend/` (API) and `recurring-payments-frontend/` (Expo app and admin web apps).

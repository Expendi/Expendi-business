# Implementation notes

- Existing import runs require a staff FK and staff-only RLS; customer imports need explicit member provenance and tenant-scoped policies.
- Existing historical imports use claim/paid_outside and require member email. Customer paid expenses should use company/recorded with import source and the recording admin as owner.
- Existing history window skips everything older than three months. Remove the cutoff to support migration of Q2/year history, retaining calendar/future-date validation.
- Existing preview signatures bind actor/company/source/mapping/actions; bind layout and filename too.
- Shanga templates contain no actual transactions.

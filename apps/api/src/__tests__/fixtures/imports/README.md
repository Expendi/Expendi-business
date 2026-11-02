# Public expense fixture

`ukef-july-2026.csv` is the original, unmodified UK Export Finance July 2026 spending-over-£25,000 download (25 payments). It uses Windows-1252 encoding, padded headings and an entirely blank trailing column.

- Publisher: UK Export Finance, Crown copyright.
- Publication: https://www.gov.uk/government/publications/ukef-spend-over-25000-july-2026
- Download: https://assets.publishing.service.gov.uk/media/6aa012545f6e942efe37eef9/July_2026_25k_Transparency_Report.csv
- Retrieved: 2026-11-02.
- Licence: contains public sector information licensed under the Open Government Licence v3.0: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/

Amounts are **GBP, not KES**. Integration tests explicitly decode the original, retain source supplier/date/description, and derive KES fixture amounts at a **synthetic test-only rate of 100 KES per GBP**. This is not a market exchange rate or a representation of Kenyan transactions. Tests add the local fixture member's email/category and use an August 2026 test clock to exercise the three-month historical window. The original is also tested to ensure GBP-prefixed amounts are rejected by the KES importer.

No rows from this file are sent to the deployed app, providers, or a client's company. Client-specific headers and all actual imported amounts still need founder review.

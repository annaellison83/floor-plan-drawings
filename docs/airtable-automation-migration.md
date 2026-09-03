# Airtable Automation Migration to Render

Updated: 2026-09-03

## Objective

Move the Floor Plan Drawings automation engine from Airtable Automations to the
existing Render backend while Airtable remains the dashboard and source of
truth. Netlify remains live during the transition. Do not disable an Airtable
automation until its Render replacement has passed dry-run, duplicate, delivery,
and rollback checks.

## Audit result

Base: `Floor Plan Drawings Command Center` (`appBq1xl0G5vCegAH`)

All seven automations are deployed and valid. Airtable reported no difference
between the current draft and the deployed version for any automation.

### 2026-09-03 read-only queue comparison

The connected Airtable base was re-read without changing records or
automations. It contains 56 Jobs records and 8 Communication Log records.
Applying the Render candidate rules to the current records produced:

| Render shadow workflow | Matching records | Observation |
| --- | ---: | --- |
| NEW REQUEST | 0 | No Order record currently has the exact `Anna Email Status = Not Sent` value. |
| PROPERTY REVIEW NEEDED | 0 | No Quick Quote record currently matches the unsent + researched + manual-review combination. |
| FOLLOW-UP | 15 | All 15 matching rows have 2024 quote/follow-up dates; they appear to be seeded historical records and must be reviewed before enabling live follow-up delivery. |

The comparison was captured before the cutover. Render now has all three
per-workflow shadow flags disabled and the corresponding send flags enabled.
QUOTE READY and approved client quotes remain on their already-tested Render
delivery path.

To prevent the historical rows from being revived during a later cutover,
Render now applies `FOLLOW_UP_MAX_AGE_DAYS` to the quote-sent date. It is set
to 90 days in Render; setting it to `0` restores the legacy unbounded rule.

| Airtable automation | Trigger | Actions to reproduce on Render |
| --- | --- | --- |
| Notify Anna of new website request | Order + Anna Email Status `Not Sent` + property research complete | Send `NEW REQUEST`; create Communication Log row; set status `Sent - New Order` |
| Notify Anna when quote is ready | Quick Quote + Quote Review `Ready for Anna` + email not sent + research complete | Send `QUOTE READY`; create Communication Log row; set status `Sent - Quote Ready` |
| Translate quote notes for review | Quick Quote with non-empty Client Notes | Generate a concise internal scope note; save to Quote Calculation Notes |
| Morning quote follow-ups | Daily at 8:00 AM America/Los_Angeles | Find due quote follow-ups; send Anna one `FOLLOW-UP` digest |
| Notify Anna when quote has no property match | Quick Quote + email not sent + Property Check Status `No Match` + research complete | Send `PROPERTY REVIEW NEEDED`; log it; set status `Sent - Manual Review` |
| Notify Anna when quote needs manual property review | Quick Quote + email not sent + Property Check Status `Needs Manual Review` + research complete | Send `PROPERTY REVIEW NEEDED`; log it; set status `Sent - Manual Review` |
| Send approved quote to client and log it | Quick Quote + Anna Decision `Approved` + Quote Sent Date empty + Client Email present | Send client quote; log it; set Status `Quote Sent`, Client Response `Awaiting Reply`, and sent timestamps |

## Existing Airtable tables

- `Jobs` (`tbl6iNAIVKLb9QcYi`) holds workflow state and duplicate-protection stamps.
- `Communication Log` (`tblabpelqSMSfeG4E`) records outgoing notifications.
- `Message Templates` (`tbl4Jg5gxSgWol6cv`) is available for reusable content but the deployed automations currently embed their message bodies directly.

## Email finding

The internal Airtable messages embed roughly 6.5–7 KB of raw HTML in each
automation action. Their outer containers use 980 px maximum widths, and the
follow-up digest uses 1100 px. This is fragile in narrower Gmail/mobile
viewports and should not be copied verbatim. The Render replacements should use
one shared, tested email shell with a 640–680 px content width, table-based
layout, inline styles, plain-text alternatives, and explicit top labels.

Required top labels:

- `NEW REQUEST`
- `QUOTE READY`
- `PROPERTY REVIEW NEEDED`
- `FOLLOW-UP`
- `REMINDER`

## Render design

1. Poll or receive a webhook for candidate Airtable records.
2. Re-read each record immediately before acting.
3. Claim an idempotency key for `workflow + record ID + state/version`.
4. Render HTML and plain text from shared templates.
5. Send through the selected mailbox provider.
6. Create the Communication Log row.
7. Stamp the Jobs record only after delivery succeeds.
8. Record failures without marking the workflow complete so retries are safe.

Render now has live replacements for `NEW REQUEST`, `PROPERTY REVIEW NEEDED`,
and the daily `FOLLOW-UP` digest. They use the same
Communication Log reservation pattern as the existing QUOTE READY and client
quote senders. Preview them with the protected
`GET /api/airtable/workflow-preview?workflow=...` endpoint before enabling any
flag. The preview is read-only and does not send mail or modify Jobs records.

### 2026-09-03 cutover status

Render is live for NEW REQUEST, PROPERTY REVIEW NEEDED, and FOLLOW-UP. The
corresponding Airtable sender automations are still configured as a reversible
rollback path. Pause (do not delete) the NEW REQUEST automation, both PROPERTY
REVIEW automations (No Match and Needs Manual Review), and the daily FOLLOW-UP
automation in Airtable after Anna signs into the Automations UI and confirms
Render delivery. QUOTE READY, approved client quote, and note-translation
automations remain available while their Render equivalents are verified.

The note-translation automation remains deliberately unchanged for now. Its
AI rewrite needs a separately selected model/provider and an explicit comparison
against the current Airtable output before Render writes `Quote Calculation
Notes`. Client confirmations and reminders likewise remain on their existing
Airtable paths until their exact trigger/state contract is documented and a
Render sender has passed a controlled test.

The scheduled follow-up job must run at 8:00 AM America/Los_Angeles and must
not send an empty digest.

## Provisional quote-zone resolver

The supplied service-area image is a hand-drawn guide rather than a GIS file.
Until Anna supplies exact boundaries, Render approximates it using the nearer
of the North Hollywood and Monterey Park hubs:

- Zone 1: up to 8 miles; $200 minimum
- Zone 2: over 8 and up to 15 miles; $230 minimum
- Zone 3: over 15 and up to 24 miles; $260 minimum
- Zone 4: over 24 and up to 35 miles; $300 minimum

Locations within one mile of a boundary are marked for review. Locations more
than 35 miles from both hubs are marked outside the mapped service area. A
manual `Quote Zone` value in Airtable always overrides the approximation. Zone
pricing remains a floor: `max(service/size price, zone minimum)`, never a fee
added to the service price.

## Safe cutover order

1. AI note translation (no external message)
2. Internal `PROPERTY REVIEW NEEDED`
3. Internal `NEW REQUEST`
4. Internal `QUOTE READY`
5. Internal `FOLLOW-UP` digest
6. Approved client quote

For each workflow: run Render in dry-run, compare candidate records and rendered
output, enable live sending with the Airtable automation still available for
rollback, then disable only that one Airtable automation after duplicate checks
pass. Never disable all automations at once.

## Required Render configuration

Secrets belong in Render, not GitHub:

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID=appBq1xl0G5vCegAH`
- `AIRTABLE_JOBS_TABLE=Jobs`
- `AIRTABLE_COMMUNICATION_LOG_TABLE=Communication Log`
- Mail-provider credentials (provider still to be selected)
- `INTERNAL_ADMIN_TOKEN` (already configured)
- `FOLLOW_UP_MAX_AGE_DAYS=90` (Render safety guard for stale historical rows)

Workflow flags remain false until each replacement has passed shadow-run and
duplicate checks:

- `ENABLE_NEW_REQUEST_SENDS`
- `ENABLE_PROPERTY_REVIEW_SENDS`
- `ENABLE_FOLLOW_UP_SENDS`

The Airtable PAT is scoped only to the Floor Plan Drawings Command Center base
with `data.records:read`, `data.records:write`, and `schema.bases:read`.

# FloorPlanDrawings Codex Handoff

Updated: 2026-09-08

## Verified current state

- Repository: `annaellison83/floor-plan-drawings`
- Branch: `main`
- Latest synced commit: `5e91483` (`build Render workflow intake and Gmail runtime`)
- `main` contains the Render intake handoff, Gmail runtime, project state, and
  delivery-audit changes. The older `release` branch is not used for this
  staged backend cutover.
- Airtable remains the dashboard/source of truth. Render sends the migrated
  workflow emails. Netlify's $5 add-on pack has restored 500 credits for the
  current billing period, and `floorplandrawings.com` is serving normally
  again.
- Render service: `floorplan-drawings-backend` at `https://floor-plan-drawings.onrender.com`
- Render settings: `npm install --prefix server`; `node server/index.js`; health path `/healthz`; Starter plan; auto-deploy from `main` enabled.
- Netlify production is intentionally configured to the `release` branch;
  branch deploys are enabled for all pushed branches and pull-request
  previews remain enabled. Develop on `main`, review a preview, then merge or
  push `release` for an intentional production release after credits return.
- Render health is passing with Airtable, Gmail SMTP, and iCloud integrations enabled. Gmail SMTP is the primary sender and the configured alternate SMTP path is available for bounded fallback delivery.
- The public Netlify intake now attempts the protected Render `/api/intake`
  endpoint first using a shared `RENDER_INTAKE_TOKEN`, with the existing
  Airtable write retained as a fail-safe fallback.
- A Gmail API intake runtime is implemented but intentionally disabled until
  Anna enters a separate least-privilege Google OAuth refresh token in Render.
  It reads only the `[FPD] Intake` label, preserves Gmail message/thread
  IDs, and never assumes an unknown sender is the client.
- Gmail's `NEW REQUEST` filter now applies `[FPD] Intake`; the existing label
  was renamed in place so its label ID and filter behavior were preserved.
- `RENDER_INTAKE_TOKEN` is now set identically in Netlify and Render. Render
  has a 1 GB disk mounted at `/var/data`, with `STATE_FILE` set to
  `/var/data/fpd-state.json`.
- Render has `GMAIL_INTAKE_LABEL_ID=Label_29` configured for `[FPD] Intake`.
  `ENABLE_GMAIL_INTAKE_POLL=false` is explicit until the first manual poll is
  reviewed; Google OAuth client/refresh values are still intentionally absent.
- Protected read-only iCloud discovery and roster endpoints are live. The roster classifies `anna` as owner, `corrie`, `sarah`, and `ricardo` as workers, and excludes `Home` and `Reminders`.
- Read-only worker availability is live at `/api/icloud/availability`; the dry-run planner is live at `/api/icloud/appointments/dry-run`.
- The internal appointment-proposal board is available for test-only use. Anna
  can open the signed review link from a QUOTE READY email, inspect fresh
  worker/time recommendations, and send an expiring selection link. The board
  does not create calendar events. Approved client quote emails do not include
  scheduling automatically yet (`ENABLE_CLIENT_QUOTE_SCHEDULING=false`).
- Current Render migration flags: NEW REQUEST, PROPERTY REVIEW, and FOLLOW-UP
  are live with per-workflow shadow flags false; QUOTE READY and approved
  CLIENT QUOTE remain live on Render; provisional holds and client scheduling
  remain disabled. The matching Airtable sender automations are retained as a
  reversible rollback path until Anna pauses them in Airtable's Automations UI.
- Render FOLLOW-UP candidates are limited by `FOLLOW_UP_MAX_AGE_DAYS=90` so
  the historical 2024 rows cannot be revived during cutover. Airtable data was
  not changed.
- Provisional hold create/release endpoints are staged behind `ENABLE_PROVISIONAL_HOLDS=false`; no event writes have been enabled.
- No calendar events were created or modified.

## Email and quote safeguards

`netlify/functions/fpd-intake.js` attempts the protected Render intake first and
falls back to Airtable if Render is unavailable. Render and the existing
pollers reserve a Communication Log row before sending, retry failed sends
while the job remains `Not Sent`, and stamp `Sent` only after Gmail SMTP
accepts the message. Duplicate sends are blocked by both the Communication Log
reservation and Render's delivery ledger.

The approval page now saves edits with confirmation, records manually entered size as `Anna confirmed during quote review`, and links directly to the expanded Airtable job after approval. Automatic quote zones are persisted from the two-hub distance resolver; manual Airtable zones still override them.

For missing size, the system does not trust Google AI summaries or rental-unit descriptions as whole-building size. It provides Google, Zillow, Redfin, Realtor.com, and Homes.com search links for manual confirmation.

Current resilience gap: the fallback Airtable sender automations are retained for
manual rollback, not as an automatic second sender. A true mission-critical
failover still needs an independently scheduled Airtable-sender fallback and a
separate-channel alert when a record remains unsent. Note translation, client
confirmations, and reminders still require a documented Render state contract
and controlled migration.

## Connector status

- Gmail connector is connected locally for inspection. Render Gmail SMTP is
  configured separately. The production Gmail API poller still needs its
  OAuth client/refresh-token environment values; do not request or paste the
  Gmail password or tokens into chat.
- Airtable CLI authentication is verified with a PAT restricted to the Floor Plan Drawings Command Center base. The automation audit is recorded in `docs/airtable-automation-migration.md`.
- Airtable's Codex connector is now connected to the `Floor Plan Drawings
  Command Center` base (`appBq1xl0G5vCegAH`) in read-only audit mode. The
  latest inventory contains 56 Jobs records and 8 Communication Log records.
  Render's candidate rules currently find 0 NEW REQUEST, 0 PROPERTY REVIEW,
  and 15 historical FOLLOW-UP rows (the latter are seeded 2024 records and
  should be reviewed before any cutover).
- The Netlify dashboard is linked to the existing `floorplandrawings` site and
  the production branch guardrail is configured as above. The latest published
  production deploy is `39aa44d`; the site returned HTTP 200 after credits were
  restored.
- The Airtable and Netlify Codex plugins are installed. Their in-app OAuth connectors are separate from the verified CLI sessions.

## Next safe steps

1. Verify a controlled website submission reaches `/api/intake` using the
   shared token, then confirm the Render state file survives a restart.
2. Enter Google OAuth client ID, client secret, and least-privilege refresh
   token directly in Render. Keep `ENABLE_GMAIL_INTAKE_POLL=false` for the
   first manual poll; turn on the timer only after that pass is reviewed.
4. Add an automatic, delayed Airtable-sender fallback for QUOTE READY after a Render/Gmail failure, with an idempotent claim field.
5. Add a separate-channel alert for jobs that remain unsent beyond the retry window.
6. Keep the current Airtable automations available as manual rollback until the independent fallback is tested.
7. Finish the iCloud custom-domain DNS cutover only after deciding whether Bluehost will continue hosting DNS.
8. Review the first real appointment proposal end-to-end. Client selections
   are logged for Anna while holds remain disabled; enable provisional holds
   only after the selection and rollback path are approved.

## Security constraints

Never commit passwords, API keys, tokens, `.env` files, or calendar credentials. Anna must enter sensitive credentials directly into the provider's OAuth or environment-variable UI.

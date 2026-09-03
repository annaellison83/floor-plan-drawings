# FloorPlanDrawings Codex Handoff

Updated: 2026-09-03

## Verified current state

- Repository: `annaellison83/floor-plan-drawings`
- Branch: `main`
- Latest synced commit: `630f8a9` (`add appointment availability proposal flow`)
- Netlify website and functions remain live. Airtable remains the dashboard/source of truth. Render now sends the migrated QUOTE READY and approved-client quote emails.
- Render service: `floorplan-drawings-backend` at `https://floor-plan-drawings.onrender.com`
- Render settings: `npm install --prefix server`; `node server/index.js`; health path `/healthz`; Starter plan; auto-deploy from `main` enabled.
- Render health is passing with Airtable, Gmail SMTP, and iCloud integrations enabled.
- Protected read-only iCloud discovery and roster endpoints are live. The roster classifies `anna` as owner, `corrie`, `sarah`, and `ricardo` as workers, and excludes `Home` and `Reminders`.
- Read-only worker availability is live at `/api/icloud/availability`; the dry-run planner is live at `/api/icloud/appointments/dry-run`.
- Appointment proposals are now feature-enabled on Render. Anna can open the
  signed review link from a QUOTE READY email, inspect fresh worker/time
  recommendations, and send the client an expiring selection link. Approved
  client quote emails also include the available-time link when a verified
  square-footage estimate is present.
- Provisional hold create/release endpoints are staged behind `ENABLE_PROVISIONAL_HOLDS=false`; no event writes have been enabled.
- No calendar events were created or modified.

## Email and quote safeguards

`netlify/functions/fpd-intake.js` writes the submission to Airtable before any notification is attempted. Render polls Airtable every minute, reserves a Communication Log row before sending, retries failed sends while the job remains `Not Sent`, and stamps `Sent` only after Gmail SMTP accepts the message. Duplicate sends are blocked by the Communication Log reservation.

The approval page now saves edits with confirmation, records manually entered size as `Anna confirmed during quote review`, and links directly to the expanded Airtable job after approval. Automatic quote zones are persisted from the two-hub distance resolver; manual Airtable zones still override them.

For missing size, the system does not trust Google AI summaries or rental-unit descriptions as whole-building size. It provides Google, Zillow, Redfin, Realtor.com, and Homes.com search links for manual confirmation.

Current resilience gap: the fallback Airtable QUOTE READY automation is disabled/undeployed, so it is a manual rollback path rather than an automatic second sender. A true mission-critical failover still needs an independently scheduled Airtable-sender fallback and a separate-channel alert when a record remains unsent.

## Connector status

- Gmail connector installed locally, but Google authentication is incomplete. Render Gmail SMTP is configured separately; do not request or paste the Gmail password or tokens into chat.
- Airtable CLI authentication is verified with a PAT restricted to the Floor Plan Drawings Command Center base. The automation audit is recorded in `docs/airtable-automation-migration.md`.
- Netlify CLI authentication is verified as Anna on the `FPD` team, and this checkout is linked to the existing `floorplandrawings` site. Production deploys are Git-triggered.
- The Airtable and Netlify Codex plugins are installed. Their in-app OAuth connectors are separate from the verified CLI sessions.

## Next safe steps

1. Add an automatic, delayed Airtable-sender fallback for QUOTE READY after a Render/Gmail failure, with an idempotent claim field.
2. Add a separate-channel alert for jobs that remain unsent beyond the retry window.
3. Keep the current disabled Airtable QUOTE READY flow available as a manual rollback until the independent fallback is tested.
4. Finish the iCloud custom-domain DNS cutover only after deciding whether Bluehost will continue hosting DNS.
5. Review the first real appointment proposal end-to-end. Client selections
   are logged for Anna while holds remain disabled; enable provisional holds
   only after the selection and rollback path are approved.

## Security constraints

Never commit passwords, API keys, tokens, `.env` files, or calendar credentials. Anna must enter sensitive credentials directly into the provider's OAuth or environment-variable UI.

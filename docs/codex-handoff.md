# FloorPlanDrawings Codex Handoff

Updated: 2026-09-02

## Verified current state

- Repository: `annaellison83/floor-plan-drawings`
- Branch: `main`
- Latest synced commit: `f0765b4` (`Add iCloud calendar roster endpoint`)
- Netlify website, Netlify functions, Airtable base, Airtable automations, and quote/order workflows remain live and unchanged during the transition.
- Render service: `floorplan-drawings-backend` at `https://floor-plan-drawings.onrender.com`
- Render settings: `npm install --prefix server`; `node server/index.js`; health path `/healthz`; Starter plan; auto-deploy from `main` enabled.
- Render health is passing with iCloud integration enabled.
- Protected read-only iCloud discovery and roster endpoints are live. The roster classifies `anna` as owner, `corrie`, `sarah`, and `ricardo` as workers, and excludes `Home` and `Reminders`.
- No calendar events were created or modified.

## Email investigation

The Netlify functions do not deliver email. `netlify/functions/fpd-intake.js` writes submission fields to Airtable, and `netlify/functions/approve-quote.js` updates the Airtable approval fields. Email subjects, formatting, reminders, follow-ups, and client delivery remain in Airtable Automations / Airtable's sender.

The likely fix is therefore in the Airtable automation's deployed configuration, not in the Netlify code. Draft edits alone are insufficient; each changed automation must be explicitly updated/published.

## Connector status

- Gmail connector installed locally, but Google authentication is incomplete. Do not request or paste the Gmail password or tokens into chat.
- Airtable connector installed locally, but its account connection still needs to be completed before inspecting automations.
- Netlify connector installed locally; its account connection still needs to be completed before inspecting deploys or environment settings.
- The legacy `airtable-mcp` CLI is not installed on this Mac; use the official Airtable connector when it is available in a refreshed Codex session.

## Next safe steps

1. Start a fresh Codex session (or reload the app) so the newly installed Airtable and Netlify connector tools are exposed.
2. Connect Airtable as Anna and verify access to the Floor Plan Drawings Command Center base; connect Netlify and verify the existing site/functions.
3. Audit the `NEW REQUEST`, `QUOTE READY`, `PROPERTY REVIEW NEEDED`, `FOLLOW-UP`, and approved client quote automations. Capture each trigger, condition, field update, schedule, message body, and sender.
4. Implement equivalent, idempotent Render jobs that read/write Airtable and send through the approved mail sender. Keep the existing Airtable automations enabled while testing.
5. Add a dry-run/replay path and communication log so each Airtable record can be tested without duplicate sends.
6. Compare Render output with the deployed Airtable versions, then cut over one workflow at a time. Do not disable Airtable automations until parity and rollback checks pass.
7. Keep Gmail access optional until mailbox-level verification is needed; the migration can initially use the configured Airtable/approved sender.

## Security constraints

Never commit passwords, API keys, tokens, `.env` files, or calendar credentials. Anna must enter sensitive credentials directly into the provider's OAuth or environment-variable UI.

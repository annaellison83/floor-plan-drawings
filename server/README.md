# FloorPlanDrawings backend

This service is the Render workflow engine for the FloorPlanDrawings site.
Netlify remains the public intake website and Airtable remains the dashboard and
source of truth. Render currently sends QUOTE READY, approved client quotes,
NEW REQUEST, PROPERTY REVIEW NEEDED, and the daily FOLLOW-UP digest with
idempotent Communication Log reservations. It does not create calendar events.

## Render settings

- Build command: `npm install --prefix server`
- Start command: `node server/index.js`
- Health check path: `/healthz`
- Plan: Starter (`$7/month`)

## Environment variables

Set these in the Render service, never in GitHub:

- `ICLOUD_EMAIL`: Anna's iCloud/Apple Account email
- `ICLOUD_APP_PASSWORD`: Anna's app-specific password
- `INTERNAL_ADMIN_TOKEN`: a separate random token for the private test endpoint
- `RENDER_INTAKE_TOKEN`: a separate random shared secret used only by the
  Netlify website intake function. Set the same value in the Netlify site
  environment and Render; do not reuse `INTERNAL_ADMIN_TOKEN`.

The iCloud endpoint is:

`GET /api/icloud/calendars`

Send the admin token in the `X-Admin-Token` header. The endpoint returns
calendar names and CalDAV URLs, but never returns the iCloud password.

## Website intake handoff

Netlify remains the public form runtime. When `RENDER_INTAKE_URL` and
`RENDER_INTAKE_TOKEN` are configured, `netlify/functions/fpd-intake.js` sends
the normalized submission to Render first:

`POST /api/intake`

Render authenticates the `Authorization: Bearer ...` header, validates the
versioned `netlify-fpd-intake` envelope, and creates the Airtable Jobs record
with an idempotent `Job ID` lookup. It returns the Airtable record ID so the
existing Netlify property-research enrichment can continue during the
migration. If Render is unreachable, rejects the request, or the handoff
variables are not set, Netlify uses its existing direct Airtable create path.

Set these values in both providers (with a newly generated random value for
the token):

```text
# Render and Netlify
RENDER_INTAKE_TOKEN=<same random secret, entered in provider UIs>

# Netlify only
RENDER_INTAKE_URL=https://floor-plan-drawings.onrender.com/api/intake
```

The endpoint never accepts browser traffic without the shared secret and does
not log request contents or credentials. A duplicate `Job ID` returns the
existing record instead of creating a second job.

The read-only roster endpoint is:

`GET /api/icloud/roster`

The roster classifies `anna` as the owner calendar, `corrie`, `sarah`, and
`ricardo` as worker calendars, and excludes `Home` and `Reminders` from
booking. It does not create or modify events.

The read-only availability endpoint is:

`GET /api/icloud/availability?startDate=YYYY-MM-DD&days=7&squareFeet=2400`

It queries worker calendars for existing events and evaluates the 11:00 AM and
1:00 PM appointment starts. It never creates or changes events.

The dry-run planner is:

`POST /api/icloud/appointments/dry-run`

with JSON such as `{ "squareFeet": 2400, "service": "Black & White" }`. It
returns policy-compliant worker/slot recommendations and delivery targets. It
is read-only and does not change Airtable or iCloud.

## Delivery safety

Render retries transient SMTP failures a bounded number of times (`MAIL_MAX_ATTEMPTS`,
default 3). If a second provider is configured with `FALLBACK_SMTP_*`, it is
tried only after the primary provider's retries fail. Set `DELIVERY_ALERT_EMAIL`
to receive a failure alert after a delivery is marked failed; the alert never
contains credentials.

Anna can inspect the latest failed delivery records with the protected
`GET /api/ops/delivery-failures` endpoint and the `X-Admin-Token` header. This
endpoint is read-only and returns only workflow, record, subject, status, and
summary fields.

The approved client email can be inspected without delivery at
`GET /api/airtable/client-quote-preview?recordId=rec...` (or add
`format=html` for a browser preview). It is protected by `X-Admin-Token` and
does not change Airtable.

## Render project state and delivery audit

Render maintains a canonical project/event/delivery boundary in
`server/project-state.js`. It is deliberately compatible with Airtable
shadow mode: Airtable communication logs remain the rollback record while
Render also records idempotent delivery reservations and outcomes. Set
`STATE_FILE` to a mounted private path if this state should survive a service
restart; without it, the service uses an in-memory store and Airtable remains
the recovery source during the migration.

The protected operational endpoints are read-only unless noted:

- `GET /api/ops/projects` — current project state
- `POST /api/ops/projects` — upsert an intake/project envelope
- `GET /api/ops/events` — project lifecycle/audit events
- `GET /api/ops/deliveries` — delivery reservations and outcomes
- `GET /api/ops/delivery-failures` — Airtable delivery failures

All require `X-Admin-Token`. State stores only contact addresses, project
metadata, and delivery metadata; it never stores passwords, tokens, message
bodies, or credentials.

Client and agent contacts are separate. If both are present and no explicit
recipient policy is stored on the project, client-facing quote, appointment,
confirmation, and reminder sends are blocked for Anna to clarify. Supported
policies are `client`, `agent`, `both`, `internal`, and `custom`. This avoids
ever assuming that the person who submitted a request should receive the
client-facing confirmation.

Each workflow also has a shadow switch (`SHADOW_NEW_REQUEST`,
`SHADOW_PROPERTY_REVIEW`, `SHADOW_QUOTE_READY`, `SHADOW_CLIENT_QUOTE`, or
`SHADOW_FOLLOW_UP`). Shadow mode reads candidates and renders the message but
does not create a Communication Log record, send mail, or update a Job. Use
these switches to compare Render output with Airtable before cutting over one
workflow at a time. `SHADOW_MODE=true` enables all of them together.

Appointment options are intentionally test-only by default. Keep
`ENABLE_APPOINTMENT_PROPOSALS=true` for Anna's internal board if desired, but
leave `ENABLE_CLIENT_QUOTE_SCHEDULING=false` until client-facing scheduling is
approved. Enabling the second flag is what adds live options to approved client
quote emails.

## Appointment proposals

The protected preview endpoint is:

`GET /api/airtable/availability-proposal/preview?recordId=rec...`

It reads the verified square footage and current worker calendars, then returns
policy-compliant options without sending email or writing an event. Anna's
quote-ready email includes a review link at `/api/scheduling/proposal/start`.
That page is a mobile-friendly weekly board: it shows each worker's open and
busy 11:00 AM / 1:00 PM slots, highlights policy recommendations, supports
week navigation (including touch swipes), and lets Anna select up to five
options to send. The board re-reads the calendars when it is opened and again
when the selected options are submitted. The client receives an expiring,
signed selection link. A client selection is re-checked against iCloud before
it is logged. With `ENABLE_PROVISIONAL_HOLDS=false`, no calendar event is
created; the selection is logged for Anna to confirm manually. Enabling the
flag adds the existing deterministic provisional hold, still requiring a later
confirmation step before a final event is created.

Provisional holds are staged behind `ENABLE_PROVISIONAL_HOLDS=false`. When
explicitly enabled, `POST /api/icloud/appointments/hold` creates a deterministic
tentative event only on a roster worker calendar. The request must include a
`worker`, `jobKey`, `start`, `end`, and `expiresAt` (future, within 24 hours).
`DELETE /api/icloud/appointments/hold` releases a hold by `holdId` and worker.
Both endpoints require the admin token; Home and Reminders can never be used.

## Gmail intake runtime (staged)

`server/gmail-runtime.js` is the production-safe Gmail API boundary for the
future inbound workflow. It uses a separately authorized OAuth refresh token
(not the Codex Gmail connector and not an SMTP app password), reads only the
configured intake label, preserves Gmail message and thread IDs, and exposes an
idempotent processing hook. Configure `GMAIL_INTAKE_LABEL_ID` with the ID of
`[00] FPD Intake`; do not use the display name as the ID.

The parser keeps the sender (`contacts.source`) separate from
`contacts.agent` and `contacts.client`. Only explicitly configured addresses
in `GMAIL_AGENT_EMAILS` and `GMAIL_CLIENT_EMAILS` receive those roles; unknown
contacts remain unknown so Render cannot accidentally send a client-facing
message to an agent. This module is scaffolding until the OAuth credential,
project database, and durable idempotency store are provisioned.

When the production OAuth values are ready, the protected endpoint
`POST /api/gmail/intake/poll` runs one idempotent intake pass. It creates a
Render project with the Gmail thread ID and keeps unknown contacts unknown;
it never assumes the sender is the client. Set `ENABLE_GMAIL_INTAKE_POLL=true`
to run the same pass every two minutes (or set `GMAIL_INTAKE_POLL_MS`).
Optionally set `GMAIL_PROCESSED_LABEL_ID` to add a separate processed label;
the intake label is never removed automatically.

The current project-state store is durable only when `STATE_FILE` points at a
persistent Render disk. Until that is provisioned, Airtable remains the
recovery source and the Gmail poller should stay disabled.

`GET /healthz` reports this as `integrations.renderStateDurable`; it is `false`
when the service is using the in-memory safety mode.

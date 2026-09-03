# FloorPlanDrawings backend

This service is the first Render slice. It is intentionally small: it provides
the Render health check and a protected, read-only iCloud CalDAV discovery
endpoint. It does not create calendar events or change Airtable records yet.

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

The iCloud endpoint is:

`GET /api/icloud/calendars`

Send the admin token in the `X-Admin-Token` header. The endpoint returns
calendar names and CalDAV URLs, but never returns the iCloud password.

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

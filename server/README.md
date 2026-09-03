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

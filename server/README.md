# FloorPlanDrawings backend

This service is the Render workflow engine for the FloorPlanDrawings site.
Netlify remains the public intake website and Airtable remains the dashboard and
source of truth. Render currently sends QUOTE READY, approved client quotes,
QUOTE REQUEST, QUOTE READY, PROPERTY REVIEW NEEDED, and the daily FOLLOW-UP digest with
idempotent Communication Log reservations. It does not create calendar events.
Internal review emails use the compact quote layout, label the automatic price
as **Auto quote**, and attach the cached aerial image inline so Gmail can display
it without waiting on a remote image request. Appointment confirmation emails
are intentionally disabled for now; reminders and the experimental availability
board remain separately controlled.
Incoming quote requests use the subject `QUOTE REQUEST | [address]`. The
client draft and approved client email use `Floor plan quote for [address]` and
describe square-foot pricing, separate B&W/color amounts when available, and
optional scheduling language without exposing internal review notes.
Client-note normalization is staged behind `ENABLE_NOTE_TRANSLATION=false` and
must be reviewed through the read-only
`GET /api/airtable/note-translation-preview` endpoint before enabling writes.

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
- `PORTAL_USERNAME`: username for the private master portal (for example, `anna`)
- `PORTAL_PASSWORD`: private master portal password. Enter it directly in Render;
  never commit it or paste it into ChatGPT, GitHub, or a terminal transcript.
- `PORTAL_SESSION_SECRET`: optional random signing key for portal sessions. If
  omitted, sessions are signed with `INTERNAL_ADMIN_TOKEN`.
- `RENDER_INTAKE_TOKEN`: a separate random shared secret used only by the
  Netlify website intake function. Set the same value in the Netlify site
  environment and Render; do not reuse `INTERNAL_ADMIN_TOKEN`.

The master portal at `https://master.floorplandrawings.com/` uses
`PORTAL_USERNAME` and `PORTAL_PASSWORD`. On successful sign-in it sets an
HttpOnly, Secure session cookie that lasts 30 days, so Chrome can save the
credentials and Anna does not need to re-enter a token on every visit. Logging
out clears the cookie. The `X-Admin-Token` header remains supported for API and
break-glass access.

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

`SMTP_USER` is the authenticated/sending account. Set
`INTERNAL_NOTIFICATION_EMAIL` when internal workflow mail should go to a
separate operator mailbox such as `anna@floorplandrawings.com`; it defaults to
`SMTP_USER` for backwards compatibility. Add Anna's address to
`GMAIL_AGENT_EMAILS` so Gmail intake role classification treats her as an
internal/agent contact.

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
`[FPD] Intake`; do not use the display name as the ID.

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

To capture future requests that arrive without Anna manually applying the
label, set `ENABLE_GMAIL_AUTO_LABEL=true`. Before each intake poll Render runs
a bounded Gmail search (default: the last three days, excluding spam/trash)
and reads each candidate. A message is labeled only when it contains both a
FloorPlanDrawings marker (floor plan, site plan, quote, Matterport, square feet,
etc.) and an address or explicit FloorPlanDrawings/new-request marker. Obvious
medical, tax, insurance, Stripe, and other finance messages are rejected. The
whole matched Gmail thread receives `[FPD] Intake`; message content is never
changed, sent, archived, or deleted. Override the search with
`GMAIL_AUTO_LABEL_QUERY` and cap the pass with `GMAIL_AUTO_LABEL_MAX_RESULTS`
(default 10).

To converge Gmail, website, and calendar sources into Airtable, set
`ENABLE_GMAIL_AIRTABLE_SYNC=true` after the Airtable token/base are configured.
Each labeled Gmail message with both a thread ID and extracted property address
uses an idempotent key of `thread ID + normalized property address`. Render
updates the existing Jobs record when that key (or a unique normalized address
from a calendar/website intake) already exists; otherwise it creates one
`New Request` Job. Existing status, quote, assignment, and scheduling fields are
never overwritten. The Jobs table stores Gmail Thread ID, Gmail Message ID,
Normalized Property Key, and Source Channels so later calendar and email runs
can merge in either order without duplicates. Messages missing an address stay
in Render for review and are not written as ambiguous Airtable Jobs.
When the bridge is first enabled, each poll also backfills up to
`GMAIL_AIRTABLE_BACKFILL_MAX` previously ingested Gmail projects that are not
already represented in Airtable (default 5) to avoid Gmail quota spikes.
When a message has an unknown contact or both a known client and agent with no
explicit recipient policy, Render sends an internal `ROLE CLARIFICATION` email
to Anna and records it in Communication Log. It never sends client-facing mail
until the role is explicit. Set `ENABLE_GMAIL_ROLE_CLARIFICATION=false` to
pause those notices without disabling intake.

### Delivery and payment reconciliation

The Gmail poll also runs two narrow reconciliation searches when
`ENABLE_GMAIL_AIRTABLE_SYNC=true`:

- `GMAIL_DELIVERY_QUERY` (default: `from:me (wetransfer OR we.tl) newer_than:730d`)
  captures the first WeTransfer link sent for a matched job in the Jobs field
  `Delivery Link`. That is the durable “floor plan sent” signal.
- `GMAIL_PAYMENT_QUERY` (default: WeTransfer sender/subject notifications from
  the last 730 days) recognizes a provider notification that a transfer was
  downloaded or accepted. It sets `Payment Status` and `Invoice Status` to
  `Paid`, records `Payment Confirmed At`, stores a Gmail `Payment Evidence URL`,
  and adds a Communication Log event.

The payment detector rejects expiry, cancellation, and failure messages. It
matches by Gmail thread, normalized property key, or the WeTransfer token saved
in `Delivery Link`. An unmatched notification remains retryable and is returned
in the poll result for review; it never creates a new job or guesses which job
was paid. Override the searches or caps with `GMAIL_DELIVERY_QUERY`,
`GMAIL_DELIVERY_MAX_RESULTS`, `GMAIL_PAYMENT_QUERY`, and
`GMAIL_PAYMENT_MAX_RESULTS`.

This is the workflow contract going forward: website, Gmail, Calendar, and
future phone/SMS events all resolve to one Jobs record, and each channel only
adds evidence to the fields it owns. A future phone integration should write
through the same address/contact matcher and append a Communication Log row;
it should not create a parallel job table or infer payment from an unverified
conversation.

Set `ENABLE_GMAIL_INTAKE_NOTIFICATIONS=true` only after reviewing one manual
poll. For each labeled message with an extracted property address, Render then
sends Anna an internal-only `QUOTE REQUEST | [address]` email using the same responsive quote
layout and includes an **Open Gmail thread** link. The message is addressed only
to `SMTP_USER`; the sender and client are never copied or blind-copied. Render
also supplies Gmail `In-Reply-To`/`References` headers when available, so Gmail
can group the review with the original thread while keeping the quote details
private. Messages without an address remain in the Render project queue for
manual review and do not generate a client-facing message.

Render tracks job progress with the protected endpoint
`POST /api/ops/projects/:id/progress`. Send a small JSON body such as
`{"stage":"scheduled","status":"scheduled","note":"Client selected a time"}`;
each change is durable (when `STATE_FILE` is mounted) and creates a
`project.progressed` event. The protected lifecycle routes are:

- `POST /api/ops/projects/:id/appointment-confirmation`
- `POST /api/ops/projects/:id/appointment-reminder`

Both require an explicit client recipient policy, reserve an idempotency key,
update the project timeline, and send the styled client email through Render's
primary/fallback SMTP path. `ENABLE_APPOINTMENT_CONFIRMATIONS` is deliberately
off for the current production workflow because the confirmation messages were
creating inbox noise. Leave it unset or set it to `false`; do not turn it on
until Anna approves a new confirmation design. `ENABLE_APPOINTMENT_REMINDERS`
is false by default. When reminders are
enabled, Render checks scheduled projects every `APPOINTMENT_REMINDER_POLL_MS`
and sends one reminder in the 20–28 hour window before the stored appointment.

## Phone communications and the FPD mailbox

The confirmed FPD business line is `(213) 435-7223` (`+12134357223`). The
phone path remains deliberately channel-neutral until that number is confirmed
as provider-backed SMS/MMS, iMessage, or a carrier-app-only line. Record it as
`BUSINESS_PHONE_NUMBER` when configuring the eventual provider adapter.
`server/communications.js` normalizes phone numbers to E.164, preserves the
provider message ID and conversation ID, and matches in this order: external
message ID, conversation/thread ID, normalized property key, then a unique
verified phone/email. Ambiguous or unmatched messages never create a Job; they
are stored as a short-lived-summary review item.

Google Voice email notifications are recognized as SMS transport. They are not
eligible for new-job auto-creation, but the Gmail poll can attach one to an
existing Job or put it in the protected review queue. This keeps a reply about
an existing property from becoming a duplicate Job.

The generic adapter endpoint is staged behind `ENABLE_PHONE_COMMUNICATION_INGEST`:

- `POST /api/communications/inbound` — accepts a signed normalized envelope for
  `sms`, `mms`, `imessage`, or `email`; it logs only a matched existing Job or
  queues the message for review.
- `GET /api/ops/communications/review` — Anna-only review queue.
- `POST /api/ops/communications/review/:communication/resolve` — manually
  attaches one review item to a selected existing Airtable Job and writes its
  idempotent Communication Log row.
- `POST /api/phone/heartbeat` — signed bridge heartbeat; accepts bridge ID,
  version, queue depth, and last successful send/receive timestamps.
- `GET /api/ops/phone/heartbeats` — Anna-only heartbeat status.

Set `AIRTABLE_COMMUNICATION_EXTENDED_FIELDS=true` only after adding these
optional fields to `Communication Log`: `External Message ID`, `Conversation
ID`, `Sender`, `Recipients`, `Received At`, `Body Summary`, `Match Confidence`,
`Match Reason`, and `Attachment IDs`. Until then, the writer uses the existing
Communication Log schema. Raw phone message bodies are not persisted by the
channel-neutral path; only a bounded searchable summary is retained in Render
state.

### One Gmail surface for two addresses

The confirmed business line is separate from the email routing decision. The
least burdensome email experience is to create `anna@floorplandrawings.com` on
the current iCloud custom domain, forward it to Anna's existing Gmail with an
`FPD` label, and configure Gmail `Send mail as` for both `anna@...` and
`hello@...`. A separate Google Workspace mailbox is only needed if FPD must
have an independent mailbox, retention boundary, or delegated account. Gmail's
Multiple Inboxes view can show `label:FPD` as a separate section beside her
normal inbox, while `Send mail as` lets her reply
as the FPD identity. Keep the FPD mailbox copy for retention. The backend can
continue polling the existing `[FPD] Intake` label in Anna's mailbox, or the
OAuth credential can be moved to the FPD mailbox; choose exactly one backend
intake source.

If the FPD address is a Google mailbox, delegation is the cleaner desktop
alternative: Anna opens the delegated inbox from Gmail's account menu and can
read, send, and delete from that mailbox without sharing its password. Google
currently notes that delegated-account support in the iOS/Android Gmail apps is
still rolling out, so mobile use should be tested before relying on delegation
alone. For mobile, adding both accounts to the Gmail app and using **All
inboxes** is the safer fallback.

Do not use a Gmail alias as a substitute for a second mailbox: an alias changes
the From identity but does not give the backend an independent inbox or
independent retention boundary. Configure only one backend intake source for
FPD mail to avoid duplicate Gmail/API and forwarded-copy processing. The
current `GMAIL_INTAKE_LABEL_ID` flow can remain the intake source while Anna's
forwarded view is the operator convenience.

The Gmail help pages for [delegation](https://support.google.com/mail/answer/138350),
[multiple inboxes](https://support.google.com/mail/answer/9694882), and
[sending from another address](https://support.google.com/mail/answer/22370)
describe the corresponding UI settings.

## Calendar reconciliation

`GET /api/icloud/calendar-sync` (or `POST` with `{"dryRun":true}`) performs a
read-only reconciliation of Anna's and the workers' iCloud calendars. It
excludes Home and Reminders, extracts addresses when present, matches existing
Render projects and Airtable Jobs, and reports which events would be created
versus matched. Existing Render projects are matched by normalized property
address. When no Render project matches, Render performs a read-only Gmail
search across all labels for the property address; an exact/strong match carries
the Gmail thread ID (and only explicitly classified client contact details) into
the proposed Airtable listing. No Gmail labels, messages, or threads are changed.

The pass is deliberately dry-run by default. After reviewing one controlled
result, set `ENABLE_CALENDAR_AIRTABLE_SYNC=true` and run the protected endpoint
with `{"dryRun":false}`. Render then creates only unmatched Airtable Jobs and
updates matched records only for fields already present in the table. Every
import uses a stable iCloud calendar URL + event UID key, so moving an event
updates the same listing instead of creating a second one. Automatic polling is
off until that first review; when enabled it runs every `CALENDAR_SYNC_POLL_MS`.

To have a live calendar reconciliation also apply the configured `[FPD] Intake`
label to matched Gmail threads, set `ENABLE_CALENDAR_GMAIL_LABEL_SYNC=true`.
This is independent and guarded: it only runs during a non-dry-run calendar
sync, labels every message in the matched thread (up to 100), and never sends,
archives, or edits message content. Leave it false while reviewing the dry run.

The current project-state store is durable only when `STATE_FILE` points at a
persistent Render disk. Until that is provisioned, Airtable remains the
recovery source and the Gmail poller should stay disabled.

## Portal intake dropbox

The authenticated master portal includes a **Paste a request** section for
text-message, email, or voice-note transcripts that did not arrive through the
website or Gmail label. Render extracts the street address and any email/phone
it can identify, adds Google Maps, ZIMAS, and aerial links, then matches a
single existing Airtable Job by normalized address before creating anything.
The request text is retained as the original request/client notes for Anna to
review. An optional HTTPS photo/card URL can be attached; raw passwords and
credentials are never accepted. The endpoint is `POST /api/portal/intake` and
uses the same portal session as the Jobs view.

`GET /healthz` reports this as `integrations.renderStateDurable`; it is `false`
when the service is using the in-memory safety mode.

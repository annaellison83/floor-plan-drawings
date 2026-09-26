# Cellphone line integration — implementation handoff

Updated: 2026-09-26

## Current audit

The confirmed FPD business number is `(213) 435-7223`, stored in integration
configuration as the E.164 value `+12134357223`. It is not connected to a
provider by this change; the number type and provider still determine whether
the eventual bridge uses SMS/MMS, iMessage, or a carrier app.

The existing Master backend already has the important email-side primitives:

- Gmail OAuth polling scoped to `[FPD] Intake`, with polling fallback and a
  durable Render idempotency store.
- Gmail thread/message IDs and normalized property keys on Jobs.
- Conservative Gmail matching to website/calendar-created Jobs.
- Airtable Communication Log reservations for inbound and outbound email.
- Gmail draft creation for human-reviewed replies.
- Durable Render project, event, delivery, and processed-message state when
  `STATE_FILE` is mounted.

Before this change, a Google Voice notification was rejected by the new-job
heuristic and then marked processed. That prevented accidental Job creation,
but it also discarded the communication instead of attaching it to an existing
Job or showing Anna a review item.

## Implemented first phase

`server/communications.js` is the channel-neutral boundary. It handles SMS,
MMS, iMessage, and email envelopes without choosing a phone provider. It:

1. normalizes phone numbers to E.164 and email addresses to lowercase;
2. creates a stable communication key from provider/message identity;
3. matches only one existing Job, in order of external message ID,
   conversation/thread ID, normalized property key, and unique verified
   phone/email;
4. sends ambiguous or unmatched messages to a durable review queue; and
5. stores only a bounded searchable summary, never the raw message body, in
   the Render review state.

Anna can resolve a review item with the protected
`POST /api/ops/communications/review/:communication/resolve` route and an
existing Airtable Job record ID. That manual action is idempotent and creates
the Communication Log row; it cannot create a new Job.

The Gmail poll now recognizes Google Voice notification mail as an SMS
transport. A message may be logged against an existing Job, or it may enter
the review queue. It cannot create a Job from a phone conversation.

The generic adapter boundary is staged, not enabled by default:

```text
POST /api/communications/inbound
X-Communication-Ingest-Token: <secret>
{
  "channel": "sms",
  "provider": "provider-name",
  "externalMessageId": "provider-message-id",
  "conversationId": "provider-conversation-id",
  "sender": { "phone": "+13235550142" },
  "body": "message text",
  "receivedAt": "2026-09-26T18:00:00.000Z"
}
```

The endpoint requires `ENABLE_PHONE_COMMUNICATION_INGEST=true`. It never
creates a Job. The bridge heartbeat endpoint is:

```text
POST /api/phone/heartbeat
X-Phone-Bridge-Token: <secret>
{
  "bridgeId": "fpd-mac-mini",
  "channel": "imessage",
  "version": "2026.09.26",
  "queuedInbound": 0,
  "lastSuccessfulSendAt": "...",
  "lastSuccessfulReceiveAt": "..."
}
```

Render can monitor the heartbeat and send a stale alert after five minutes,
with optional escalation after fifteen. The Mac bridge is never responsible
for alerting Anna that it is down. An independent uptime monitor should still
watch the Render heartbeat endpoint after production rollout.

## Gmail experience for Anna

The recommended operating model is:

1. Create `anna@floorplandrawings.com` on the current iCloud custom domain, or
   use Google Workspace only if FPD needs a separate mailbox and retention
   boundary.
2. Forward FPD mail to Anna's existing Gmail and apply an `FPD` label. Keep
   the iCloud/primary mailbox copy for retention.
3. Keep the current `[FPD] Intake` OAuth mailbox as the backend source, or move
   that OAuth credential to the FPD mailbox; choose exactly one source.
4. Configure Gmail Multiple Inboxes with a `label:FPD` section so the FPD
   queue is visible without forcing Anna to change her normal inbox habits.
5. Configure Gmail `Send mail as` for both `anna@...` and `hello@...`, with
   replies using the address that received the message.

This gives the backend a clean mailbox/label boundary while giving Anna one
familiar Gmail surface. The forwarded copy is an operator view, not a second
ingestion source; otherwise Gmail/API polling and forwarding can create
duplicate processing. If a separate FPD mailbox is not available, Gmail account switcher
plus **All inboxes** is the mobile fallback. Delegation is convenient on the
desktop, but Google's current help page says delegated-account support in the
Gmail mobile apps is still rolling out, so it should not be the only mobile
plan.

An alias alone is not enough if FPD needs a separate inbox or retention
boundary. For the current one-inbox operating model, an iCloud custom-domain
address plus forwarding is sufficient; a provider-backed mailbox is required
only if that boundary becomes necessary.

The current domain is not using Google for mail. A DNS check shows MX records
at `mx01.mail.icloud.com` and `mx02.mail.icloud.com`, plus an iCloud SPF
record. The repository's mail adapter also prefers `ICLOUD_SMTP_*` when those
credentials are configured. Netlify hosts the public website, Bluehost is the
authoritative DNS provider, and Render hosts the Master backend; none of those
is the current mailbox host.

Therefore a hypothetical `anna@floorplandrawings.com` can be created under
iCloud Custom Email Domain and used with the same domain/mail system as
`hello@floorplandrawings.com`. The backend can use
`INTERNAL_NOTIFICATION_EMAIL=anna@floorplandrawings.com` for internal workflow
mail while keeping `SMTP_USER`/`MAIL_FROM` as the FPD business sender. No
Google Workspace migration is required.

## Number decision matrix

| Number type | Recommended adapter | Anna's outbound path | Main risk |
| --- | --- | --- | --- |
| Provider-backed SMS/MMS | Provider webhook + API to `/api/communications/inbound` | Approval queue → provider API | Consent, STOP handling, delivery status |
| iMessage number | Dedicated Mac bridge + heartbeat | Approval queue → serialized Messages bridge | Full Disk Access, lockouts, fragile Apple boundary |
| Carrier phone app only | Keep phone-app intake/manual portal fallback | Phone app or manual portal | No dependable server-side message API |
| Google Voice notification mail | Existing Gmail poll as SMS transport | Gmail/Google Voice until provider decision | Notification parsing and stale Gmail access |

Do not select the provider or enable autonomous replies until the number type,
business identity, alert destination, and retention policy are confirmed.

## Airtable schema rollout

The new writer remains compatible with the current Communication Log schema.
After creating the optional fields below, set
`AIRTABLE_COMMUNICATION_EXTENDED_FIELDS=true`:

- `External Message ID`
- `Conversation ID`
- `Sender`
- `Recipients`
- `Received At`
- `Body Summary`
- `Match Confidence`
- `Match Reason`
- `Attachment IDs`

The first deployment can therefore run in shadow/review mode without an
Airtable schema migration.

## Safe rollout

1. Confirm the number type and whether FPD mail will be a separate mailbox.
2. Keep `ENABLE_PHONE_COMMUNICATION_INGEST=false` and run parser/matcher
   fixture tests.
3. If using Google Voice, run one manual Gmail poll and review
   `/api/ops/communications/review`.
4. Add the optional Communication Log fields and enable the extended payload
   only after the schema is confirmed.
5. Enable one inbound adapter and replay a duplicate webhook/checkpoint.
6. Add the outbound approval queue and provider send test; do not enable
   autonomous sending.
7. Start the bridge heartbeat and simulate a fifteen-minute outage before
   enabling live customer communication.

No credentials, provider selection, Airtable records, calendar events, or
outbound phone messages are changed by this implementation.

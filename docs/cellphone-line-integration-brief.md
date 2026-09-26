# Cellphone line integration brief

## Objective

Give Anna one dependable communications path for the new business number. Inbound messages and emails should be attached to the right job, outbound replies should be possible from the same identity, and a computer or bridge outage should create an alert before messages are missed.

## Current build status

The confirmed number is `(213) 435-7223` (`+12134357223`). The first phase is
implemented as a read-only Mac Messages ingest probe for Anna's logged-in Mac
session, with a durable SQLite row checkpoint, strict destination filtering,
sender normalization, attachment-aware channel detection, and optional signed
forwarding to the hosted communication endpoint. It is currently in dry-run
mode: the test message was detected locally, but no server request, Airtable
write, outbound reply, or checkpoint advance has occurred.

The hosted communication boundary, review queue, deduplication key, heartbeat
endpoint, stale-bridge monitor, and migration-aware business-number filtering
are staged in the backend. Activation still requires deploying that backend,
setting the ingest token and feature flags, and then loading the Anna-session
LaunchAgent. Outbound sending remains intentionally unimplemented until the
inbound path has been shadow-tested.

## First decision: what kind of number is this?

Before implementation, confirm whether the new number is:

- a carrier mobile number used by an iPhone and signed into iMessage;
- an SMS/MMS number that can be moved to Twilio, Telnyx, or another messaging API; or
- a number that must remain in the carrier's phone app.

The answer changes the design. iMessage has no supported general-purpose server API. An Apple-first bridge can read the macOS Messages database and send through Messages/Shortcuts, but it requires a dedicated, always-on Mac with Full Disk Access and is more fragile than an SMS provider. A provider number gives a cleaner webhook/API path for SMS and MMS, but it will not receive iMessages sent to an Apple ID or iMessage-enabled number. If both are required, treat them as two channels with one shared conversation model.

## Recommended architecture

1. **Channel adapters**
   - Gmail adapter: Gmail history/watch where available, with polling fallback.
   - SMS/MMS adapter: provider webhooks and outbound API if the number is provider-backed.
   - iMessage adapter, only if required: a small macOS bridge that reads new rows from `~/Library/Messages/chat.db` and forwards normalized inbound envelopes to the hosted endpoint. Keep this adapter replaceable so the rest of the system does not depend on AppleScript or UI automation. Outbound sends remain a later, human-approved phase.

2. **Normalization and matching**
   - Normalize phone numbers to E.164 and email addresses to lowercase.
   - Match first on provider/message/thread IDs, then on a normalized property key, then on a verified contact match. Never create a job from a signature, carrier footer, or a sender label that is only a phone number.
   - Store a confidence and match reason for every automatic attachment. Low-confidence messages go to a review queue instead of creating a job.

3. **Shared communication record**
   Extend the existing Communication Log with channel, direction, external message ID, thread/conversation ID, sender, recipients, received/sent time, delivery status, body/summary, attachment IDs, matched Job record ID, match confidence, and processing error. Keep raw message bodies short-lived or access-controlled; retain searchable summaries and links where possible.

4. **Outbound queue**
   Begin with human approval for every reply. Store a draft, target channel, target number/email, job ID, and idempotency key. Send only once, record the provider response, and surface failures in Master. Automatic sending can be enabled later for narrowly defined templates.

5. **Dead-man monitoring**
   - The bridge sends a signed heartbeat to a hosted endpoint every 60 seconds.
   - The hosted service records the last heartbeat and raises an alert after a configurable threshold (start at 5 minutes, escalate at 15 minutes).
   - Use an external monitor or hosted scheduler for the alert; the Mac cannot be responsible for notifying Anna that the Mac is down.
   - Alert by email first and by a separate channel (existing phone/email or an uptime service) for escalation. Include last heartbeat, bridge version, queued inbound count, and last successful send/receive time.

## Email ingest requirements

- Keep the current Gmail intake label/query as the front door.
- Use Gmail `historyId`/watch when available, and poll as a fallback so a missed webhook does not lose mail.
- Separate new intake, client reply, quote approval, scheduling, confirmation, reminder, delivery, and payment signals.
- Deduplicate by Gmail message ID and thread ID; keep thread replies attached to the existing Job.
- Reject automated footers, carrier notifications, and unrelated mail before Airtable creation.
- Preserve sender role (`client`, `agent`, `internal`, `unknown`) and send unknown-role messages to review.
- Keep WeTransfer acceptance/download signals as payment evidence, with the transfer URL and Gmail message ID in the log.

## iMessage bridge requirements, if selected

- Run on a dedicated Mac user session that stays signed into Messages and iCloud.
- Request Full Disk Access explicitly; never copy the entire chat database to the server.
- Read only new rows after a stored `rowid`/timestamp checkpoint; normalize reactions, attachments, and group chats.
- Resolve the business number and participant phone numbers before ingesting.
- For outbound messages, use a single serialized sender with an idempotency key and verify the sent message appears in the local database.
- Pause outbound sends when the bridge is stale, the target conversation is ambiguous, or Messages is locked out.
- Keep an operator-visible “needs review” queue for unknown numbers and messages without a property/job reference.

## Rollout sequence

1. Inventory the carrier number, Apple ID/iMessage state, Mac availability, and desired alert destination.
2. Build the shared communication schema and read-only Gmail/SMS ingestion with fixtures and replay tests.
3. Add matching, deduplication, review queue, and audit logging before enabling any replies.
4. Add the outbound approval queue and one-channel send test.
5. Add heartbeat monitoring and simulate a 15-minute outage.
6. Add the iMessage bridge only if the number truly needs iMessage; otherwise use a provider webhook/API. For the current number, the bridge is installed for dry-run verification but not loaded as a live LaunchAgent.
7. Run a one-week shadow period, compare every inbound message against Gmail/Messages, then enable limited automation.

## Acceptance criteria

- No message creates a duplicate Job when its thread, phone, email, or property already exists.
- No automated footer or phone number is displayed as a property or client name.
- Every inbound and outbound message has an audit record and a visible processing result.
- Anna can reply from the business identity and see delivery/failure status.
- A stopped bridge produces an external alert within the agreed threshold.
- Replaying the same webhook, Gmail history page, or Messages checkpoint is safe and idempotent.

## Agent handoff prompt

> Audit the existing Master jobs portal and Gmail/Airtable sync before proposing code. Design a channel-neutral communication layer for Gmail plus the new business phone number, explicitly comparing a provider-backed SMS/MMS number with an iMessage-on-Mac bridge. Preserve job matching, deduplication, human approval, audit logging, and the existing Airtable Jobs/Communication Log model. Specify the smallest safe first phase, required credentials and macOS permissions, heartbeat/outage monitoring, outbound reply flow, data retention, failure modes, and a test plan. Do not enable autonomous outbound messaging or create records from low-confidence messages until the review queue and idempotency checks are in place.

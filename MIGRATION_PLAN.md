# FloorPlanDrawings Render migration plan

This plan keeps Netlify, Airtable, and the existing workflows live until Render
has passed a shadow-run and delivery verification. No Airtable automation is
disabled as part of the preparatory work.

## Completed

1. Render web service is live from `main` with health checks enabled.
2. iCloud CalDAV authentication and read-only calendar discovery work.
3. Calendar roster recognizes Anna as owner, Corrie/Sarah/Ricardo as workers,
   and excludes Home/Reminders.
4. iCloud SMTP authentication works; `hello@floorplandrawings.com` is the
   authorized sender. A real test message was accepted and recovered from Gmail
   spam.
5. Render quote-ready and approved-client quote pollers use Airtable
   communication-log reservations and duplicate-delivery guards.
6. Scheduling policy is live at the protected read-only
   `/api/icloud/scheduling-policy` endpoint.
7. Read-only worker availability is live at `/api/icloud/availability`.
8. The dry-run planner is live at
   `/api/icloud/appointments/dry-run`; it recommends a worker/slot without
   creating events or changing Airtable.
9. Provisional hold create/release endpoints are implemented but remain
   disabled behind `ENABLE_PROVISIONAL_HOLDS=false` pending review.

## Execution order

1. **Availability read layer (read-only).** Query each roster calendar for
   existing events at the 11:00 AM and 1:00 PM slots. Do not create or modify
   events. Return available slots plus the selected worker rationale.
2. **Dry-run appointment planner.** Combine square footage, service type,
   Sarah's 5-mile starting radius, worker capacity, and delivery targets. Every
   recommendation must include duration, worker, slot, and delivery target.
3. **Provisional holds.** Enable the staged idempotent CalDAV create endpoint
   only after the dry-run output is reviewed. It requires an expiration time,
   uses a unique job/slot key, and includes a protected release path.
4. **Confirmed events.** Add the confirmation path, duplicate protection, and
   Airtable communication logging. Never write to Home or Reminders.
5. **Operational email parity.** Move follow-ups, reminders, client
   confirmations, and communication logging to Render using the same guarded
   sender and an explicit retry/failure record.
6. **Delivery resilience.** Add an alert path for failed sends and a carefully
   bounded fallback provider. Do not retry an ambiguous SMTP result blindly.
7. **Shadow run.** Leave Airtable automations on, compare Render decisions and
   delivery logs against Airtable for a representative set of jobs, and send
   controlled test messages.
8. **Cutover.** Only after shadow-run success and Anna's approval, pause the
   corresponding Airtable email automations one at a time. Keep Airtable as the
   dashboard/source of truth and retain the rollback path.

## Future customer-agent phase

After the Render migration is stable, add a website conversation agent with a
seamless web-to-text handoff. A visitor can start a quote or scheduling
conversation on FloorPlanDrawings.com, choose **Text me this conversation**,
explicitly opt in to SMS, and continue later from the same conversation ID.
The handoff must preserve the conversation summary, property research, quote
state, and pending actions. The agent can send routine client updates and
employee/Anna notifications, while escalating pricing exceptions, unusual
properties, cancellations, and capacity conflicts for human approval. SMS
delivery must include consent, STOP handling, delivery-status logging, retries,
and a secure link back to the website for uploads or quote review.

## Current scheduling defaults

- Appointment starts: 11:00 AM and 1:00 PM.
- Up to 3,000 sq ft: 90 minutes.
- Larger projects: linear scaling from that baseline, rounded up to 30-minute
  increments.
- Corrie is prioritized to 3–4 appointments/week; 5,000+ sq ft is one Corrie
  appointment/day.
- Ricky/Ricardo can take up to two appointments/day.
- Sarah is small-house spillover within a starting 5-mile radius of 431 Marie.
- Anna targets eight Monday/Tuesday appointments for Friday delivery.
- Black-and-white target: two days. Color target: three days. Wednesday aims for
  Saturday; Thursday and Friday aim for Monday EOD.

## Decisions to confirm before event writes

- Provisional-hold expiry duration (the staged endpoint enforces a 24-hour
  maximum and requires an explicit expiry on each request).
- Working hours, holidays, and whether weekends may be booked.
- The full street address for Sarah's home base (the radius is currently a
  tunable starting assumption).
- Whether Ricky's two-appointment capacity applies to every size or only large
  projects.

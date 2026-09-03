# Email delivery resilience

## What is protected now

- A website submission is written to Airtable before notification delivery.
- Render checks for unsent QUOTE READY and approved-client records every minute.
- A Communication Log reservation is created before SMTP delivery.
- A successful Gmail SMTP response is required before the Jobs record is stamped sent.
- SMTP failures leave the job unsent, so Render retries it.
- Existing Pending/Sent log entries block duplicate delivery.

This protects against transient Render, Airtable, or SMTP errors and preserves the lead even when an email is delayed.

## What is not automatic yet

The disabled Airtable QUOTE READY automation is a manual rollback, not an active failover. Do not simply turn it on while Render is healthy: it can duplicate a Render email.

The mission-critical next layer is a delayed Airtable-sender fallback:

1. An independent scheduler finds Quick Quotes still `Anna Email Status = Not Sent` after the retry window.
2. It claims the record with a dedicated backup-pending state.
3. Airtable's sender delivers the fallback message and writes the Communication Log.
4. A separate alert channel reports any record that remains pending or failed.

The claim must happen before the fallback sends so Render and Airtable cannot both deliver the same message. Test this with a throwaway record before enabling it for production.

## Recovery checklist

1. Check `https://floor-plan-drawings.onrender.com/healthz`.
2. In Jobs, filter for `Anna Email Status = Not Sent` and inspect Communication Log for failures.
3. If Render is down, do not approve repeatedly. Use the Airtable record as the durable queue and enable the reviewed fallback only after confirming no Pending/Sent reservation exists.
4. After recovery, verify one Communication Log row and one sent message per Job record.

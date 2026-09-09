# Netlify → Render intake handoff

The public form continues to run on Netlify. The function normalizes the
submission, then attempts the protected Render endpoint before falling back
to the existing Airtable write if Render is unavailable.

## Provider configuration

Set a new random shared secret in both provider dashboards:

```text
RENDER_INTAKE_TOKEN=<same secret in Netlify and Render>
```

Set this in Netlify:

```text
RENDER_INTAKE_URL=https://floor-plan-drawings.onrender.com/api/intake
```

Keep the token out of GitHub, chat, terminal output, and committed `.env`
files. Do not reuse `INTERNAL_ADMIN_TOKEN`.

## Request contract

Netlify sends a JSON envelope with a bearer token:

```json
{
  "version": 1,
  "source": "netlify-fpd-intake",
  "idempotencyKey": "WEB-...",
  "fields": {
    "Job ID": "WEB-...",
    "Property Address": "...",
    "Status": "Needs Quote"
  }
}
```

Render creates the Jobs record using its own Airtable credentials and returns
the record ID. The `Job ID` lookup makes a retried handoff safe. Netlify then
continues the existing research enrichment and notification step while the
workflow migration is in progress.

If the Render request times out, is rejected, or is not configured, the
function writes directly to Airtable using the legacy path. This makes the
handoff fail-safe during rollout; it does not make the two systems send two
records for the same `Job ID`.

# Property Research Helper

`/.netlify/functions/property-research` provides a cautious first pass for property context.

## What it does

- Searches the public LA County CAMS address-point layer.
- Returns a possible AIN/APN candidate and the LA area label.
- Generates a public LARIAC aerial preview URL.
- Estimates straight-line miles from North Hollywood and Monterey Park.
- Marks uncertain or missing matches for manual review.
- Never fills square footage or quote amounts.

The address lookup uses [CAMS address points](https://arcgis.gis.lacounty.gov/arcgis/rest/services/LACounty_Dynamic/CAMS/MapServer/1). The aerial preview uses Esri's public [World Imagery MapServer](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer), which is more dependable for a small preview image than the county's current dynamic raster export.

## Read-only preview

After deployment, open this URL in a browser:

`/.netlify/functions/property-research?address=4011%20Scandia%20Way%2C%20Los%20Angeles%2C%20CA%2090065`

This mode does not need Airtable credentials and does not change any records.

## Airtable update mode

The protected POST mode accepts:

```json
{"recordId":"rec..."}
```

It reads the address from the Jobs record, researches it, and writes only property-research fields and a dated note. It requires these Netlify environment variables:

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_JOBS_TABLE` (optional; defaults to `Jobs`)
- `PROPERTY_RESEARCH_KEY`

The request must include `X-Property-Research-Key` matching `PROPERTY_RESEARCH_KEY`. Keep that key out of the website and out of GitHub. The key does not need to be exposed to browser code.

## Deliberate limits

The CAMS result is an address point, not proof of a particular apartment, suite, unit, or parcel. A single-family-looking address is still stored as `Possible Match`; duplexes, apartments, commercial suites, multi-parcel properties, and no-match results remain manual-review work.

The helper currently leaves these alone until the property is reviewed:

- `Verified Sq Ft`
- `Sq Ft Source`
- `Suggested Quote`
- `Quote Zone`
- `Zone Fee`
- `Multi-Unit Fee`

## Next wiring step

Airtable's currently available automation actions do not include an outbound HTTP request or a script action through the CLI. To make this run automatically, use one of these small adapters:

1. A Render cron job that finds new `Jobs` records and POSTs their record IDs here.
2. An Airtable UI `Run a script` action that POSTs the record ID here.

Keep the adapter idempotent: only call records with `Property Check Status = Not Checked`, and let the helper overwrite only its own research fields.

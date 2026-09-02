# Property Research Helper

`/.netlify/functions/property-research` provides a cautious first pass for property context.

## What it does

- Searches the public LA County CAMS address-point layer.
- Falls back to the submitted map address through a public geocoder when CAMS misses a valid directional or numbered street address.
- Returns a possible AIN/APN candidate and the LA area label.
- Adds ZIMAS PIN, parcel area, and zoning when the point lands cleanly on one City of Los Angeles parcel.
- Looks up building square footage, building count, units, use type, and year built from the official LA County assessor parcel layer. If the geocoded point lands just outside a parcel, retries nearby parcels and accepts only an address-number/street-name match.
- Stores a human-facing ZIMAS link and LA County Assessor Portal link; raw ArcGIS query URLs are kept out of the email-facing source field.
- Generates a public LARIAC aerial preview URL.
- Generates a second, wider Google Maps context image centered on the property so Anna can see where it sits in greater Los Angeles.
- Estimates straight-line miles from North Hollywood and Monterey Park.
- Calculates a suggested internal price from the Airtable `Quote Pricing` table when online building square footage and a recognized service are available.
- Marks uncertain, missing-size, out-of-band, or unpriced jobs for manual review.

The address lookup uses [CAMS address points](https://arcgis.gis.lacounty.gov/arcgis/rest/services/LACounty_Dynamic/CAMS/MapServer/1). Parcel and zoning context comes from the [ZIMAS landbase service](https://zimas.lacity.org/arcgis/rest/services/zma/zimas/MapServer/105) and [ZIMAS zoning service](https://zimas.lacity.org/arcgis/rest/services/zma/zimas/MapServer/1102). Building size comes from the [LA County parcel boundary service](https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/GISNET_Public/MapServer/333), whose assessor fields include building square footage. The close aerial preview uses LA County's public 2023 imagery layer rendered through ArcGIS; the wider context preview uses Google Maps Static API when `GOOGLE_MAPS_STATIC_KEY` is configured.

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

The helper leaves these alone until the property is reviewed when the source data is missing or ambiguous:

- `Verified Sq Ft` is filled from LA County assessor building square footage, never from ZIMAS lot area. A nearby-parcel recovery is labeled in `Sq Ft Source` and the research note.
- `Sq Ft Source` identifies the public source.
- `Suggested Quote` is filled from the Airtable pricing table when the online size and requested service are usable.
- `Quote Zone`, `Zone Fee`, and `Multi-Unit Fee` remain pending until Anna's travel and complexity rules are entered.

`Lot Size` is parcel area from ZIMAS. It is not the building's livable square footage and must not be used as the quote size.

## Quote calculation

The intake function reads the `Quote Pricing` table on each new job. It chooses the smallest size band that contains the online building square footage, then applies the requested service:

- B&W uses `B&W Base`.
- Color Interior uses `Condo Color Interior Base` and is flagged for review when the property is not a condo.
- Color Interior + Exterior uses `Color + Exterior Starting At`.
- A requested 3D tour adds the size-band `Matterport Base` when available.

The result is an internal suggested number for Anna. It is not presented as a detailed client-facing fee breakdown. Travel, multi-unit, commercial, and partial-scope adjustments are called out in `Quote Calculation Notes` until their amounts are configured.

## Runtime behavior

Website submissions call the research pass immediately after the Airtable record is created. A protected POST can also rerun research for an existing record when needed. Keep any future adapter idempotent: only call records with `Property Check Status = Not Checked`, and let the helper overwrite only its own research fields.

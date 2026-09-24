const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAerialFallbackLink } = require("./property-links");
const { gmailAirtableFields } = require("./gmail-airtable-sync");
const { enrichGmailProperty } = require("./gmail-property-enrichment");

const address = "1917 Eden Ave, Pasadena, CA 91103";

function builtFields() {
  return {
    "Property Check Status": "Matched",
    "Property Research Complete": true,
    "Aerial Map URL": "https://gis.example/fresh-aerial.jpg",
    "Satellite Photo Link": "https://gis.example/fresh-aerial.jpg",
    "ZIMAS Link": "https://zimas.example/pin/123",
    "Google Maps Link": "https://maps.example/property"
  };
}

test("Gmail fields enrich end to end and persist a stable asset attachment", async () => {
  const fields = gmailAirtableFields({ propertyAddress: address, threadId: "thread-1", id: "message-1", subject: "Floor plans", text: "Please quote this address" });
  const updates = [];
  const seen = [];
  const result = await enrichGmailProperty({
    recordId: "rec1",
    fields,
    researchAddress: async () => ({ ok: true, status: "Matched" }),
    buildUpdateFields: () => builtFields(),
    prepareEmailAssets: async (job) => { seen.push(job); return { emailAerialUrl: "https://floor-plan-drawings.onrender.com/assets/property-aerial?address=x" }; },
    updateJob: async (_id, patch) => updates.push(patch)
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0].mapUrl, "https://gis.example/fresh-aerial.jpg");
  assert.equal(updates[0]["Property Research Complete"], true);
  assert.equal(updates[0]["Aerial Parcel Preview"][0].url, "https://floor-plan-drawings.onrender.com/assets/property-aerial?address=x");
});

test("retry uses a stored real aerial source and preserves a manual satellite link", async () => {
  const fields = {
    "Property Address": address,
    "Property Research Complete": false,
    "Property Check Status": "Needs Manual Review",
    "Aerial Map URL": buildAerialFallbackLink(address),
    "Satellite Photo Link": "https://manual.example/satellite.jpg"
  };
  const updates = [];
  const seen = [];
  const result = await enrichGmailProperty({
    recordId: "rec2",
    fields,
    researchAddress: async () => ({ ok: true, status: "Matched" }),
    buildUpdateFields: () => ({ ...builtFields(), "Property Check Status": "Matched" }),
    prepareEmailAssets: async (job) => { seen.push(job); return { emailAerialUrl: "https://floor-plan-drawings.onrender.com/assets/property-aerial?address=x" }; },
    updateJob: async (_id, patch) => updates.push(patch)
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0].mapUrl, "https://gis.example/fresh-aerial.jpg");
  assert.equal(seen[0].satellitePhotoLink, "https://manual.example/satellite.jpg");
  assert.equal(updates[0]["Property Check Status"], "Matched");
  assert.equal(updates[0]["Satellite Photo Link"], undefined);
});

test("retry passes an existing Airtable aerial attachment to the cache", async () => {
  const fields = {
    "Property Address": address,
    "Property Research Complete": false,
    "Property Check Status": "Needs Manual Review",
    "Aerial Parcel Preview": [{ url: "https://v5.airtableusercontent.com/real-aerial.jpg" }],
    "Aerial Map URL": buildAerialFallbackLink(address)
  };
  let preparedJob;
  const updates = [];
  const result = await enrichGmailProperty({
    recordId: "rec4",
    fields,
    researchAddress: async () => ({ ok: true, status: "Matched" }),
    buildUpdateFields: () => builtFields(),
    prepareEmailAssets: async (job) => { preparedJob = job; return { emailAerialUrl: "https://floor-plan-drawings.onrender.com/assets/property-aerial?address=x" }; },
    updateJob: async (_id, patch) => updates.push(patch)
  });
  assert.equal(result.ok, true);
  assert.equal(preparedJob.aerialAttachmentUrl, "https://v5.airtableusercontent.com/real-aerial.jpg");
  assert.equal(updates[0]["Aerial Parcel Preview"], undefined);
});

test("research or asset failure leaves the record retryable", async () => {
  const updates = [];
  const result = await enrichGmailProperty({
    recordId: "rec3",
    fields: { "Property Address": address },
    researchAddress: async () => { throw new Error("temporary GIS outage"); },
    buildUpdateFields: () => ({}),
    prepareEmailAssets: async () => ({ emailAerialUrl: "" }),
    updateJob: async (_id, patch) => updates.push(patch)
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.deepEqual(updates[0], { "Property Research Complete": false, "Property Check Status": "Needs Manual Review" });
});

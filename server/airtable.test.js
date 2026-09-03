const test = require("node:test");
const assert = require("node:assert/strict");
const { mapJob } = require("./airtable");

test("maps a Jobs record without exposing credentials", () => {
  const job = mapJob({
    id: "rec08dRgUXUMPajMt",
    fields: {
      "Property Address": "349 Mount Washington Dr, Los Angeles, CA 90065",
      "Client Name": "Eric Greenburg",
      "Client Email": "eric.greenburg@gmail.com",
      "Drawing Style": "Color Interior + Exterior",
      "Quote Zone": "Zone 1",
      "Verified Sq Ft": 784,
      "Suggested Quote": 345,
      "3D Tour Requested": false,
      "Quote Approval Token": "approval-secret"
    }
  }, {
    baseId: "appBq1xl0G5vCegAH",
    tableId: "tbl6iNAIVKLb9QcYi",
    approvalBaseUrl: "https://floorplandrawings.com/.netlify/functions/approve-quote"
  });

  assert.equal(job.propertyAddress, "349 Mount Washington Dr, Los Angeles, CA 90065");
  assert.equal(job.verifiedSqFt, 784);
  assert.equal(job.tourRequested, "No");
  assert.match(job.recordUrl, /rec08dRgUXUMPajMt$/);
  assert.match(job.approvalUrl, /token=approval-secret$/);
  assert.equal("token" in job, false);
});

test("supports field-name fallbacks", () => {
  const job = mapJob({ id: "recABC123", fields: {
    Address: "123 Main St",
    "Service Requested": "Black and White",
    "Approx Square Feet": 1200
  }});
  assert.equal(job.propertyAddress, "123 Main St");
  assert.equal(job.service, "Black and White");
  assert.equal(job.approxSqFt, 1200);
});

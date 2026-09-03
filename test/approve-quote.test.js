const assert = require("node:assert/strict");
const test = require("node:test");
const { airtableRecordUrl, parseEdits } = require("../netlify/functions/approve-quote");

test("approval confirmation uses a direct Airtable record URL", () => {
  assert.equal(
    airtableRecordUrl("appBq1xl0G5vCegAH", "tbl6iNAIVKLb9QcYi", "viwQRZQIUr0hbAzv7", "recOJNBI1XANzHKy5"),
    "https://airtable.com/appBq1xl0G5vCegAH/tbl6iNAIVKLb9QcYi/viwQRZQIUr0hbAzv7/recOJNBI1XANzHKy5?blocks=hide"
  );
  assert.equal(airtableRecordUrl("bad", "tbl6iNAIVKLb9QcYi", "viwQRZQIUr0hbAzv7", "recOJNBI1XANzHKy5"), "");
});

test("manually entered project size is labeled as Anna-confirmed", () => {
  const fields = parseEdits({
    body: new URLSearchParams({
      action: "save",
      quoteAmount: "300",
      quoteZone: "Zone 1",
      drawingStyle: "Color Interior + Exterior",
      verifiedSqFt: "475"
    }).toString()
  }, {
    "Sq Ft Source": "No online building square footage found"
  }).fields;

  assert.equal(fields["Verified Sq Ft"], 475);
  assert.equal(fields["Sq Ft Source"], "Anna confirmed during quote review");
});

test("an unchanged assessor size keeps its original source", () => {
  const fields = parseEdits({
    body: new URLSearchParams({
      action: "save",
      quoteAmount: "300",
      quoteZone: "Zone 1",
      drawingStyle: "Color Interior + Exterior",
      verifiedSqFt: "900"
    }).toString()
  }, {
    "Verified Sq Ft": 900,
    "Sq Ft Source": "LA County Assessor public record"
  }).fields;

  assert.equal(fields["Sq Ft Source"], undefined);
});

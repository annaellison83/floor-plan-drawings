const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAirtableFields } = require("./fpd-intake");

test("website intake keeps city out of Property Address", () => {
  const fields = buildAirtableFields({
    workflow: "Quick Quote",
    address: "941 Fortune Way",
    city: "Highland Park",
    email: "lisa@example.com",
    name: "Lisa Klipsic"
  });
  assert.equal(fields["Property Address"], "941 Fortune Way");
  assert.equal(fields.City, "Highland Park");
  assert.match(fields["Google Maps Link"], /941%20Fortune%20Way%2C%20Highland%20Park/);
});

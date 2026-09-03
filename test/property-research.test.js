const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUpdateFields } = require("../netlify/functions/property-research");

function researchAtDistances(milesFromNorthHollywood, milesFromMontereyPark) {
  return {
    ok: true,
    status: "Possible Match",
    address: "228 East Avenue 42, Los Angeles, CA 90031",
    sourceUrl: "https://example.test/source",
    candidate: {
      ain: "",
      fullAddress: "228 East Avenue 42, Los Angeles, CA 90031",
      area: "Montecito Heights",
      aerialUrl: ""
    },
    milesFromNorthHollywood,
    milesFromMontereyPark,
    laCityMatch: "Matched",
    zimas: null,
    countyAssessor: null,
    contextMapUrl: ""
  };
}

test("property research writes the automatically resolved quote zone", () => {
  const fields = buildUpdateFields(researchAtDistances(11.9, 5.3), {});
  assert.equal(fields["Quote Zone"], "Zone 1");
  assert.match(fields["Quote Calculation Notes"], /Automatic quote zone: Zone 1/);
});

test("a manually assigned quote zone is preserved", () => {
  const fields = buildUpdateFields(researchAtDistances(11.9, 5.3), { "Quote Zone": "Zone 4" });
  assert.equal(fields["Quote Zone"], "Zone 4");
});

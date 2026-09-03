const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveSquareFootage, sizeResearchLinks } = require("./square-footage");

test("assessor building area is verified and permits automatic pricing", () => {
  const result = resolveSquareFootage({ assessorSqFt: 784, lotSqFt: 5000 });
  assert.equal(result.value, 784);
  assert.equal(result.verified, true);
  assert.equal(result.canAutoQuote, true);
});

test("client estimate stays visibly unverified", () => {
  const result = resolveSquareFootage({ submittedSqFt: 1800 });
  assert.equal(result.value, 1800);
  assert.equal(result.verified, false);
  assert.equal(result.canAutoQuote, false);
  assert.match(result.label, /client estimate/);
});

test("listing estimates provide a labeled fallback without becoming verified", () => {
  const result = resolveSquareFootage({ zillowSqFt: 1200, redfinSqFt: 1250 });
  assert.equal(result.value, 1250);
  assert.equal(result.verified, false);
  assert.equal(result.canAutoQuote, false);
  assert.match(result.label, /Redfin estimate/);
  assert.match(result.source, /verification required/);
});

test("lot size is never accepted as building square footage", () => {
  const result = resolveSquareFootage({ lotSqFt: 12000 });
  assert.equal(result.value, null);
  assert.equal(result.canAutoQuote, false);
  assert.match(result.source, /lot size was not used/);
});

test("unresolved size has direct Google and listing-site research links", () => {
  const links = sizeResearchLinks("349 Mount Washington Dr, Los Angeles, CA 90065");
  assert.deepEqual(links.map((link) => link.label), [
    "Google square-footage search",
    "Zillow results",
    "Redfin results",
    "Realtor.com results",
    "Homes.com results"
  ]);
  assert.match(links[0].url, /349%20Mount%20Washington/);
  assert.match(links[0].url, /square%20feet/);
  assert.match(links[0].url, /sq%20ft/);
  assert.match(links[0].url, /sq%20feet/);
});

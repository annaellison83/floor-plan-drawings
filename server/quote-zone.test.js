const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveQuoteZone } = require("./quote-zone");

test("manual zone always wins", () => {
  assert.equal(resolveQuoteZone({ quoteZone: "Zone 4", milesFromNorthHollywood: 2 }).zoneNumber, 4);
});

test("uses the nearer of Anna's two service hubs", () => {
  const zone = resolveQuoteZone({ milesFromNorthHollywood: 11.5, milesFromMontereyPark: 5.7 });
  assert.equal(zone.zoneNumber, 1);
  assert.equal(zone.minimum, 200);
  assert.equal(zone.needsReview, false);
});

test("marks map boundaries and distant locations for review", () => {
  assert.equal(resolveQuoteZone({ milesFromNorthHollywood: 14.5, milesFromMontereyPark: 25 }).needsReview, true);
  assert.equal(resolveQuoteZone({ milesFromNorthHollywood: 40, milesFromMontereyPark: 42 }).zoneNumber, null);
});

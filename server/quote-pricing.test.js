const assert = require("node:assert/strict");
const test = require("node:test");
const { largeColorProjectFloor } = require("./quote-pricing");
const { quotePricing, quoteReadyEmail } = require("./email-templates");

test("large color projects get a provisional linear floor near ten cents per square foot", () => {
  assert.equal(largeColorProjectFloor(4000, "Color Interior"), 400);
  assert.equal(largeColorProjectFloor(4600, "Color Interior"), 450);
  assert.equal(largeColorProjectFloor(4000, "Color Interior + Exterior"), 400);
  assert.equal(largeColorProjectFloor(4000, "B&W"), null);
});

test("email pricing does not let a large color project fall back to a small zone minimum", () => {
  const pricing = quotePricing({
    suggestedQuote: 200,
    submittedSqFt: 4000,
    service: "Color Interior",
    quoteZone: "Zone 1"
  });
  assert.equal(pricing.finalPrice, 400);
  assert.equal(pricing.sizeFloor, 400);
});

test("quote detail rows use line breaks and separators for dense service notes", () => {
  const email = quoteReadyEmail({
    propertyAddress: "123 Main St",
    service: "Color Interior",
    scope: "Balcony and front porch",
    tourRequested: "No",
    clientNotes: "Main house is about 4,000 sq ft.",
    suggestedQuote: 200,
    submittedSqFt: 4000,
    quoteZone: "Zone 1"
  });
  assert.match(email.html, /Color Interior\n• Scope: Balcony and front porch\n• 3D tour: No/);
  assert.match(email.html, /font-weight:700;">Client note<\/td>/);
  assert.match(email.html, /border-bottom:1px solid #e4dfd5/);
});

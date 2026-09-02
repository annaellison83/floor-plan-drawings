const assert = require("node:assert/strict");
const test = require("node:test");
const { quotePricing, quoteReadyEmail } = require("./email-templates");

test("quote ready template escapes all dynamic HTML", () => {
  const rendered = quoteReadyEmail({
    propertyAddress: '349 Mount Washington <script>alert("x")</script>',
    service: 'Color Interior + Exterior <img src=x onerror=alert(1)>',
    mapUrl: 'https://example.com/a.jpg" style="display:block',
    recordUrl: "https://airtable.com/record?<tr><td style=",
    approvalUrl: "https://floorplandrawings.com/approve?token=abc&record=123",
    suggestedQuote: 345
  });

  assert.doesNotMatch(rendered.html, /<script>|<img src=x/);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.doesNotMatch(rendered.html, /a\.jpg" style=/);
  assert.match(rendered.html, /token=abc&amp;record=123/);
});

test("quote ready template is wide on desktop and stacks on mobile", () => {
  const { html } = quoteReadyEmail({ propertyAddress: "349 Mount Washington Dr", suggestedQuote: 345 });
  assert.match(html, /max-width:1100px/);
  assert.match(html, /@media only screen and \(max-width:640px\)/);
  assert.match(html, /\.summary tr,\.summary td\{display:block/);
  assert.match(html, /text-align:center/);
});

test("zone pricing uses the minimum as a floor, not an add-on", () => {
  assert.deepEqual(quotePricing({ quoteZone: "Zone 3", baseServiceQuote: 200 }), {
    zoneNumber: 3,
    zoneMinimum: 260,
    basePrice: 200,
    finalPrice: 260
  });
  assert.equal(quotePricing({ quoteZone: "Zone 4", baseServiceQuote: 345 }).finalPrice, 345);
});

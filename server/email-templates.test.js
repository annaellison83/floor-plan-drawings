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
  const { html } = quoteReadyEmail({
    propertyAddress: "349 Mount Washington Dr",
    suggestedQuote: 345,
    mapUrl: "https://example.com/aerial.jpg"
  });
  assert.match(html, /max-width:1100px/);
  assert.match(html, /@media only screen and \(max-width:640px\)/);
  assert.match(html, /\.summary tr,\.detail-cell\{display:block/);
  assert.match(html, /text-align:center/);
  assert.match(html, /max-width:100%/);
  assert.match(html, /class="detail-cell"[^>]*><div class="detail">/);
  assert.match(html, /class="property-head"/);
  assert.match(html, /https:\/\/www\.google\.com\/maps\/search/);
  assert.match(html, /color:#0b57d0/);
});

test("zone pricing uses the minimum as a floor, not an add-on", () => {
  const zoneThree = quotePricing({ quoteZone: "Zone 3", baseServiceQuote: 200 });
  assert.equal(zoneThree.zoneNumber, 3);
  assert.equal(zoneThree.zoneMinimum, 260);
  assert.equal(zoneThree.basePrice, 200);
  assert.equal(zoneThree.finalPrice, 260);
  assert.equal(quotePricing({ quoteZone: "Zone 4", baseServiceQuote: 345 }).finalPrice, 345);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { clientAvailabilityProposalEmail, clientQuoteEmail, quotePricing, quoteReadyEmail } = require("./email-templates");

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
  assert.equal(rendered.subject, 'QUOTE READY | 349 Mount Washington <script>alert("x")</script>');
  assert.doesNotMatch(rendered.subject, /Review:/);
});

test("client quote email contains one approved amount and escapes client data", () => {
  const email = clientQuoteEmail({
    clientName: "A <script>",
    propertyAddress: "123 Main St",
    service: "Color Interior + Exterior",
    scope: "Main house",
    finalQuote: 365
  });
  assert.equal(email.subject, "Your floor plan quote - 123 Main St");
  assert.match(email.html, /\$365/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.text, /Quote: \$365/);
});

test("approved client quote can include appointment options", () => {
  const email = clientQuoteEmail({
    clientName: "Eric",
    propertyAddress: "123 Main St",
    service: "Color Interior + Exterior",
    finalQuote: 365
  }, "https://floor-plan-drawings.onrender.com/api/scheduling/proposal?token=abc", [{
    date: "2026-09-07",
    localStart: "11:00 AM",
    worker: "corrie",
    durationMinutes: 90
  }]);
  assert.match(email.html, /Appointment options/);
  assert.match(email.html, /Choose an appointment time/);
  assert.match(email.text, /Option 1/);
});

test("appointment proposal email presents responsive selectable options", () => {
  const email = clientAvailabilityProposalEmail({
    clientName: "Eric",
    clientEmail: "eric@example.com",
    propertyAddress: "123 Main St",
    service: "Color Interior + Exterior"
  }, "https://floor-plan-drawings.onrender.com/api/scheduling/proposal?token=abc", [{
    date: "2026-09-07",
    localStart: "11:00 AM",
    worker: "corrie",
    durationMinutes: 90,
    deliveryTarget: { label: "Friday" }
  }]);
  assert.equal(email.subject, "APPOINTMENT OPTIONS | 123 Main St");
  assert.match(email.html, /Choose an appointment time/);
  assert.match(email.html, /Review and choose a time/);
  assert.match(email.html, /@media only screen and \(max-width:640px\)/);
  assert.match(email.text, /Option 1/);
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
  assert.doesNotMatch(html, /class="badge"/);
  assert.match(html, /class="eyebrow section-title">QUOTE READY/);
});

test("quote ready email exposes the separate availability proposal action", () => {
  const { html, text } = quoteReadyEmail({
    propertyAddress: "123 Main St",
    suggestedQuote: 345,
    availabilityReviewUrl: "https://floor-plan-drawings.onrender.com/api/scheduling/proposal/start?recordId=rec123&token=abc"
  });
  assert.match(html, /Check availability &amp; send options/);
  assert.match(html, /class="availability"/);
  assert.match(html, /Optional appointment availability/);
  assert.match(text, /Check availability and send appointment options/);
});

test("zone pricing uses the minimum as a floor, not an add-on", () => {
  const zoneThree = quotePricing({ quoteZone: "Zone 3", baseServiceQuote: 200 });
  assert.equal(zoneThree.zoneNumber, 3);
  assert.equal(zoneThree.zoneMinimum, 260);
  assert.equal(zoneThree.basePrice, 200);
  assert.equal(zoneThree.finalPrice, 260);
  assert.equal(quotePricing({ quoteZone: "Zone 4", baseServiceQuote: 345 }).finalPrice, 345);
});

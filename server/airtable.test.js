const test = require("node:test");
const assert = require("node:assert/strict");
const { addressParts, clientQuoteLogFields, communicationKey, inboundCommunicationLogFields, mapJob, quoteReadyLogFields, requestAddressParts } = require("./airtable");

test("derives city, state, and zip from a full address", () => {
  assert.deepEqual(addressParts("941 FORTUNE WAY LOS ANGELES CA 90042"), { city: "LOS ANGELES", state: "CA", zip: "90042" });
});

test("uses the intake map query when Airtable has only a street address", () => {
  const job = mapJob({ fields: {
    "Property Address": "1200 Elm Ave, Unit H",
    "Original Request": JSON.stringify({ address: "1200 Elm Ave, Unit H", mapQuery: "1200 Elm Ave, San Gabriel, CA 91775, USA" })
  }});
  assert.equal(job.city, "San Gabriel");
  assert.equal(job.state, "CA");
  assert.equal(job.zip, "91775");
  assert.deepEqual(requestAddressParts(job.originalRequest), { city: "San Gabriel", state: "CA", zip: "91775" });
});

test("uses contact details from the original request when Airtable fields are blank", () => {
  const job = mapJob({ fields: {
    "Property Address": "123 Main St",
    "Original Request": "Subject: Floor plan request\n\nClient: Alex Rivera\nEmail: alex@example.com\nPhone: 323-555-0142\n\nAnna Ellison <annaellisonmail@gmail.com>"
  }});
  assert.equal(job.clientName, "Alex Rivera");
  assert.equal(job.clientEmail, "alex@example.com");
  assert.equal(job.clientPhone, "323-555-0142");
  assert.deepEqual(job.detailFields, { "Property Address": "123 Main St", "Original Request": job.originalRequest });
});

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
  assert.match(job.approvalUrl, /recordId=rec08dRgUXUMPajMt&token=approval-secret$/);
  assert.equal("token" in job, false);
});

test("builds an approved-client quote log payload", () => {
  const fields = clientQuoteLogFields({
    recordId: "rec08dRgUXUMPajMt",
    clientName: "Eric",
    subject: "Floor plan quote for 123 Main St"
  });
  assert.equal(fields.Communication, "rec08dRgUXUMPajMt:approved_quote:v1");
  assert.equal(fields["Event Type"], "Quote Sent");
  assert.equal(fields["Delivery Status"], "Pending");
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

test("maps an Airtable aerial attachment for durable email caching", () => {
  const job = mapJob({ id: "recABC123", fields: {
    "Property Address": "123 Main St",
    "Aerial Parcel Preview": [{
      url: "https://v5.airtableusercontent.com/attachment.jpg",
      thumbnails: { full: { url: "https://v5.airtableusercontent.com/attachment-full.jpg" } }
    }]
  }});
  assert.equal(job.aerialAttachmentUrl, "https://v5.airtableusercontent.com/attachment.jpg");
});

test("builds a deterministic idempotency key and communication log payload", () => {
  assert.equal(
    communicationKey("rec08dRgUXUMPajMt", "QUOTE READY"),
    "rec08dRgUXUMPajMt:quote_ready:v1"
  );
  assert.deepEqual(quoteReadyLogFields({
    recordId: "rec08dRgUXUMPajMt",
    subject: "QUOTE READY | 349 Mount Washington Dr",
    status: "Sent",
    summary: "Delivered by Render"
  }), {
    Communication: "rec08dRgUXUMPajMt:quote_ready:v1",
    "Job Record ID": "rec08dRgUXUMPajMt",
    Direction: "Outgoing",
    Channel: "Email",
    "Event Type": "QUOTE READY",
    "Email Subject": "QUOTE READY | 349 Mount Washington Dr",
    "Delivery Status": "Sent",
    Summary: "Delivered by Render"
  });
});

test("builds an incoming Gmail communication log payload", () => {
  const fields = inboundCommunicationLogFields({
    recordId: "rec08dRgUXUMPajMt",
    subject: "Re: Floor plan request",
    communication: "rec08dRgUXUMPajMt:gmail_received:msg-1",
    summary: "Inbound Gmail message received."
  });
  assert.equal(fields.Direction, "Incoming");
  assert.equal(fields.Channel, "Email");
  assert.equal(fields["Event Type"], "Gmail Received");
  assert.equal(fields.Communication, "rec08dRgUXUMPajMt:gmail_received:msg-1");
});

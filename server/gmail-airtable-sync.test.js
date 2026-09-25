const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findGmailAirtableMatch,
  findGmailAirtableThreadMatch,
  gmailAirtableKey,
  gmailJobId,
  gmailAirtableFields,
  isGeneratedPropertyFallback,
  normalizedPropertyKey,
  patchMissingGmailFields,
  resolveGmailSyncAddress
} = require("./gmail-airtable-sync");

test("normalizes the Gmail thread/address key deterministically", () => {
  assert.equal(normalizedPropertyKey("228 East Avenue 42, Los Angeles, CA 90031"), "228 east ave 42 los angeles ca 90031");
  assert.equal(gmailAirtableKey("thread-123", "228 East Avenue 42, Los Angeles, CA 90031"), "thread-123::228 east ave 42 los angeles ca 90031");
  assert.equal(gmailJobId("thread-123", "228 East Avenue 42, Los Angeles, CA 90031"), gmailJobId("thread-123", "228 East Avenue 42, Los Angeles, CA 90031"));
});

test("matches an existing record by exact Gmail thread and address", () => {
  const records = [{ id: "rec1", fields: { "Gmail Thread ID": "thread-123", "Property Address": "228 East Avenue 42, Los Angeles, CA 90031" } }];
  assert.equal(findGmailAirtableMatch(records, { threadId: "thread-123", propertyAddress: "228 East Avenue 42, Los Angeles, CA 90031" }).id, "rec1");
});

test("matches an existing record by unique thread when a reply has no extracted address", () => {
  const record = { id: "rec1", fields: { "Gmail Thread ID": "thread-123", "Property Address": "228 East Avenue 42, Los Angeles, CA 90031" } };
  assert.equal(findGmailAirtableThreadMatch([record], { threadId: "thread-123" }), record);
  assert.equal(findGmailAirtableThreadMatch([record, { id: "rec2", fields: { "Gmail Thread ID": "thread-123", "Property Address": "other" } }], { threadId: "thread-123" }), null);
});

test("does not revive a removed project from its stored signature address", () => {
  const message = { id: "m1", threadId: "thread-signature-only", propertyAddress: "", subject: "fp for st andrew", text: "Please review floor plan" };
  const project = { propertyAddress: "6430 W Sunset Boulevard, 6th Floor", metadata: { gmailThreadId: "thread-signature-only" } };
  assert.deepEqual(resolveGmailSyncAddress(message, project, []), { address: "", existing: null });
});

test("merges a unique calendar-first address instead of creating a duplicate", () => {
  const records = [{ id: "rec-calendar", fields: { "Property Address": "228 East Avenue 42, Los Angeles, CA 90031", "Status": "Scheduled" } }];
  assert.equal(findGmailAirtableMatch(records, { threadId: "thread-123", propertyAddress: "228 East Avenue 42, Los Angeles, CA 90031" }).id, "rec-calendar");
});

test("fills only missing business fields and always refreshes source identifiers", () => {
  const record = { id: "rec1", fields: { Status: "Quote Sent", "Client Name": "Anna's manual name", "Source Channels": "calendar" } };
  const incoming = gmailAirtableFields({ id: "msg1", threadId: "thread-1", propertyAddress: "228 East Avenue 42, Los Angeles, CA 90031", subject: "Floor plan", text: "Please quote", contacts: { client: [{ name: "Client", email: "client@example.com" }], agent: [] } }, { propertyAddress: "228 East Avenue 42, Los Angeles, CA 90031" }, record);
  const patch = patchMissingGmailFields(record, incoming);
  assert.equal(patch.Status, undefined);
  assert.equal(patch["Client Name"], undefined);
  assert.equal(patch["Gmail Thread ID"], "thread-1");
  assert.equal(patch["Source Channels"], "calendar, gmail");
  assert.equal(patch["Client Email"], "client@example.com");
});

test("uses the parsed client name instead of an address-like fallback and repairs it", () => {
  const address = "854 South Rimpau Boulevard, Los Angeles, CA 90019";
  const record = { id: "rec1", fields: { "Property Address": address, "Client Name": address } };
  const incoming = gmailAirtableFields({ id: "msg1", threadId: "thread-1", propertyAddress: address, clientName: "Deborah Wolsh", subject: "Floor plan", text: "Client: Deborah Wolsh" }, { propertyAddress: address, clientName: address }, record);
  assert.equal(incoming["Client Name"], "Deborah Wolsh");
  assert.equal(patchMissingGmailFields(record, incoming)["Client Name"], "Deborah Wolsh");
});

test("recognizes generated Gmail property fallbacks as replaceable asset placeholders", () => {
  const address = "1917 Eden Ave, Pasadena, CA 91103";
  const fields = gmailAirtableFields({ propertyAddress: address, threadId: "thread-assets", id: "message-assets", subject: "Floor plans", text: "Please quote this address" });
  assert.equal(isGeneratedPropertyFallback("ZIMAS Link", fields["ZIMAS Link"], address), true);
  assert.equal(isGeneratedPropertyFallback("Aerial Map URL", fields["Aerial Map URL"], address), true);
  assert.equal(isGeneratedPropertyFallback("Aerial Map URL", "https://v5.airtableusercontent.com/real.jpg", address), false);
});

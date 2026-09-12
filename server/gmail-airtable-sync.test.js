const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findGmailAirtableMatch,
  gmailAirtableFields,
  gmailAirtableKey,
  gmailJobId,
  normalizedPropertyKey,
  patchMissingGmailFields
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

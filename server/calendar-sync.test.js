const assert = require("node:assert/strict");
const test = require("node:test");
const { calendarAirtableFields, calendarEventKey, extractAddress, findProjectMatch, isLikelyWorkEvent, jobIdForCalendarEvent, mergeCalendarAirtableFields, normalizeAddress, propertyCoreKey, shouldSkipBlankAddressCreate, streetAddressKey } = require("./calendar-sync");

const calendar = { name: "Corrie", url: "https://caldav.example/corrie/" };
const event = {
  uid: "event-123",
  summary: "Floor plan — 123 Main St, Los Angeles, CA 90065",
  description: "Client visit",
  start: new Date("2026-09-15T18:00:00.000Z"),
  end: new Date("2026-09-15T19:30:00.000Z")
};

test("calendar event identity stays stable if an event is moved", () => {
  const moved = { ...event, start: new Date("2026-09-16T18:00:00.000Z") };
  assert.equal(calendarEventKey(calendar, event), calendarEventKey(calendar, moved));
  assert.equal(jobIdForCalendarEvent(calendar, event), jobIdForCalendarEvent(calendar, moved));
});

test("calendar sync extracts an address and matches a Gmail project", () => {
  assert.equal(extractAddress(event), "123 Main St, Los Angeles, CA 90065");
  assert.equal(extractAddress({ summary: "2380 lake view ave steve chetelat 11am" }), "2380 lake view ave");
  assert.equal(normalizeAddress("123 Main Street, Los Angeles, CA 90065"), normalizeAddress("123 Main St, Los Angeles, CA 90065"));
  const project = findProjectMatch(event, calendar, [{
    id: "gmail-thread-1",
    propertyAddress: "123 Main Street, Los Angeles, CA 90065",
    metadata: { gmailThreadId: "thread-1" },
    contacts: { client: ["client@example.com"] }
  }]);
  assert.equal(project.id, "gmail-thread-1");
});

test("street keys discard location suffixes but retain explicit units", () => {
  assert.equal(streetAddressKey("941 FORTUNE WAY LOS ANGELES CA 90042"), "941 fortune way");
  assert.equal(streetAddressKey("941 Fortune Way, Los Angeles, CA 90042, USA"), "941 fortune way");
  assert.equal(streetAddressKey("1200 Elm Ave, Unit H"), "1200 elm ave unit h");
  assert.equal(propertyCoreKey("1200 Elm Ave, Unit H"), "1200 elm ave");
});

test("calendar project matching reconciles a unit omitted by the event title", () => {
  const match = findProjectMatch({
    uid: "calendar-unit",
    summary: "Floor plan — 1200 Elm Ave",
    start: new Date("2026-09-15T18:00:00.000Z")
  }, calendar, [{
    id: "gmail-unit",
    propertyAddress: "1200 Elm Ave, Unit H",
    metadata: { gmailThreadId: "thread-unit" },
    contacts: { client: ["client@example.com"] }
  }]);
  assert.equal(match.id, "gmail-unit");
});

test("calendar sync skips obvious personal events", () => {
  assert.equal(isLikelyWorkEvent({ summary: "camping" }), false);
  assert.equal(isLikelyWorkEvent({ summary: "140 N Plymouth color yard ali jack" }), true);
});

test("calendar sync fields preserve the thread link and stable event identity", () => {
  const fields = calendarAirtableFields(calendar, event, {
    clientName: "Client",
    propertyAddress: "123 Main St, Los Angeles, CA 90065",
    contacts: { client: ["client@example.com"] },
    metadata: { gmailThreadId: "thread-1" }
  });
  assert.equal(fields["Calendar Event UID"], "event-123");
  assert.equal(fields["Calendar Sync Source"], "iCloud");
  assert.equal(fields["Gmail Thread ID"], "thread-1");
  assert.equal(fields["Property Address"], "123 Main St");
});

test("calendar sync can carry an explicitly classified Gmail thread", () => {
  const fields = calendarAirtableFields(calendar, event, null, {
    threadId: "thread-42",
    clientName: "Client From Thread",
    contacts: { client: [{ email: "client@example.com" }] }
  });
  assert.equal(fields["Gmail Thread ID"], "thread-42");
  assert.equal(fields["Client Name"], "Client From Thread");
  assert.equal(fields["Client Email"], "client@example.com");
});

test("calendar sync preserves every nonblank workflow status and identity fields", () => {
  for (const status of ["Delivered", "Completed", "Needs Manual Review"]) {
  const existing = { fields: {
    Status: status,
    "Job ID": "WEB-42",
    "Website Workflow": "Order",
    "Source Channels": "gmail",
    "Property Address": "123 Main St"
  } };
  const patch = mergeCalendarAirtableFields(existing, {
    Status: "Calendar Imported",
    "Job ID": "CAL-new",
    "Website Workflow": "Calendar",
    "Source Channels": "calendar",
    "Property Address": "123 Main St"
  });
  assert.equal(patch.Status, undefined);
  assert.equal(patch["Job ID"], undefined);
  assert.equal(patch["Website Workflow"], undefined);
  assert.equal(patch["Source Channels"], "gmail, calendar");
  }
});

test("calendar sync fills a blank status while retaining blank identity fields", () => {
  const existing = { fields: { Status: "", "Job ID": "", "Website Workflow": "", "Property Address": "123 Main St" } };
  const patch = mergeCalendarAirtableFields(existing, { Status: "Calendar Imported", "Job ID": "CAL-new", "Website Workflow": "Calendar", "Property Address": "123 Main St" });
  assert.equal(patch.Status, "Calendar Imported");
  assert.equal(patch["Job ID"], "CAL-new");
  assert.equal(patch["Website Workflow"], "Calendar");
});

test("calendar sync fills protected identity fields omitted from the Airtable schema", () => {
  const patch = mergeCalendarAirtableFields({ fields: { "Property Address": "123 Main St" } }, { Status: "Calendar Imported", "Job ID": "CAL-new", "Website Workflow": "Calendar" });
  assert.deepEqual(patch, { Status: "Calendar Imported", "Job ID": "CAL-new", "Website Workflow": "Calendar" });
});

test("calendar sync fields do not invent an address for marker-only events", () => {
  const fields = calendarAirtableFields(calendar, { uid: "marker-only", summary: "floor plan appointment", description: "client visit" });
  assert.equal(fields["Property Address"], "");
  assert.equal(shouldSkipBlankAddressCreate(fields, null), true);
  assert.equal(shouldSkipBlankAddressCreate(fields, { id: "existing" }), false);
});

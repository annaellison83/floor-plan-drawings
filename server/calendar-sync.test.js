const assert = require("node:assert/strict");
const test = require("node:test");
const { calendarAirtableFields, calendarEventKey, extractAddress, findProjectMatch, jobIdForCalendarEvent, normalizeAddress } = require("./calendar-sync");

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
  assert.equal(normalizeAddress("123 Main Street, Los Angeles, CA 90065"), normalizeAddress("123 Main St, Los Angeles, CA 90065"));
  const project = findProjectMatch(event, calendar, [{
    id: "gmail-thread-1",
    propertyAddress: "123 Main Street, Los Angeles, CA 90065",
    metadata: { gmailThreadId: "thread-1" },
    contacts: { client: ["client@example.com"] }
  }]);
  assert.equal(project.id, "gmail-thread-1");
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
  assert.equal(fields["Property Address"], "123 Main St, Los Angeles, CA 90065");
});

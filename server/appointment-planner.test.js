const assert = require("node:assert/strict");
const test = require("node:test");
const { planAppointments } = require("./appointment-planner");

function availability(calendars) {
  return { calendars };
}

test("dry-run planner recommends an available Corrie slot first", () => {
  const result = planAppointments({
    squareFeet: 2400,
    service: "Black & White",
    availability: availability([
      { name: "corrie", url: "https://corrie", slots: [
        { date: "2026-09-07", localStart: "2026-09-07 11:00", start: "2026-09-07T18:00:00.000Z", end: "2026-09-07T19:30:00.000Z", available: true }
      ] },
      { name: "ricardo", url: "https://ricky", slots: [
        { date: "2026-09-07", localStart: "2026-09-07 11:00", start: "2026-09-07T18:00:00.000Z", end: "2026-09-07T19:30:00.000Z", available: true }
      ] }
    ])
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.durationMinutes, 90);
  assert.equal(result.recommendations[0].worker, "corrie");
  assert.equal(result.recommendations[0].deliveryTarget.label, "Friday");
});

test("dry-run planner keeps Sarah for nearby small-house spillover", () => {
  const result = planAppointments({
    squareFeet: 1800,
    milesFromSarah: 2,
    bookedThisWeek: { corrie: 4, ricky: 2 },
    bookedToday: { corrie: 2, ricky: 2 },
    availability: availability([
      { name: "sarah", url: "https://sarah", slots: [
        { date: "2026-09-09", localStart: "2026-09-09 13:00", start: "2026-09-09T20:00:00.000Z", end: "2026-09-09T21:30:00.000Z", available: true }
      ] }
    ])
  });
  assert.equal(result.recommendations[0].worker, "sarah");
});

test("dry-run planner never creates or modifies events", () => {
  const result = planAppointments({ squareFeet: 3000, availability: availability([]) });
  assert.equal(result.readOnly, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.recommendations.length, 0);
});

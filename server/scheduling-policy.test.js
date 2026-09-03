const assert = require("node:assert/strict");
const test = require("node:test");
const {
  appointmentDurationMinutes,
  canWorkerTake,
  deliveryDaysForService,
  deliveryTargetForWeekday,
  rankWorkers,
  schedulingPolicy
} = require("./scheduling-policy");

test("uses the 1.5-hour default for projects up to 3,000 sq ft", () => {
  assert.equal(appointmentDurationMinutes(3000), 90);
  assert.equal(appointmentDurationMinutes(4500), 150);
  assert.equal(appointmentDurationMinutes(5000), 150);
});

test("Corrie can only take one 5,000+ sq ft appointment in a day", () => {
  assert.equal(canWorkerTake("corrie", { squareFeet: 5000, appointmentsToday: 0 }), true);
  assert.equal(canWorkerTake("corrie", { squareFeet: 5000, appointmentsToday: 1 }), false);
  assert.equal(canWorkerTake("ricky", { squareFeet: 5000, appointmentsToday: 1 }), true);
});

test("Sarah is limited to nearby small-house spillover", () => {
  assert.equal(canWorkerTake("sarah", { squareFeet: 1800, milesFromSarah: 5.1 }), false);
  assert.equal(canWorkerTake("sarah", { squareFeet: 1800, milesFromSarah: 5 }), true);
  assert.equal(canWorkerTake("sarah", { squareFeet: 3200, milesFromSarah: 2 }), false);
});

test("Corrie is preferred on her preferred weekdays before Ricky", () => {
  const ranked = rankWorkers({
    weekday: "Monday",
    squareFeet: 2400,
    bookedThisWeek: { corrie: 1, ricky: 0 },
    bookedToday: { corrie: 0, ricky: 0 }
  });
  assert.equal(ranked[0].name, "corrie");
});

test("Sarah remains spillover behind primary workers", () => {
  const ranked = rankWorkers({
    weekday: "Wednesday",
    squareFeet: 1800,
    milesFromSarah: 5,
    bookedThisWeek: { corrie: 4, ricky: 2, sarah: 0 },
    bookedToday: { corrie: 2, ricky: 2, sarah: 0 }
  });
  assert.equal(ranked[0].name, "sarah");
});

test("policy exposes the two default appointment starts", () => {
  assert.deepEqual(schedulingPolicy().appointmentStarts, ["11:00", "13:00"]);
});

test("delivery timing distinguishes black-and-white and color work", () => {
  assert.equal(deliveryDaysForService("Black & White"), 2);
  assert.equal(deliveryDaysForService("Color Interior + Exterior"), 3);
});

test("weekday delivery targets match Anna's turnaround commitments", () => {
  assert.deepEqual(deliveryTargetForWeekday("Wednesday"), {
    weekday: 6,
    label: "Saturday",
    endOfDay: false
  });
  assert.deepEqual(deliveryTargetForWeekday("Thursday"), {
    weekday: 1,
    label: "Monday",
    endOfDay: true
  });
  assert.equal(schedulingPolicy().delivery.batchBooking.targetAppointments, 8);
});

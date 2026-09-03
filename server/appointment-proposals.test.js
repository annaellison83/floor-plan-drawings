const assert = require("node:assert/strict");
const test = require("node:test");
const { proposalPayload, signProposal, verifyProposal } = require("./appointment-proposals");

test("proposal tokens round-trip without exposing a signing secret", () => {
  const payload = proposalPayload({
    recordId: "rec08dRgUXUMPajMt",
    address: "123 Main St",
    clientEmail: "client@example.com",
    squareFeet: 2400,
    service: "Black & White",
    slots: [{ date: "2026-09-07", localStart: "11:00 AM", start: "2026-09-07T18:00:00.000Z", end: "2026-09-07T19:30:00.000Z", durationMinutes: 90, worker: "corrie", calendarName: "Corrie" }]
  }, { PROPOSAL_SIGNING_SECRET: "test-secret", APPOINTMENT_PROPOSAL_TTL_HOURS: "2" });
  const token = signProposal(payload, { PROPOSAL_SIGNING_SECRET: "test-secret" });
  const verified = verifyProposal(token, { PROPOSAL_SIGNING_SECRET: "test-secret" });
  assert.equal(verified.recordId, payload.recordId);
  assert.equal(verified.slots.length, 1);
  assert.equal(verifyProposal(`${token}x`, { PROPOSAL_SIGNING_SECRET: "test-secret" }), null);
});

test("proposal payload caps options and strips unknown fields", () => {
  const slots = Array.from({ length: 8 }, (_, index) => ({ date: "2026-09-07", localStart: "11:00 AM", start: String(index), end: String(index + 1), worker: "corrie", secret: "do-not-copy" }));
  const payload = proposalPayload({ recordId: "rec08dRgUXUMPajMt", slots }, { PROPOSAL_SIGNING_SECRET: "x" });
  assert.equal(payload.slots.length, 5);
  assert.equal("secret" in payload.slots[0], false);
});

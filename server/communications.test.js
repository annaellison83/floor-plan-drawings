const test = require("node:test");
const assert = require("node:assert/strict");
const {
  communicationKey,
  communicationLogFields,
  heartbeatConfig,
  isInternalPhone,
  matchCommunicationToJobs,
  normalizeCommunication,
  normalizePhone,
  reviewMetadata
} = require("./communications");

test("normalizes US phone numbers to E.164", () => {
  assert.equal(normalizePhone("(323) 555-0142"), "+13235550142");
  assert.equal(normalizePhone("+1 323 555 0142"), "+13235550142");
  assert.equal(normalizePhone("not a phone"), "");
});

test("recognizes both business numbers so they are not saved as client phones", () => {
  assert.equal(isInternalPhone("(443) 621-3024"), true);
  assert.equal(isInternalPhone("(213) 435-7223"), true);
  assert.equal(isInternalPhone("(213) 555-0199"), false);
  assert.equal(isInternalPhone("(999) 111-2222", { BUSINESS_PHONE_NUMBER: "+19991112222" }), true);
});

test("communication keys are stable without retaining the message body", () => {
  const first = communicationKey({ channel: "sms", provider: "twilio", externalMessageId: "SM-1" });
  const second = communicationKey({ channel: "sms", provider: "twilio", externalMessageId: "SM-1", body: "a different body" });
  assert.equal(first, second);
  assert.match(first, /^comm:[a-f0-9]{32}$/);
});

test("matches a phone message to one existing Job without creating a Job", () => {
  const communication = normalizeCommunication({
    channel: "sms",
    provider: "google-voice-email",
    externalMessageId: "gmail-message-1",
    conversationId: "gmail-thread-1",
    senderPhone: "323-555-0142",
    body: "Can we schedule the floor plan?"
  });
  const match = matchCommunicationToJobs(communication, [
    { id: "rec-job-1", fields: { "Property Address": "123 Main St", "Client Phone": "(323) 555-0142" } },
    { id: "rec-job-2", fields: { "Property Address": "456 Main St", "Client Phone": "(213) 555-0199" } }
  ]);
  assert.equal(match.record.id, "rec-job-1");
  assert.equal(match.confidence, "medium");
  assert.equal(match.reason, "verified-phone-match");
});

test("ambiguous phone matches go to review", () => {
  const match = matchCommunicationToJobs({ channel: "sms", senderPhone: "+13235550142", body: "hello" }, [
    { id: "rec-job-1", fields: { "Client Phone": "323-555-0142" } },
    { id: "rec-job-2", fields: { "Agent Phone": "323-555-0142" } }
  ]);
  assert.equal(match.record, null);
  assert.equal(match.confidence, "low");
  assert.equal(match.reason, "ambiguous-phone-match");
  assert.deepEqual(match.candidates.map((record) => record.id), ["rec-job-1", "rec-job-2"]);
});

test("conversation and property keys outrank contact guesses", () => {
  const match = matchCommunicationToJobs({
    channel: "imessage",
    conversationId: "thread-1",
    propertyAddress: "123 Main Street, Los Angeles, CA 90065",
    senderPhone: "213-555-0199"
  }, [
    { id: "rec-job-1", fields: { "Gmail Thread ID": "thread-1", "Property Address": "123 Main St" } },
    { id: "rec-job-2", fields: { "Property Address": "123 Main St", "Client Phone": "213-555-0199" } }
  ]);
  assert.equal(match.record.id, "rec-job-1");
  assert.equal(match.confidence, "high");
  assert.equal(match.reason, "conversation-id");
});

test("communication log stays compatible until the Airtable schema is extended", () => {
  const message = normalizeCommunication({
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM-1",
    conversationId: "conv-1",
    senderPhone: "323-555-0142",
    body: "Please call me."
  });
  const legacy = communicationLogFields({ recordId: "rec-job-1", communication: message });
  assert.equal(legacy.Channel, "SMS");
  assert.equal(legacy["Event Type"], "SMS Received");
  assert.equal("External Message ID" in legacy, false);
  const extended = communicationLogFields({ recordId: "rec-job-1", communication: message, extended: true });
  assert.equal(extended["External Message ID"], "SM-1");
  assert.equal(extended["Conversation ID"], "conv-1");
  assert.equal(extended.Sender, "+13235550142");
});

test("review metadata contains only a searchable summary", () => {
  const message = normalizeCommunication({ channel: "sms", senderPhone: "323-555-0142", body: "A".repeat(2000) });
  const review = reviewMetadata(message, { confidence: "low", reason: "no-safe-match", candidates: [] });
  assert.equal(review.matchReason, "no-safe-match");
  assert.ok(review.bodySummary.length <= 1200);
  assert.deepEqual(heartbeatConfig({ PHONE_BRIDGE_HEARTBEAT_MAX_AGE_MINUTES: "5", PHONE_BRIDGE_HEARTBEAT_ESCALATION_MINUTES: "15", ENABLE_PHONE_BRIDGE_MONITOR: "true" }), {
    maxAgeMs: 300000,
    escalationAgeMs: 900000,
    monitorEnabled: true,
    alertEmail: "",
    escalationEmail: ""
  });
});

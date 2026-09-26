const crypto = require("node:crypto");
const { normalizeAddress, streetAddressKey } = require("./calendar-sync");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

// The current business number is US-based. Keep the country-code assumption in
// one place so a provider adapter can supply a different default later.
function normalizePhone(value, { defaultCountryCode = "1" } = {}) {
  const raw = clean(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10 && defaultCountryCode) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return "";
}

function phoneCandidates(value) {
  return [...clean(value).matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)]
    .map((match) => normalizePhone(match[0]))
    .filter((phone, index, values) => phone && values.indexOf(phone) === index);
}

function stripAutomatedFooter(value) {
  const text = clean(value);
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const footerIndex = lines.findIndex((line) => /^(?:to respond to this text message|your account\b|this email was sent to you because|google llc\b)/i.test(clean(line)));
  return (footerIndex >= 0 ? lines.slice(0, footerIndex) : lines).join("\n").trim();
}

function compactSummary(value, limit = 1200) {
  return clean(stripAutomatedFooter(value)).replace(/\s+/g, " ").slice(0, Math.max(80, limit));
}

function channelLabel(channel) {
  return ({ email: "Email", sms: "SMS", mms: "MMS", imessage: "iMessage" })[channel] || "Other";
}

function normalizeChannel(value, fallback = "other") {
  const channel = clean(value).toLowerCase();
  return ["email", "sms", "mms", "imessage"].includes(channel) ? channel : fallback;
}

function communicationKey({ channel, provider, externalMessageId, conversationId, body, receivedAt } = {}) {
  const stablePart = [
    normalizeChannel(channel),
    clean(provider).toLowerCase(),
    clean(externalMessageId),
    clean(conversationId),
    // A provider should always send an external ID. The fallback keeps a
    // malformed adapter replay-safe without storing message bodies as keys.
    !clean(externalMessageId) && !clean(conversationId) ? clean(receivedAt) : "",
    !clean(externalMessageId) && !clean(conversationId) ? compactSummary(body, 160) : ""
  ].join("|");
  return `comm:${crypto.createHash("sha256").update(stablePart).digest("hex").slice(0, 32)}`;
}

function senderFromInput(input = {}) {
  const sender = input.sender && typeof input.sender === "object" ? input.sender : {};
  return {
    name: clean(sender.name || input.senderName),
    email: normalizeEmail(sender.email || input.senderEmail),
    phone: normalizePhone(sender.phone || input.senderPhone)
  };
}

function recipientList(input = {}) {
  const values = Array.isArray(input.recipients) ? input.recipients : input.recipient ? [input.recipient] : [];
  return values.map((item) => {
    const value = item && typeof item === "object" ? item : { value: item };
    return {
      name: clean(value.name),
      email: normalizeEmail(value.email || value.value),
      phone: normalizePhone(value.phone || value.value)
    };
  }).filter((item) => item.email || item.phone || item.name);
}

function normalizeCommunication(input = {}) {
  const channel = normalizeChannel(input.channel, input.transport === "google-voice-email" ? "sms" : "other");
  const sender = senderFromInput(input);
  const body = clean(input.body || input.text || input.message);
  const propertyAddress = clean(input.propertyAddress || input.address);
  const receivedAt = clean(input.receivedAt || input.date) || new Date().toISOString();
  return {
    communication: clean(input.communication) || communicationKey({
      channel,
      provider: input.provider || input.transport,
      externalMessageId: input.externalMessageId || input.messageId,
      conversationId: input.conversationId || input.threadId,
      body,
      receivedAt
    }),
    channel,
    channelLabel: channelLabel(channel),
    direction: clean(input.direction).toLowerCase() === "outgoing" ? "outgoing" : "incoming",
    provider: clean(input.provider || input.transport).toLowerCase(),
    externalMessageId: clean(input.externalMessageId || input.messageId),
    conversationId: clean(input.conversationId || input.threadId),
    sender,
    recipients: recipientList(input),
    subject: clean(input.subject),
    propertyAddress,
    normalizedPropertyKey: streetAddressKey(propertyAddress) || normalizeAddress(propertyAddress),
    receivedAt,
    body,
    bodySummary: compactSummary(body),
    attachmentIds: (Array.isArray(input.attachmentIds) ? input.attachmentIds : []).map(clean).filter(Boolean).slice(0, 50)
  };
}

function fieldValue(fields, names) {
  for (const name of names) {
    const value = fields && fields[name];
    if (value !== undefined && value !== null && clean(value)) return value;
  }
  return "";
}

function recordPhones(record) {
  const fields = record && record.fields || {};
  const values = [
    fields["Client Phone"], fields["Agent Phone"], fields["Realtor Phone"], fields.Phone,
    fields["Contact Phone"], fields["Original Request"]
  ];
  return values.flatMap(phoneCandidates).filter((phone, index, all) => all.indexOf(phone) === index);
}

function recordEmails(record) {
  const fields = record && record.fields || {};
  return [fields["Client Email"], fields["Agent Email"], fields.Email, fields["Original Request"]]
    .flatMap((value) => [...clean(value).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => normalizeEmail(match[0])))
    .filter((email, index, all) => email && all.indexOf(email) === index);
}

function recordAddressKey(record) {
  const fields = record && record.fields || {};
  return streetAddressKey(fieldValue(fields, ["Normalized Property Key", "Property Address", "Address"]));
}

function uniqueMatches(records, predicate) {
  return records.filter(predicate).filter((record, index, all) => all.findIndex((item) => clean(item && item.id) === clean(record && record.id)) === index);
}

// Matching is deliberately conservative. A phone number or address can only
// attach a message when it identifies one Job; ambiguous candidates go to the
// review queue and never create a new Job.
function matchCommunicationToJobs(communication, records = []) {
  const message = normalizeCommunication(communication);
  const validRecords = Array.isArray(records) ? records : [];
  const externalId = clean(message.externalMessageId);
  const conversationId = clean(message.conversationId);
  const exactExternal = uniqueMatches(validRecords, (record) => {
    const fields = record && record.fields || {};
    return externalId && [fields["External Message ID"], fields["Communication External ID"], fields["SMS Message ID"], fields["iMessage ID"]]
      .some((value) => clean(value) === externalId);
  });
  if (exactExternal.length === 1) return { record: exactExternal[0], confidence: "high", reason: "external-message-id", candidates: exactExternal };
  if (exactExternal.length > 1) return { record: null, confidence: "low", reason: "ambiguous-external-message-id", candidates: exactExternal };

  const conversationMatches = uniqueMatches(validRecords, (record) => {
    const fields = record && record.fields || {};
    return conversationId && [fields["Conversation ID"], fields["Thread ID"], fields["Gmail Thread ID"], fields["Email Thread ID"]]
      .some((value) => clean(value) === conversationId);
  });
  if (conversationMatches.length === 1) return { record: conversationMatches[0], confidence: "high", reason: "conversation-id", candidates: conversationMatches };
  if (conversationMatches.length > 1) return { record: null, confidence: "low", reason: "ambiguous-conversation-id", candidates: conversationMatches };

  if (message.normalizedPropertyKey) {
    const addressMatches = uniqueMatches(validRecords, (record) => recordAddressKey(record) === message.normalizedPropertyKey);
    if (addressMatches.length === 1) return { record: addressMatches[0], confidence: "high", reason: "normalized-property-key", candidates: addressMatches };
    if (addressMatches.length > 1) return { record: null, confidence: "low", reason: "ambiguous-property-key", candidates: addressMatches };
  }

  const senderPhone = message.sender.phone;
  if (senderPhone) {
    const phoneMatches = uniqueMatches(validRecords, (record) => recordPhones(record).includes(senderPhone));
    if (phoneMatches.length === 1) return { record: phoneMatches[0], confidence: "medium", reason: "verified-phone-match", candidates: phoneMatches };
    if (phoneMatches.length > 1) return { record: null, confidence: "low", reason: "ambiguous-phone-match", candidates: phoneMatches };
  }
  const senderEmail = message.sender.email;
  if (senderEmail) {
    const emailMatches = uniqueMatches(validRecords, (record) => recordEmails(record).includes(senderEmail));
    if (emailMatches.length === 1) return { record: emailMatches[0], confidence: "medium", reason: "verified-email-match", candidates: emailMatches };
    if (emailMatches.length > 1) return { record: null, confidence: "low", reason: "ambiguous-email-match", candidates: emailMatches };
  }
  return { record: null, confidence: "low", reason: "no-safe-match", candidates: [] };
}

function communicationLogFields({ recordId, communication, summary, extended = false } = {}) {
  const message = normalizeCommunication(communication || {});
  const fields = {
    Communication: message.communication,
    "Job Record ID": clean(recordId),
    Direction: message.direction === "outgoing" ? "Outgoing" : "Incoming",
    Channel: message.channelLabel,
    "Event Type": `${message.channelLabel} ${message.direction === "outgoing" ? "Sent" : "Received"}`,
    "Email Subject": message.subject || (message.channel !== "email" ? `${message.channelLabel} message` : ""),
    "Delivery Status": message.direction === "outgoing" ? "Pending" : "Received",
    Summary: clean(summary) || message.bodySummary
  };
  if (!extended) return Object.fromEntries(Object.entries(fields).filter(([, value]) => clean(value)));
  return Object.fromEntries(Object.entries({
    ...fields,
    "External Message ID": message.externalMessageId,
    "Conversation ID": message.conversationId,
    Sender: message.sender.phone || message.sender.email || message.sender.name,
    Recipients: message.recipients.map((item) => item.phone || item.email || item.name).filter(Boolean).join(", "),
    "Received At": message.receivedAt,
    "Body Summary": message.bodySummary,
    "Match Confidence": clean(communication.matchConfidence),
    "Match Reason": clean(communication.matchReason),
    "Attachment IDs": message.attachmentIds.join(", ")
  }).filter(([, value]) => clean(value)));
}

function reviewMetadata(communication, match = {}) {
  const message = normalizeCommunication(communication);
  return {
    communication: message.communication,
    channel: message.channel,
    provider: message.provider,
    externalMessageId: message.externalMessageId,
    conversationId: message.conversationId,
    sender: message.sender,
    subject: message.subject,
    propertyAddress: message.propertyAddress,
    normalizedPropertyKey: message.normalizedPropertyKey,
    receivedAt: message.receivedAt,
    bodySummary: message.bodySummary,
    matchConfidence: clean(match.confidence) || "low",
    matchReason: clean(match.reason) || "needs-review",
    candidateRecordIds: (match.candidates || []).map((record) => clean(record && record.id)).filter(Boolean)
  };
}

function heartbeatConfig(env = process.env) {
  const minutes = (name, fallback) => Math.max(1, Number(env[name]) || fallback);
  return {
    maxAgeMs: minutes("PHONE_BRIDGE_HEARTBEAT_MAX_AGE_MINUTES", 5) * 60 * 1000,
    escalationAgeMs: minutes("PHONE_BRIDGE_HEARTBEAT_ESCALATION_MINUTES", 15) * 60 * 1000,
    monitorEnabled: clean(env.ENABLE_PHONE_BRIDGE_MONITOR).toLowerCase() === "true",
    alertEmail: clean(env.PHONE_BRIDGE_ALERT_EMAIL || env.DELIVERY_ALERT_EMAIL),
    escalationEmail: clean(env.PHONE_BRIDGE_ESCALATION_EMAIL)
  };
}

module.exports = {
  channelLabel,
  communicationKey,
  communicationLogFields,
  heartbeatConfig,
  matchCommunicationToJobs,
  normalizeCommunication,
  normalizeEmail,
  normalizePhone,
  phoneCandidates,
  reviewMetadata,
  stripAutomatedFooter
};

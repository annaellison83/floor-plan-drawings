const crypto = require("node:crypto");
const { normalizeAddress } = require("./calendar-sync");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeThreadId(value) {
  return clean(value);
}

function normalizedPropertyKey(value) {
  return normalizeAddress(value);
}

function gmailAirtableKey(threadId, propertyAddress) {
  const thread = normalizeThreadId(threadId);
  const address = normalizedPropertyKey(propertyAddress);
  if (!thread || !address) return "";
  return `${thread}::${address}`;
}

function gmailJobId(threadId, propertyAddress) {
  const key = gmailAirtableKey(threadId, propertyAddress);
  return key ? `GML-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}` : "";
}

function firstContact(contacts, role) {
  const list = contacts && Array.isArray(contacts[role]) ? contacts[role] : [];
  return list[0] || null;
}

function contactEmail(contact) {
  return clean(contact && (contact.email || contact.address)).toLowerCase();
}

function contactName(contact) {
  return clean(contact && contact.name);
}

function existingSourceChannels(record) {
  return clean(record && record.fields && record.fields["Source Channels"])
    .split(",").map(clean).filter(Boolean);
}

function mergedSourceChannels(record, incoming = "gmail") {
  const additions = clean(incoming).split(",").map(clean).filter(Boolean);
  return [...new Set([...existingSourceChannels(record), ...additions])].join(", ");
}

function findGmailAirtableMatch(records = [], { threadId, propertyAddress } = {}) {
  const thread = normalizeThreadId(threadId);
  const address = normalizedPropertyKey(propertyAddress);
  if (!thread || !address) return null;
  const exact = records.find((record) => {
    const fields = record && record.fields || {};
    return normalizeThreadId(fields["Gmail Thread ID"]) === thread
      && normalizedPropertyKey(fields["Property Address"]) === address;
  });
  if (exact) return exact;
  // Calendar or website intake may have created the Job before Gmail arrived.
  // A unique address match merges the sources instead of creating a duplicate.
  const byAddress = records.filter((record) => normalizedPropertyKey(record && record.fields && record.fields["Property Address"]) === address);
  return byAddress.length === 1 ? byAddress[0] : null;
}

function gmailAirtableFields(message = {}, project = {}, existing = null) {
  const address = clean(message.propertyAddress || project.propertyAddress);
  const threadId = normalizeThreadId(message.threadId || project.metadata && project.metadata.gmailThreadId);
  const messageId = clean(message.id || project.metadata && project.metadata.gmailMessageId);
  const addressKey = normalizedPropertyKey(address);
  const client = firstContact(message.contacts, "client");
  const agent = firstContact(message.contacts, "agent");
  const body = clean(message.text);
  const subject = clean(message.subject);
  const originalRequest = [subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n\n").slice(0, 12000);
  const fields = {
    "Job ID": gmailJobId(threadId, address),
    "Status": "New Request",
    "Property Address": address,
    "Original Request": originalRequest,
    "AI Summary": subject ? `Email intake: ${subject}` : "Email intake received for review.",
    "Request Type": "Email Intake",
    "Website Workflow": "Quick Quote",
    "Gmail Thread ID": threadId,
    "Gmail Message ID": messageId,
    "Normalized Property Key": addressKey,
    "Source Channels": mergedSourceChannels(existing, "gmail")
  };
  if (client) {
    fields["Client Name"] = contactName(client) || clean(project.clientName);
    fields["Client Email"] = contactEmail(client);
  } else if (clean(project.clientName)) {
    fields["Client Name"] = clean(project.clientName);
  }
  if (agent) fields["Agent / Company"] = contactName(agent) || contactEmail(agent);
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => clean(value)));
}

function patchMissingGmailFields(record, incoming) {
  const existing = record && record.fields || {};
  const patch = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!clean(value)) continue;
    if (key === "Status" || key === "Website Workflow" || key === "Job ID") continue;
    if (["Gmail Thread ID", "Gmail Message ID", "Normalized Property Key", "Source Channels"].includes(key)) {
      patch[key] = key === "Source Channels" ? mergedSourceChannels(record, value) : value;
      continue;
    }
    if (!clean(existing[key])) patch[key] = value;
  }
  return patch;
}

module.exports = {
  findGmailAirtableMatch,
  gmailAirtableFields,
  gmailAirtableKey,
  gmailJobId,
  normalizeThreadId,
  normalizedPropertyKey,
  patchMissingGmailFields
};

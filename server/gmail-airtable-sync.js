const crypto = require("node:crypto");
const { directionlessStreetKey, normalizeAddress, propertyCoreKey, streetAddressKey, streetAddressValue } = require("./calendar-sync");
const { buildAerialFallbackLink, buildZimasAddressLink, ensurePropertyLinks } = require("./property-links");
const { isWeTransferPaymentConfirmation } = require("./gmail-runtime");

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

function externalEmail(value) {
  const email = contactEmail({ email: value });
  return email && !/annaellison|floorplandrawings|noreply|no-reply/i.test(email) ? email : "";
}

function inferredClientContact(message = {}) {
  const contacts = message.contacts || {};
  const configuredClient = firstContact(contacts, "client");
  if (configuredClient && externalEmail(contactEmail(configuredClient))) return configuredClient;
  const source = contacts.source;
  if (source && externalEmail(contactEmail(source))) return source;
  const unknown = (Array.isArray(contacts.unknown) ? contacts.unknown : [])
    .filter((contact) => externalEmail(contactEmail(contact)));
  return unknown.length === 1 ? unknown[0] : null;
}

function messageContactEmail(message = {}, candidate = null) {
  const direct = externalEmail(contactEmail(candidate));
  if (direct) return direct;
  const matches = [...`${clean(message.subject)}\n${clean(message.text)}`.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => externalEmail(match[0]))
    .filter((email, index, values) => email && values.indexOf(email) === index);
  return matches.length === 1 ? matches[0] : "";
}

function messageContactPhone(message = {}) {
  const matches = [...`${clean(message.subject)}\n${clean(message.text)}`.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}\b/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((phone, index, values) => phone.replace(/\D/g, "") !== "4436213024" && values.indexOf(phone) === index);
  return matches.length ? matches[0] : "";
}

function weTransferLinks(message = {}) {
  return [...`${clean(message.subject)}\n${clean(message.text)}`.matchAll(/https?:\/\/(?:www\.)?(?:wetransfer\.com|we\.tl)[^\s<>"')]+/gi)]
    .map((match) => match[0].replace(/[),.;]+$/, ""))
    .filter((url, index, values) => values.indexOf(url) === index);
}

function transferTokens(urls = []) {
  return urls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      return parsed.pathname.split("/").map(clean).filter((part) => part.length >= 8);
    } catch {
      return [];
    }
  });
}

function paymentFieldsForMessage(message = {}) {
  if (!isWeTransferPaymentConfirmation(message)) return {};
  const timestamp = Date.parse(message.date || message.internalDate || "");
  const confirmedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
  const evidence = clean(message.threadId)
    ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}`
    : weTransferLinks(message)[0] || "";
  return {
    "Payment Status": "Paid",
    "Invoice Status": "Paid",
    "Payment Evidence URL": evidence,
    "Payment Confirmed At": confirmedAt
  };
}

function deliveryFieldsForMessage(message = {}) {
  const link = weTransferLinks(message)[0] || "";
  return link ? { "Delivery Link": link } : {};
}

function isAddressLikeClient(value, address = "") {
  const current = clean(value);
  const property = clean(address);
  if (!current || !property) return false;
  const normalize = (input) => clean(input).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const clientKey = normalize(current);
  const addressKey = normalize(property);
  if (clientKey === addressKey) return true;
  return clientKey.startsWith(addressKey) && /\b(?:ca|california)\b|\b\d{5}(?:-\d{4})?\b/i.test(current);
}

function existingSourceChannels(record) {
  return clean(record && record.fields && record.fields["Source Channels"])
    .split(",").map(clean).filter(Boolean);
}

function mergedSourceChannels(record, incoming = "gmail") {
  const additions = clean(incoming).split(",").map(clean).filter(Boolean);
  return [...new Set([...existingSourceChannels(record), ...additions])].join(", ");
}

function findGmailAirtableMatch(records = [], { threadId, propertyAddress, clientEmail } = {}) {
  const thread = normalizeThreadId(threadId);
  const address = normalizedPropertyKey(propertyAddress);
  if (!address) return null;
  const exact = thread && records.find((record) => {
    const fields = record && record.fields || {};
    return normalizeThreadId(fields["Gmail Thread ID"]) === thread
      && normalizedPropertyKey(fields["Property Address"]) === address;
  });
  if (exact) return exact;
  // Calendar or website intake may have created the Job before Gmail arrived.
  // A unique street match merges the sources instead of creating a duplicate.
  // The core-key fallback handles a calendar title that omitted a unit, but
  // only when the contact email confirms the same person/property.
  const byAddress = records.filter((record) => normalizedPropertyKey(record && record.fields && record.fields["Property Address"]) === address);
  if (byAddress.length === 1) return byAddress[0];

  const streetKey = streetAddressKey(propertyAddress);
  const byStreet = records.filter((record) => streetAddressKey(record && record.fields && record.fields["Property Address"]) === streetKey);
  if (byStreet.length === 1) return byStreet[0];
  const directionlessKey = directionlessStreetKey(propertyAddress);
  const byDirectionlessStreet = directionlessKey
    ? records.filter((record) => directionlessStreetKey(record && record.fields && record.fields["Property Address"]) === directionlessKey)
    : [];
  if (byDirectionlessStreet.length === 1) return byDirectionlessStreet[0];
  const email = externalEmail(clientEmail);
  const coreKey = propertyCoreKey(propertyAddress);
  if (!coreKey || !email) return null;
  const byCoreAndEmail = records.filter((record) => propertyCoreKey(record && record.fields && record.fields["Property Address"]) === coreKey
    && externalEmail(record && record.fields && record.fields["Client Email"]) === email);
  return byCoreAndEmail.length === 1 ? byCoreAndEmail[0] : null;
}

function findPaymentAirtableMatch(records = [], message = {}) {
  const thread = normalizeThreadId(message.threadId);
  if (thread) {
    const threadMatches = records.filter((record) => normalizeThreadId(record && record.fields && record.fields["Gmail Thread ID"]) === thread);
    if (threadMatches.length === 1) return threadMatches[0];
  }
  const addressKey = streetAddressKey(message.propertyAddress);
  if (addressKey) {
    const addressMatches = records.filter((record) => streetAddressKey(record && record.fields && record.fields["Property Address"]) === addressKey);
    if (addressMatches.length === 1) return addressMatches[0];
  }
  const tokens = transferTokens(weTransferLinks(message));
  if (!tokens.length) return null;
  const tokenMatches = records.filter((record) => tokens.some((token) => JSON.stringify(record && record.fields || {}).includes(token)));
  return tokenMatches.length === 1 ? tokenMatches[0] : null;
}

function findGmailAirtableThreadMatch(records = [], { threadId } = {}) {
  const thread = normalizeThreadId(threadId);
  if (!thread) return null;
  const matches = records.filter((record) => normalizeThreadId(record && record.fields && record.fields["Gmail Thread ID"]) === thread);
  return matches.length === 1 ? matches[0] : null;
}

function resolveGmailSyncAddress(message = {}, project = {}, records = []) {
  const directAddress = clean(message.propertyAddress);
  if (directAddress) return { address: directAddress, existing: null };
  const threadId = clean(message.threadId || project.metadata && project.metadata.gmailThreadId);
  const existing = findGmailAirtableThreadMatch(records, { threadId });
  return { address: clean(existing && existing.fields && existing.fields["Property Address"]), existing };
}

function gmailAirtableFields(message = {}, project = {}, existing = null) {
  const linkAddress = clean(message.propertyAddress || project.propertyAddress);
  const address = streetAddressValue(linkAddress);
  const threadId = normalizeThreadId(message.threadId || project.metadata && project.metadata.gmailThreadId);
  const messageId = clean(message.id || project.metadata && project.metadata.gmailMessageId);
  const addressKey = streetAddressKey(address) || normalizedPropertyKey(address);
  const client = inferredClientContact(message);
  const agent = firstContact(message.contacts, "agent");
  const body = clean(message.text);
  const subject = clean(message.subject);
  const originalRequest = [subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n\n").slice(0, 12000);
  const fields = ensurePropertyLinks({
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
  }, linkAddress || address);
  // Keep fallback assets keyed to the stored street-only address so a later
  // property-research retry recognizes and replaces them. Maps can still use
  // the richer source string above when it is available.
  fields["ZIMAS Link"] = buildZimasAddressLink(address);
  fields["Aerial Map URL"] = buildAerialFallbackLink(address);
  fields["Satellite Photo Link"] = buildAerialFallbackLink(address);
  Object.assign(fields, deliveryFieldsForMessage(message), paymentFieldsForMessage(message));
  const parsedClientName = clean(message.clientName);
  const candidateName = contactName(client) || parsedClientName || clean(project.clientName);
  if (candidateName && !isAddressLikeClient(candidateName, address)) fields["Client Name"] = candidateName;
  const candidateEmail = messageContactEmail(message, client);
  if (candidateEmail) fields["Client Email"] = candidateEmail;
  const candidatePhone = messageContactPhone(message);
  if (candidatePhone) fields["Client Phone"] = candidatePhone;
  if (agent) fields["Agent / Company"] = contactName(agent) || contactEmail(agent);
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => clean(value)));
}

function patchMissingGmailFields(record, incoming) {
  const existing = record && record.fields || {};
  const patch = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!clean(value)) continue;
    if (["Payment Status", "Invoice Status", "Payment Evidence URL", "Payment Confirmed At"].includes(key)
      && (incoming["Payment Status"] === "Paid" || key === "Payment Evidence URL" || key === "Payment Confirmed At")) {
      patch[key] = value;
      continue;
    }
    if (key === "Delivery Link") {
      if (!clean(existing[key])) patch[key] = value;
      continue;
    }
    if (key === "Status" || key === "Website Workflow" || key === "Job ID") continue;
    if (["Gmail Thread ID", "Gmail Message ID", "Normalized Property Key", "Source Channels"].includes(key)) {
      patch[key] = key === "Source Channels" ? mergedSourceChannels(record, value) : value;
      continue;
    }
    if (!clean(existing[key]) || (key === "Client Name" && isAddressLikeClient(existing[key], existing["Property Address"]) && !isAddressLikeClient(value, existing["Property Address"]))) patch[key] = value;
  }
  return patch;
}

function isGeneratedPropertyFallback(key, value, address) {
  const current = clean(value);
  const property = clean(address);
  if (key === "ZIMAS Link" && current === buildZimasAddressLink(property)) return true;
  if ((key === "Aerial Map URL" || key === "Satellite Photo Link") && current === buildAerialFallbackLink(property)) return true;
  try {
    const parsed = new URL(current);
    const rawQueryAddress = parsed.searchParams.get("address") || parsed.pathname.split("/search/")[1] || "";
    const queryAddress = decodeURIComponent(rawQueryAddress);
    if (!queryAddress || streetAddressKey(queryAddress) !== streetAddressKey(property)) return false;
    if (key === "ZIMAS Link") return parsed.hostname === "zimas.lacity.org" && /\/map\.asp$/i.test(parsed.pathname);
    return /earth\.google\.com\/web\/search\//i.test(parsed.href);
  } catch {
    return false;
  }
}

module.exports = {
  deliveryFieldsForMessage,
  findGmailAirtableMatch,
  findGmailAirtableThreadMatch,
  findPaymentAirtableMatch,
  gmailAirtableFields,
  gmailAirtableKey,
  gmailJobId,
  isGeneratedPropertyFallback,
  messageContactEmail,
  paymentFieldsForMessage,
  weTransferLinks,
  normalizeThreadId,
  normalizedPropertyKey,
  patchMissingGmailFields,
  resolveGmailSyncAddress
};

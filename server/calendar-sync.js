const crypto = require("node:crypto");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeText(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeAddress(value) {
  return normalizeText(value).replace(/\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln)\b/g, (word) => ({ street: "st", avenue: "ave", boulevard: "blvd", drive: "dr", road: "rd", lane: "ln" }[word] || word));
}

function looksLikeAddress(value) {
  const candidate = clean(value);
  return /^\d{1,6}\s+\S+(?:\s+\S+){1,12}$/i.test(candidate)
    && /\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b/i.test(candidate);
}

function extractAddress(event = {}) {
  const candidates = [event.location, event.summary, event.description]
    .flatMap((value) => clean(value).split(/[\n|•]+/).map(clean));
  for (const candidate of candidates) {
    const stateZip = candidate.match(/\b\d{1,6}(?:-\d{1,6})?\s+[^\n|]+?\b(?:CA|California)\s+\d{5}\b/i);
    if (stateZip && looksLikeAddress(stateZip[0])) return stateZip[0];
    const match = candidate.match(/\b\d{1,6}(?:-\d{1,6})?\s+[^,\n|]+?\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b(?:\s+\d{5})?/i);
    if (match && looksLikeAddress(match[0])) return match[0];
  }
  return "";
}

function isLikelyWorkEvent(event = {}) {
  if (extractAddress(event)) return true;
  return /\b(color|b\s*&?\s*w|black\s*and\s*white|floor\s*plan|fp|yard|matterport|site\s*map|tic|condo|apartment|drawing|property|client)\b/i.test([event.summary, event.description, event.location].map(clean).join(" "));
}

function calendarEventKey(calendar, event) {
  const uid = clean(event && event.uid);
  const start = clean(event && event.start && event.start.toISOString ? event.start.toISOString() : event && event.start);
  const source = `${clean(calendar && calendar.url)}|${uid || clean(event && event.summary)}|${uid ? "" : start}`;
  return `calendar:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

function jobIdForCalendarEvent(calendar, event) {
  return `CAL-${crypto.createHash("sha256").update(calendarEventKey(calendar, event)).digest("hex").slice(0, 24)}`;
}

function eventStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function findProjectMatch(event, calendar, projects = []) {
  const uid = clean(event.uid);
  const address = normalizeAddress(extractAddress(event));
  const start = eventStart(event.start);
  return projects.find((project) => {
    const metadata = project.metadata || {};
    const stored = metadata.calendarEvent || {};
    if (uid && clean(stored.uid) === uid && clean(stored.calendarUrl) === clean(calendar.url)) return true;
    if (address && normalizeAddress(project.propertyAddress) === address) {
      const appointment = metadata.appointment || {};
      return !start || !appointment.start || eventStart(appointment.start) === start;
    }
    return false;
  }) || null;
}

function calendarAirtableFields(calendar, event, project = null, gmailMatch = null) {
  const address = extractAddress(event) || (project && project.propertyAddress) || "";
  const start = eventStart(event.start);
  const end = eventStart(event.end);
  const projectClient = project && project.contacts && project.contacts.client;
  const projectClientEmail = Array.isArray(projectClient) ? projectClient[0] : projectClient;
  const gmailClient = gmailMatch && gmailMatch.contacts && gmailMatch.contacts.client && gmailMatch.contacts.client[0];
  return {
    "Job ID": jobIdForCalendarEvent(calendar, event),
    "Property Address": address,
    "Client Name": project && project.clientName || gmailMatch && gmailMatch.clientName || "",
    "Client Email": projectClientEmail || gmailClient && gmailClient.email || "",
    "Status": "Calendar Imported",
    "Website Workflow": "Calendar",
    "Calendar Event UID": clean(event.uid),
    "Calendar Name": clean(calendar.name),
    "Calendar URL": clean(calendar.url),
    "Calendar Event Start": start,
    "Calendar Event End": end,
    "Calendar Event Summary": clean(event.summary),
    "Calendar Event Description": clean(event.description),
    "Calendar Event Location": clean(event.location),
    "Calendar Sync Source": "iCloud",
    "Gmail Thread ID": project && project.metadata && project.metadata.gmailThreadId || gmailMatch && gmailMatch.threadId || "",
    "Normalized Property Key": normalizeAddress(address),
    "Source Channels": "calendar",
    "Calendar Sync Key": calendarEventKey(calendar, event)
  };
}

module.exports = { calendarAirtableFields, calendarEventKey, extractAddress, findProjectMatch, isLikelyWorkEvent, jobIdForCalendarEvent, normalizeAddress };

const crypto = require("node:crypto");
const { buildAerialFallbackLink, buildZimasAddressLink, ensurePropertyLinks } = require("./property-links");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function googleMapsLink(address) {
  const value = clean(address);
  return value ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}` : "";
}

function normalizeText(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeAddress(value) {
  return normalizeText(value)
    .replace(/\b(north|n|south|s|east|e|west|w)\b/g, (word) => ({ north: "n", south: "s", east: "e", west: "w" }[word] || word))
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b/g, (word) => ({
      street: "st", avenue: "ave", boulevard: "blvd", drive: "dr", road: "rd", lane: "ln", court: "ct", place: "pl", parkway: "pkwy", circle: "cir", terrace: "ter", highway: "hwy"
    }[word] || word));
}

// Address matching needs a street-only key because the same property arrives
// from the website, Gmail, and Calendar in different forms (street only,
// city/state/ZIP appended, or a unit omitted by the calendar title). Keep the
// unit when it is explicit so separate apartments do not collapse together.
function streetAddressValue(value) {
  let source = clean(value).replace(/\s+/g, " ");
  if (!source) return "";
  const segments = source.split(",").map(clean).filter(Boolean);
  const unitSegment = segments.slice(1).find((segment) => /^(?:unit|suite|apt|#)\s*[A-Za-z0-9-]+$/i.test(segment));
  if (segments.length > 1) source = segments[0] + (unitSegment ? `, ${unitSegment}` : "");
  // Handle compact all-caps strings such as “941 FORTUNE WAY LOS ANGELES CA 90042”.
  const compact = source.match(/^(.+?\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy))\s+[A-Za-z .'-]+\s+(?:CA|California)\b.*$/i);
  if (compact) source = compact[1];
  source = source.replace(/\s*,?\s*(?:CA|California)\b.*$/i, "");
  source = source.replace(/(?:,|\s)\d{5}(?:-\d{4})?\b.*$/, "");
  source = source.replace(/\s*,?\s*(?:USA|United States)\b.*$/i, "");
  return source.replace(/[\s,]+$/, "").trim();
}

function streetAddressKey(value) {
  return normalizeAddress(streetAddressValue(value));
}

function directionlessStreetKey(value) {
  return streetAddressKey(value).replace(/^(\d+)\s+[nesw]\s+/, "$1 ").trim();
}

function propertyCoreKey(value) {
  return streetAddressKey(value).replace(/\s+(?:unit|suite|apt|#)\s*[A-Za-z0-9-]+$/i, "").trim();
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
  const streetKey = streetAddressKey(extractAddress(event));
  const coreKey = propertyCoreKey(extractAddress(event));
  const start = eventStart(event.start);
  const exact = projects.find((project) => {
    const metadata = project.metadata || {};
    const stored = metadata.calendarEvent || {};
    if (uid && clean(stored.uid) === uid && clean(stored.calendarUrl) === clean(calendar.url)) return true;
    if (address && normalizeAddress(project.propertyAddress) === address) {
      const appointment = metadata.appointment || {};
      return !start || !appointment.start || eventStart(appointment.start) === start;
    }
    return false;
  });
  if (exact) return exact;
  if (!streetKey) return null;
  const streetMatches = projects.filter((project) => streetAddressKey(project.propertyAddress) === streetKey);
  if (streetMatches.length === 1) return streetMatches[0];
  const directionlessKey = directionlessStreetKey(extractAddress(event));
  const directionlessMatches = directionlessKey
    ? projects.filter((project) => directionlessStreetKey(project.propertyAddress) === directionlessKey)
    : [];
  if (directionlessMatches.length === 1) return directionlessMatches[0];
  if (!coreKey) return null;
  const coreMatches = projects.filter((project) => propertyCoreKey(project.propertyAddress) === coreKey);
  return coreMatches.length === 1 ? coreMatches[0] : null;
}

function calendarAirtableFields(calendar, event, project = null, gmailMatch = null) {
  const linkAddress = extractAddress(event) || (project && project.propertyAddress) || "";
  const address = streetAddressValue(linkAddress);
  const start = eventStart(event.start);
  const end = eventStart(event.end);
  const projectClient = project && project.contacts && project.contacts.client;
  const projectClientEmail = Array.isArray(projectClient) ? projectClient[0] : projectClient;
  const gmailClient = gmailMatch && gmailMatch.contacts && gmailMatch.contacts.client && gmailMatch.contacts.client[0];
  const fields = ensurePropertyLinks({
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
    "Normalized Property Key": streetAddressKey(address),
    "Source Channels": "calendar",
    "Calendar Sync Key": calendarEventKey(calendar, event)
  }, linkAddress || address);
  fields["ZIMAS Link"] = buildZimasAddressLink(address);
  fields["Aerial Map URL"] = buildAerialFallbackLink(address);
  fields["Satellite Photo Link"] = buildAerialFallbackLink(address);
  return fields;
}

function mergeCalendarAirtableFields(existingRecord, incomingFields) {
  const existing = existingRecord && existingRecord.fields ? existingRecord.fields : existingRecord || {};
  return Object.fromEntries(Object.entries(incomingFields || {})
    .filter(([key, value]) => value !== "" && (["Status", "Job ID", "Website Workflow"].includes(key) || Object.prototype.hasOwnProperty.call(existing, key)))
    .map(([key, value]) => {
      // Calendar discovery is a source of scheduling metadata, not authority over
      // an existing workflow identity or manually advanced status.
      if (["Status", "Job ID", "Website Workflow"].includes(key) && clean(existing[key])) {
        return null;
      }
      if (key === "Source Channels") {
        return [key, [...new Set(`${clean(existing[key])},${clean(value)}`.split(",").map(clean).filter(Boolean))].join(", ")];
      }
      return [key, value];
    }).filter(Boolean));
}

function shouldSkipBlankAddressCreate(fields, existingRecord) {
  return !clean(fields && fields["Property Address"]) && !existingRecord;
}

module.exports = { calendarAirtableFields, calendarEventKey, directionlessStreetKey, extractAddress, findProjectMatch, isLikelyWorkEvent, jobIdForCalendarEvent, mergeCalendarAirtableFields, normalizeAddress, propertyCoreKey, shouldSkipBlankAddressCreate, streetAddressKey, streetAddressValue };

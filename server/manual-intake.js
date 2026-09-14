const crypto = require("node:crypto");
const { extractPropertyAddress, extractClientName } = require("./gmail-runtime");
const { normalizeAddress } = require("./calendar-sync");
const { ensurePropertyLinks } = require("./property-links");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

const STREET_SUFFIX = /\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b/i;

function extractAddress(text) {
  const source = clean(text);
  const fromStructuredText = extractPropertyAddress("", source);
  if (fromStructuredText) return fromStructuredText;

  // Text messages commonly omit commas/state/ZIP (for example, “150 Arlington
  // Dr Pasadena”). Keep the human-entered wording and normalize only for
  // matching; property research can enrich it later.
  const match = source.match(/\b(\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.'-]*){0,8}\s+\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}(?:,\s*(?:CA|California)\b(?:\s+\d{5})?)?)/i);
  if (!match || !STREET_SUFFIX.test(match[1])) return "";
  return clean(match[1].replace(/[.!?]+$/, ""));
}

function extractEmail(text) {
  const match = clean(text).match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return match ? match[0].toLowerCase() : "";
}

function extractPhone(text) {
  const match = clean(text).match(/(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/);
  return match ? clean(match[0]) : "";
}

function fallbackName(text, email) {
  const source = clean(text);
  const explicit = source.match(/(?:from|client|agent|contact)\s*[:\-]\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/i);
  if (explicit) return clean(explicit[1]);
  if (email) return email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return extractClientName("", source);
}

function manualIntakeKey(address, text) {
  const normalized = `${normalizeAddress(address)}|${clean(text).toLowerCase().replace(/\s+/g, " ")}`;
  return `MAN-${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function propertyLinks(address) {
  const fields = ensurePropertyLinks({}, address);
  return {
    googleMapsLink: fields["Google Maps Link"],
    zimasLink: fields["ZIMAS Link"],
    aerialMapUrl: fields["Aerial Map URL"],
    satellitePhotoLink: fields["Satellite Photo Link"]
  };
}

function parseManualIntake(text, options = {}) {
  const value = clean(text);
  if (!value) return { ok: false, error: "Paste a request first" };
  if (value.length > 20000) return { ok: false, error: "Request is too long (20,000 characters maximum)" };
  const propertyAddress = extractAddress(value);
  if (!propertyAddress) return { ok: false, error: "I could not find a street address. Include the property address and try again.", needsAddress: true };
  const email = extractEmail(value);
  const phone = extractPhone(value);
  const clientName = fallbackName(value, email);
  const photoUrl = clean(options.photoUrl);
  if (photoUrl && (!/^https?:\/\//i.test(photoUrl) || photoUrl.length > 2000)) {
    return { ok: false, error: "Property photo URL must be an http(s) link under 2,000 characters" };
  }
  const links = propertyLinks(propertyAddress);
  const jobId = manualIntakeKey(propertyAddress, value);
  const fields = ensurePropertyLinks({
    "Job ID": jobId,
    "Status": "New Request",
    "Property Address": propertyAddress,
    "Client Name": clientName,
    "Client Email": email,
    "Client Phone": phone,
    "Original Request": value.slice(0, 12000),
    "Client Notes": value.slice(0, 12000),
    "Request Type": "Manual Intake",
    "Website Workflow": "Quick Quote",
    "Source Channels": "manual portal",
    "Request Started Date": new Date().toISOString(),
    ...(photoUrl ? { "Property Photo URL": photoUrl } : {})
  }, propertyAddress);
  return { ok: true, propertyAddress, clientName, email, phone, jobId, fields, links };
}

module.exports = { extractAddress, manualIntakeKey, parseManualIntake, propertyLinks };

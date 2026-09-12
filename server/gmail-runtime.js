const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function clean(value) { return value === undefined || value === null ? "" : String(value).trim(); }
function list(value) { return clean(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean); }

function gmailConfig(env = process.env) {
  return {
    clientId: clean(env.GMAIL_CLIENT_ID), clientSecret: clean(env.GMAIL_CLIENT_SECRET),
    refreshToken: clean(env.GMAIL_REFRESH_TOKEN), accessToken: clean(env.GMAIL_ACCESS_TOKEN),
    intakeLabelId: clean(env.GMAIL_INTAKE_LABEL_ID), intakeQuery: clean(env.GMAIL_INTAKE_QUERY),
    autoLabelEnabled: clean(env.ENABLE_GMAIL_AUTO_LABEL).toLowerCase() === "true",
    autoLabelQuery: clean(env.GMAIL_AUTO_LABEL_QUERY),
    autoLabelMaxResults: Math.max(1, Math.min(100, Number(env.GMAIL_AUTO_LABEL_MAX_RESULTS) || 50)),
    maxResults: Math.max(1, Math.min(100, Number(env.GMAIL_INTAKE_MAX_RESULTS) || 25)),
    agentEmails: list(env.GMAIL_AGENT_EMAILS), clientEmails: list(env.GMAIL_CLIENT_EMAILS)
  };
}

function isGmailConfigured(env = process.env) {
  const config = gmailConfig(env);
  return Boolean(config.intakeLabelId && ((config.clientId && config.clientSecret && config.refreshToken) || config.accessToken));
}

function decodeBase64Url(value) {
  if (!value) return "";
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function headerMap(headers = []) {
  return headers.reduce((result, header) => {
    const name = clean(header.name).toLowerCase();
    if (name && !(name in result)) result[name] = clean(header.value);
    return result;
  }, {});
}

function addressParts(value) {
  const raw = clean(value);
  const matches = [...raw.matchAll(/(?:^|,|\s)(?:"?([^"<,]+?)"?\s*)?<([^>]+)>|(?:^|,|\s)([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/g)];
  const result = [];
  for (const match of matches) {
    const email = clean(match[2] || match[3]).toLowerCase();
    if (!email || result.some((item) => item.email === email)) continue;
    result.push({ name: clean(match[1]), email });
  }
  return result;
}

function classifyContacts({ from = [], to = [], cc = [], agentEmails = [], clientEmails = [] } = {}) {
  const agentSet = new Set(agentEmails.map((item) => clean(item).toLowerCase()).filter(Boolean));
  const clientSet = new Set(clientEmails.map((item) => clean(item).toLowerCase()).filter(Boolean));
  const classify = (contact) => ({ ...contact, role: agentSet.has(contact.email) ? "agent" : clientSet.has(contact.email) ? "client" : "unknown" });
  const contacts = [...from, ...to, ...cc].map(classify);
  return {
    // Never infer that a sender is the client; resolve this per project when needed.
    source: from[0] ? classify(from[0]) : null,
    agent: contacts.filter((contact) => contact.role === "agent"),
    client: contacts.filter((contact) => contact.role === "client"),
    unknown: contacts.filter((contact) => contact.role === "unknown")
  };
}

function collectBodies(part, result = { text: [], html: [] }) {
  if (!part) return result;
  const mime = clean(part.mimeType).toLowerCase();
  if (part.body && part.body.data && mime === "text/plain") result.text.push(decodeBase64Url(part.body.data));
  if (part.body && part.body.data && mime === "text/html") result.html.push(decodeBase64Url(part.body.data));
  for (const child of part.parts || []) collectBodies(child, result);
  return result;
}

function collectAttachmentNames(part, result = []) {
  if (!part) return result;
  if (clean(part.filename)) result.push(clean(part.filename));
  for (const child of part.parts || []) collectAttachmentNames(child, result);
  return result;
}

const STREET_SUFFIX = /\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b/i;

function titleCase(value) {
  return clean(value).replace(/\b([a-z])/gi, (match) => match.toUpperCase());
}

function looksLikeAddress(value) {
  const candidate = clean(value);
  return /^\d{1,6}\s+\S+(?:\s+\S+){1,10}$/i.test(candidate)
    && (STREET_SUFFIX.test(candidate) || /^\d{1,6}\s+[A-Za-z]+(?:\s+[A-Za-z]+)?$/i.test(candidate));
}

function addressFromPropertyUrl(text) {
  const match = clean(text).match(/https?:\/\/[^\s<>]+\/(?:listing|homedetails)\/([^\s<>?#]+)/i);
  if (!match) return "";
  const slug = decodeURIComponent(match[1]).replace(/[-_]+/g, " ").replace(/\s+zpid\b.*$/i, "").trim();
  const stateZip = slug.match(/\b([A-Z]{2})\s+(\d{5})(?:\b|$)/i);
  if (!stateZip) return "";
  const before = clean(slug.slice(0, stateZip.index));
  if (!before) return "";
  return `${titleCase(before)}, ${stateZip[1].toUpperCase()} ${stateZip[2]}`;
}

function extractPropertyAddress(subject, text) {
  const headline = clean(subject).replace(/^re:\s*/i, "");
  const pipeParts = headline.split("|").map(clean);
  if (pipeParts.length >= 3 && looksLikeAddress(pipeParts[1])) return pipeParts[1];
  const dashAddress = headline.match(/^(.+?)\s+-\s+(?:site map|floor plan|property)\s+requested\b/i);
  if (dashAddress && clean(dashAddress[1])) return clean(dashAddress[1]);
  const lines = clean(text).split(/\r?\n/).map(clean).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^https?:\/\//i.test(lines[index]) || /^<https?:\/\//i.test(lines[index])) {
      const previous = lines[index - 1] || "";
      if (looksLikeAddress(previous)) return previous;
      const fromUrl = addressFromPropertyUrl(lines[index]);
      if (fromUrl) return fromUrl;
    }
  }
  return lines.find(looksLikeAddress) || "";
}

function extractClientName(subject, text) {
  const parts = clean(subject).replace(/^re:\s*/i, "").split("|").map(clean);
  if (parts.length >= 3 && parts[2] && !/requested|needed/i.test(parts[2])) return parts[2];
  const listingMatch = clean(text).match(/\b(?:listing|project|property)\s*(?:for|by|with)?\s*:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\b/);
  return listingMatch ? listingMatch[1] : "";
}

function parseGmailMessage(message, options = {}) {
  const headers = headerMap(message && message.payload && message.payload.headers);
  const bodies = collectBodies(message && message.payload);
  const attachmentNames = [...new Set(collectAttachmentNames(message && message.payload))];
  const from = addressParts(headers.from), to = addressParts(headers.to), cc = addressParts(headers.cc);
  return {
    id: clean(message && message.id), threadId: clean(message && message.threadId), historyId: clean(message && message.historyId),
    internalDate: Number(message && message.internalDate) || null,
    messageId: headers["message-id"], inReplyTo: headers["in-reply-to"], references: headers.references,
    subject: headers.subject, date: headers.date, from, to, cc, replyTo: addressParts(headers["reply-to"]),
    contacts: classifyContacts({ from, to, cc, agentEmails: options.agentEmails || [], clientEmails: options.clientEmails || [] }),
    propertyAddress: extractPropertyAddress(headers.subject, bodies.text.join("\n\n")),
    clientName: extractClientName(headers.subject, bodies.text.join("\n\n")),
    text: bodies.text.join("\n\n").trim(), html: bodies.html.join("\n").trim(), attachmentNames,
    labelIds: Array.isArray(message && message.labelIds) ? [...message.labelIds] : [], raw: message
  };
}

const FPD_INTAKE_MARKERS = /\b(?:floor\s*plans?|floorplans?|site\s*plans?|matterport|3d\s*(?:tour|scan)|sq\.?\s*ft|square\s*feet|quick\s*quote|quote\s*(?:request|ready)|new\s+request|measure(?:ment)?s?|fpd\s+website)\b/i;
const FPD_NON_INTAKE_MARKERS = /\b(?:kaiser|medical|therapy|soul\s*tenders|stripe|payout|tax|sep\s+contribution|retirement|insurance)\b/i;

function isLikelyFloorPlanIntake(message = {}) {
  const subject = clean(message.subject);
  const text = clean(message.text || message.snippet);
  const attachments = Array.isArray(message.attachmentNames) ? message.attachmentNames.join(" ") : "";
  const searchable = `${subject}\n${text}\n${attachments}`;
  if (!searchable || FPD_NON_INTAKE_MARKERS.test(searchable)) return false;
  const hasMarker = FPD_INTAKE_MARKERS.test(searchable);
  const hasAddress = Boolean(clean(message.propertyAddress)) || /\b\d{1,6}\s+[A-Za-z0-9][^\n,]{1,80}\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b/i.test(searchable);
  const websiteMarker = /floorplandrawings\.com|floor\s*plan\s*drawings/i.test(searchable);
  return hasMarker && (hasAddress || websiteMarker || /new\s+request|quick\s+quote|site\s+map/i.test(subject));
}

async function jsonFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && body.error && (body.error.message || body.error_description);
    throw new Error(`Gmail request failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return body;
}

function createGmailClient({ env = process.env, fetchImpl = fetch } = {}) {
  const config = gmailConfig(env); let accessToken = config.accessToken; let tokenPromise;
  async function token() {
    if (accessToken) return accessToken;
    if (!config.clientId || !config.clientSecret || !config.refreshToken) throw new Error("Gmail OAuth is not configured");
    if (!tokenPromise) {
      tokenPromise = jsonFetch(fetchImpl, OAUTH_TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: "refresh_token" })
      }).then((body) => { accessToken = clean(body.access_token); if (!accessToken) throw new Error("Gmail OAuth response did not include an access token"); return accessToken; }).finally(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }
  async function api(path, options = {}) {
    const currentToken = await token();
    return jsonFetch(fetchImpl, `${GMAIL_API}${path}`, { ...options, headers: { Authorization: `Bearer ${currentToken}`, Accept: "application/json", ...(options.headers || {}) } });
  }
  return {
    config,
    async listMessages({ labelId = config.intakeLabelId, query = config.intakeQuery, pageToken, maxResults = config.maxResults } = {}) {
      const params = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(100, maxResults))) });
      if (labelId) params.set("labelIds", labelId); if (query) params.set("q", query); if (pageToken) params.set("pageToken", pageToken);
      return api(`/messages?${params}`);
    },
    async getMessage(id) { if (!clean(id)) throw new Error("A Gmail message ID is required"); return api(`/messages/${encodeURIComponent(id)}?format=full`); },
    async getThread(id) { if (!clean(id)) throw new Error("A Gmail thread ID is required"); return api(`/threads/${encodeURIComponent(id)}?format=full`); },
    async modifyLabels(id, { addLabelIds = [], removeLabelIds = [] } = {}) {
      return api(`/messages/${encodeURIComponent(id)}/modify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addLabelIds, removeLabelIds }) });
    }
  };
}

function createMemoryIdempotencyStore() { const seen = new Set(); return { async has(key) { return seen.has(clean(key)); }, async mark(key) { seen.add(clean(key)); } }; }

async function processIntakeMessages({ client, onMessage, store = createMemoryIdempotencyStore(), parser = parseGmailMessage, options = {}, listOptions = {} } = {}) {
  if (!client || typeof client.listMessages !== "function" || typeof client.getMessage !== "function") throw new Error("A Gmail client is required");
  if (typeof onMessage !== "function") throw new Error("onMessage is required");
  const listed = await client.listMessages(listOptions), processed = [], skipped = [];
  for (const item of listed.messages || []) {
    const id = clean(item && item.id); if (!id) continue;
    const key = `gmail:${id}`;
    if (await store.has(key)) { skipped.push(id); continue; }
    const message = parser(await client.getMessage(id), options); await onMessage(message); await store.mark(key); processed.push(message);
  }
  return { processed, skipped, nextPageToken: listed.nextPageToken || "" };
}

module.exports = { addressParts, classifyContacts, collectAttachmentNames, createGmailClient, createMemoryIdempotencyStore, extractClientName, extractPropertyAddress, gmailConfig, isGmailConfigured, isLikelyFloorPlanIntake, parseGmailMessage, processIntakeMessages };

const AIRTABLE_API = "https://api.airtable.com/v0";

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function first(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function yesNo(value) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return clean(value) || "No";
}

function attachmentUrl(value) {
  if (!Array.isArray(value)) return "";
  const attachment = value.find((item) => item && (item.url || (item.thumbnails && item.thumbnails.full && item.thumbnails.full.url)));
  return clean(attachment && (attachment.url || (attachment.thumbnails && attachment.thumbnails.full && attachment.thumbnails.full.url)));
}

function addressParts(value) {
  const text = clean(value).replace(/\s+/g, " ").trim();
  if (!text) return {};
  const match = text.match(/\b(CA|California)\s*,?\s*(\d{5}(?:-\d{4})?)\b/i);
  if (!match) return {};
  const before = text.slice(0, match.index).replace(/[\s,]+$/, "").trim();
  const commaParts = before.split(",").map((part) => part.trim()).filter(Boolean);
  let city = commaParts.length > 1 ? commaParts[commaParts.length - 1] : "";
  if (!city) {
    const street = before.match(/^(.*?\b(?:street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|highway|hwy)\b)(?:\s+|,)+(.*?)$/i);
    city = street && street[2] ? street[2].trim() : "";
  }
  return { city, state: /^California$/i.test(match[1]) ? "CA" : match[1].toUpperCase(), zip: match[2] };
}

function requestAddressParts(value) {
  const text = clean(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const fromQuery = addressParts(parsed.mapQuery);
      const fromAddress = addressParts(parsed.address);
      return {
        city: fromQuery.city || fromAddress.city || clean(parsed.city),
        state: fromQuery.state || fromAddress.state || clean(parsed.state),
        zip: fromQuery.zip || fromAddress.zip || clean(parsed.zip || parsed.postalCode)
      };
    }
  } catch {}
  return addressParts(text);
}

function requestContactParts(value) {
  const text = clean(value);
  if (!text) return {};
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const parsedClient = parsed && typeof parsed === "object" && parsed.client && typeof parsed.client === "object" ? parsed.client : {};
  const emailMatches = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => match[0].toLowerCase())
    .filter((email, index, values) => values.indexOf(email) === index)
    .filter((email) => !/annaellison|floorplandrawings|noreply|no-reply/i.test(email));
  const phoneMatches = [...text.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}\b/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((phone, index, values) => values.indexOf(phone) === index)
    .filter((phone) => phone.replace(/\D/g, "") !== "4436213024");
  const explicitName = text.match(/(?:^|\n)\s*(?:client|contact|name)\s*:\s*([^\n|]+)/i);
  return {
    name: clean(parsedClient.name || parsedClient.fullName || explicitName && explicitName[1]),
    email: clean(parsedClient.email) || emailMatches[0] || "",
    phone: clean(parsedClient.phone) || phoneMatches[0] || "",
    emails: emailMatches,
    phones: phoneMatches
  };
}

function detailValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "object") {
    if (value.name) return String(value.name);
    if (Array.isArray(value)) return value.map((item) => detailValue(item)).filter(Boolean).join(", ");
    return JSON.stringify(value);
  }
  return String(value);
}

function mapJob(record, options = {}) {
  const fields = record && record.fields ? record.fields : {};
  const baseId = clean(options.baseId);
  const tableId = clean(options.tableId);
  const approvalBaseUrl = clean(options.approvalBaseUrl);
  const proposalReviewBaseUrl = clean(options.proposalReviewBaseUrl);
  const approvalToken = clean(first(fields, ["Quote Approval Token", "Approval Token"]));
  const verifiedSqFt = Number(first(fields, ["Verified Sq Ft", "Verified Square Feet"]));
  const propertyAddress = first(fields, ["Full Address", "Property Address", "Address"]);
  const originalRequest = first(fields, ["Original Request", "Client Message", "Client Request"]);
  const derivedAddress = addressParts(propertyAddress);
  const requestParts = requestAddressParts(originalRequest);
  const requestContact = requestContactParts(originalRequest);
  const detailFields = Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => value !== "" && value !== null && value !== undefined && !/(token|secret|password)/i.test(key))
    .map(([key, value]) => [key, detailValue(value)]));

  return {
    recordId: clean(record && record.id),
    propertyAddress,
    city: first(fields, ["City", "Town", "Municipality"]) || derivedAddress.city || requestParts.city,
    state: first(fields, ["State", "State/Province"]) || derivedAddress.state || requestParts.state,
    zip: first(fields, ["Zip", "Zip Code", "Postal Code"]) || derivedAddress.zip || requestParts.zip,
    clientName: first(fields, ["Client Name", "Name"]) || requestContact.name,
    clientEmail: first(fields, ["Client Email", "Email"]) || requestContact.email,
    clientPhone: first(fields, ["Client Phone", "Phone"]) || requestContact.phone,
    contactEmails: requestContact.emails,
    contactPhones: requestContact.phones,
    detailFields,
    agentName: first(fields, ["Agent Name", "Realtor Name", "Contact Name"]),
    agentEmail: first(fields, ["Agent Email", "Realtor Email", "Agent Email Address"]),
    agentPhone: first(fields, ["Agent Phone", "Realtor Phone"]),
    recipientPolicy: first(fields, ["Recipient Policy", "Confirmation Recipient", "Client Communication Recipient"]),
    gmailThreadId: first(fields, ["Gmail Thread ID", "Email Thread ID"]),
    gmailMessageId: first(fields, ["Gmail Message ID"]),
    normalizedPropertyKey: first(fields, ["Normalized Property Key"]),
    sourceChannels: first(fields, ["Source Channels"]),
    clientNotes: first(fields, ["Client Notes"]),
    originalRequest,
    service: first(fields, ["Drawing Style", "Service Requested", "Service"]),
    scope: first(fields, ["Scope", "Unit / Suite / Scope Detail"]),
    workflow: first(fields, ["Website Workflow", "Workflow", "Request Type"]) || "Quick Quote",
    status: first(fields, ["Status"]),
    assignedMeasurer: first(fields, ["Assigned Measurer", "Employee Assigned", "Employee", "Measurer"]),
    // Keep this explicit: the portal must not silently substitute record creation time.
    dateStarted: first(fields, ["Request Started Date", "Date Started", "Start Date", "Submitted At"]),
    quoteZone: first(fields, ["Quote Zone", "Zone"]),
    milesFromNorthHollywood: first(fields, ["Miles From North Hollywood"]),
    milesFromMontereyPark: first(fields, ["Miles From Monterey Park"]),
    verifiedSqFt: first(fields, ["Verified Sq Ft", "Verified Square Feet"]),
    approxSqFt: first(fields, ["Approx Sq Ft", "Approx Square Feet", "Square Footage"]),
    redfinSqFt: first(fields, ["Redfin Sq Ft", "Redfin Square Feet", "Redfin Building Sq Ft"]),
    zillowSqFt: first(fields, ["Zillow Sq Ft", "Zillow Square Feet", "Zillow Building Sq Ft"]),
    realtorSqFt: first(fields, ["Realtor Sq Ft", "Realtor.com Sq Ft", "Realtor Square Feet"]),
    homesSqFt: first(fields, ["Homes.com Sq Ft", "Homes Sq Ft"]),
    suggestedQuote: first(fields, ["Suggested Quote", "Quote Estimate", "Quote Amount"]),
    blackWhiteQuote: first(fields, ["Black & White Quote", "Black and White Quote", "B&W Quote", "B&W Client Quote"]),
    colorQuote: first(fields, ["Color Quote", "Color Client Quote", "Color Interior Quote", "Color Interior + Exterior Quote"]),
    // Keep the client-facing amount separate from the internal suggestion. A
    // clean reply draft may use this value, while never leaking quote notes or
    // a merely suggested amount to the client by accident.
    clientFacingQuote: first(fields, ["Client Quote", "Presented Quote", "Approved Quote", "Quote Amount", "Final Quote Preview"]),
    finalQuote: first(fields, ["Quote Amount", "Final Quote Preview", "Approved Quote", "Client Quote"]),
    quoteNotes: first(fields, ["Quote Calculation Notes", "Quote Notes"]),
    followUpDate: first(fields, ["Follow-Up Date", "Follow Up Date"]),
    quoteSentDate: first(fields, ["Quote Sent Date"]),
    quoteGiven: first(fields, ["Quote Sent Date", "Quote Amount", "Final Quote Preview", "Suggested Quote"]),
    appointmentDateTime: first(fields, ["Appointment Date/Time", "Appointment Start", "Appointment Date"]),
    appointmentStart: first(fields, ["Appointment Start", "Appointment Date/Time"]),
    nextAvailable: first(fields, ["Next Available Appointment", "Next Available", "Proposed Appointment"]),
    deliveryDate: first(fields, ["Delivery Date", "Drawing Due Date"]),
    accessInfo: first(fields, ["Access Info", "Access Details"]),
    clientResponse: first(fields, ["Client Response"]),
    annaEmailStatus: first(fields, ["Anna Email Status"]),
    confirmationSentAt: first(fields, ["Client Confirmation Sent At", "Confirmation Sent At"]),
    reminderSentAt: first(fields, ["Client Reminder Sent At", "Reminder Sent At"]),
    calendarEventId: first(fields, ["Calendar Event ID", "Calendar Event UID"]),
    calendarEventStart: first(fields, ["Calendar Event Start"]),
    paymentStatus: first(fields, ["Payment Status"]),
    invoiceStatus: first(fields, ["Invoice Status"]),
    finalFiles: first(fields, ["Final Files", "Files / Final Deliverables"]),
    propertyCheckStatus: first(fields, ["Property Check Status"]),
    propertyResearchComplete: first(fields, ["Property Research Complete"]),
    tourRequested: yesNo(first(fields, ["3D Tour Requested", "3D Tour"])),
    aerialAttachmentUrl: attachmentUrl(first(fields, ["Aerial Parcel Preview"])),
    mapUrl: first(fields, ["Aerial Map URL", "Aerial URL"]),
    googleMapsLink: first(fields, ["Google Maps Link", "Google Maps URL"]),
    zimasLink: first(fields, ["ZIMAS Link"]),
    satellitePhotoLink: first(fields, ["Satellite Photo Link", "Aerial Map URL", "Aerial URL"]),
    contextMapUrl: first(fields, ["LA Context Map URL", "Context Map URL"]),
    recordUrl: baseId && tableId && record.id
      ? `https://airtable.com/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(record.id)}`
      : "",
    approvalUrl: approvalBaseUrl && approvalToken && record.id
      ? `${approvalBaseUrl}${approvalBaseUrl.includes("?") ? "&" : "?"}recordId=${encodeURIComponent(record.id)}&token=${encodeURIComponent(approvalToken)}`
      : "",
    availabilityReviewUrl: proposalReviewBaseUrl && approvalToken && record.id && Number.isFinite(verifiedSqFt) && verifiedSqFt > 0
      ? `${proposalReviewBaseUrl}${proposalReviewBaseUrl.includes("?") ? "&" : "?"}recordId=${encodeURIComponent(record.id)}&token=${encodeURIComponent(approvalToken)}`
      : ""
  };
}

function config(env = process.env) {
  const followUpMaxAge = clean(env.FOLLOW_UP_MAX_AGE_DAYS);
  return {
    token: clean(env.AIRTABLE_TOKEN),
    baseId: clean(env.AIRTABLE_BASE_ID),
    jobsTable: clean(env.AIRTABLE_JOBS_TABLE) || "Jobs",
    jobsTableId: clean(env.AIRTABLE_JOBS_TABLE_ID),
    communicationLogTable: clean(env.AIRTABLE_COMMUNICATION_LOG_TABLE) || "Communication Log",
    // Prevent a Render cutover from reviving indefinitely stale follow-ups.
    // Set to 0 to preserve the legacy unbounded Airtable rule.
    followUpMaxAgeDays: followUpMaxAge !== "" && Number.isFinite(Number(followUpMaxAge))
      ? Math.max(0, Math.floor(Number(followUpMaxAge)))
      : 90,
    approvalBaseUrl: clean(env.QUOTE_APPROVAL_URL),
    proposalReviewBaseUrl: clean(env.PROPOSAL_REVIEW_BASE_URL) || "https://floor-plan-drawings.onrender.com/api/scheduling/proposal/start"
  };
}

function communicationKey(recordId, eventType, version = "v1") {
  return [clean(recordId), clean(eventType).toLowerCase().replace(/[^a-z0-9]+/g, "_"), clean(version)]
    .filter(Boolean)
    .join(":");
}

function quoteReadyLogFields({ recordId, subject, status = "Pending", summary = "" }) {
  return {
    Communication: communicationKey(recordId, "quote_ready"),
    "Job Record ID": clean(recordId),
    Direction: "Outgoing",
    Channel: "Email",
    "Event Type": "QUOTE READY",
    "Email Subject": clean(subject),
    "Delivery Status": status,
    Summary: clean(summary)
  };
}

function clientQuoteLogFields({ recordId, clientName, subject, status = "Pending", summary = "" }) {
  return {
    Communication: communicationKey(recordId, "approved_quote"),
    "Job Record ID": clean(recordId),
    Direction: "Outgoing",
    Channel: "Email",
    "Event Type": "Quote Sent",
    "Email Subject": clean(subject),
    "Delivery Status": status,
    Summary: clean(summary) || `Client quote reserved for ${clean(clientName) || "client"}`
  };
}

function notificationLogFields({ recordId, eventType, subject, status = "Pending", summary = "", communication }) {
  return {
    Communication: clean(communication) || communicationKey(recordId, eventType),
    "Job Record ID": clean(recordId),
    Direction: "Outgoing",
    Channel: "Email",
    "Event Type": clean(eventType),
    "Email Subject": clean(subject),
    "Delivery Status": status,
    Summary: clean(summary)
  };
}

function inboundCommunicationLogFields({ recordId, subject, status = "Received", summary = "", communication }) {
  return {
    Communication: clean(communication) || communicationKey(recordId, "gmail_received"),
    "Job Record ID": clean(recordId),
    Direction: "Incoming",
    Channel: "Email",
    "Event Type": "Gmail Received",
    "Email Subject": clean(subject),
    "Delivery Status": status,
    Summary: clean(summary)
  };
}

function appointmentProposalLogFields({ recordId, subject, status = "Pending", summary = "", communication }) {
  return notificationLogFields({
    recordId,
    eventType: "APPOINTMENT OPTIONS",
    subject,
    status,
    summary,
    communication: communication || communicationKey(recordId, "appointment_options")
  });
}

async function airtableJson(url, { token, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result && result.error && (result.error.message || result.error.type);
    throw new Error(`Airtable ${method.toLowerCase()} failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return result;
}

async function getJob(recordId, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Airtable record ID is required");

  const table = settings.jobsTableId || settings.jobsTable;
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`;
  const body = await airtableJson(url, { token: settings.token });

  return mapJob(body, {
    baseId: settings.baseId,
    tableId: settings.jobsTableId || settings.jobsTable,
    approvalBaseUrl: settings.approvalBaseUrl,
    proposalReviewBaseUrl: settings.proposalReviewBaseUrl
  });
}

async function getApprovalState(recordId, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Airtable record ID is required");
  const table = settings.jobsTableId || settings.jobsTable;
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`;
  const body = await airtableJson(url, { token: settings.token });
  const fields = body.fields || {};
  return {
    approvalToken: clean(first(fields, ["Quote Approval Token", "Approval Token"])),
    decision: clean(fields["Anna Decision"]),
    workflow: clean(first(fields, ["Website Workflow", "Workflow", "Request Type"])),
    address: first(fields, ["Property Address", "Address"])
  };
}

async function findQuoteReadyDeliveries(recordId, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Airtable record ID is required");

  const formula = `AND({Job Record ID}='${id}',{Event Type}='QUOTE READY',OR({Delivery Status}='Pending',{Delivery Status}='Sent'))`;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "10");
  url.searchParams.append("fields[]", "Communication");
  url.searchParams.append("fields[]", "Email Subject");
  url.searchParams.append("fields[]", "Delivery Status");
  const body = await airtableJson(url.href, { token: settings.token });
  return (body.records || []).map((record) => ({ id: record.id, ...record.fields }));
}

async function listQuoteReadyCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const formula = "AND({Website Workflow}='Quick Quote',{Quote Review}='Ready for Anna',{Anna Email Status}='Not Sent',{Property Research Complete}=1)";
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "10");
  const body = await airtableJson(url.href, { token: settings.token });
  return body.records || [];
}

async function listJobs(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const table = settings.jobsTableId || settings.jobsTable;
  const records = [];
  let offset = "";
  const maxRecords = Math.max(1, Math.min(500, Number(options.maxRecords) || 500));
  const fetchLimit = options.newestFirst ? 500 : maxRecords;
  do {
    const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const body = await airtableJson(url.href, { token: settings.token });
    records.push(...(body.records || []));
    offset = clean(body.offset);
  } while (offset && records.length < fetchLimit);
  if (options.newestFirst) {
    const dateValue = (record) => first(record && record.fields ? record.fields : {}, ["Request Started Date", "Date Started", "Start Date", "Submitted At"]);
    records.sort((a, b) => {
      const aValue = dateValue(a);
      const bValue = dateValue(b);
      if (!aValue && !bValue) return clean(a && a.id).localeCompare(clean(b && b.id));
      if (!aValue) return 1;
      if (!bValue) return -1;
      const delta = new Date(bValue).getTime() - new Date(aValue).getTime();
      return Number.isFinite(delta) && delta !== 0 ? delta : clean(a && a.id).localeCompare(clean(b && b.id));
    });
  }
  return records.slice(0, maxRecords);
}

async function findClientQuoteDeliveries(recordId, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Airtable record ID is required");
  const formula = `AND({Job Record ID}='${id}',{Event Type}='Quote Sent',OR({Delivery Status}='Pending',{Delivery Status}='Sent'))`;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "10");
  const body = await airtableJson(url.href, { token: settings.token });
  return body.records || [];
}

async function findNotificationDeliveries(recordId, eventType, options = {}) {
  const settings = { ...config(), ...options };
  const key = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!key || !eventType) throw new Error("A notification key and event type are required");
  const formula = `AND({Communication}='${key}',{Event Type}='${clean(eventType)}',OR({Delivery Status}='Pending',{Delivery Status}='Sent'))`;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "10");
  url.searchParams.append("fields[]", "Communication");
  url.searchParams.append("fields[]", "Delivery Status");
  const body = await airtableJson(url.href, { token: settings.token });
  return body.records || [];
}

async function findAppointmentProposalDeliveries(recordId, options = {}) {
  return findNotificationDeliveries(recordId, "APPOINTMENT OPTIONS", options);
}

async function listApprovedQuoteCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const formula = "AND({Website Workflow}='Quick Quote',{Anna Decision}='Approved',{Quote Sent Date}=BLANK(),{Client Email}!='')";
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "10");
  const body = await airtableJson(url.href, { token: settings.token });
  return body.records || [];
}

async function listNewRequestCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const formula = "AND({Website Workflow}='Order',{Anna Email Status}='Not Sent',{Property Research Complete}=1)";
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "20");
  return (await airtableJson(url.href, { token: settings.token })).records || [];
}

async function listPropertyReviewCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const formula = "AND({Website Workflow}='Quick Quote',{Anna Email Status}='Not Sent',{Property Research Complete}=1,OR({Property Check Status}='No Match',{Property Check Status}='Needs Manual Review'))";
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "20");
  return (await airtableJson(url.href, { token: settings.token })).records || [];
}

async function listNoteTranslationCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const formula = "AND({Website Workflow}='Quick Quote',{Client Notes}!='',{Quote Calculation Notes}='')";
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", String(Math.max(1, Math.min(50, Number(options.maxRecords) || 20))));
  return (await airtableJson(url.href, { token: settings.token })).records || [];
}

async function listFollowUpCandidates(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const maxAgeDays = Number.isFinite(Number(settings.followUpMaxAgeDays))
    ? Math.max(0, Math.floor(Number(settings.followUpMaxAgeDays)))
    : 90;
  const ageGuard = maxAgeDays > 0
    ? `,IS_AFTER({Quote Sent Date},DATEADD(TODAY(),-${maxAgeDays},'days'))`
    : "";
  const formula = `AND({Quote Sent Date}!='',{Follow-Up Date}!='',{Follow-Up Date}<=TODAY(),OR({Client Response}='Awaiting Reply',{Client Response}='No Response',{Client Response}='')${ageGuard})`;
  const table = settings.jobsTableId || settings.jobsTable;
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("maxRecords", "50");
  return (await airtableJson(url.href, { token: settings.token })).records || [];
}

async function createQuoteReadyLog(input, options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "POST",
    body: { records: [{ fields: quoteReadyLogFields(input) }], typecast: false }
  });
}

async function createClientQuoteLog(input, options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "POST",
    body: { records: [{ fields: clientQuoteLogFields(input) }], typecast: false }
  });
}

async function createNotificationLog(input, options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "POST",
    body: { records: [{ fields: notificationLogFields(input) }], typecast: false }
  });
}

async function createInboundCommunicationLog(input, options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const fields = inboundCommunicationLogFields(input);
  const formula = `{Communication}='${clean(fields.Communication).replaceAll("'", "\\'")}'`;
  const lookupUrl = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`);
  lookupUrl.searchParams.set("filterByFormula", formula);
  lookupUrl.searchParams.set("maxRecords", "1");
  const existing = await airtableJson(lookupUrl.href, { token: settings.token });
  if (existing.records && existing.records.length) return { records: existing.records, duplicate: true };
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return { ...(await airtableJson(url, { token: settings.token, method: "POST", body: { records: [{ fields }], typecast: false } })), duplicate: false };
}

async function createAppointmentProposalLog(input, options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "POST",
    body: { records: [{ fields: appointmentProposalLogFields(input) }], typecast: false }
  });
}

async function listFailedDeliveries(options = {}) {
  const settings = { ...config(), ...options };
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  const limit = Math.max(1, Math.min(50, Number(options.maxRecords) || 20));
  const table = encodeURIComponent(settings.communicationLogTable);
  const url = new URL(`${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${table}`);
  url.searchParams.set("filterByFormula", "{Delivery Status}='Failed'");
  url.searchParams.set("maxRecords", String(limit));
  ["Communication", "Job Record ID", "Event Type", "Email Subject", "Delivery Status", "Summary"].forEach((field) => url.searchParams.append("fields[]", field));
  const body = await airtableJson(url.href, { token: settings.token });
  return (body.records || []).map((record) => ({ id: record.id, ...record.fields }));
}

async function updateCommunicationLog(recordId, fields, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Communication Log record ID is required");
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(settings.communicationLogTable)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "PATCH",
    body: { records: [{ id, fields }] }
  });
}

async function updateJob(recordId, fields, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Job record ID is required");
  const table = settings.jobsTableId || settings.jobsTable;
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}`;
  return airtableJson(url, {
    token: settings.token,
    method: "PATCH",
    body: { records: [{ id, fields }] }
  });
}

module.exports = {
  addressParts,
  appointmentProposalLogFields,
  clientQuoteLogFields,
  communicationKey,
  config,
  createClientQuoteLog,
  createAppointmentProposalLog,
  createQuoteReadyLog,
  createNotificationLog,
  createInboundCommunicationLog,
  findClientQuoteDeliveries,
  findAppointmentProposalDeliveries,
  findQuoteReadyDeliveries,
  findNotificationDeliveries,
  getJob,
  getApprovalState,
  listApprovedQuoteCandidates,
  listFollowUpCandidates,
  listJobs,
  listFailedDeliveries,
  listNewRequestCandidates,
  listNoteTranslationCandidates,
  listPropertyReviewCandidates,
  listQuoteReadyCandidates,
  mapJob,
  notificationLogFields,
  inboundCommunicationLogFields,
  quoteReadyLogFields,
  updateCommunicationLog,
  requestAddressParts,
  updateJob
};

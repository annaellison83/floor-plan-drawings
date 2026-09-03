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

function mapJob(record, options = {}) {
  const fields = record && record.fields ? record.fields : {};
  const baseId = clean(options.baseId);
  const tableId = clean(options.tableId);
  const approvalBaseUrl = clean(options.approvalBaseUrl);
  const approvalToken = clean(first(fields, ["Quote Approval Token", "Approval Token"]));

  return {
    recordId: clean(record && record.id),
    propertyAddress: first(fields, ["Property Address", "Address"]),
    clientName: first(fields, ["Client Name", "Name"]),
    clientEmail: first(fields, ["Client Email", "Email"]),
    clientPhone: first(fields, ["Client Phone", "Phone"]),
    service: first(fields, ["Drawing Style", "Service Requested", "Service"]),
    workflow: first(fields, ["Website Workflow", "Workflow", "Request Type"]) || "Quick Quote",
    status: first(fields, ["Status"]),
    quoteZone: first(fields, ["Quote Zone", "Zone"]),
    milesFromNorthHollywood: first(fields, ["Miles From North Hollywood"]),
    milesFromMontereyPark: first(fields, ["Miles From Monterey Park"]),
    verifiedSqFt: first(fields, ["Verified Sq Ft", "Verified Square Feet"]),
    approxSqFt: first(fields, ["Approx Sq Ft", "Approx Square Feet", "Square Footage"]),
    suggestedQuote: first(fields, ["Suggested Quote", "Quote Amount"]),
    quoteNotes: first(fields, ["Quote Calculation Notes", "Quote Notes"]),
    tourRequested: yesNo(first(fields, ["3D Tour Requested", "3D Tour"])),
    mapUrl: first(fields, ["Aerial Map URL", "Aerial URL"]),
    contextMapUrl: first(fields, ["LA Context Map URL", "Context Map URL"]),
    recordUrl: baseId && tableId && record.id
      ? `https://airtable.com/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(record.id)}`
      : "",
    approvalUrl: approvalBaseUrl && approvalToken && record.id
      ? `${approvalBaseUrl}${approvalBaseUrl.includes("?") ? "&" : "?"}recordId=${encodeURIComponent(record.id)}&token=${encodeURIComponent(approvalToken)}`
      : ""
  };
}

function config(env = process.env) {
  return {
    token: clean(env.AIRTABLE_TOKEN),
    baseId: clean(env.AIRTABLE_BASE_ID),
    jobsTable: clean(env.AIRTABLE_JOBS_TABLE) || "Jobs",
    jobsTableId: clean(env.AIRTABLE_JOBS_TABLE_ID),
    communicationLogTable: clean(env.AIRTABLE_COMMUNICATION_LOG_TABLE) || "Communication Log",
    approvalBaseUrl: clean(env.QUOTE_APPROVAL_URL)
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
    approvalBaseUrl: settings.approvalBaseUrl
  });
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
  communicationKey,
  config,
  createQuoteReadyLog,
  findQuoteReadyDeliveries,
  getJob,
  listQuoteReadyCandidates,
  mapJob,
  quoteReadyLogFields,
  updateCommunicationLog,
  updateJob
};

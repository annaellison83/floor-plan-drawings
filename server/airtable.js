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
    workflow: first(fields, ["Workflow", "Request Type"]) || "Quick Quote",
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
    approvalUrl: approvalBaseUrl && approvalToken
      ? `${approvalBaseUrl}${approvalBaseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(approvalToken)}`
      : ""
  };
}

function config(env = process.env) {
  return {
    token: clean(env.AIRTABLE_TOKEN),
    baseId: clean(env.AIRTABLE_BASE_ID),
    jobsTable: clean(env.AIRTABLE_JOBS_TABLE) || "Jobs",
    jobsTableId: clean(env.AIRTABLE_JOBS_TABLE_ID),
    approvalBaseUrl: clean(env.QUOTE_APPROVAL_URL)
  };
}

async function getJob(recordId, options = {}) {
  const settings = { ...config(), ...options };
  const id = clean(recordId);
  if (!settings.token || !settings.baseId) throw new Error("Airtable is not configured");
  if (!id || !/^rec[a-zA-Z0-9]+$/.test(id)) throw new Error("A valid Airtable record ID is required");

  const table = settings.jobsTableId || settings.jobsTable;
  const url = `${AIRTABLE_API}/${encodeURIComponent(settings.baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${settings.token}`, Accept: "application/json" }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && body.error && (body.error.message || body.error.type);
    throw new Error(`Airtable read failed (${response.status})${message ? `: ${message}` : ""}`);
  }

  return mapJob(body, {
    baseId: settings.baseId,
    tableId: settings.jobsTableId || settings.jobsTable,
    approvalBaseUrl: settings.approvalBaseUrl
  });
}

module.exports = { config, getJob, mapJob };

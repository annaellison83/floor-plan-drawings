const AIRTABLE_API_URL = "https://api.airtable.com/v0";
const { researchAddress, buildUpdateFields } = require("./property-research");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
  };
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function cleanEnv(value) {
  return clean(value).replace(/^=\s*/, "").trim();
}

function cleanAirtableToken(value) {
  return cleanEnv(value)
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function compactLines(lines) {
  return lines.filter(Boolean).join("\n");
}

function compactInline(parts) {
  return parts.filter(Boolean).join(" | ");
}

function missingInfo(data, workflow) {
  const missing = [];
  if (!clean(data.name)) missing.push("client name");
  if (!clean(data.email)) missing.push("email");
  if (!clean(data.phone)) missing.push("phone");
  if (!clean(data.approxSqFt)) missing.push("square footage");
  if (!clean(data.buildingType)) missing.push("building type");
  if (!clean(data.planType)) missing.push("plan purpose");
  if (workflow === "Order" && !clean(data.access)) missing.push("access");
  if (workflow === "Order" && !clean(data.appointment)) missing.push("appointment timing");
  return missing;
}

function inferFlags(data) {
  const text = [
    data.address,
    data.addressDetail,
    data.buildingType,
    data.planType,
    data.exteriorInclusions,
    data.notes,
    data.access
  ].map(clean).join(" ").toLowerCase();

  const flags = [];
  if (/\b(duplex|triplex|fourplex|apartment|apartments|multi[-\s]?unit|multifamily|multi family)\b/.test(text)) {
    flags.push("multi-unit/apartment building");
  }
  if (/\b(commercial|retail|office|warehouse|tenant|suite)\b/.test(text)) {
    flags.push("commercial or suite/tenant space");
  }
  if (/\b(upstairs|downstairs|rear|front|back house|guest house|adu|main house|unit|suite|floor|level|partial)\b/.test(text)) {
    flags.push("scope may be partial or sub-address specific");
  }
  if (/\b(tic|tenancy|condo|hoa|legal|attorney|estate|probate)\b/.test(text)) {
    flags.push("may need special-use/legal-style plan");
  }
  if (/\b(asap|urgent|today|tomorrow|rush|this week|photo|photos|listing|mls|marketing)\b/.test(text)) {
    flags.push("marketing/timing-sensitive");
  }
  return flags;
}

function airtableComplexityFlags(data) {
  const flags = inferFlags(data);
  const mapped = [];

  flags.forEach((flag) => {
    if (/multi-unit|apartment/i.test(flag)) {
      mapped.push("Multi-unit", "Apartment building");
    }
    if (/commercial|suite|tenant/i.test(flag)) {
      mapped.push("Commercial or suite/tenant space");
    }
    if (/partial|sub-address/i.test(flag)) {
      mapped.push("Partial scope/sub-address", "Scope unclear");
    }
    if (/special-use|legal/i.test(flag)) {
      mapped.push("Scope unclear");
    }
    if (/marketing|timing/i.test(flag)) {
      mapped.push("Marketing/timing-sensitive");
    }
  });

  return [...new Set(mapped)];
}

function buildAiSummary(data, workflow, status) {
  const missing = missingInfo(data, workflow);
  const flags = inferFlags(data);
  const contact = compactInline([
    clean(data.name) && `Name: ${clean(data.name)}`,
    clean(data.email) && `Email: ${clean(data.email)}`,
    clean(data.phone) && `Phone: ${clean(data.phone)}`,
    clean(data.role) && `Role: ${clean(data.role)}`
  ]);

  return compactLines([
    `${workflow} from website - ${status}`,
    contact && `Contact: ${contact}`,
    clean(data.addressDetail) && `Unit / suite / scope detail: ${clean(data.addressDetail)}`,
    clean(data.notes) && `Client note: ${clean(data.notes)}`,
    clean(data.drawingStyleLabel || data.drawingStyle) && `Requested drawing: ${clean(data.drawingStyleLabel || data.drawingStyle)}`,
    clean(data.tour3d) && `3D tour: ${clean(data.tour3d)}`,
    clean(data.exteriorInclusions) && `Exterior/site notes: ${clean(data.exteriorInclusions)}`,
    clean(data.appointment) && `Timing: ${clean(data.appointment)}`,
    clean(data.access) && `Access: ${clean(data.access)}`,
    clean(data.parking) && `Parking: ${clean(data.parking)}`,
    flags.length && `Possible flags: ${flags.join(", ")}`,
    missing.length && `Missing info: ${missing.join(", ")}`
  ]);
}

function summarizePayload(data, workflow, status) {
  return {
    workflow,
    status,
    address: clean(data.address),
    addressDetail: clean(data.addressDetail),
    city: clean(data.city),
    googlePlaceId: clean(data.googlePlaceId),
    mapQuery: clean(data.mapQuery),
    approxSqFt: clean(data.approxSqFt),
    buildingType: clean(data.buildingType),
    planType: clean(data.planType),
    drawingStyle: clean(data.drawingStyleLabel || data.drawingStyle),
    tour3d: clean(data.tour3d),
    appointment: clean(data.appointment),
    access: clean(data.access),
    parking: clean(data.parking),
    dayOfContact: clean(data.dayOfContact),
    client: {
      name: clean(data.name),
      email: clean(data.email),
      phone: clean(data.phone),
      role: clean(data.role)
    },
    notes: clean(data.notes),
    submittedAt: clean(data.submittedAt) || new Date().toISOString()
  };
}

function buildAirtableFields(data) {
  const request = clean(data.request);
  const workflow = clean(data.workflow) || (/order/i.test(request) ? "Order" : "Quick Quote");
  const status = clean(data.status) || (workflow === "Order" ? "Needs Scheduling" : "Needs Quote");
  const address = clean(data.address);
  const addressDetail = clean(data.addressDetail);
  const city = clean(data.city);
  const summary = summarizePayload(data, workflow, status);
  const aiSummary = buildAiSummary(data, workflow, status);
  const missing = missingInfo(data, workflow);
  const complexityFlags = airtableComplexityFlags(data);

  const fields = {
    "Job ID": `WEB-${Date.now()}`,
    Status: status,
    "Website Workflow": workflow,
    "Request Type": request,
    "Client Name": clean(data.name) || clean(data.email) || clean(data.phone) || "Website Lead",
    "Client Phone": clean(data.phone),
    "Client Email": clean(data.email),
    "Property Address": city ? `${address}, ${city}` : address,
    City: city,
    State: city || address ? "CA" : "",
    "Approx Sq Ft": clean(data.approxSqFt),
    "Property Type": clean(data.buildingType),
    Purpose: clean(data.planType),
    "Drawing Style": clean(data.drawingStyleLabel || data.drawingStyle),
    "3D Tour Requested": clean(data.tour3d),
    "Google Place ID": clean(data.googlePlaceId),
    "Map Query": clean(data.mapQuery),
    Scope: compactLines([
      addressDetail && `Unit / suite / scope detail: ${addressDetail}`,
      clean(data.drawingStyleLabel || data.drawingStyle) && `Plan: ${clean(data.drawingStyleLabel || data.drawingStyle)}`,
      clean(data.tour3d) && `3D tour: ${clean(data.tour3d)}`,
      clean(data.exteriorInclusions) && `Exterior: ${clean(data.exteriorInclusions)}`,
      clean(data.appointment) && `Appointment preference: ${clean(data.appointment)}`,
      clean(data.notes) && `Client note: ${clean(data.notes)}`
    ]),
    "Access Info": compactLines([
      clean(data.access),
      clean(data.parking) && `Parking: ${clean(data.parking)}`,
      clean(data.dayOfContact) && `Day-of contact: ${clean(data.dayOfContact)}`
    ]),
    "AI Summary": aiSummary,
    "Missing Info": missing.join(", "),
    "Complexity Flags": complexityFlags,
    "Client Notes": clean(data.notes),
    "Unit / Suite / Scope Detail": addressDetail,
    "Original Request": JSON.stringify(summary, null, 2),
    "Property Check Status": "Not Checked",
    "LA City Match Status": "Not Checked",
    "Anna Email Status": "Not Sent",
    ...(workflow === "Quick Quote" ? { "Quote Review": "Not Started" } : {}),
    "Access Status": workflow === "Order" ? "Requested" : "Not Requested",
    "Drawing Status": "Not Started",
    "Invoice Status": "Not Invoiced",
    "Payment Status": "Unpaid",
    "Internal Notes": compactLines([
      `Source: Website ${workflow}`,
      clean(data.notes) && `Client notes: ${clean(data.notes)}`
    ])
  };

  return fields;
}

async function maybeNotify(url, payload) {
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn("Notification webhook failed", error);
  }
}

function unknownFieldName(errorBody) {
  const message = errorBody && errorBody.error && errorBody.error.message;
  if (!message) return "";

  const match = String(message).match(/Unknown field name: "([^"]+)"/);
  return match ? match[1] : "";
}

async function createAirtableRecord(airtableUrl, token, fields) {
  const remainingFields = { ...fields };
  const omittedFields = [];

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const airtableResponse = await fetch(airtableUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: remainingFields, typecast: true })
    });

    const airtableBody = await airtableResponse.json().catch(() => ({}));

    if (airtableResponse.ok) {
      return { airtableBody, omittedFields };
    }

    const fieldName = unknownFieldName(airtableBody);
    if (!fieldName || !(fieldName in remainingFields)) {
      return { airtableBody, omittedFields, error: true };
    }

    omittedFields.push(fieldName);
    delete remainingFields[fieldName];
  }

  return {
    error: true,
    omittedFields,
    airtableBody: {
      error: {
        type: "FIELD_RETRY_LIMIT",
        message: "Too many Airtable fields were missing from the target table."
      }
    }
  };
}

async function updateAirtableRecord(recordUrl, token, fields) {
  const response = await fetch(recordUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields, typecast: true })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body.error && body.error.message) || `Airtable update failed with status ${response.status}`);
  }
  return body;
}

async function enrichCreatedRecord(recordUrl, token, fields, workflow) {
  try {
    const research = await researchAddress(fields["Property Address"]);
    const researchFields = buildUpdateFields(research, fields);
    const finalFields = {
      ...researchFields,
      "Property Research Complete": true,
      "Anna Email Status": "Not Sent"
    };

    if (workflow === "Quick Quote" && research.ok) {
      finalFields["Quote Review"] = "Ready for Anna";
    }

    await updateAirtableRecord(recordUrl, token, finalFields);
    return { ok: true, research };
  } catch (error) {
    console.error("Property research during intake failed", error.message);

    const fallbackFields = {
      "Property Check Status": "Needs Manual Review",
      "LA City Match Status": "Needs Manual Review",
      "Property Research Complete": true,
      "Anna Email Status": "Not Sent",
      "Quote Calculation Notes": `[Property research ${new Date().toISOString()}] Research service failed; manual property review is required before relying on property data.`
    };

    try {
      await updateAirtableRecord(recordUrl, token, fallbackFields);
    } catch (updateError) {
      console.error("Property research fallback update failed", updateError.message);
    }

    return { ok: false, error: error.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const token = cleanAirtableToken(process.env.AIRTABLE_TOKEN);
  const baseId = cleanEnv(process.env.AIRTABLE_BASE_ID);
  const tableName = cleanEnv(process.env.AIRTABLE_JOBS_TABLE) || "Jobs";

  if (!token || !baseId) {
    return json(500, {
      ok: false,
      error: "Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID"
    });
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const fields = buildAirtableFields(data);

  if (!fields["Property Address"]) {
    return json(400, { ok: false, error: "Property address is required" });
  }

  const airtableUrl = `${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableName)}`;
  const { airtableBody, omittedFields, error } = await createAirtableRecord(airtableUrl, token, fields);

  if (error) {
    return json(502, {
      ok: false,
      error: "Airtable create failed",
      detail: airtableBody
    });
  }

  const recordUrl = `${airtableUrl}/${encodeURIComponent(airtableBody.id)}`;
  const enrichment = await enrichCreatedRecord(
    recordUrl,
    token,
    fields,
    clean(fields["Website Workflow"])
  );

  await maybeNotify(process.env.NOTIFY_WEBHOOK_URL, {
    text: `New ${data.workflow || data.request || "website request"}: ${fields["Property Address"]}`,
    recordId: airtableBody.id,
    status: fields.Status,
    fields
  });

  return json(200, {
    ok: true,
    id: airtableBody.id,
    status: fields.Status,
    address: fields["Property Address"],
    omittedFields,
    propertyResearch: enrichment.ok ? enrichment.research.status : "Needs Manual Review"
  });
};

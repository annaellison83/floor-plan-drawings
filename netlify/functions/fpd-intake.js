const AIRTABLE_API_URL = "https://api.airtable.com/v0";

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

function summarizePayload(data, workflow, status) {
  return {
    workflow,
    status,
    address: clean(data.address),
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
  const city = clean(data.city);
  const summary = summarizePayload(data, workflow, status);

  return {
    "Job ID": `WEB-${Date.now()}`,
    Status: status,
    "Client Name": clean(data.name),
    "Client Phone": clean(data.phone),
    "Client Email": clean(data.email),
    "Property Address": city ? `${address}, ${city}` : address,
    City: city,
    "Approx Sq Ft": clean(data.approxSqFt),
    "Property Type": clean(data.buildingType),
    Purpose: clean(data.planType),
    Scope: compactLines([
      clean(data.drawingStyleLabel || data.drawingStyle) && `Plan: ${clean(data.drawingStyleLabel || data.drawingStyle)}`,
      clean(data.tour3d) && `3D tour: ${clean(data.tour3d)}`,
      clean(data.exteriorInclusions) && `Exterior: ${clean(data.exteriorInclusions)}`,
      clean(data.appointment) && `Appointment preference: ${clean(data.appointment)}`
    ]),
    "Access Info": compactLines([
      clean(data.access),
      clean(data.parking) && `Parking: ${clean(data.parking)}`,
      clean(data.dayOfContact) && `Day-of contact: ${clean(data.dayOfContact)}`
    ]),
    "Original Request": JSON.stringify(summary, null, 2),
    "Internal Notes": compactLines([
      `Source: Website ${workflow}`,
      clean(data.notes) && `Client notes: ${clean(data.notes)}`
    ])
  };
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

  for (let attempt = 0; attempt < 12; attempt += 1) {
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
    omittedFields
  });
};

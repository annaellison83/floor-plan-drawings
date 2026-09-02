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

function parseSquareFeet(value) {
  const match = clean(value).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Math.round(Number(match[0]));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
    "Approx Sq Ft": parseSquareFeet(data.approxSqFt),
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

async function fetchPricingRows(baseId, token, tableName) {
  const rows = [];
  let offset = "";
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (offset) params.set("offset", offset);
    const response = await fetch(`${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableName)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((body.error && body.error.message) || `Pricing lookup failed with status ${response.status}`);
    }
    rows.push(...(body.records || []).map((record) => record.fields || {}));
    offset = body.offset || "";
  } while (offset);
  return rows;
}

function quoteStyle(value) {
  const style = clean(value).toLowerCase();
  if (/matterport|3d|tour/.test(style)) return "matterport";
  if (/color.*exterior|exterior.*color|colorext/.test(style)) return "colorExterior";
  if (/color/.test(style)) return "colorInterior";
  if (/b\s*[&+]?\s*w|black|white|line/.test(style)) return "bw";
  return "";
}

function isComplexProperty(fields) {
  const text = [
    fields["Property Type"],
    fields["Unit / Suite / Scope Detail"],
    fields.Scope,
    fields["Complexity Flags"]
  ].map((item) => Array.isArray(item)
    ? item.map((entry) => entry && entry.name ? entry.name : clean(entry)).join(" ")
    : clean(item)).join(" ");
  return /\b(duplex|triplex|fourplex|apartment|multi[-\s]?unit|multifamily|commercial|suite|tenant|partial|adu|guest house|unit)\b/i.test(text);
}

function calculateSuggestedQuote(fields, research, pricingRows) {
  const assessor = research && research.countyAssessor;
  const verifiedSqFt = assessor && assessor.buildingSqFt ? Number(assessor.buildingSqFt) : null;
  const style = quoteStyle(fields["Drawing Style"]);
  const tourRequested = /^(yes|true|requested|add|included)$/i.test(clean(fields["3D Tour Requested"]));
  const notes = [];

  if (!verifiedSqFt) {
    return {
      fields: {
        "Quote Review": "Ready for Anna",
        "Quote Calculation Notes": "No online building square footage was found in the LA County assessor record; do not use lot size as building size. Anna should verify the size before quoting."
      },
      note: "No online building square footage found"
    };
  }

  const rows = (pricingRows || [])
    .map((row) => ({
      maxSqFt: parseSquareFeet(row["Max Sq Ft"]),
      bw: parseMoney(row["B&W Base"]),
      colorInterior: parseMoney(row["Condo Color Interior Base"]),
      colorExterior: parseMoney(row["Color + Exterior Starting At"]),
      matterport: parseMoney(row["Matterport Base"]),
      bundle: parseMoney(row["Bundle Base"]),
      sizeBand: clean(row["Size Band"]),
      exteriorRange: clean(row["Color + Exterior Range"])
    }))
    .filter((row) => row.maxSqFt && row.maxSqFt > 0)
    .sort((a, b) => a.maxSqFt - b.maxSqFt);
  const row = rows.find((candidate) => verifiedSqFt <= candidate.maxSqFt);

  if (!row || !style) {
    return {
      fields: {
        "Quote Review": "Ready for Anna",
        "Quote Calculation Notes": !row
          ? `${verifiedSqFt.toLocaleString()} sq ft is outside the configured pricing table; Anna should quote manually.`
          : "The requested drawing service does not match a configured pricing rule; Anna should quote manually."
      },
      note: !row ? "Size outside pricing table" : "Service needs manual pricing"
    };
  }

  let base = null;
  let serviceLabel = "";
  if (style === "bw") {
    base = Number.isFinite(row.bw) ? row.bw : null;
    serviceLabel = "B&W interior";
  } else if (style === "colorInterior") {
    base = Number.isFinite(row.colorInterior) ? row.colorInterior : null;
    serviceLabel = "Color interior";
    if (!/condo/i.test(clean(fields["Property Type"]))) {
      notes.push("Color interior uses the condo rate; review for non-condo property");
    }
  } else if (style === "colorExterior") {
    base = Number.isFinite(row.colorExterior) ? row.colorExterior : null;
    serviceLabel = "Color interior + exterior";
    row.exteriorRange && notes.push(`Published range: ${row.exteriorRange}`);
  } else if (style === "matterport") {
    base = Number.isFinite(row.matterport) ? row.matterport : null;
    serviceLabel = "Matterport";
  }

  if (base === null) {
    return {
      fields: {
        "Quote Review": "Ready for Anna",
        "Quote Calculation Notes": `No configured ${serviceLabel || "service"} price exists for the ${row.sizeBand || "selected"} size band.`
      },
      note: "Service price missing"
    };
  }

  let suggested = base;
  if (tourRequested && style !== "matterport") {
    if (Number.isFinite(row.matterport)) {
      suggested += row.matterport;
      notes.push(`Matterport add-on included because 3D Tour Requested is ${clean(fields["3D Tour Requested"])}: $${row.matterport}`);
    } else {
      notes.push("3D tour requested but no Matterport price is configured for this size band");
    }
  }
  const complex = isComplexProperty(fields);
  if (complex) notes.push("Multi-unit/commercial/partial-scope adjustment is pending Anna's fee rule");
  notes.push("Travel zone and fee are pending Anna's zone chart");

  return {
    fields: {
      "Suggested Quote": suggested,
      "Quote Calculation Notes": [
        `Online size: ${verifiedSqFt.toLocaleString()} sq ft`,
        `Pricing row: ${row.sizeBand || `up to ${row.maxSqFt.toLocaleString()} sq ft`}`,
        `Base service: ${serviceLabel} ($${base})`,
        ...notes
      ].join("\n"),
      "Quote Review": "Ready for Anna"
    },
    note: `Suggested base: $${suggested}`
  };
}

async function enrichCreatedRecord(recordUrl, token, fields, workflow, baseId, pricingTable) {
  try {
    const research = await researchAddress(fields["Property Address"], {
      mapQuery: fields["Map Query"]
    });
    const researchFields = buildUpdateFields(research, fields);
    let quoteFields = {};
    try {
      const pricingRows = await fetchPricingRows(baseId, token, pricingTable);
      quoteFields = calculateSuggestedQuote({ ...fields, ...researchFields }, research, pricingRows).fields;
    } catch (pricingError) {
      console.error("Quote pricing lookup failed", pricingError.message);
      quoteFields = {
        "Quote Review": "Ready for Anna",
        "Quote Calculation Notes": `Pricing lookup failed; Anna should quote manually. (${pricingError.message})`
      };
    }
    const finalFields = {
      ...researchFields,
      ...quoteFields,
      "Property Research Complete": true,
      "Anna Email Status": "Not Sent"
    };

    if (workflow === "Quick Quote" && research.ok && !finalFields["Quote Review"]) {
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
  const pricingTable = cleanEnv(process.env.AIRTABLE_PRICING_TABLE) || "Quote Pricing";

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
    clean(fields["Website Workflow"]),
    baseId,
    pricingTable
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

exports.calculateSuggestedQuote = calculateSuggestedQuote;

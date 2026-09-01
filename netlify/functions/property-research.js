const AIRTABLE_API_URL = "https://api.airtable.com/v0";
const CAMS_QUERY_URL = "https://arcgis.gis.lacounty.gov/arcgis/rest/services/LACounty_Dynamic/CAMS/MapServer/1/query";
const AERIAL_EXPORT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export";
const NORTH_HOLLYWOOD = { lat: 34.187, lon: -118.3813 };
const MONTEREY_PARK = { lat: 34.0625, lon: -118.1228 };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Property-Research-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  return clean(value).replace(/^=\s*/, "").replace(/^['"]|['"]$/g, "").trim();
}

function cleanToken(value) {
  return cleanEnv(value).replace(/^Bearer\s+/i, "").trim();
}

function escapeArcgisLiteral(value) {
  return clean(value).replace(/'/g, "''");
}

function parseAddress(address) {
  const normalized = clean(address).replace(/\s+/g, " ");
  const numberMatch = normalized.match(/^\s*(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)/);
  if (!numberMatch) return { normalized, number: "", streetWords: [] };

  const remainder = normalized.slice(numberMatch[0].length).replace(/^[,\s]+/, "");
  const streetPart = remainder.split(",")[0];
  const allStreetWords = streetPart
    .replace(/\b(unit|apt|apartment|suite|ste|#|floor|fl)\b.*$/i, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9'-]/g, ""))
    .filter(Boolean)
    .slice(0, 6);
  const roadTypeIndex = allStreetWords.findIndex((word) => /^(alley|avenue|ave|boulevard|blvd|circle|court|ct|drive|dr|highway|hwy|lane|ln|parkway|pkwy|place|pl|road|rd|street|st|terrace|ter|trail|trl|way|wy)$/i.test(word));
  const streetWords = (roadTypeIndex > 0 ? allStreetWords.slice(0, roadTypeIndex) : allStreetWords)
    .slice(0, 4);

  return {
    normalized,
    number: numberMatch[1],
    streetWords
  };
}

function buildCamsQueryUrl(address) {
  const parsed = parseAddress(address);
  const needle = [parsed.number, ...parsed.streetWords.slice(0, 3)].filter(Boolean).join(" ");
  if (!parsed.number || !parsed.streetWords.length) return "";

  const params = new URLSearchParams({
    where: `FullAddress LIKE '%${escapeArcgisLiteral(needle)}%'`,
    outFields: "AIN,Number,StreetName,FullName,FullAddress,LegalComm,PostComm1,PostComm2,PostComm3,ZipCode",
    returnGeometry: "true",
    outSR: "3857",
    resultRecordCount: "25",
    f: "json"
  });

  return `${CAMS_QUERY_URL}?${params.toString()}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && body.error && body.error.message;
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return body;
}

function webMercatorToLatLon(x, y) {
  const radius = 6378137;
  return {
    lat: (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * (180 / Math.PI),
    lon: (x / radius) * (180 / Math.PI)
  };
}

function milesBetween(first, second) {
  const radiusMiles = 3958.7613;
  const lat1 = first.lat * Math.PI / 180;
  const lat2 = second.lat * Math.PI / 180;
  const deltaLat = (second.lat - first.lat) * Math.PI / 180;
  const deltaLon = (second.lon - first.lon) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return radiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundMiles(value) {
  return Math.round(value * 10) / 10;
}

function buildAerialUrl(x, y) {
  const bbox = [x - 250, y - 180, x + 250, y + 180].join(",");
  const params = new URLSearchParams({
    bbox,
    bboxSR: "3857",
    imageSR: "3857",
    size: "900,650",
    format: "jpg",
    transparent: "false",
    dpi: "96",
    f: "image"
  });
  return `${AERIAL_EXPORT_URL}?${params.toString()}`;
}

function uniqueCandidates(features) {
  const byKey = new Map();
  (features || []).forEach((feature) => {
    const attributes = feature && feature.attributes ? feature.attributes : {};
    const geometry = feature && feature.geometry ? feature.geometry : {};
    const key = clean(attributes.AIN) || clean(attributes.FullAddress);
    if (key && !byKey.has(key)) {
      byKey.set(key, { attributes, geometry });
    }
  });
  return [...byKey.values()];
}

function getArea(attributes) {
  return [
    attributes.LegalComm,
    attributes.PostComm1,
    attributes.PostComm2,
    attributes.PostComm3
  ].map(clean).find(Boolean) || "";
}

function addFlags(existing, additions) {
  const flags = Array.isArray(existing)
    ? existing.map((item) => (item && item.name ? item.name : clean(item))).filter(Boolean)
    : [];
  return [...new Set([...flags, ...additions])];
}

async function researchAddress(address) {
  const queryUrl = buildCamsQueryUrl(address);
  if (!queryUrl) {
    return {
      ok: false,
      status: "Needs Manual Review",
      reason: "Could not separate a street number and street name from the address.",
      address: clean(address),
      candidates: []
    };
  }

  const result = await fetchJson(queryUrl);
  const candidates = uniqueCandidates(result.features);

  if (candidates.length === 0) {
    return {
      ok: false,
      status: "No Match",
      reason: "No single LA County address point matched the street number and street name.",
      address: clean(address),
      sourceUrl: queryUrl,
      candidates: []
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      status: "Needs Manual Review",
      reason: `More than one address point matched (${candidates.length}).`,
      address: clean(address),
      sourceUrl: queryUrl,
      candidates: candidates.map(({ attributes }) => ({
        ain: clean(attributes.AIN),
        fullAddress: clean(attributes.FullAddress)
      }))
    };
  }

  const candidate = candidates[0];
  const attributes = candidate.attributes;
  const x = Number(candidate.geometry.x);
  const y = Number(candidate.geometry.y);
  const location = Number.isFinite(x) && Number.isFinite(y)
    ? webMercatorToLatLon(x, y)
    : null;
  const area = getArea(attributes);
  const insideLaCity = /\blos angeles\b/i.test(area);

  return {
    ok: true,
    status: "Possible Match",
    address: clean(address),
    sourceUrl: queryUrl,
    candidate: {
      ain: clean(attributes.AIN),
      fullAddress: clean(attributes.FullAddress),
      area,
      zip: clean(attributes.ZipCode),
      location,
      aerialUrl: location ? buildAerialUrl(x, y) : ""
    },
    milesFromNorthHollywood: location ? roundMiles(milesBetween(location, NORTH_HOLLYWOOD)) : null,
    milesFromMontereyPark: location ? roundMiles(milesBetween(location, MONTEREY_PARK)) : null,
    laCityMatch: insideLaCity ? "Matched" : "Needs Manual Review"
  };
}

function researchNote(research) {
  const timestamp = new Date().toISOString();
  if (!research.ok) {
    return `[Property research ${timestamp}] ${research.status}: ${research.reason}`;
  }

  const candidate = research.candidate;
  return [
    `[Property research ${timestamp}] Possible public GIS match: ${candidate.fullAddress || research.address}`,
    candidate.ain && `AIN/APN candidate: ${candidate.ain}`,
    candidate.area && `LA area: ${candidate.area}`,
    research.milesFromNorthHollywood !== null && `Approx. miles from North Hollywood: ${research.milesFromNorthHollywood}`,
    research.milesFromMontereyPark !== null && `Approx. miles from Monterey Park: ${research.milesFromMontereyPark}`,
    "This is an address-point match, not a final parcel or unit confirmation. Review duplexes, apartments, suites, and unusual sub-addresses manually."
  ].filter(Boolean).join("\n");
}

function buildUpdateFields(research, existingFields) {
  const note = researchNote(research);
  const currentNotes = clean(existingFields["Quote Calculation Notes"]);
  const baseFields = {
    "Property Check Status": research.status,
    "Property Data Source URL": research.sourceUrl || "",
    "Quote Calculation Notes": [currentNotes, note].filter(Boolean).join("\n\n")
  };

  if (!research.ok) {
    return {
      ...baseFields,
      "LA City Match Status": research.status === "No Match" ? "No Match" : "Needs Manual Review",
      "Complexity Flags": addFlags(existingFields["Complexity Flags"], ["Needs manual property check", "Address unclear"])
    };
  }

  const candidate = research.candidate;
  return {
    ...baseFields,
    APN: candidate.ain,
    "Neighborhood / LA Area": candidate.area,
    "Miles From North Hollywood": research.milesFromNorthHollywood,
    "Miles From Monterey Park": research.milesFromMontereyPark,
    "Aerial Map URL": candidate.aerialUrl,
    "LA City Match Status": research.laCityMatch,
    "Complexity Flags": addFlags(existingFields["Complexity Flags"], [])
  };
}

async function getAirtableRecord(baseId, tableName, recordId, token) {
  const url = `${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`;
  return fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function updateAirtableRecord(baseId, tableName, recordId, token, fields) {
  const url = `${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`;
  return fetchJson(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields, typecast: true })
  });
}

function header(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? clean(headers[key]) : "";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (!["GET", "POST"].includes(event.httpMethod)) {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  let input = {};
  if (event.httpMethod === "GET") {
    input = event.queryStringParameters || {};
  } else {
    try {
      input = JSON.parse(event.body || "{}");
    } catch (error) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }
  }

  const baseId = cleanEnv(process.env.AIRTABLE_BASE_ID);
  const tableName = cleanEnv(process.env.AIRTABLE_JOBS_TABLE) || "Jobs";
  const token = cleanToken(process.env.AIRTABLE_TOKEN);
  const recordId = clean(input.recordId);
  const address = clean(input.address || input.propertyAddress || input.mapQuery);

  if (!recordId && !address) {
    return json(400, { ok: false, error: "Provide an address or Airtable recordId" });
  }

  if (recordId) {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Record updates require POST" });
    }

    const configuredKey = cleanEnv(process.env.PROPERTY_RESEARCH_KEY);
    if (!configuredKey) {
      return json(503, {
        ok: false,
        error: "PROPERTY_RESEARCH_KEY is not configured; read-only address preview is available"
      });
    }
    if (header(event, "X-Property-Research-Key") !== configuredKey) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    if (!baseId || !token) {
      return json(500, { ok: false, error: "Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID" });
    }

    try {
      const record = await getAirtableRecord(baseId, tableName, recordId, token);
      const recordAddress = clean(record.fields && (record.fields["Property Address"] || record.fields["Map Query"]));
      if (!recordAddress) {
        return json(400, { ok: false, error: "The Airtable record has no property address" });
      }

      const research = await researchAddress(recordAddress);
      const updated = await updateAirtableRecord(
        baseId,
        tableName,
        recordId,
        token,
        buildUpdateFields(research, record.fields || {})
      );

      return json(200, {
        ok: true,
        recordId: updated.id || recordId,
        research
      });
    } catch (error) {
      console.error("Property research update failed", error.message);
      return json(502, { ok: false, error: "Property research update failed" });
    }
  }

  try {
    const research = await researchAddress(address);
    return json(200, { ok: true, research });
  } catch (error) {
    console.error("Property research preview failed", error.message);
    return json(502, { ok: false, error: "Property research preview failed" });
  }
};

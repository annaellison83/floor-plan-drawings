const AIRTABLE_API_URL = "https://api.airtable.com/v0";
const { resolveQuoteZone } = require("../../server/quote-zone");
const CAMS_QUERY_URL = "https://arcgis.gis.lacounty.gov/arcgis/rest/services/LACounty_Dynamic/CAMS/MapServer/1/query";
const AERIAL_EXPORT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export";
const GOOGLE_STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const COUNTY_PRINT_URL = "https://utility.arcgisonline.com/arcgis/rest/services/Utilities/PrintingTools/GPServer/Export%20Web%20Map%20Task/execute";
const COUNTY_AERIAL_TEMPLATE_URL = "https://svc.pictometry.com/Image/BCC27E3E-766E-CE0B-7D11-AA4760AC43ED/wmts/PICT-LARIAC7--KCrSFBeqgG/default/GoogleMapsCompatible/{level}/{col}/{row}.png";
const COUNTY_LABEL_STYLE_URL = "https://www.arcgis.com/sharing/rest/content/items/ba9c22e4e587428988481824d4e61a2e/resources/styles/root.json";
const ZIMAS_LANDBASE_QUERY_URL = "https://zimas.lacity.org/arcgis/rest/services/zma/zimas/MapServer/105/query";
const ZIMAS_ZONING_QUERY_URL = "https://zimas.lacity.org/arcgis/rest/services/zma/zimas/MapServer/1102/query";
const COUNTY_PARCEL_QUERY_URL = "https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/GISNET_Public/MapServer/333/query";
const COUNTY_ASSESSOR_PORTAL_URL = "https://portal.assessor.lacounty.gov/parceldetail";
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
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
  const wordsThroughRoadType = roadTypeIndex > 0
    ? roadTypeIndex + 1
    : allStreetWords.length;
  // Keep numbered road names such as "W Ave 42" together; dropping the number
  // makes the county lookup match many unrelated address points.
  const numberedRoadSuffix = roadTypeIndex >= 0 && /\d/.test(allStreetWords[roadTypeIndex + 1] || "") ? 1 : 0;
  const streetWords = allStreetWords
    .slice(0, Math.min(allStreetWords.length, wordsThroughRoadType + numberedRoadSuffix))
    .slice(0, 5);

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

async function fetchJson(url, options = {}) {
  const requestOptions = { ...options };
  if (!requestOptions.signal && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    requestOptions.signal = AbortSignal.timeout(8000);
  }

  const response = await fetch(url, requestOptions);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && body.error && body.error.message;
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return body;
}

async function lookupNominatim(address) {
  const query = clean(address);
  if (!query) return null;

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: "1",
    countrycodes: "us"
  });
  const sourceUrl = `${NOMINATIM_SEARCH_URL}?${params.toString()}`;
  const results = await fetchJson(sourceUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "FloorPlanDrawings property research (https://floorplandrawings.com)"
    }
  });
  const result = Array.isArray(results) ? results[0] : null;
  const lat = Number(result && result.lat);
  const lon = Number(result && result.lon);
  if (!result || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const addressParts = result.address || {};
  return {
    sourceUrl,
    location: { lat, lon },
    fullAddress: clean(result.display_name),
    area: clean(addressParts.suburb || addressParts.neighbourhood || addressParts.city_district || addressParts.city),
    zip: clean(addressParts.postcode),
    type: clean(result.type)
  };
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

function buildMarkedAerialUrl(location) {
  const key = cleanEnv(process.env.GOOGLE_MAPS_STATIC_KEY);
  if (!key || !location) return "";

  const point = `${location.lat},${location.lon}`;
  const params = new URLSearchParams({
    center: point,
    zoom: "19",
    size: "900x650",
    scale: "2",
    maptype: "satellite",
    markers: `color:red|label:P|${point}`,
    key
  });
  return `${GOOGLE_STATIC_MAP_URL}?${params.toString()}`;
}

function buildContextMapUrl(location) {
  const key = cleanEnv(process.env.GOOGLE_MAPS_STATIC_KEY);
  if (!key || !location) return "";

  const point = `${location.lat},${location.lon}`;
  const params = new URLSearchParams({
    center: point,
    zoom: "10",
    size: "640x420",
    scale: "2",
    maptype: "roadmap",
    markers: `color:red|label:P|${point}`,
    key
  });
  params.append("style", "feature:all|saturation:-85|lightness:5");
  params.append("style", "feature:poi|visibility:off");
  params.append("style", "feature:transit|visibility:off");
  return `${GOOGLE_STATIC_MAP_URL}?${params.toString()}`;
}

function webMercatorFromLatLon(location) {
  const radius = 6378137;
  return {
    x: location.lon * Math.PI / 180 * radius,
    y: Math.log(Math.tan(Math.PI / 4 + location.lat * Math.PI / 360)) * radius
  };
}

function countyTileInfo() {
  const origin = -20037508.34278925;
  const baseResolution = 156543.03392804097;
  return {
    dpi: 96,
    rows: 256,
    cols: 256,
    origin: {
      x: origin,
      y: -origin,
      spatialReference: { wkid: 102100 }
    },
    spatialReference: { wkid: 102100 },
    lods: Array.from({ length: 31 }, (_, level) => ({
      level,
      resolution: baseResolution / (2 ** level),
      scale: 591658710.9091312 / (2 ** level)
    }))
  };
}

async function buildCountyAerialUrl(location) {
  if (!location) return "";

  const point = webMercatorFromLatLon(location);
  // A tight crop keeps the requested building and nearby address labels legible.
  const halfWidth = 75;
  const halfHeight = 50;
  const webMap = {
    mapOptions: {
      extent: {
        xmin: point.x - halfWidth,
        ymin: point.y - halfHeight,
        xmax: point.x + halfWidth,
        ymax: point.y + halfHeight,
        spatialReference: { wkid: 102100 }
      }
    },
    exportOptions: {
      dpi: 96,
      outputSize: [1200, 800]
    },
    operationalLayers: [{
      id: "property-marker",
      title: "Requested property",
      featureCollection: {
        layers: [{
          layerDefinition: {
            name: "Requested property",
            geometryType: "esriGeometryPoint",
            drawingInfo: {
              renderer: {
                type: "simple",
                symbol: {
                  type: "esriSMS",
                  style: "esriSMSCircle",
                  color: [214, 40, 40, 230],
                  size: 18,
                  outline: { color: [255, 255, 255, 255], width: 3 }
                }
              }
            }
          },
          featureSet: {
            geometryType: "esriGeometryPoint",
            features: [{
              geometry: {
                x: point.x,
                y: point.y,
                spatialReference: { wkid: 102100 }
              },
              attributes: {}
            }]
          }
        }]
      }
    }],
    baseMap: {
      title: "LA County Aerial 2023 (Labels)",
      baseMapLayers: [
        {
          id: "county-aerial-2023",
          title: "LARIAC7-02 (2023 AccuPlus Winter Countywide RGB Ortho)",
          type: "WebTiledLayer",
          layerType: "WebTiledLayer",
          templateURL: COUNTY_AERIAL_TEMPLATE_URL,
          tileInfo: countyTileInfo(),
          visibility: true,
          opacity: 1
        },
        {
          id: "county-aerial-labels",
          title: "Aerial Imagery Labels - Vector Tile",
          type: "VectorTileLayer",
          layerType: "VectorTileLayer",
          styleUrl: COUNTY_LABEL_STYLE_URL,
          visibility: true,
          opacity: 1
        }
      ]
    }
  };

  const response = await fetch(COUNTY_PRINT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      f: "json",
      Web_Map_as_JSON: JSON.stringify(webMap),
      Format: "JPG",
      Layout_Template: "MAP_ONLY"
    }),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(7000)
      : undefined
  });
  const body = await response.json().catch(() => ({}));
  const imageUrl = body && body.results && body.results[0]
    && body.results[0].value && body.results[0].value.url;
  if (!response.ok || !imageUrl) {
    const detail = body && body.error && body.error.message;
    throw new Error(detail || `County aerial render failed with status ${response.status}`);
  }
  return imageUrl;
}

function buildZimasPublicUrl(pin, address) {
  if (!clean(pin)) return "";

  const params = new URLSearchParams({
    Cmd: "zoom1ToPIN",
    PIN: clean(pin),
    MultiSelPin: clean(pin),
    SelectedMultiAddress: clean(address),
    ToolTips: "true"
  });
  return `https://zimas.lacity.org/map.asp?${params.toString()}`;
}

function buildGoogleMapsSearchUrl(address) {
  const value = clean(address);
  return value
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`
    : "";
}

function buildGoogleSqFtSearchUrl(address) {
  const value = clean(address);
  return value
    ? `https://www.google.com/search?q=${encodeURIComponent(`${value} square footage`)}`
    : "";
}

function buildAssessorPublicUrl(ain) {
  const value = clean(ain).replace(/[^0-9]/g, "");
  return value ? `${COUNTY_ASSESSOR_PORTAL_URL}/${value}` : "";
}

function buildZimasPointQueryUrl(endpoint, x, y, outFields) {
  const params = new URLSearchParams({
    geometry: `${x},${y}`,
    geometryType: "esriGeometryPoint",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "false",
    resultRecordCount: "5",
    f: "json"
  });
  return `${endpoint}?${params.toString()}`;
}

function buildCountyParcelPointQueryUrl(x, y, ain) {
  const params = new URLSearchParams({
    geometry: `${x},${y}`,
    geometryType: "esriGeometryPoint",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "AIN,APN,SitusFullAddress,UseDescription,UseType,SQFTmain1,SQFTmain2,SQFTmain3,SQFTmain4,SQFTmain5,Units1,YearBuilt1",
    returnGeometry: "false",
    resultRecordCount: "10",
    f: "json"
  });
  if (clean(ain)) params.set("where", `AIN = '${escapeArcgisLiteral(ain)}'`);
  return `${COUNTY_PARCEL_QUERY_URL}?${params.toString()}`;
}

function buildCountyParcelEnvelopeQueryUrl(x, y, delta) {
  const params = new URLSearchParams({
    geometry: `${x - delta},${y - delta},${x + delta},${y + delta}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "AIN,APN,SitusFullAddress,UseDescription,UseType,SQFTmain1,SQFTmain2,SQFTmain3,SQFTmain4,SQFTmain5,Units1,YearBuilt1",
    returnGeometry: "false",
    resultRecordCount: "50",
    f: "json"
  });
  return `${COUNTY_PARCEL_QUERY_URL}?${params.toString()}`;
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

async function lookupZimas(x, y) {
  const landbaseUrl = buildZimasPointQueryUrl(
    ZIMAS_LANDBASE_QUERY_URL,
    x,
    y,
    "PIN,PIND,BPP,BOOK,PAGE,PARCEL,Shape_Area"
  );
  const zoningUrl = buildZimasPointQueryUrl(
    ZIMAS_ZONING_QUERY_URL,
    x,
    y,
    "ZONE_CMPLT,ZONE_CLASS,ZONELEGEND"
  );

  const [landbaseResult, zoningResult] = await Promise.all([
    fetchJson(landbaseUrl),
    fetchJson(zoningUrl)
  ]);
  const parcels = (landbaseResult.features || []).map((feature) => feature.attributes || {});
  const zones = (zoningResult.features || []).map((feature) => feature.attributes || {});

  return {
    status: parcels.length === 1 ? "Matched" : parcels.length > 1 ? "Needs Manual Review" : "No Match",
    sourceUrl: landbaseUrl,
    parcel: parcels.length === 1 ? {
      pin: clean(parcels[0].PIN),
      apn: clean(parcels[0].BPP),
      lotSizeSqFt: Number.isFinite(Number(parcels[0].Shape_Area))
        ? Math.round(Number(parcels[0].Shape_Area))
        : null
    } : null,
    zoning: zones.length ? clean(zones[0].ZONE_CMPLT) : "",
    zoneSourceUrl: zoningUrl,
    parcelCount: parcels.length
  };
}

function buildingSqFtForAttributes(attributes) {
  const buildings = [1, 2, 3, 4, 5]
    .map((index) => ({
      number: index,
      sqFt: Number.isFinite(Number(attributes[`SQFTmain${index}`]))
        ? Number(attributes[`SQFTmain${index}`])
        : null
    }))
    .filter((building) => building.sqFt && building.sqFt > 0);
  return {
    buildings,
    buildingSqFt: buildings.length
      ? buildings.reduce((total, building) => total + building.sqFt, 0)
      : null
  };
}

function assessorMatchScore(attributes, addressHint, ain) {
  if (ain && clean(attributes.AIN) === clean(ain)) return 1000;

  const target = parseAddress(addressHint);
  const candidateText = clean(attributes.SitusFullAddress).toUpperCase();
  if (!target.number || !candidateText) return -1;

  const numberPattern = new RegExp(`\\b${target.number.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`);
  if (!numberPattern.test(candidateText)) return -1;

  const candidateWords = candidateText.replace(/[^A-Z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  const matchingStreetWords = target.streetWords
    .map((word) => word.toUpperCase())
    .filter((word) => candidateWords.includes(word)).length;
  return 60 + matchingStreetWords * 15;
}

function chooseAssessorMatch(features, addressHint, ain) {
  const matches = (features || [])
    .map((feature) => feature && feature.attributes ? feature.attributes : {})
    .filter((attributes) => clean(attributes.AIN));
  return matches
    .map((attributes) => ({
      attributes,
      score: assessorMatchScore(attributes, addressHint, ain)
    }))
    .filter((candidate) => candidate.score >= 75)
    .sort((first, second) => second.score - first.score)[0] || null;
}

async function lookupCountyAssessor(x, y, ain, addressHint) {
  const queryUrl = buildCountyParcelPointQueryUrl(x, y, ain);
  const result = await fetchJson(queryUrl);
  let selected = chooseAssessorMatch(result.features, addressHint, ain);
  let selectedSourceUrl = queryUrl;
  let matchMethod = "address point";

  // Address geocoders occasionally place the point on the street edge or a
  // neighboring driveway. Retry a small parcel window, then match the exact
  // requested street number and name before accepting a nearby assessor row.
  if (!selected || !buildingSqFtForAttributes(selected.attributes).buildingSqFt) {
    for (const delta of [50, 125]) {
      const nearbyUrl = buildCountyParcelEnvelopeQueryUrl(x, y, delta);
      const nearbyResult = await fetchJson(nearbyUrl);
      const nearby = chooseAssessorMatch(nearbyResult.features, addressHint, ain);
      if (nearby && (!selected || nearby.score >= selected.score)) {
        selected = nearby;
        selectedSourceUrl = nearbyUrl;
        matchMethod = "nearby parcel address match";
      }
      if (selected && buildingSqFtForAttributes(selected.attributes).buildingSqFt) break;
    }
  }

  const attributes = selected && selected.attributes;
  if (!attributes) {
    return {
      status: "No Match",
      sourceUrl: selectedSourceUrl,
      publicUrl: "",
      buildingSqFt: null,
      buildings: [],
      units: null,
      useDescription: ""
    };
  }

  const { buildings, buildingSqFt } = buildingSqFtForAttributes(attributes);

  return {
    status: buildingSqFt ? "Matched" : "Matched - No Building Sq Ft",
    sourceUrl: selectedSourceUrl,
    publicUrl: buildAssessorPublicUrl(attributes.AIN),
    ain: clean(attributes.AIN),
    apn: clean(attributes.APN),
    address: clean(attributes.SitusFullAddress),
    buildingSqFt,
    buildings,
    matchMethod,
    units: Number.isFinite(Number(attributes.Units1)) ? Number(attributes.Units1) : null,
    useDescription: clean(attributes.UseDescription),
    useType: clean(attributes.UseType),
    yearBuilt: clean(attributes.YearBuilt1)
  };
}

function addFlags(existing, additions) {
  const flags = Array.isArray(existing)
    ? existing.map((item) => (item && item.name ? item.name : clean(item))).filter(Boolean)
    : [];
  return [...new Set([...flags, ...additions])];
}

async function researchFromLocation(address, source) {
  const location = source.location;
  const point = webMercatorFromLatLon(location);
  const area = clean(source.area);
  const insideLaCity = /\blos angeles\b/i.test(`${source.fullAddress} ${area}`);
  let zimas = null;
  let countyAssessor = null;
  let aerialUrl = "";
  let contextMapUrl = "";
  const [zimasResult, assessorResult, aerialResult] = await Promise.all([
    lookupZimas(point.x, point.y).catch((error) => {
      console.warn("ZIMAS lookup failed", error.message);
      return null;
    }),
    lookupCountyAssessor(point.x, point.y, clean(source.ain), source.fullAddress || address).catch((error) => {
      console.warn("LA County assessor lookup failed", error.message);
      return null;
    }),
    buildCountyAerialUrl(location).catch((error) => {
      console.warn("LA County aerial render failed", error.message);
      return "";
    })
  ]);
  zimas = zimasResult;
  countyAssessor = assessorResult;
  aerialUrl = aerialResult;
  contextMapUrl = buildContextMapUrl(location);

  const assessorAddress = countyAssessor && countyAssessor.address;
  const candidate = {
    ain: clean(source.ain) || clean(countyAssessor && countyAssessor.ain),
    fullAddress: clean(assessorAddress) || clean(source.fullAddress) || clean(address),
    area,
    zip: clean(source.zip),
    location,
    aerialUrl: aerialUrl || buildMarkedAerialUrl(location) || buildAerialUrl(point.x, point.y)
  };

  return {
    ok: true,
    status: "Possible Match",
    address: clean(address),
    sourceUrl: source.sourceUrl,
    candidate,
    milesFromNorthHollywood: location ? roundMiles(milesBetween(location, NORTH_HOLLYWOOD)) : null,
    milesFromMontereyPark: location ? roundMiles(milesBetween(location, MONTEREY_PARK)) : null,
    laCityMatch: insideLaCity ? "Matched" : "Needs Manual Review",
    zimas,
    countyAssessor,
    contextMapUrl
  };
}

async function researchAddress(address, options = {}) {
  const queryUrl = buildCamsQueryUrl(address);
  const result = queryUrl ? await fetchJson(queryUrl) : { features: [] };
  const candidates = uniqueCandidates(result.features);

  if (candidates.length === 1) {
    const candidate = candidates[0];
    const x = Number(candidate.geometry && candidate.geometry.x);
    const y = Number(candidate.geometry && candidate.geometry.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const attributes = candidate.attributes || {};
      return researchFromLocation(address, {
        sourceUrl: queryUrl,
        location: webMercatorToLatLon(x, y),
        ain: clean(attributes.AIN),
        fullAddress: clean(attributes.FullAddress),
        area: getArea(attributes),
        zip: clean(attributes.ZipCode)
      });
    }
  }

  // CAMS can miss valid Google/autocomplete addresses, especially directional
  // numbered streets such as "4000 W Avenue 42". Use the submitted address as
  // a coordinate fallback, then verify the location against county records.
  const fallback = await lookupNominatim(clean(options.mapQuery) || clean(address)).catch((error) => {
    console.warn("Address geocoder fallback failed", error.message);
    return null;
  });
  if (fallback && ["house", "building", "residential"].includes(fallback.type)) {
    return researchFromLocation(address, fallback);
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      status: "No Match",
      reason: "No single LA County address point or fallback geocoder result matched the address.",
      address: clean(address),
      sourceUrl: queryUrl,
      candidates: []
    };
  }

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

function researchNote(research) {
  const timestamp = new Date().toISOString();
  if (!research.ok) {
    return `[Property research ${timestamp}] ${research.status}: ${research.reason}`;
  }

  const candidate = research.candidate;
  const quoteZone = resolveQuoteZone({
    milesFromNorthHollywood: research.milesFromNorthHollywood,
    milesFromMontereyPark: research.milesFromMontereyPark
  });
  return [
    `[Property research ${timestamp}] Possible public GIS match: ${candidate.fullAddress || research.address}`,
    candidate.ain && `AIN/APN candidate: ${candidate.ain}`,
    candidate.area && `LA area: ${candidate.area}`,
    research.zimas && research.zimas.parcel && `ZIMAS PIN: ${research.zimas.parcel.pin || "not provided"}`,
    research.zimas && research.zimas.zoning && `ZIMAS zoning: ${research.zimas.zoning}`,
    research.countyAssessor && research.countyAssessor.buildingSqFt && `LA County assessor building size: ${research.countyAssessor.buildingSqFt.toLocaleString()} sq ft`,
    research.countyAssessor && research.countyAssessor.matchMethod === "nearby parcel address match" && "Assessor match recovered by nearby parcel/address retry",
    research.countyAssessor && !research.countyAssessor.buildingSqFt && `No online building square footage found; Google size search prepared for ${candidate.fullAddress || research.address}`,
    research.countyAssessor && research.countyAssessor.units && `LA County assessor units: ${research.countyAssessor.units}`,
    research.milesFromNorthHollywood !== null && `Approx. miles from North Hollywood: ${research.milesFromNorthHollywood}`,
    research.milesFromMontereyPark !== null && `Approx. miles from Monterey Park: ${research.milesFromMontereyPark}`,
    quoteZone.zoneNumber && `Automatic quote zone: Zone ${quoteZone.zoneNumber}${quoteZone.needsReview ? " (near a zone boundary; review recommended)" : ""}`,
    candidate.aerialUrl && "Aerial preview: LA County 2023 imagery with address labels",
    research.contextMapUrl && "LA context map: Google Maps road map centered on the property",
    "Review duplexes, apartments, suites, and unusual sub-addresses manually even when ZIMAS returns one parcel."
  ].filter(Boolean).join("\n");
}

function buildUpdateFields(research, existingFields) {
  const note = researchNote(research);
  const currentNotes = clean(existingFields["Quote Calculation Notes"]);
  const searchAddress = research.candidate && research.candidate.fullAddress
    ? research.candidate.fullAddress
    : research.address || existingFields["Property Address"];
  const baseFields = {
    "Property Check Status": research.status,
    // Keep raw GIS query endpoints internal; they open as JSON/code in a browser.
    "Property Data Source URL": research.ok
      ? research.sourceUrl || ""
      : buildGoogleMapsSearchUrl(research.address || existingFields["Property Address"]),
    "Quote Calculation Notes": [currentNotes, note].filter(Boolean).join("\n\n"),
    "Google Sq Ft Search URL": buildGoogleSqFtSearchUrl(searchAddress),
    "Property Research Complete": true
  };

  if (!research.ok) {
    return {
      ...baseFields,
      "LA City Match Status": research.status === "No Match" ? "No Match" : "Needs Manual Review",
      "Complexity Flags": addFlags(existingFields["Complexity Flags"], ["Needs manual property check", "Address unclear"])
    };
  }

  const candidate = research.candidate;
  const zimas = research.zimas;
  const complexityText = [
    existingFields["Property Type"],
    existingFields["Unit / Suite / Scope Detail"],
    existingFields.Scope,
    ...(Array.isArray(existingFields["Complexity Flags"]) ? existingFields["Complexity Flags"] : [])
  ].map((item) => item && item.name ? item.name : clean(item)).join(" ");
  const needsUnitReview = /\b(duplex|triplex|fourplex|apartment|multi[-\s]?unit|multifamily|condo|unit|suite|commercial|partial|adu|guest house)\b/i.test(complexityText);
  const hasParcel = Boolean(zimas && zimas.parcel);
  const zimasPublicUrl = hasParcel
    ? buildZimasPublicUrl(zimas.parcel.pin, candidate.fullAddress || research.address)
    : "";
  const assessor = research.countyAssessor;
  const quoteZone = resolveQuoteZone({
    quoteZone: existingFields["Quote Zone"],
    milesFromNorthHollywood: research.milesFromNorthHollywood,
    milesFromMontereyPark: research.milesFromMontereyPark
  });
  const publicDataUrl = (assessor && assessor.publicUrl)
    || zimasPublicUrl
    || buildGoogleMapsSearchUrl(candidate.fullAddress || research.address);
  const aerialFilename = (candidate.fullAddress || research.address)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "property";
  const contextMapFilename = `la-context-${aerialFilename}.jpg`;
  const propertyStatus = hasParcel && !needsUnitReview ? "Matched" : "Possible Match";
  return {
    ...baseFields,
    APN: candidate.ain,
    PIN: hasParcel ? zimas.parcel.pin : "",
    "Lot Size": hasParcel && zimas.parcel.lotSizeSqFt !== null
      ? `${zimas.parcel.lotSizeSqFt.toLocaleString()} sq ft`
      : "",
    Zoning: zimas ? zimas.zoning : "",
    "Neighborhood / LA Area": candidate.area,
    "Miles From North Hollywood": research.milesFromNorthHollywood,
    "Miles From Monterey Park": research.milesFromMontereyPark,
    ...(quoteZone.zoneNumber ? { "Quote Zone": `Zone ${quoteZone.zoneNumber}` } : {}),
    "Verified Sq Ft": assessor && assessor.buildingSqFt ? assessor.buildingSqFt : null,
    "Sq Ft Source": assessor && assessor.buildingSqFt
      ? assessor.matchMethod === "nearby parcel address match"
        ? "LA County Assessor public record (nearby parcel address match)"
        : "LA County Assessor public record"
      : "No online building square footage found",
    "Aerial Map URL": candidate.aerialUrl,
    "Aerial Parcel Preview": candidate.aerialUrl ? [{
      url: candidate.aerialUrl,
      filename: `aerial-${aerialFilename}.jpg`
    }] : [],
    "LA Context Map URL": research.contextMapUrl,
    "LA Context Map Preview": research.contextMapUrl ? [{
      url: research.contextMapUrl,
      filename: contextMapFilename
    }] : [],
    "ZIMAS Link": zimasPublicUrl,
    "Property Data Source URL": publicDataUrl,
    "Property Check Status": propertyStatus,
    "LA City Match Status": hasParcel ? "Matched" : research.laCityMatch,
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

      const research = await researchAddress(recordAddress, {
        mapQuery: record.fields && record.fields["Map Query"]
      });
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
    const research = await researchAddress(address, {
      mapQuery: input.mapQuery || address
    });
    return json(200, { ok: true, research });
  } catch (error) {
    console.error("Property research preview failed", error.message);
    return json(502, { ok: false, error: "Property research preview failed" });
  }
};

exports.researchAddress = researchAddress;
exports.buildUpdateFields = buildUpdateFields;
exports.buildCountyAerialUrl = buildCountyAerialUrl;
exports.buildContextMapUrl = buildContextMapUrl;

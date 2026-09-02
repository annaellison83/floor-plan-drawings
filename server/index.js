const http = require("node:http");
const { discoverCalendars } = require("./icloud");
const { buildRoster } = require("./calendar-roster");
const { isSmtpConfigured, sendMail, verifySmtp } = require("./mail");
const { quoteReadyEmail } = require("./email-templates");

const PORT = Number(process.env.PORT) || 10000;
const SERVICE_NAME = "floorplan-drawings-backend";
const TEST_PROPERTY_ADDRESSES = [
  "2800 E Observatory Rd, Los Angeles, CA 90027",
  "5905 Wilshire Blvd, Los Angeles, CA 90036",
  "221 S Grand Ave, Los Angeles, CA 90012",
  "4700 Western Heritage Way, Los Angeles, CA 90027",
  "1418 Descanso Dr, La Canada Flintridge, CA 91011"
];

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req) {
  const expected = clean(process.env.INTERNAL_ADMIN_TOKEN);
  if (!expected) return false;
  return clean(req.headers["x-admin-token"]) === expected;
}

function integrationStatus() {
  return {
    airtable: Boolean(process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID),
    gmailSmtp: isSmtpConfigured(),
    icloud: Boolean(process.env.ICLOUD_EMAIL && process.env.ICLOUD_APP_PASSWORD),
    googleMaps: Boolean(process.env.GOOGLE_MAPS_STATIC_KEY || process.env.GOOGLE_MAPS_SERVER_KEY),
    postgres: Boolean(process.env.DATABASE_URL)
  };
}

async function buildTestQuote() {
  const address = TEST_PROPERTY_ADDRESSES[Math.floor(Math.random() * TEST_PROPERTY_ADDRESSES.length)];
  const endpoint = clean(process.env.PROPERTY_RESEARCH_URL)
    || "https://floorplandrawings.com/.netlify/functions/property-research";
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set("address", address);

  const response = await fetch(requestUrl, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  const research = body.research;
  if (!response.ok || !research || !research.ok) {
    throw new Error("Read-only property research did not return a single usable location");
  }

  const candidate = research.candidate || {};
  const assessor = research.countyAssessor || {};
  return {
    propertyAddress: candidate.fullAddress || address,
    clientName: "Eric Greenburg",
    clientEmail: "ericreenburg@gmail.com",
    clientPhone: "909-921-7490",
    service: "Color Interior + Exterior",
    milesFromNorthHollywood: research.milesFromNorthHollywood,
    milesFromMontereyPark: research.milesFromMontereyPark,
    verifiedSqFt: assessor.buildingSqFt || null,
    suggestedQuote: 345,
    tourRequested: "No",
    status: "TEST MODE — no Airtable record changed",
    mapUrl: candidate.aerialUrl,
    contextMapUrl: research.contextMapUrl,
    quoteNotes: [
      "TEST EMAIL — layout and delivery check only",
      "This address was randomly selected from a list of public Los Angeles landmarks.",
      assessor.buildingSqFt ? `Online size: ${Number(assessor.buildingSqFt).toLocaleString()} sq ft` : "Online size needs verification",
      `Approx. miles from North Hollywood: ${research.milesFromNorthHollywood}`,
      `Approx. miles from Monterey Park: ${research.milesFromMontereyPark}`,
      "The aerial and context map were generated live through the read-only property-research endpoint."
    ].join("\n")
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    return json(res, 200, {
      service: SERVICE_NAME,
      status: "ok",
      health: "/healthz"
    });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, {
      service: SERVICE_NAME,
      status: "ok",
      integrations: integrationStatus()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/icloud/calendars") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    try {
      const result = await discoverCalendars({
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD)
      });
      return json(res, 200, {
        calendarHomeUrl: result.calendarHomeUrl,
        calendars: result.calendars
      });
    } catch (error) {
      return json(res, 502, {
        error: "iCloud calendar discovery failed",
        detail: error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/icloud/roster") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    try {
      const result = await discoverCalendars({
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD)
      });
      return json(res, 200, {
        calendarHomeUrl: result.calendarHomeUrl,
        ...buildRoster(result.calendars)
      });
    } catch (error) {
      return json(res, 502, {
        error: "iCloud calendar roster failed",
        detail: error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/email/verify") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    try {
      return json(res, 200, await verifySmtp());
    } catch (error) {
      return json(res, 502, {
        error: "Gmail SMTP verification failed",
        detail: error.message
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/test") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    const recipient = clean(process.env.SMTP_USER);
    if (!recipient) return json(res, 503, { error: "SMTP_USER is not configured" });

    try {
      const sampleJob = await buildTestQuote();
      const sample = quoteReadyEmail(sampleJob);
      const delivery = await sendMail({
        to: recipient,
        subject: `[TEST — NO WORKFLOW] ${sample.subject}`,
        html: sample.html,
        text: sample.text
      });
      return json(res, 200, { ok: true, test: true, recipient, ...delivery });
    } catch (error) {
      return json(res, 502, { error: "Test email delivery failed", detail: error.message });
    }
  }

  return json(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    json(res, 500, { error: "Internal server error", detail: error.message });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});

const http = require("node:http");
const { discoverCalendars } = require("./icloud");
const { buildRoster } = require("./calendar-roster");
const { schedulingPolicy } = require("./scheduling-policy");
const { isSmtpConfigured, sendMail, verifySmtp } = require("./mail");
const { clientQuoteEmail, quoteReadyEmail } = require("./email-templates");
const {
  createClientQuoteLog,
  createQuoteReadyLog,
  findClientQuoteDeliveries,
  findQuoteReadyDeliveries,
  getJob,
  listApprovedQuoteCandidates,
  listQuoteReadyCandidates,
  updateCommunicationLog,
  updateJob
} = require("./airtable");

const PORT = Number(process.env.PORT) || 10000;
const SERVICE_NAME = "floorplan-drawings-backend";
const TEST_PROPERTY_ADDRESSES = [
  "349 Mount Washington Dr, Los Angeles, CA 90065",
  "3960 Verdugo View Dr, Los Angeles, CA 90065",
  "2630 Delevan Dr, Los Angeles, CA 90065",
  "4968 Vincent Ave, Los Angeles, CA 90041",
  "3842 Cazador St, Los Angeles, CA 90065",
  "4011 Scandia Way, Los Angeles, CA 90065",
  "2750 Medlow Ave, Los Angeles, CA 90065"
];
const quoteReadyLocks = new Set();
const clientQuoteLocks = new Set();
let quoteReadyPollRunning = false;
let clientQuotePollRunning = false;

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

function html(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  res.end(body);
}

function isAuthorized(req) {
  const expected = clean(process.env.INTERNAL_ADMIN_TOKEN);
  if (!expected) return false;
  return clean(req.headers["x-admin-token"]) === expected;
}

function integrationStatus() {
  const smtpReady = isSmtpConfigured();
  return {
    airtable: Boolean(process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID),
    smtp: smtpReady,
    gmailSmtp: Boolean(process.env.SMTP_USER && process.env.SMTP_APP_PASSWORD),
    icloud: Boolean(process.env.ICLOUD_EMAIL && process.env.ICLOUD_APP_PASSWORD),
    googleMaps: Boolean(process.env.GOOGLE_MAPS_STATIC_KEY || process.env.GOOGLE_MAPS_SERVER_KEY),
    postgres: Boolean(process.env.DATABASE_URL),
    quoteReadySendEnabled: clean(process.env.ENABLE_QUOTE_READY_SENDS).toLowerCase() === "true",
    clientQuoteSendEnabled: clean(process.env.ENABLE_CLIENT_QUOTE_SENDS).toLowerCase() === "true"
  };
}

function quoteReadyEnabled() {
  return clean(process.env.ENABLE_QUOTE_READY_SENDS).toLowerCase() === "true";
}

function clientQuoteEnabled() {
  return clean(process.env.ENABLE_CLIENT_QUOTE_SENDS).toLowerCase() === "true";
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function deliverQuoteReady(recordId) {
  if (quoteReadyLocks.has(recordId)) return { ok: false, status: 409, error: "Delivery already in progress" };
  quoteReadyLocks.add(recordId);
  let logRecordId = "";

  try {
    const priorDeliveries = await findQuoteReadyDeliveries(recordId);
    if (priorDeliveries.length) {
      return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    }
    const job = await getJob(recordId);
    const email = quoteReadyEmail(job);
    const reservation = await createQuoteReadyLog({
      recordId,
      subject: email.subject,
      status: "Pending",
      summary: "Reserved by Render before SMTP delivery"
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");

    const recipient = clean(process.env.SMTP_USER);
    if (!recipient) throw new Error("SMTP_USER is not configured");
    const delivery = await sendMail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
    await updateCommunicationLog(logRecordId, {
      "Delivery Status": "Sent",
      Summary: `Delivered by Render via Gmail SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}`
    });
    await updateJob(recordId, { "Anna Email Status": "Sent - Quote Ready" });
    return { ok: true, status: 200, recordId, logRecordId, delivery: "sent" };
  } catch (error) {
    if (logRecordId) {
      await updateCommunicationLog(logRecordId, {
        "Delivery Status": "Failed",
        Summary: `Render delivery failed: ${error.message}`
      }).catch(() => {});
    }
    return { ok: false, status: 502, error: "QUOTE READY delivery failed", detail: error.message };
  } finally {
    quoteReadyLocks.delete(recordId);
  }
}

async function pollQuoteReady() {
  if (!quoteReadyEnabled() || quoteReadyPollRunning) return;
  quoteReadyPollRunning = true;
  try {
    const candidates = await listQuoteReadyCandidates();
    for (const candidate of candidates) {
      const result = await deliverQuoteReady(candidate.id);
      console.log(`QUOTE READY poll ${candidate.id}: ${result.ok ? "sent" : result.error}`);
    }
  } catch (error) {
    console.error(`QUOTE READY poll failed: ${error.message}`);
  } finally {
    quoteReadyPollRunning = false;
  }
}

async function deliverClientQuote(recordId) {
  if (clientQuoteLocks.has(recordId)) return { ok: false, status: 409, error: "Delivery already in progress" };
  clientQuoteLocks.add(recordId);
  let logRecordId = "";
  try {
    const priorDeliveries = await findClientQuoteDeliveries(recordId);
    if (priorDeliveries.length) return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    const job = await getJob(recordId);
    if (!job.clientEmail) throw new Error("Client Email is missing");
    if (!Number.isFinite(Number(job.finalQuote)) || Number(job.finalQuote) <= 0) throw new Error("Approved quote amount is missing");
    const email = clientQuoteEmail(job);
    const reservation = await createClientQuoteLog({
      recordId,
      clientName: job.clientName,
      subject: email.subject,
      status: "Pending",
      summary: `Reserved by Render for ${job.clientName || "client"}`
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");
    const delivery = await sendMail({
      to: job.clientEmail,
      replyTo: clean(process.env.SMTP_USER),
      subject: email.subject,
      html: email.html,
      text: email.text
    });
    const sentAt = new Date().toISOString();
    await updateCommunicationLog(logRecordId, {
      "Delivery Status": "Sent",
      Summary: `Client quote email sent by Render. Property: ${job.propertyAddress}. Service: ${job.service}. Quote: ${job.finalQuote}.`
    });
    await updateJob(recordId, {
      Status: "Quote Sent",
      "Client Response": "Awaiting Reply",
      "Quote Sent Date": localDate(),
      "Approval Email Sent At": sentAt
    });
    return { ok: true, status: 200, recordId, logRecordId, delivery: "sent", accepted: delivery.accepted };
  } catch (error) {
    if (logRecordId) {
      await updateCommunicationLog(logRecordId, {
        "Delivery Status": "Failed",
        Summary: `Render client quote delivery failed: ${error.message}`
      }).catch(() => {});
    }
    return { ok: false, status: 502, error: "Client quote delivery failed", detail: error.message };
  } finally {
    clientQuoteLocks.delete(recordId);
  }
}

async function pollClientQuotes() {
  if (!clientQuoteEnabled() || clientQuotePollRunning) return;
  clientQuotePollRunning = true;
  try {
    const candidates = await listApprovedQuoteCandidates();
    for (const candidate of candidates) {
      const result = await deliverClientQuote(candidate.id);
      console.log(`CLIENT QUOTE poll ${candidate.id}: ${result.ok ? "sent" : result.error}`);
    }
  } catch (error) {
    console.error(`CLIENT QUOTE poll failed: ${error.message}`);
  } finally {
    clientQuotePollRunning = false;
  }
}

async function buildTestQuote() {
  const endpoint = clean(process.env.PROPERTY_RESEARCH_URL)
    || "https://floorplandrawings.com/.netlify/functions/property-research";
  const shuffled = [...TEST_PROPERTY_ADDRESSES].sort(() => Math.random() - 0.5);
  let research = null;
  let address = "";

  for (const candidateAddress of shuffled) {
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set("address", candidateAddress);
    const response = await fetch(requestUrl, { headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    const candidateResearch = body.research;
    if (response.ok && candidateResearch && candidateResearch.ok
      && Number(candidateResearch.countyAssessor && candidateResearch.countyAssessor.buildingSqFt) > 0) {
      research = candidateResearch;
      address = candidateAddress;
      break;
    }
  }

  if (!research) {
    throw new Error("No test address returned assessor-verified building square footage; no email was sent");
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

  if (req.method === "GET" && url.pathname === "/api/icloud/scheduling-policy") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { readOnly: true, ...schedulingPolicy() });
  }

  if (req.method === "GET" && url.pathname === "/api/email/verify") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    try {
      return json(res, 200, await verifySmtp());
    } catch (error) {
      return json(res, 502, {
        error: "SMTP verification failed",
        detail: error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/airtable/quote-ready-preview") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    try {
      const recordId = clean(url.searchParams.get("recordId"));
      const job = await getJob(recordId);
      const preview = quoteReadyEmail(job);
      if (url.searchParams.get("format") === "html") return html(res, 200, preview.html);
      const priorDeliveries = await findQuoteReadyDeliveries(recordId);
      return json(res, 200, {
        ok: true,
        dryRun: true,
        readOnly: true,
        emailSent: false,
        airtableRecordChanged: false,
        deliveryGuard: {
          allowed: priorDeliveries.length === 0,
          reason: priorDeliveries.length === 0 ? "No pending or sent QUOTE READY log found" : "Pending or already sent",
          priorSentCount: priorDeliveries.length,
          priorDeliveryRecordIds: priorDeliveries.map((delivery) => delivery.id)
        },
        recordId: job.recordId,
        subject: preview.subject,
        html: preview.html,
        text: preview.text
      });
    } catch (error) {
      return json(res, 502, {
        error: "Airtable quote preview failed",
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

  if (req.method === "POST" && url.pathname === "/api/airtable/send-quote-ready") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!quoteReadyEnabled()) {
      return json(res, 503, { error: "QUOTE READY sending is disabled" });
    }
    const recordId = clean(url.searchParams.get("recordId"));
    const result = await deliverQuoteReady(recordId);
    return json(res, result.status, result);
  }

  if (req.method === "POST" && url.pathname === "/api/airtable/send-client-quote") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!clientQuoteEnabled()) return json(res, 503, { error: "Client quote sending is disabled" });
    const result = await deliverClientQuote(clean(url.searchParams.get("recordId")));
    return json(res, result.status, result);
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
  setTimeout(pollQuoteReady, 5000).unref();
  setInterval(pollQuoteReady, Number(process.env.QUOTE_READY_POLL_MS) || 60000).unref();
  setTimeout(pollClientQuotes, 8000).unref();
  setInterval(pollClientQuotes, Number(process.env.CLIENT_QUOTE_POLL_MS) || 60000).unref();
});

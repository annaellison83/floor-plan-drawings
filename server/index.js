const http = require("node:http");
const crypto = require("node:crypto");
const {
  createProvisionalHold,
  discoverCalendars,
  getCalendarAvailability,
  releaseProvisionalHold
} = require("./icloud");
const { buildRoster } = require("./calendar-roster");
const { appointmentDurationMinutes, schedulingPolicy } = require("./scheduling-policy");
const { planAppointments } = require("./appointment-planner");
const { proposalPayload, signProposal, verifyProposal } = require("./appointment-proposals");
const { isSmtpConfigured, sendMail, verifySmtp } = require("./mail");
const {
  clientQuoteEmail,
  clientAvailabilityProposalEmail,
  followUpEmail,
  newRequestEmail,
  propertyReviewEmail,
  quoteReadyEmail
} = require("./email-templates");
const {
  createClientQuoteLog,
  createAppointmentProposalLog,
  createNotificationLog,
  createQuoteReadyLog,
  findClientQuoteDeliveries,
  findAppointmentProposalDeliveries,
  findNotificationDeliveries,
  findQuoteReadyDeliveries,
  getApprovalState,
  getJob,
  listApprovedQuoteCandidates,
  listFollowUpCandidates,
  listNewRequestCandidates,
  listPropertyReviewCandidates,
  listQuoteReadyCandidates,
  communicationKey,
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
// Test-only delivery target. Production notifications continue to use SMTP_USER.
const TEST_EMAIL_RECIPIENT = "eric.greenburg@gmail.com";
const quoteReadyLocks = new Set();
const clientQuoteLocks = new Set();
const internalNotificationLocks = new Set();
let quoteReadyPollRunning = false;
let clientQuotePollRunning = false;
let newRequestPollRunning = false;
let propertyReviewPollRunning = false;
let followUpPollRunning = false;
let followUpRunDate = "";

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
    clientQuoteSendEnabled: clean(process.env.ENABLE_CLIENT_QUOTE_SENDS).toLowerCase() === "true",
    provisionalHoldsEnabled: provisionalHoldEnabled(),
    newRequestSendEnabled: newRequestEnabled(),
    propertyReviewSendEnabled: propertyReviewEnabled(),
    followUpSendEnabled: followUpEnabled(),
    appointmentProposalSendEnabled: appointmentProposalEnabled(),
    appointmentProposalHoldEnabled: provisionalHoldEnabled()
  };
}

function quoteReadyEnabled() {
  return clean(process.env.ENABLE_QUOTE_READY_SENDS).toLowerCase() === "true";
}

function clientQuoteEnabled() {
  return clean(process.env.ENABLE_CLIENT_QUOTE_SENDS).toLowerCase() === "true";
}

function newRequestEnabled() {
  return clean(process.env.ENABLE_NEW_REQUEST_SENDS).toLowerCase() === "true";
}

function propertyReviewEnabled() {
  return clean(process.env.ENABLE_PROPERTY_REVIEW_SENDS).toLowerCase() === "true";
}

function followUpEnabled() {
  return clean(process.env.ENABLE_FOLLOW_UP_SENDS).toLowerCase() === "true";
}

function appointmentProposalEnabled() {
  return clean(process.env.ENABLE_APPOINTMENT_PROPOSALS).toLowerCase() === "true";
}

function provisionalHoldEnabled() {
  return clean(process.env.ENABLE_PROVISIONAL_HOLDS).toLowerCase() === "true";
}

function holdId({ jobKey, worker, start }) {
  return `fpd-hold-${crypto.createHash("sha256").update(`${jobKey}|${worker}|${start}`).digest("hex")}`;
}

function workerCalendar(roster, worker) {
  const requested = clean(worker).toLowerCase();
  const calendarName = requested === "ricky" ? "ricardo" : requested;
  return roster.workers.find((calendar) => clean(calendar.name).toLowerCase() === calendarName) || null;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function localTimeParts() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
}

function followUpDueNow() {
  const parts = localTimeParts();
  return Number(parts.hour) === 8;
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request body is too large");
  }
  if (!body.trim()) return {};
  if (String(req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Request body must be valid JSON");
  }
}

async function workerAvailability({ startDate, days, durationMinutes }) {
  const discovered = await discoverCalendars({
    email: clean(process.env.ICLOUD_EMAIL),
    password: clean(process.env.ICLOUD_APP_PASSWORD)
  });
  const roster = buildRoster(discovered.calendars);
  const availability = await getCalendarAvailability({
    email: clean(process.env.ICLOUD_EMAIL),
    password: clean(process.env.ICLOUD_APP_PASSWORD),
    calendars: roster.workers,
    startDate,
    days,
    durationMinutes,
    appointmentStarts: schedulingPolicy().appointmentStarts
  });
  return { ...availability, calendarHomeUrl: discovered.calendarHomeUrl, roster };
}

function appointmentProposalBaseUrl() {
  return clean(process.env.PROPOSAL_PUBLIC_BASE_URL) || "https://floor-plan-drawings.onrender.com/api/scheduling/proposal";
}

function escapeHtml(value) {
  return clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function formatProposalSlot(slot) {
  const date = new Date(`${clean(slot.date)}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime()) ? clean(slot.date) : date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const rawTime = clean(slot.localStart).match(/(?:T|\s)(\d{1,2}:\d{2})$/);
  const time = rawTime ? rawTime[1] : clean(slot.localStart);
  const [hour, minute] = time.split(":").map(Number);
  const timeLabel = Number.isFinite(hour) && Number.isFinite(minute)
    ? `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`
    : time;
  return `${dateLabel} at ${timeLabel} · ${clean(slot.worker)} · ${Number(slot.durationMinutes) || 0} minutes`;
}

async function buildAppointmentProposal(recordId, input = {}) {
  const job = await getJob(recordId);
  const squareFeet = Number(job.verifiedSqFt);
  if (!Number.isFinite(squareFeet) || squareFeet <= 0) throw new Error("Verified square footage is required before proposing appointment times");
  const days = Math.min(14, Math.max(1, Number(input.days) || 7));
  const availability = await workerAvailability({
    startDate: clean(input.startDate) || localDate(),
    days,
    durationMinutes: appointmentDurationMinutes(squareFeet)
  });
  const plan = planAppointments({
    availability,
    squareFeet,
    service: job.service,
    nearbyToSarah: input.nearbyToSarah === true,
    milesFromSarah: input.milesFromSarah,
    bookedThisWeek: input.bookedThisWeek,
    bookedToday: input.bookedToday,
    count: Math.min(5, Math.max(1, Number(input.count) || 3))
  });
  if (!plan.recommendations.length) throw new Error(plan.unassignedReason || "No available appointment options found");
  const payload = proposalPayload({
    recordId: job.recordId,
    address: job.propertyAddress,
    clientName: job.clientName,
    squareFeet,
    service: job.service,
    slots: plan.recommendations
  });
  return { job, plan, payload };
}

function proposalPage(payload, token, notice = "", actionUrl = appointmentProposalBaseUrl(), submitLabel = "Request this time") {
  const options = payload.slots.map((slot, index) => `<label style="display:block;margin:12px 0;padding:16px;border:1px solid #d9d5ca;border-radius:10px;background:#fff;cursor:pointer;"><input type="radio" name="slot" value="${index}"${index === 0 ? " checked" : ""} style="margin-right:10px;"><strong>Option ${index + 1}</strong><br><span style="display:inline-block;margin:6px 0 0 24px;color:#394842;">${escapeHtml(formatProposalSlot(slot))}<br>Target delivery: ${escapeHtml(slot.deliveryTarget && slot.deliveryTarget.label || "To be confirmed")}</span></label>`).join("");
  const noticeHtml = notice ? `<div role="status" style="margin:0 0 18px;padding:13px 15px;background:#E4F1DE;border:1px solid #9FBC91;border-radius:8px;color:#1F3A34;font-weight:bold;">${escapeHtml(notice)}</div>` : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose an appointment | FloorPlanDrawings</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:680px;margin:5vh auto;padding:34px 26px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / scheduling</div><h1 style="font-size:30px;line-height:38px;margin:12px 0 16px;">Choose an appointment time</h1>${noticeHtml}<p style="font-size:16px;line-height:25px;color:#4A4A40;">${escapeHtml(payload.address)}</p><p style="font-size:15px;line-height:24px;color:#4A4A40;">Select one option below. We will re-check the calendar and confirm the appointment before it is final.</p><form method="post" action="${escapeHtml(actionUrl)}"><input type="hidden" name="token" value="${escapeHtml(token)}">${options}<button type="submit" style="border:0;border-radius:8px;background:#1F3A34;color:#F5F1E8;font-size:16px;line-height:22px;font-weight:bold;padding:15px 22px;cursor:pointer;">${escapeHtml(submitLabel)}</button></form><p style="font-size:13px;line-height:20px;color:#8A897C;margin-top:20px;">Options expire automatically.</p></main></body></html>`;
}

async function sendAvailabilityProposal(recordId, input = {}) {
  const { job, plan, payload } = await buildAppointmentProposal(recordId, input);
  if (!job.clientEmail) throw new Error("Client Email is missing");
  const token = signProposal(payload);
  const proposalUrl = `${appointmentProposalBaseUrl()}?token=${encodeURIComponent(token)}`;
  const email = clientAvailabilityProposalEmail(job, proposalUrl, payload.slots);
  const prior = await findAppointmentProposalDeliveries(recordId);
  if (prior.length) return { ok: false, status: 409, error: "Appointment proposal already sent", recordId, priorDeliveryRecordIds: prior.map((item) => item.id) };
  const reservation = await createAppointmentProposalLog({ recordId, subject: email.subject, status: "Pending", summary: `Reserved by Render for ${payload.slots.length} appointment options` });
  const logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
  if (!logRecordId) throw new Error("Airtable did not return the appointment proposal log ID");
  try {
    const delivery = await sendMail({ to: job.clientEmail, replyTo: clean(process.env.SMTP_USER), subject: email.subject, html: email.html, text: email.text });
    await updateCommunicationLog(logRecordId, { "Delivery Status": "Sent", Summary: `Appointment options sent by Render for ${job.propertyAddress}${delivery.messageId ? `; message ${delivery.messageId}` : ""}` });
    return { ok: true, status: 200, recordId, logRecordId, proposalUrl, options: plan.recommendations };
  } catch (error) {
    await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Appointment proposal delivery failed: ${error.message}` }).catch(() => {});
    throw error;
  }
}

async function authorizeProposalStart(recordId, providedToken) {
  const state = await getApprovalState(recordId);
  if (state.workflow !== "Quick Quote") throw new Error("This link only applies to Quick Quote records");
  if (!state.approvalToken || !tokensMatch(state.approvalToken, providedToken)) throw new Error("This scheduling link is no longer valid");
  if (state.decision && state.decision !== "Pending") throw new Error("This quote is no longer pending review");
  return state;
}

async function selectAppointment(payload, selectedIndex) {
  const slot = payload.slots[selectedIndex];
  if (!slot) throw new Error("Choose one of the listed appointment options");
  const availability = await workerAvailability({
    startDate: localDate(),
    days: 14,
    durationMinutes: Number(slot.durationMinutes) || schedulingPolicy().defaultAppointmentMinutes
  });
  const worker = clean(slot.worker).toLowerCase() === "ricky" ? "ricardo" : clean(slot.worker).toLowerCase();
  const current = (availability.calendars || [])
    .filter((calendar) => clean(calendar.name).toLowerCase() === (clean(slot.calendarName).toLowerCase() || worker))
    .flatMap((calendar) => calendar.slots || [])
    .find((candidate) => candidate.available && candidate.start === slot.start && candidate.end === slot.end);
  if (!current) throw new Error("That time is no longer available. Please use the link again for fresh options.");

  const selectionKey = crypto.createHash("sha256").update(`${payload.recordId}|${worker}|${slot.start}`).digest("hex").slice(0, 20);
  const communication = communicationKey(payload.recordId, "appointment_selection", selectionKey);
  if ((await findNotificationDeliveries(communication, "APPOINTMENT SELECTION")).length) {
    throw new Error("That appointment option has already been requested");
  }
  const reservation = await createNotificationLog({
    recordId: payload.recordId,
    communication,
    eventType: "APPOINTMENT SELECTION",
    subject: `Appointment requested | ${payload.address}`,
    status: "Pending",
    summary: `Client selected ${formatProposalSlot(slot)}`
  });
  const logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
  if (!logRecordId) throw new Error("Airtable did not return the appointment selection log ID");

  if (!provisionalHoldEnabled()) {
    await updateCommunicationLog(logRecordId, { Summary: `Client requested ${formatProposalSlot(slot)}; Anna confirmation required while calendar holds are disabled` });
    return { slot, held: false, logRecordId };
  }

  try {
    const discovered = await discoverCalendars({ email: clean(process.env.ICLOUD_EMAIL), password: clean(process.env.ICLOUD_APP_PASSWORD) });
    const calendar = workerCalendar(buildRoster(discovered.calendars), worker);
    if (!calendar) throw new Error("The selected worker calendar is no longer available");
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const expiresAt = new Date(Math.min(Date.now() + 24 * 60 * 60 * 1000, Number(payload.expiresAt)));
    const id = holdId({ jobKey: payload.recordId, worker: calendar.name, start: start.toISOString() });
    const hold = await createProvisionalHold({
      calendar,
      email: clean(process.env.ICLOUD_EMAIL),
      password: clean(process.env.ICLOUD_APP_PASSWORD),
      uid: id,
      start,
      end,
      expiresAt,
      summary: `FloorPlanDrawings provisional hold — ${payload.address}`,
      description: "Client selected this time; awaiting Anna's confirmation"
    });
    await updateCommunicationLog(logRecordId, { "Delivery Status": "Sent", Summary: `Client selected ${formatProposalSlot(slot)}; provisional hold ${hold.duplicate ? "already existed" : "created"}` });
    return { slot, held: true, duplicate: hold.duplicate, holdId: id, logRecordId };
  } catch (error) {
    await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Appointment hold failed: ${error.message}` }).catch(() => {});
    throw error;
  }
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
    let proposalUrl = "";
    let proposalSlots = [];
    if (appointmentProposalEnabled()) {
      try {
        const built = await buildAppointmentProposal(recordId);
        const proposalToken = signProposal(built.payload);
        proposalUrl = `${appointmentProposalBaseUrl()}?token=${encodeURIComponent(proposalToken)}`;
        proposalSlots = built.payload.slots;
      } catch (error) {
        console.warn(`Appointment options unavailable for ${recordId}: ${error.message}`);
      }
    }
    const email = clientQuoteEmail(job, proposalUrl, proposalSlots);
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

async function deliverInternalNotification(recordId, eventType, buildEmail, statusStamp) {
  const lockKey = `${eventType}:${recordId}`;
  if (internalNotificationLocks.has(lockKey)) return { ok: false, status: 409, error: "Delivery already in progress" };
  internalNotificationLocks.add(lockKey);
  let logRecordId = "";
  try {
    const priorDeliveries = await findNotificationDeliveries(recordId, eventType);
    if (priorDeliveries.length) return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    const job = await getJob(recordId);
    const email = buildEmail(job);
    const reservation = await createNotificationLog({
      recordId,
      eventType,
      subject: email.subject,
      status: "Pending",
      summary: `Reserved by Render before ${eventType} delivery`
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");
    const recipient = clean(process.env.SMTP_USER);
    if (!recipient) throw new Error("SMTP_USER is not configured");
    const delivery = await sendMail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
    await updateCommunicationLog(logRecordId, {
      "Delivery Status": "Sent",
      Summary: `Delivered by Render via SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}`
    });
    await updateJob(recordId, { "Anna Email Status": statusStamp });
    return { ok: true, status: 200, recordId, logRecordId, delivery: "sent" };
  } catch (error) {
    if (logRecordId) await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Render delivery failed: ${error.message}` }).catch(() => {});
    return { ok: false, status: 502, error: `${eventType} delivery failed`, detail: error.message };
  } finally {
    internalNotificationLocks.delete(lockKey);
  }
}

async function pollNewRequests() {
  if (!newRequestEnabled() || newRequestPollRunning) return;
  newRequestPollRunning = true;
  try {
    for (const candidate of await listNewRequestCandidates()) {
      const result = await deliverInternalNotification(candidate.id, "NEW REQUEST", newRequestEmail, "Sent - New Order");
      console.log(`NEW REQUEST poll ${candidate.id}: ${result.ok ? "sent" : result.error}`);
    }
  } catch (error) {
    console.error(`NEW REQUEST poll failed: ${error.message}`);
  } finally {
    newRequestPollRunning = false;
  }
}

async function pollPropertyReviews() {
  if (!propertyReviewEnabled() || propertyReviewPollRunning) return;
  propertyReviewPollRunning = true;
  try {
    for (const candidate of await listPropertyReviewCandidates()) {
      const result = await deliverInternalNotification(candidate.id, "PROPERTY REVIEW NEEDED", propertyReviewEmail, "Sent - Manual Review");
      console.log(`PROPERTY REVIEW poll ${candidate.id}: ${result.ok ? "sent" : result.error}`);
    }
  } catch (error) {
    console.error(`PROPERTY REVIEW poll failed: ${error.message}`);
  } finally {
    propertyReviewPollRunning = false;
  }
}

async function pollFollowUps() {
  const today = localDate();
  if (!followUpEnabled() || followUpPollRunning || followUpRunDate === today || !followUpDueNow()) return;
  followUpPollRunning = true;
  try {
    const candidates = await listFollowUpCandidates();
    const jobs = [];
    for (const candidate of candidates) jobs.push(await getJob(candidate.id));
    // Airtable's automation does not send an empty digest. Mark the local run
    // only after a non-empty digest has been delivered successfully.
    if (!jobs.length) {
      followUpRunDate = today;
      return;
    }
    const communication = communicationKey("daily-follow-up", "follow_up", today);
    if ((await findNotificationDeliveries(communication, "FOLLOW-UP")).length) {
      followUpRunDate = today;
      return;
    }
    const email = followUpEmail(jobs, today);
    const reservation = await createNotificationLog({
      recordId: "daily-follow-up",
      communication,
      eventType: "FOLLOW-UP",
      subject: email.subject,
      status: "Pending",
      summary: `Reserved by Render for ${jobs.length} follow-up${jobs.length === 1 ? "" : "s"}`
    });
    const logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the follow-up Communication Log ID");
    try {
      const recipient = clean(process.env.SMTP_USER);
      if (!recipient) throw new Error("SMTP_USER is not configured");
      const delivery = await sendMail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
      await updateCommunicationLog(logRecordId, { "Delivery Status": "Sent", Summary: `Delivered by Render via SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}` });
      followUpRunDate = today;
    } catch (error) {
      await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Render follow-up delivery failed: ${error.message}` }).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error(`FOLLOW-UP poll failed: ${error.message}`);
  } finally {
    followUpPollRunning = false;
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
    clientEmail: TEST_EMAIL_RECIPIENT,
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

function buildTestFollowUp() {
  const today = localDate();
  return [{
    recordId: "test-follow-up",
    clientName: "Test Client",
    clientEmail: "test-client@example.com",
    clientPhone: "(555) 010-0142",
    propertyAddress: "123 Test Street, Los Angeles, CA 90065",
    service: "Color Interior + Exterior",
    quoteSentDate: today,
    followUpDate: today,
    recordUrl: "https://airtable.com/"
  }];
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

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/scheduling/proposal/start") {
    const recordId = clean(url.searchParams.get("recordId"));
    const providedToken = clean(url.searchParams.get("token"));
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId) || !providedToken) return html(res, 400, proposalPage({ address: "this quote", slots: [] }, "", "This scheduling link is incomplete."));
    try {
      await authorizeProposalStart(recordId, providedToken);
      if (req.method === "GET") {
        const built = await buildAppointmentProposal(recordId);
        const proposalToken = signProposal(built.payload);
        const actionUrl = `${appointmentProposalBaseUrl()}/start?recordId=${encodeURIComponent(recordId)}&token=${encodeURIComponent(providedToken)}`;
        return html(res, 200, proposalPage(built.payload, proposalToken, "", actionUrl, "Send these options to the client"));
      }
      if (!appointmentProposalEnabled()) return html(res, 503, proposalPage({ address: "this quote", slots: [] }, "", "Appointment proposals are not enabled yet. No email or calendar event was created."));
      const result = await sendAvailabilityProposal(recordId);
      return html(res, 200, `<!doctype html><html><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:620px;margin:10vh auto;padding:36px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;"><h1>Appointment options sent</h1><p>The available times were emailed to the client. No calendar event was created.</p></main></body></html>`);
    } catch (error) {
      return html(res, 409, proposalPage({ address: "this quote", slots: [] }, "", error.message));
    }
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/scheduling/proposal") {
    const token = clean(url.searchParams.get("token"));
    const payload = verifyProposal(token);
    if (!payload) return html(res, 410, proposalPage({ address: "this quote", slots: [] }, "", "This appointment link is invalid or expired."));
    if (req.method === "GET") return html(res, 200, proposalPage(payload, token));
    try {
      const body = await readJsonBody(req);
      const selectedIndex = Number(body.slot);
      if (!Number.isInteger(selectedIndex)) return html(res, 400, proposalPage(payload, token, "Choose an appointment option first."));
      const result = await selectAppointment(payload, selectedIndex);
      const notice = result.held
        ? "Your request was received and a provisional hold was placed. Anna will confirm the appointment."
        : "Your request was received. Anna will re-check the calendar and confirm the appointment.";
      return html(res, 200, proposalPage(payload, token, notice));
    } catch (error) {
      return html(res, 409, proposalPage(payload, token, error.message));
    }
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

  if (req.method === "GET" && url.pathname === "/api/icloud/availability") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const squareFeet = Number(url.searchParams.get("squareFeet"));
      const durationMinutes = Number.isFinite(squareFeet) && squareFeet > 0
        ? appointmentDurationMinutes(squareFeet)
        : schedulingPolicy().defaultAppointmentMinutes;
      const days = Math.min(14, Math.max(1, Number(url.searchParams.get("days")) || 7));
      const result = await workerAvailability({
        startDate: clean(url.searchParams.get("startDate")) || localDate(),
        days,
        durationMinutes
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, 502, { error: "iCloud availability query failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/icloud/appointments/dry-run") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const requestBody = await readJsonBody(req);
      const squareFeet = Number(requestBody.squareFeet);
      const durationMinutes = appointmentDurationMinutes(squareFeet);
      if (!durationMinutes) return json(res, 400, { error: "squareFeet must be a positive number" });
      const days = Math.min(14, Math.max(1, Number(requestBody.days) || 7));
      const availability = await workerAvailability({
        startDate: clean(requestBody.startDate) || localDate(),
        days,
        durationMinutes
      });
      const plan = planAppointments({
        availability,
        squareFeet,
        service: requestBody.service,
        nearbyToSarah: requestBody.nearbyToSarah === true,
        milesFromSarah: requestBody.milesFromSarah,
        bookedThisWeek: requestBody.bookedThisWeek,
        bookedToday: requestBody.bookedToday,
        count: requestBody.count
      });
      return json(res, 200, { ...plan, availability: { startDate: availability.startDate, days: availability.days } });
    } catch (error) {
      return json(res, 502, { error: "Dry-run appointment planning failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/icloud/appointments/hold") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!provisionalHoldEnabled()) {
      return json(res, 503, { error: "Provisional holds are disabled", enabled: false, eventCreated: false });
    }
    try {
      const requestBody = await readJsonBody(req);
      const start = validDate(requestBody.start);
      const end = validDate(requestBody.end);
      const expiresAt = validDate(requestBody.expiresAt);
      const jobKey = clean(requestBody.jobKey);
      const worker = clean(requestBody.worker || requestBody.calendar).toLowerCase();
      if (!jobKey || !worker || !start || !end || !expiresAt || end <= start) {
        return json(res, 400, { error: "worker, jobKey, start, end, and expiresAt are required; end must follow start" });
      }
      const now = Date.now();
      if (expiresAt.getTime() <= now || expiresAt.getTime() > now + 24 * 60 * 60 * 1000) {
        return json(res, 400, { error: "expiresAt must be in the future and within 24 hours" });
      }
      const discovered = await discoverCalendars({
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD)
      });
      const roster = buildRoster(discovered.calendars);
      const calendar = workerCalendar(roster, worker);
      if (!calendar) return json(res, 400, { error: "Unknown or non-bookable worker calendar" });
      const id = holdId({ jobKey, worker: calendar.name, start: start.toISOString() });
      const result = await createProvisionalHold({
        calendar,
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD),
        uid: id,
        start,
        end,
        expiresAt,
        summary: clean(requestBody.summary) || `FloorPlanDrawings provisional hold — ${jobKey}`,
        description: clean(requestBody.description) || "Provisional appointment hold; not yet confirmed"
      });
      return json(res, result.duplicate ? 409 : 201, {
        readOnly: false,
        provisional: true,
        eventCreated: result.created,
        duplicate: result.duplicate,
        holdId: id,
        worker: calendar.name,
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: expiresAt.toISOString(),
        calendarUrl: result.url
      });
    } catch (error) {
      return json(res, 502, { error: "Provisional hold failed", detail: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname === "/api/icloud/appointments/hold") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!provisionalHoldEnabled()) {
      return json(res, 503, { error: "Provisional holds are disabled", enabled: false, eventDeleted: false });
    }
    try {
      const requestBody = await readJsonBody(req);
      const id = clean(requestBody.holdId || url.searchParams.get("holdId"));
      const worker = clean(requestBody.worker || url.searchParams.get("worker"));
      if (!/^fpd-hold-[a-f0-9]{64}$/.test(id) || !worker) {
        return json(res, 400, { error: "A valid holdId and worker are required" });
      }
      const discovered = await discoverCalendars({
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD)
      });
      const calendar = workerCalendar(buildRoster(discovered.calendars), worker);
      if (!calendar) return json(res, 400, { error: "Unknown or non-bookable worker calendar" });
      const result = await releaseProvisionalHold({
        calendar,
        email: clean(process.env.ICLOUD_EMAIL),
        password: clean(process.env.ICLOUD_APP_PASSWORD),
        uid: id
      });
      return json(res, 200, { provisional: true, eventDeleted: result.released, missing: result.missing, holdId: id, worker: calendar.name });
    } catch (error) {
      return json(res, 502, { error: "Provisional hold release failed", detail: error.message });
    }
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

  if (req.method === "GET" && url.pathname === "/api/airtable/availability-proposal/preview") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const built = await buildAppointmentProposal(clean(url.searchParams.get("recordId")), {
        startDate: clean(url.searchParams.get("startDate")),
        days: url.searchParams.get("days"),
        count: url.searchParams.get("count"),
        nearbyToSarah: url.searchParams.get("nearbyToSarah") === "true",
        milesFromSarah: url.searchParams.get("milesFromSarah")
      });
      return json(res, 200, { ok: true, readOnly: true, dryRun: true, recordId: built.job.recordId, address: built.job.propertyAddress, options: built.plan.recommendations, expiresAt: built.payload.expiresAt });
    } catch (error) {
      return json(res, 409, { error: "Appointment availability preview failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/airtable/send-availability-proposal") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!appointmentProposalEnabled()) return json(res, 503, { error: "Appointment proposal sending is disabled", eventCreated: false });
    try {
      const body = await readJsonBody(req);
      const result = await sendAvailabilityProposal(clean(url.searchParams.get("recordId")), body);
      return json(res, result.status, result);
    } catch (error) {
      return json(res, 502, { error: "Appointment proposal delivery failed", detail: error.message });
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

  if (req.method === "GET" && url.pathname === "/api/airtable/workflow-preview") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const workflow = clean(url.searchParams.get("workflow")).toLowerCase();
      const candidates = workflow === "new request"
        ? await listNewRequestCandidates()
        : workflow === "property review needed"
          ? await listPropertyReviewCandidates()
          : workflow === "follow-up"
            ? await listFollowUpCandidates()
            : [];
      const jobs = [];
      for (const candidate of candidates) jobs.push(await getJob(candidate.id));
      const emails = workflow === "new request"
        ? jobs.map((job) => ({ recordId: job.recordId, ...newRequestEmail(job) }))
        : workflow === "property review needed"
          ? jobs.map((job) => ({ recordId: job.recordId, ...propertyReviewEmail(job) }))
          : workflow === "follow-up"
            ? [{ recordId: "daily-follow-up", ...followUpEmail(jobs, localDate()) }]
            : [];
      if (url.searchParams.get("includeHtml") !== "true") emails.forEach((email) => { delete email.html; });
      return json(res, 200, { ok: true, readOnly: true, dryRun: true, workflow, candidateCount: jobs.length, emails });
    } catch (error) {
      return json(res, 502, { error: "Workflow preview failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/test") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });

    const recipient = TEST_EMAIL_RECIPIENT;

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

  if (req.method === "POST" && url.pathname === "/api/email/test-follow-up") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    const recipient = TEST_EMAIL_RECIPIENT;
    try {
      const sample = followUpEmail(buildTestFollowUp(), localDate());
      const delivery = await sendMail({
        to: recipient,
        subject: `[TEST — NO WORKFLOW] ${sample.subject}`,
        html: sample.html,
        text: sample.text
      });
      return json(res, 200, { ok: true, test: true, workflow: "FOLLOW-UP", recipient, ...delivery });
    } catch (error) {
      return json(res, 502, { error: "Follow-up test email delivery failed", detail: error.message });
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
  setTimeout(pollNewRequests, 5000).unref();
  setInterval(pollNewRequests, Number(process.env.NEW_REQUEST_POLL_MS) || 60000).unref();
  setTimeout(pollPropertyReviews, 6000).unref();
  setInterval(pollPropertyReviews, Number(process.env.PROPERTY_REVIEW_POLL_MS) || 60000).unref();
  setTimeout(pollQuoteReady, 5000).unref();
  setInterval(pollQuoteReady, Number(process.env.QUOTE_READY_POLL_MS) || 60000).unref();
  setTimeout(pollClientQuotes, 8000).unref();
  setInterval(pollClientQuotes, Number(process.env.CLIENT_QUOTE_POLL_MS) || 60000).unref();
  setTimeout(pollFollowUps, 10000).unref();
  setInterval(pollFollowUps, Number(process.env.FOLLOW_UP_POLL_MS) || 60000).unref();
});

const http = require("node:http");
const crypto = require("node:crypto");
const {
  createProvisionalHold,
  discoverCalendars,
  getCalendarEvents,
  getCalendarAvailability,
  releaseProvisionalHold
} = require("./icloud");
const { buildRoster } = require("./calendar-roster");
const { appointmentDurationMinutes, deliveryTargetForWeekday, schedulingPolicy } = require("./scheduling-policy");
const { planAppointments } = require("./appointment-planner");
const { calendarAirtableFields, calendarEventKey, extractAddress, findProjectMatch, isLikelyWorkEvent, normalizeAddress } = require("./calendar-sync");
const { proposalPayload, signProposal, verifyProposal } = require("./appointment-proposals");
const { hasFallbackSmtp, isSmtpConfigured, sendFailureAlert, sendMail, verifySmtp } = require("./mail");
const { projectState, recipientsFor } = require("./project-state");
const { createGmailClient, isGmailConfigured, isLikelyFloorPlanIntake, parseGmailMessage, processIntakeMessages } = require("./gmail-runtime");
const { findGmailAirtableMatch, gmailAirtableFields, patchMissingGmailFields } = require("./gmail-airtable-sync");
const {
  clientQuoteEmail,
  clientAvailabilityProposalEmail,
  clientAppointmentConfirmationEmail,
  clientAppointmentReminderEmail,
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
  listFailedDeliveries,
  listFollowUpCandidates,
  listNewRequestCandidates,
  listPropertyReviewCandidates,
  listQuoteReadyCandidates,
  listJobs,
  communicationKey,
  updateCommunicationLog,
  updateJob
} = require("./airtable");
const {
  createAirtableIntakeRecord,
  intakeAuthorized,
  validateIntakeEnvelope
} = require("./intake");

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
const appointmentLifecycleLocks = new Set();
let appointmentReminderPollRunning = false;
let calendarSyncPollRunning = false;

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function syncProjectState(job, patch = {}) {
  return projectState.upsertProject({
    id: job.recordId,
    source: "airtable",
    sourceId: job.recordId,
    propertyAddress: job.propertyAddress,
    clientName: job.clientName,
    status: patch.status || job.status || "new",
    stage: patch.stage || job.workflow || "intake",
    contacts: {
      client: job.clientEmail,
      agent: job.agentEmail,
      internal: clean(process.env.SMTP_USER),
      policy: job.recipientPolicy || "client",
      policyExplicit: Boolean(job.recipientPolicy)
    },
    metadata: {
      service: job.service,
      quoteZone: job.quoteZone,
      gmailThreadId: job.gmailThreadId,
      ...patch.metadata
    }
  });
}

function messageRecipients(job, purpose) {
  const project = syncProjectState(job);
  return { project, to: recipientsFor(purpose, project.contacts) };
}

function reserveRenderDelivery({ project, workflow, recipientType, to, subject, version = "v1" }) {
  return projectState.reserveDelivery({
    projectId: project.id,
    idempotencyKey: `${project.id}:${clean(workflow).toLowerCase().replace(/[^a-z0-9]+/g, "_")}:${version}`,
    workflow,
    recipientType,
    recipients: to,
    subject
  });
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
    gmailApiIntake: isGmailConfigured(),
    gmailIntakePollEnabled: gmailIntakePollEnabled(),
    gmailAirtableSyncEnabled: gmailAirtableSyncEnabled(),
    gmailAutoLabelEnabled: gmailAutoLabelEnabled(),
    renderStateDurable: Boolean(clean(process.env.STATE_FILE)),
    icloud: Boolean(process.env.ICLOUD_EMAIL && process.env.ICLOUD_APP_PASSWORD),
    googleMaps: Boolean(process.env.GOOGLE_MAPS_STATIC_KEY || process.env.GOOGLE_MAPS_SERVER_KEY),
    postgres: Boolean(process.env.DATABASE_URL),
    quoteReadySendEnabled: clean(process.env.ENABLE_QUOTE_READY_SENDS).toLowerCase() === "true",
    clientQuoteSendEnabled: clean(process.env.ENABLE_CLIENT_QUOTE_SENDS).toLowerCase() === "true",
    provisionalHoldsEnabled: provisionalHoldEnabled(),
    newRequestSendEnabled: newRequestEnabled(),
    propertyReviewSendEnabled: propertyReviewEnabled(),
    followUpSendEnabled: followUpEnabled(),
    shadowMode: {
      all: shadowEnabled("ALL"),
      newRequest: shadowEnabled("NEW_REQUEST"),
      propertyReview: shadowEnabled("PROPERTY_REVIEW"),
      quoteReady: shadowEnabled("QUOTE_READY"),
      clientQuote: shadowEnabled("CLIENT_QUOTE"),
      followUp: shadowEnabled("FOLLOW_UP")
    },
    appointmentProposalSendEnabled: appointmentProposalEnabled(),
    clientQuoteSchedulingEnabled: clientQuoteSchedulingEnabled(),
    deliveryAlertsEnabled: Boolean(clean(process.env.DELIVERY_ALERT_EMAIL)),
    smtpFallbackConfigured: hasFallbackSmtp(),
    appointmentProposalHoldEnabled: provisionalHoldEnabled(),
    appointmentConfirmationEnabled: appointmentConfirmationEnabled(),
    appointmentReminderEnabled: appointmentReminderEnabled(),
    gmailIntakeNotificationEnabled: gmailIntakeNotificationEnabled(),
    calendarAirtableSyncEnabled: calendarAirtableSyncEnabled(),
    calendarGmailLabelSyncEnabled: calendarGmailLabelSyncEnabled()
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

function shadowEnabled(workflow) {
  const normalized = clean(workflow).toUpperCase();
  const aliases = {
    "NEW REQUEST": "NEW_REQUEST",
    "PROPERTY REVIEW NEEDED": "PROPERTY_REVIEW",
    "QUOTE READY": "QUOTE_READY",
    "CLIENT QUOTE": "CLIENT_QUOTE",
    "FOLLOW-UP": "FOLLOW_UP"
  };
  const key = aliases[normalized] || normalized.replace(/[^A-Z0-9]+/g, "_");
  return clean(process.env.SHADOW_MODE).toLowerCase() === "true"
    || clean(process.env[`SHADOW_${key}`]).toLowerCase() === "true";
}

function appointmentProposalEnabled() {
  return clean(process.env.ENABLE_APPOINTMENT_PROPOSALS).toLowerCase() === "true";
}

// The availability board can stay enabled for Anna's internal testing while
// client quote emails remain opt-in behind a separate production flag.
function clientQuoteSchedulingEnabled() {
  return appointmentProposalEnabled()
    && clean(process.env.ENABLE_CLIENT_QUOTE_SCHEDULING).toLowerCase() === "true";
}

function provisionalHoldEnabled() {
  return clean(process.env.ENABLE_PROVISIONAL_HOLDS).toLowerCase() === "true";
}

function appointmentConfirmationEnabled() {
  return clean(process.env.ENABLE_APPOINTMENT_CONFIRMATIONS).toLowerCase() === "true";
}

function appointmentReminderEnabled() {
  return clean(process.env.ENABLE_APPOINTMENT_REMINDERS).toLowerCase() === "true";
}

function gmailIntakePollEnabled() {
  return clean(process.env.ENABLE_GMAIL_INTAKE_POLL).toLowerCase() === "true";
}

function gmailAutoLabelEnabled() {
  return clean(process.env.ENABLE_GMAIL_AUTO_LABEL).toLowerCase() === "true";
}

function gmailAirtableSyncEnabled() {
  return clean(process.env.ENABLE_GMAIL_AIRTABLE_SYNC).toLowerCase() === "true";
}

function gmailIntakeNotificationEnabled() {
  return clean(process.env.ENABLE_GMAIL_INTAKE_NOTIFICATIONS).toLowerCase() === "true";
}

function calendarAirtableSyncEnabled() {
  return clean(process.env.ENABLE_CALENDAR_AIRTABLE_SYNC).toLowerCase() === "true";
}

function calendarGmailLabelSyncEnabled() {
  return clean(process.env.ENABLE_CALENDAR_GMAIL_LABEL_SYNC).toLowerCase() === "true";
}

function calendarSyncRange(input = {}) {
  const startDate = clean(input.startDate) || shiftDate(localDate(), -Math.max(0, Math.min(30, Number(process.env.CALENDAR_SYNC_LOOKBACK_DAYS) || 7)));
  const days = Math.max(1, Math.min(90, Number(input.days) || Number(process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS) || 60));
  return { startDate, days, start: new Date(`${startDate}T00:00:00Z`), end: new Date(`${shiftDate(startDate, days)}T00:00:00Z`) };
}

function airtableCalendarMatch(fields, records = []) {
  const jobId = clean(fields["Job ID"]);
  const eventUid = clean(fields["Calendar Event UID"]);
  const calendarUrl = clean(fields["Calendar URL"]);
  const address = normalizeAddress(fields["Property Address"]);
  const start = clean(fields["Calendar Event Start"]);
  return records.find((record) => {
    const existing = record && record.fields || {};
    if (jobId && clean(existing["Job ID"]) === jobId) return true;
    if (eventUid && clean(existing["Calendar Event UID"]) === eventUid && (!calendarUrl || clean(existing["Calendar URL"]) === calendarUrl)) return true;
    if (address && normalizeAddress(existing["Property Address"] || existing.Address) === address) {
      const existingStart = clean(existing["Calendar Event Start"] || existing["Appointment Start"] || existing["Appointment Date"]);
      return !start || !existingStart || new Date(existingStart).getTime() === new Date(start).getTime();
    }
    return false;
  }) || null;
}

function knownAirtablePatch(record, fields) {
  const existing = record && record.fields ? record.fields : {};
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => Object.prototype.hasOwnProperty.call(existing, key) && value !== "")
    .map(([key, value]) => [key, key === "Source Channels"
      ? [...new Set(`${clean(existing[key])},${clean(value)}`.split(",").map(clean).filter(Boolean))].join(", ")
      : value]));
}

async function findGmailThreadMatch(event, client, cache, errors = []) {
  const address = extractAddress(event);
  if (!client || !address) return null;
  const key = normalizeAddress(address);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let match = null;
  try {
    // Read-only search. Do not constrain this lookup to the intake label: a thread
    // may have progressed to scheduling, revision, delivery, or closed.
    const listed = await client.listMessages({ labelId: "", query: `"${address}"`, maxResults: 10 });
    for (const item of listed.messages || []) {
      if (!clean(item && item.id)) continue;
      const parsed = parseGmailMessage(await client.getMessage(item.id), {
        agentEmails: client.config && client.config.agentEmails,
        clientEmails: client.config && client.config.clientEmails
      });
      const parsedAddress = normalizeAddress(parsed.propertyAddress);
      const searchable = normalizeAddress(`${parsed.propertyAddress} ${parsed.subject} ${parsed.text}`);
      if (parsedAddress === key || searchable.includes(key)) {
        match = parsed;
        break;
      }
    }
  } catch (error) {
    errors.push({ address, error: error.message });
  }
  cache.set(key, match);
  return match;
}

async function applyGmailIntakeLabel(client, match) {
  const labelId = client && client.config && clean(client.config.intakeLabelId);
  const threadId = match && clean(match.threadId);
  if (!client || !labelId || !threadId) return { ok: false, reason: "Gmail label or thread is unavailable" };
  const thread = typeof client.getThread === "function" ? await client.getThread(threadId) : null;
  const ids = [...new Set((thread && thread.messages || []).map((message) => clean(message && message.id)).filter(Boolean))];
  if (match.id && !ids.includes(match.id)) ids.unshift(match.id);
  if (!ids.length) return { ok: false, reason: "Gmail thread contains no labelable messages" };
  for (const id of ids.slice(0, 100)) await client.modifyLabels(id, { addLabelIds: [labelId] });
  return { ok: true, threadId, messageCount: Math.min(ids.length, 100), labelId };
}

const DEFAULT_GMAIL_AUTO_LABEL_QUERY = 'newer_than:3d -in:spam -in:trash -label:"[FPD] Intake" {floorplan "floor plan" "site plan" "sq ft" "square feet" matterport "new request" "quick quote" measure listing}';

async function autoLabelGmailIntake(client) {
  const config = client && client.config;
  if (!gmailAutoLabelEnabled()) return { enabled: false, labeled: [], skipped: [], errors: [] };
  if (!client || !config || !config.intakeLabelId) return { enabled: true, labeled: [], skipped: [], errors: ["Gmail intake label is not configured"] };
  const query = config.autoLabelQuery || DEFAULT_GMAIL_AUTO_LABEL_QUERY;
  const listed = await client.listMessages({ labelId: "", query, maxResults: config.autoLabelMaxResults || 50 });
  const seenThreads = new Set();
  const labeled = [], skipped = [], errors = [];
  for (const item of listed.messages || []) {
    const id = clean(item && item.id);
    if (!id) continue;
    try {
      const raw = await client.getMessage(id);
      const parsed = parseGmailMessage(raw, { agentEmails: config.agentEmails, clientEmails: config.clientEmails });
      if (!isLikelyFloorPlanIntake(parsed)) { skipped.push({ id, reason: "Heuristic did not meet address + FPD marker threshold" }); continue; }
      const threadId = clean(parsed.threadId || item.threadId);
      if (!threadId || seenThreads.has(threadId)) continue;
      seenThreads.add(threadId);
      const result = await applyGmailIntakeLabel(client, { id, threadId });
      if (result.ok) labeled.push({ threadId, messageCount: result.messageCount, subject: parsed.subject, propertyAddress: parsed.propertyAddress });
      else errors.push({ id, threadId, error: result.reason });
    } catch (error) {
      errors.push({ id, error: error.message });
    }
  }
  return { enabled: true, query, labeled, skipped, errors, nextPageToken: listed.nextPageToken || "" };
}

async function syncGmailMessageToAirtable(message, project, airtableRecords = []) {
  if (!gmailAirtableSyncEnabled()) return { action: "skipped", reason: "disabled" };
  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    throw new Error("Gmail-to-Airtable sync is enabled but Airtable is not configured");
  }
  const address = clean(message && message.propertyAddress || project && project.propertyAddress);
  const threadId = clean(message && message.threadId || project && project.metadata && project.metadata.gmailThreadId);
  if (!address || !threadId) return { action: "skipped", reason: !address ? "property address is missing" : "Gmail thread ID is missing" };
  const existing = findGmailAirtableMatch(airtableRecords, { threadId, propertyAddress: address });
  const fields = gmailAirtableFields(message, project, existing);
  if (existing) {
    const patch = patchMissingGmailFields(existing, fields);
    if (Object.keys(patch).length) await updateJob(existing.id, patch);
    return { action: "matched", recordId: existing.id, patchFields: Object.keys(patch), key: fields["Normalized Property Key"] };
  }
  const created = await createAirtableIntakeRecord({ fields });
  const record = created.record || {};
  if (record && record.id) airtableRecords.push(record);
  if (created.duplicate && record.id) {
    const patch = patchMissingGmailFields(record, fields);
    if (Object.keys(patch).length) await updateJob(record.id, patch);
    return { action: "matched", duplicate: true, recordId: record.id, patchFields: Object.keys(patch), key: fields["Normalized Property Key"] };
  }
  return { action: "created", recordId: record.id || "", key: fields["Normalized Property Key"], omittedFields: created.omittedFields || [] };
}

async function backfillGmailProjectsToAirtable(client, airtableRecords, results) {
  if (!gmailAirtableSyncEnabled()) return;
  const cap = Math.max(0, Math.min(25, Number(process.env.GMAIL_AIRTABLE_BACKFILL_MAX) || 5));
  let attempted = 0;
  for (const project of projectState.listProjects({ limit: 500 })) {
    if (attempted >= cap || project.source !== "gmail" || !project.propertyAddress) continue;
    const threadId = clean(project.metadata && project.metadata.gmailThreadId);
    if (!threadId || findGmailAirtableMatch(airtableRecords, { threadId, propertyAddress: project.propertyAddress })) continue;
    const messageId = clean(project.metadata && project.metadata.gmailMessageId);
    if (!messageId) continue;
    attempted += 1;
    try {
      const raw = await client.getMessage(messageId);
      const parsed = parseGmailMessage(raw, { agentEmails: client.config.agentEmails, clientEmails: client.config.clientEmails });
      const synced = await syncGmailMessageToAirtable(parsed, project, airtableRecords);
      results.push({ messageId, threadId, backfill: true, ...synced });
    } catch (error) {
      results.push({ messageId, threadId, backfill: true, action: "error", error: error.message });
    }
  }
}

async function syncCalendarToAirtable(input = {}) {
  const range = calendarSyncRange(input);
  const dryRun = input.dryRun === undefined ? true : Boolean(input.dryRun);
  if (!dryRun && !calendarAirtableSyncEnabled()) return { ok: false, status: 503, error: "Calendar-to-Airtable sync is disabled" };
  const discovered = await discoverCalendars({ email: clean(process.env.ICLOUD_EMAIL), password: clean(process.env.ICLOUD_APP_PASSWORD) });
  const roster = buildRoster(discovered.calendars);
  const calendars = [...(roster.owner ? [roster.owner] : []), ...roster.workers];
  const calendarResults = await getCalendarEvents({ email: clean(process.env.ICLOUD_EMAIL), password: clean(process.env.ICLOUD_APP_PASSWORD), calendars, start: range.start, end: range.end });
  const renderProjects = projectState.listProjects({ limit: 500 });
  const airtableRecords = await listJobs({ maxRecords: 500 });
  const gmailClient = isGmailConfigured() ? createGmailClient() : null;
  const gmailCache = new Map();
  const gmailLookupErrors = [];
  const gmailLabelErrors = [];
  const results = [];
  const skipped = [];
  for (const result of calendarResults) {
    for (const event of result.events || []) {
      const calendar = result.calendar;
      if (!isLikelyWorkEvent(event)) {
        skipped.push({ calendar: calendar.name, uid: clean(event.uid), summary: clean(event.summary), reason: "No work marker or property address" });
        continue;
      }
      const key = calendarEventKey(calendar, event);
      const project = findProjectMatch(event, calendar, renderProjects);
      const projectThreadId = project && project.metadata && clean(project.metadata.gmailThreadId);
      const gmailMatch = projectThreadId
        ? { threadId: projectThreadId, id: project.metadata.gmailMessageId || "" }
        : await findGmailThreadMatch(event, gmailClient, gmailCache, gmailLookupErrors);
      const fields = calendarAirtableFields(calendar, event, project, gmailMatch);
      let gmailLabelApplied = false;
      if (!dryRun && calendarGmailLabelSyncEnabled() && gmailMatch) {
        try {
          const labelResult = await applyGmailIntakeLabel(gmailClient, gmailMatch);
          gmailLabelApplied = Boolean(labelResult.ok);
          if (!labelResult.ok) gmailLabelErrors.push({ threadId: gmailMatch.threadId, error: labelResult.reason });
        } catch (error) {
          gmailLabelErrors.push({ threadId: gmailMatch.threadId, error: error.message });
        }
      }
      const existing = airtableCalendarMatch(fields, airtableRecords);
      const action = existing ? "matched" : "create";
      let airtableRecordId = existing && existing.id || "";
      if (project && !dryRun) {
        projectState.upsertProject({
          ...project,
          status: project.status === "closed" ? project.status : "scheduled",
          stage: project.stage === "closed" ? project.stage : "scheduled",
          metadata: {
            ...project.metadata,
            calendarEvent: {
              uid: clean(event.uid),
              calendarName: clean(calendar.name),
              calendarUrl: clean(calendar.url),
              start: event.start && event.start.toISOString ? event.start.toISOString() : clean(event.start),
              end: event.end && event.end.toISOString ? event.end.toISOString() : clean(event.end),
              summary: clean(event.summary),
              airtableRecordId
            }
          }
        });
      }
      if (!dryRun && existing) {
        const patch = knownAirtablePatch(existing, fields);
        if (Object.keys(patch).length) await updateJob(existing.id, patch);
      } else if (!dryRun && !existing) {
        const created = await createAirtableIntakeRecord({ fields });
        airtableRecordId = created.record && created.record.id || "";
        airtableRecords.push(created.record);
      }
      if (!dryRun && project && airtableRecordId) {
        const current = projectState.getProject(project.id);
        if (current) projectState.updateProjectProgress(project.id, {
          metadata: { calendarEvent: { ...(current.metadata && current.metadata.calendarEvent), airtableRecordId } },
          note: "Calendar event reconciled to Airtable"
        }, "render");
      }
      results.push({
        key,
        action,
        dryRun,
        calendar: calendar.name,
        uid: clean(event.uid),
        summary: clean(event.summary),
        propertyAddress: extractAddress(event) || fields["Property Address"],
        start: fields["Calendar Event Start"],
        airtableRecordId,
        renderProjectId: project && project.id || "",
        gmailThreadId: fields["Gmail Thread ID"],
        gmailMatched: Boolean(gmailMatch),
        gmailLabelApplied
      });
    }
  }
  return { ok: true, readOnly: dryRun, startDate: range.startDate, days: range.days, calendars: calendars.map((calendar) => calendar.name), imported: results.filter((item) => item.action === "create").length, matched: results.filter((item) => item.action === "matched").length, gmailMatched: results.filter((item) => item.gmailMatched).length, gmailLabelsApplied: results.filter((item) => item.gmailLabelApplied).length, gmailLookupErrors, gmailLabelErrors, skipped: skipped.length, skippedEvents: skipped, results };
}

async function pollCalendarAirtableSync() {
  if (!calendarAirtableSyncEnabled() || calendarSyncPollRunning) return;
  calendarSyncPollRunning = true;
  try {
    const result = await syncCalendarToAirtable({ dryRun: false });
    console.log(`CALENDAR sync: ${result.imported} created, ${result.matched} matched`);
  } catch (error) {
    console.error(`CALENDAR sync failed: ${error.message}`);
  } finally {
    calendarSyncPollRunning = false;
  }
}

async function deliverGmailIntakeNotification(project, message) {
  if (!project.propertyAddress) return { ok: false, skipped: true, reason: "Property address is missing" };
  const internalTo = [clean(process.env.SMTP_USER)];
  if (!internalTo[0]) throw new Error("SMTP_USER is not configured");
  const threadUrl = message.threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}` : "";
  const job = {
    ...projectLifecycleJob(project),
    workflow: "Gmail Intake",
    quoteNotes: "Incoming email was labeled for FloorPlanDrawings intake. Review the extracted address and details before quoting.",
    gmailThreadUrl: threadUrl
  };
  const email = newRequestEmail(job);
  const reservation = projectState.reserveDelivery({
    projectId: project.id,
    idempotencyKey: `${project.id}:gmail_intake_notification:v1`,
    workflow: "GMAIL INTAKE",
    recipientType: "internal",
    recipients: internalTo,
    subject: email.subject
  });
  if (reservation.duplicate) return { ok: false, duplicate: true, deliveryId: reservation.delivery.id };
  const threadHeaders = [message.references, message.messageId].filter(Boolean).join(" ");
  try {
    const delivery = await sendMail({
      to: internalTo,
      subject: message.subject ? `Re: ${message.subject.replace(/^re:\s*/i, "")}` : email.subject,
      html: email.html,
      text: email.text,
      headers: threadHeaders ? {
        ...(message.messageId ? { "In-Reply-To": message.messageId } : {}),
        References: threadHeaders
      } : undefined
    });
    projectState.updateDelivery(reservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
    return { ok: true, delivery: "sent", messageId: delivery.messageId };
  } catch (error) {
    projectState.updateDelivery(reservation.delivery.idempotencyKey, { status: "failed", error: error.message });
    await sendFailureAlert({ workflow: "GMAIL INTAKE", recordId: project.id, error });
    throw error;
  }
}

async function ingestGmailMessage(message) {
  const source = message.contacts && message.contacts.source;
  const clientContacts = message.contacts && message.contacts.client || [];
  const agentContacts = message.contacts && message.contacts.agent || [];
  const policy = clientContacts.length && !agentContacts.length ? "client" : agentContacts.length && !clientContacts.length ? "agent" : "";
  const projectId = `gmail-${clean(message.threadId || message.id).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const project = projectState.upsertProject({
    id: projectId,
    source: "gmail",
    sourceId: clean(message.threadId || message.id),
    status: "new",
    stage: "intake",
    propertyAddress: message.propertyAddress,
    clientName: message.clientName || (clientContacts[0] && clientContacts[0].name),
    contacts: {
      client: clientContacts.map((contact) => contact.email),
      agent: agentContacts.map((contact) => contact.email),
      internal: clean(process.env.SMTP_USER),
      policy,
      policyExplicit: Boolean(policy)
    },
    metadata: {
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      gmailMessageIdHeader: message.messageId,
      subject: message.subject,
      sourceEmail: source && source.email,
      sourceName: source && source.name,
      receivedAt: message.date || message.internalDate,
      replyTo: (message.replyTo || []).map((contact) => contact.email),
      references: message.references,
      intakeLabelIds: message.labelIds
    }
  });
  projectState.event({ projectId: project.id, type: "gmail.message.received", data: { messageId: message.id, threadId: message.threadId, subject: message.subject } });
  if (gmailIntakeNotificationEnabled()) await deliverGmailIntakeNotification(project, message);
  return project;
}

async function pollGmailIntake() {
  if (!isGmailConfigured()) return { ok: false, skipped: true, reason: "Gmail OAuth or intake label is not configured" };
  const client = createGmailClient();
  const airtableRecords = gmailAirtableSyncEnabled() ? await listJobs({ maxRecords: 500 }) : [];
  const airtableSync = [];
  const store = {
    has: async (key) => projectState.hasProcessedMessage(key),
    mark: async (key) => projectState.markProcessedMessage(key)
  };
  const autoLabel = await autoLabelGmailIntake(client);
  const result = await processIntakeMessages({
    client,
    store,
    onMessage: async (message) => {
      const project = await ingestGmailMessage(message);
      if (gmailAirtableSyncEnabled()) {
        const synced = await syncGmailMessageToAirtable(message, project, airtableRecords);
        airtableSync.push({ messageId: message.id, threadId: message.threadId, ...synced });
      }
      return project;
    },
    options: { agentEmails: client.config.agentEmails, clientEmails: client.config.clientEmails }
  });
  // Re-enrich previously ingested Gmail projects after parser/config changes.
  // This is read-only against Gmail and only updates missing structured fields.
  const configuredAgents = new Set(client.config.agentEmails);
  const configuredClients = new Set(client.config.clientEmails);
  for (const project of projectState.listProjects({}).filter((item) => {
    if (item.source !== "gmail" || !item.metadata || !item.metadata.gmailMessageId) return false;
    const sourceEmail = clean(item.metadata.sourceEmail).toLowerCase();
    const roleNeedsRefresh = (configuredAgents.has(sourceEmail) && !(item.contacts.agent || []).includes(sourceEmail))
      || (configuredClients.has(sourceEmail) && !(item.contacts.client || []).includes(sourceEmail));
    return !item.propertyAddress || !item.clientName || roleNeedsRefresh || Object.prototype.hasOwnProperty.call(item.metadata, "textSnippet");
  })) {
    try {
      const raw = await client.getMessage(project.metadata.gmailMessageId);
      const parsed = parseGmailMessage(raw, { agentEmails: client.config.agentEmails, clientEmails: client.config.clientEmails });
      const metadata = Object.fromEntries(Object.entries(project.metadata || {}).filter(([key]) => key !== "textSnippet"));
      projectState.upsertProject({
        ...project,
        propertyAddress: project.propertyAddress || parsed.propertyAddress,
        clientName: project.clientName || parsed.clientName,
        metadata,
        contacts: {
          ...project.contacts,
          client: parsed.contacts.client.map((contact) => contact.email),
          agent: parsed.contacts.agent.map((contact) => contact.email),
          policy: parsed.contacts.client.length && !parsed.contacts.agent.length ? "client" : parsed.contacts.agent.length && !parsed.contacts.client.length ? "agent" : "internal",
          policyExplicit: Boolean(project.contacts.policyExplicit || parsed.contacts.client.length || parsed.contacts.agent.length)
        }
      });
    } catch (error) {
      console.warn(`Gmail project enrichment failed for ${project.id}: ${error.message}`);
    }
  }
  await backfillGmailProjectsToAirtable(client, airtableRecords, airtableSync);
  const processed = result.processed.map((message) => ({ id: message.id, threadId: message.threadId, subject: message.subject }));
  if (clean(process.env.GMAIL_PROCESSED_LABEL_ID) && processed.length) {
    for (const message of result.processed) {
      await client.modifyLabels(message.id, { addLabelIds: [clean(process.env.GMAIL_PROCESSED_LABEL_ID)] });
    }
  }
  return { ok: true, autoLabel, processed, skipped: result.skipped, airtableSync, nextPageToken: result.nextPageToken };
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
    const params = new URLSearchParams(body);
    return [...params.entries()].reduce((result, [key, value]) => {
      if (!(key in result)) result[key] = value;
      else result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
      return result;
    }, {});
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

function canonicalWorkerName(value) {
  return clean(value).toLowerCase() === "ricardo" ? "ricky" : clean(value).toLowerCase();
}

function isoDate(value) {
  const parsed = new Date(`${clean(value)}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function shiftDate(dateValue, days) {
  const parsed = new Date(`${clean(dateValue)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function weekStartDate(value = localDate()) {
  const date = new Date(`${isoDate(value) || localDate()}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(startDate) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${shiftDate(startDate, 6)}T12:00:00Z`);
  const format = (date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${format(start)} – ${format(end)}`;
}

function slotSelectionToken(slot) {
  return Buffer.from(JSON.stringify({
    worker: canonicalWorkerName(slot.worker || slot.calendarName),
    calendarName: clean(slot.calendarName),
    date: clean(slot.date),
    start: clean(slot.start),
    end: clean(slot.end),
    durationMinutes: Number(slot.durationMinutes) || null
  })).toString("base64url");
}

function parseSlotSelection(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (!parsed || !parsed.start || !parsed.end || !parsed.date) return null;
    return parsed;
  } catch {
    return null;
  }
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
  return { job, availability, plan, payload };
}

function appointmentReviewUrl(recordId, token, startDate) {
  if (recordId === "test-board") {
    const testUrl = new URL("https://floor-plan-drawings.onrender.com/api/email/test-scheduling-board");
    testUrl.searchParams.set("startDate", startDate);
    return testUrl.href;
  }
  const base = clean(process.env.PROPOSAL_REVIEW_BASE_URL) || "https://floor-plan-drawings.onrender.com/api/scheduling/proposal/start";
  const url = new URL(base);
  url.searchParams.set("recordId", recordId);
  url.searchParams.set("token", token);
  url.searchParams.set("startDate", startDate);
  return url.href;
}

function boardSlotTime(slot) {
  const match = clean(slot.localStart).match(/(?:T|\s)(\d{1,2}:\d{2})$/);
  const value = match ? match[1] : clean(slot.localStart);
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

async function buildAppointmentBoard(recordId, input = {}) {
  const startDate = weekStartDate(input.startDate || localDate());
  const built = await buildAppointmentProposal(recordId, { ...input, startDate, days: 7, count: 5 });
  const recommended = new Set(built.plan.recommendations.map((slot) => `${canonicalWorkerName(slot.worker)}|${slot.start}|${slot.end}`));
  return { ...built, startDate, recommended };
}

function testAppointmentBoard(startDate) {
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(startDate, index));
  const calendars = ["corrie", "ricardo", "sarah"].map((name, workerIndex) => ({
    name,
    url: "https://example.com/test-calendar",
    busy: [],
    slots: dates.flatMap((date, dayIndex) => {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if ([0, 6].includes(weekday)) return [];
      return ["11:00", "13:00"].map((time, timeIndex) => {
        const start = new Date(`${date}T${time}:00-07:00`);
        const end = new Date(start.getTime() + 90 * 60000);
        const busy = (workerIndex + dayIndex + timeIndex) % 5 === 0;
        return { date, start: start.toISOString(), end: end.toISOString(), localStart: `${date} ${time}`, available: !busy, conflicts: busy ? ["Busy (test data)"] : [] };
      });
    })
  }));
  const available = calendars.flatMap((calendar) => calendar.slots.filter((slot) => slot.available).slice(0, 1).map((slot) => ({ ...slot, worker: canonicalWorkerName(calendar.name), calendarName: calendar.name })));
  return {
    job: testSchedulingPreviewJob(),
    availability: { readOnly: true, dryRun: true, startDate, days: 7, durationMinutes: 90, calendars },
    startDate,
    plan: { recommendations: available },
    recommended: new Set(available.map((slot) => `${slot.worker}|${slot.start}|${slot.end}`))
  };
}

function appointmentBoardPage({ job, availability, startDate, plan, recommended }, recordId, token, notice = "") {
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(startDate, index));
  const workers = (availability.calendars || []).map((calendar) => ({
    ...calendar,
    worker: canonicalWorkerName(calendar.name),
    label: canonicalWorkerName(calendar.name).replace(/^./, (letter) => letter.toUpperCase())
  }));
  const dayHeader = dates.map((date) => {
    const day = new Date(`${date}T12:00:00Z`);
    const weekend = [0, 6].includes(day.getUTCDay());
    return `<div class="day-header${weekend ? " weekend" : ""}"><strong>${day.toLocaleDateString("en-US", { weekday: "short" })}</strong><span>${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></div>`;
  }).join("");
  const workerRows = workers.map((calendar) => {
    const cells = dates.map((date) => {
      const day = new Date(`${date}T12:00:00Z`).getUTCDay();
      const slots = (calendar.slots || []).filter((slot) => slot.date === date);
      if ([0, 6].includes(day)) return `<div class="day-cell closed"><span>Office closed</span></div>`;
      const content = slots.map((slot) => {
        if (!slot.available) return `<span class="slot busy"><span>${escapeHtml(boardSlotTime(slot))}</span><small>Busy</small></span>`;
        const key = `${calendar.worker}|${slot.start}|${slot.end}`;
        const isRecommended = recommended.has(key);
        const selection = slotSelectionToken({ ...slot, worker: calendar.worker, calendarName: calendar.name, durationMinutes: availability.durationMinutes });
        return `<label class="slot open${isRecommended ? " recommended" : ""}"><input type="checkbox" name="slot" value="${escapeHtml(selection)}"><span>${escapeHtml(boardSlotTime(slot))}</span>${isRecommended ? "<small>Recommended</small>" : "<small>Open</small>"}</label>`;
      }).join("");
      return `<div class="day-cell">${content || "<span class=\"slot busy\"><small>No slot</small></span>"}</div>`;
    }).join("");
    return `<div class="worker-row"><div class="worker-name"><strong>${escapeHtml(calendar.label)}</strong><small>${calendar.worker === "sarah" ? "Nearby spillover" : calendar.worker === "corrie" ? "Primary coverage" : "Secondary coverage"}</small></div>${cells}</div>`;
  }).join("");
  const noticeHtml = notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : "";
  const prevUrl = appointmentReviewUrl(recordId, token, shiftDate(startDate, -7));
  const nextUrl = appointmentReviewUrl(recordId, token, shiftDate(startDate, 7));
  const actionUrl = appointmentReviewUrl(recordId, token, startDate);
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Appointment availability | FloorPlanDrawings</title><style>body{margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{max-width:1180px;margin:22px auto;padding:0 16px}.card{background:#fbf8f1;border:1px solid #ddd7ca;border-radius:20px;padding:34px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.title{margin:10px 0 8px;color:#173f36;font-size:32px;line-height:40px}.copy{color:#53635c;font-size:16px;line-height:25px}.property{margin:18px 0;padding:18px 20px;background:#b8c9ae;border-radius:14px;font-size:18px;font-weight:700}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 0 12px}.toolbar a{color:#0b57d0;font-weight:700;text-decoration:none}.week-label{color:#173f36;font-size:20px;font-weight:700}.board-wrap{overflow-x:auto;border:1px solid #d9d5ca;border-radius:14px;background:#fff}.board{min-width:920px}.week-header,.worker-row{display:grid;grid-template-columns:150px repeat(7,minmax(110px,1fr))}.week-header{border-bottom:1px solid #d9d5ca;background:#e3eadf}.day-header{padding:12px 10px;color:#394842;font-size:13px;text-transform:uppercase;letter-spacing:.08em}.day-header span{display:block;margin-top:4px;font-size:14px;text-transform:none;letter-spacing:0}.day-header.weekend{color:#8a897c}.worker-row{min-height:126px;border-bottom:1px solid #e4e0d6}.worker-row:last-child{border-bottom:0}.worker-name{padding:16px 12px;background:#fbf8f1;border-right:1px solid #e4e0d6}.worker-name strong{display:block;color:#173f36;font-size:16px}.worker-name small,.slot small{display:block;margin-top:5px;color:#6b7067;font-size:12px;line-height:16px}.day-cell{display:flex;flex-direction:column;gap:7px;padding:10px;border-right:1px solid #e4e0d6}.day-cell:last-child{border-right:0}.day-cell.closed{justify-content:center;color:#9a988c;font-size:12px}.slot{display:block;position:relative;border-radius:10px;padding:10px 9px;font-size:14px;line-height:18px}.slot.open{background:#e3eadf;border:1px solid #b8c9ae;cursor:pointer}.slot.open.recommended{box-shadow:inset 0 0 0 2px #6c8f78}.slot.open input{margin:0 6px 0 0;accent-color:#173f36}.slot.busy{background:#f3f1eb;color:#9a988c;border:1px solid #e4e0d6}.slot.busy small{color:#9a988c}.legend{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0;color:#53635c;font-size:13px}.legend span:before{content:"";display:inline-block;width:11px;height:11px;margin-right:5px;border-radius:3px;background:#e3eadf;vertical-align:-1px}.legend .busy:before{background:#f3f1eb;border:1px solid #e4e0d6}.legend .recommended:before{background:#b8c9ae}.actions{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-top:22px}.button{border:0;border-radius:10px;background:#173f36;color:#fff;padding:15px 22px;font-size:16px;font-weight:700;cursor:pointer}.fine{color:#6b7067;font-size:13px;line-height:20px}.notice{margin:0 0 18px;padding:14px 16px;background:#e4f1de;border:1px solid #9fbc91;border-radius:10px;color:#1f3a34;font-weight:700}@media(max-width:700px){.shell{margin:8px auto;padding:0 8px}.card{padding:22px 14px;border-radius:14px}.title{font-size:27px;line-height:34px}.toolbar{margin-top:18px}.week-label{font-size:17px}.board-wrap{margin:0 -2px}.actions{align-items:stretch;flex-direction:column}.button{width:100%}}</style></head><body><main class="shell" data-prev="${escapeHtml(prevUrl)}" data-next="${escapeHtml(nextUrl)}"><section class="card"><div class="eyebrow">FloorPlanDrawings / scheduling</div><h1 class="title">Offer appointment times</h1>${noticeHtml}<p class="copy">${escapeHtml(job.clientName || "Client")} · ${escapeHtml(job.propertyAddress)}</p><div class="property">${escapeHtml(job.propertyAddress)}</div><p class="copy">Select the open times you want to offer. Recommended slots are outlined. This step only prepares an email—no calendar event is created.</p><div class="toolbar"><a href="${escapeHtml(prevUrl)}">‹ Previous week</a><div class="week-label">${escapeHtml(formatWeekRange(startDate))}</div><a href="${escapeHtml(nextUrl)}">Next week ›</a></div><form method="post" action="${escapeHtml(actionUrl)}"><input type="hidden" name="startDate" value="${escapeHtml(startDate)}"><div class="board-wrap"><div class="board"><div class="week-header"><div class="day-header">Employee</div>${dayHeader}</div>${workerRows}</div></div><div class="legend"><span>Open</span><span class="recommended">Recommended</span><span class="busy">Busy / unavailable</span></div><div class="actions"><span class="fine">Choose up to five options. Swipe left/right on mobile to change weeks.</span><button class="button" type="submit">Send selected options to client</button></div></form></section></main><script>(function(){const main=document.querySelector('main');let startX=0;main.addEventListener('touchstart',e=>{startX=e.changedTouches[0].clientX},{passive:true});main.addEventListener('touchend',e=>{const delta=e.changedTouches[0].clientX-startX;if(Math.abs(delta)>60)location.href=delta<0?main.dataset.next:main.dataset.prev},{passive:true});document.querySelector('form').addEventListener('change',()=>{const checked=[...document.querySelectorAll('input[name="slot"]:checked')];if(checked.length>5){checked[checked.length-1].checked=false;alert('Choose up to five appointment options.')}})})();</script></body></html>`;
}

function proposalPage(payload, token, notice = "", actionUrl = appointmentProposalBaseUrl(), submitLabel = "Request this time") {
  const options = payload.slots.map((slot, index) => `<label style="display:block;margin:12px 0;padding:16px;border:1px solid #d9d5ca;border-radius:10px;background:#fff;cursor:pointer;"><input type="radio" name="slot" value="${index}"${index === 0 ? " checked" : ""} style="margin-right:10px;"><strong>Option ${index + 1}</strong><br><span style="display:inline-block;margin:6px 0 0 24px;color:#394842;">${escapeHtml(formatProposalSlot(slot))}<br>Target delivery: ${escapeHtml(slot.deliveryTarget && slot.deliveryTarget.label || "To be confirmed")}</span></label>`).join("");
  const noticeHtml = notice ? `<div role="status" style="margin:0 0 18px;padding:13px 15px;background:#E4F1DE;border:1px solid #9FBC91;border-radius:8px;color:#1F3A34;font-weight:bold;">${escapeHtml(notice)}</div>` : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose an appointment | FloorPlanDrawings</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:680px;margin:5vh auto;padding:34px 26px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / scheduling</div><h1 style="font-size:30px;line-height:38px;margin:12px 0 16px;">Choose an appointment time</h1>${noticeHtml}<p style="font-size:16px;line-height:25px;color:#4A4A40;">${escapeHtml(payload.address)}</p><p style="font-size:15px;line-height:24px;color:#4A4A40;">Select one option below. We will re-check the calendar and confirm the appointment before it is final.</p><form method="post" action="${escapeHtml(actionUrl)}"><input type="hidden" name="token" value="${escapeHtml(token)}">${options}<button type="submit" style="border:0;border-radius:8px;background:#1F3A34;color:#F5F1E8;font-size:16px;line-height:22px;font-weight:bold;padding:15px 22px;cursor:pointer;">${escapeHtml(submitLabel)}</button></form><p style="font-size:13px;line-height:20px;color:#8A897C;margin-top:20px;">Options expire automatically.</p></main></body></html>`;
}

async function sendAvailabilityProposal(recordId, input = {}) {
  const { job, availability, plan, payload } = await buildAppointmentProposal(recordId, input);
  const target = messageRecipients(job, "appointment options");
  if (!target.to.length) throw new Error("A client or explicitly selected appointment recipient is missing");
  let proposalSlots = plan.recommendations;
  if (Array.isArray(input.selectedSlots) && input.selectedSlots.length) {
    if (input.selectedSlots.length > 5) throw new Error("Choose up to five appointment options");
    const selected = input.selectedSlots.map((requested) => {
      const worker = canonicalWorkerName(requested.worker || requested.calendarName);
      const calendar = (availability.calendars || []).find((item) => canonicalWorkerName(item.name) === worker);
      const current = calendar && (calendar.slots || []).find((slot) => slot.available && slot.start === requested.start && slot.end === requested.end);
      if (!current) throw new Error("One or more selected times is no longer available. Refresh the week and try again.");
      const weekday = new Date(`${current.date}T12:00:00Z`).getUTCDay();
      return {
        ...current,
        worker,
        calendarName: calendar.name,
        durationMinutes: availability.durationMinutes,
        deliveryTarget: deliveryTargetForWeekday(weekday),
        rationale: "Selected by Anna from the live availability board"
      };
    });
    const unique = new Set(selected.map((slot) => `${slot.worker}|${slot.start}|${slot.end}`));
    if (unique.size !== selected.length) throw new Error("Each appointment option must be unique");
    proposalSlots = selected;
  }
  const selectedPayload = { ...payload, slots: proposalSlots };
  const proposalToken = signProposal(selectedPayload);
  const proposalUrl = `${appointmentProposalBaseUrl()}?token=${encodeURIComponent(proposalToken)}`;
  const email = clientAvailabilityProposalEmail(job, proposalUrl, proposalSlots);
  const prior = await findAppointmentProposalDeliveries(recordId);
  if (prior.length) return { ok: false, status: 409, error: "Appointment proposal already sent", recordId, priorDeliveryRecordIds: prior.map((item) => item.id) };
  const stateReservation = reserveRenderDelivery({ project: target.project, workflow: "APPOINTMENT OPTIONS", recipientType: target.project.contacts.policy, to: target.to, subject: email.subject });
  if (stateReservation.duplicate) return { ok: false, status: 409, error: "Duplicate delivery blocked", recordId, deliveryId: stateReservation.delivery.id };
  const reservation = await createAppointmentProposalLog({ recordId, subject: email.subject, status: "Pending", summary: `Reserved by Render for ${proposalSlots.length} appointment options` });
  const logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
  if (!logRecordId) throw new Error("Airtable did not return the appointment proposal log ID");
  try {
    const delivery = await sendMail({ to: target.to, replyTo: clean(process.env.SMTP_USER), subject: email.subject, html: email.html, text: email.text });
    projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
    await updateCommunicationLog(logRecordId, { "Delivery Status": "Sent", Summary: `Appointment options sent by Render for ${job.propertyAddress}${delivery.messageId ? `; message ${delivery.messageId}` : ""}` });
    return { ok: true, status: 200, recordId, logRecordId, proposalUrl, options: proposalSlots };
  } catch (error) {
    projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "failed", error: error.message });
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
  let stateReservation = null;

  try {
    const priorDeliveries = await findQuoteReadyDeliveries(recordId);
    if (priorDeliveries.length) {
      return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    }
    const job = await getJob(recordId);
    const project = syncProjectState(job);
    const internalTo = [clean(process.env.SMTP_USER)];
    if (!internalTo[0]) throw new Error("SMTP_USER is not configured");
    const email = quoteReadyEmail(job);
    if (shadowEnabled("QUOTE_READY")) {
      return { ok: true, shadow: true, status: 200, recordId, subject: email.subject, delivery: "not-sent" };
    }
    const reservation = await createQuoteReadyLog({
      recordId,
      subject: email.subject,
      status: "Pending",
      summary: "Reserved by Render before SMTP delivery"
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");
    stateReservation = reserveRenderDelivery({ project, workflow: "QUOTE READY", recipientType: "internal", to: internalTo, subject: email.subject });
    if (stateReservation.duplicate) return { ok: false, status: 409, error: "Duplicate delivery blocked", recordId, deliveryId: stateReservation.delivery.id };
    const delivery = await sendMail({ to: internalTo, subject: email.subject, html: email.html, text: email.text });
    projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
    await updateCommunicationLog(logRecordId, {
      "Delivery Status": "Sent",
      Summary: `Delivered by Render via Gmail SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}`
    });
    await updateJob(recordId, { "Anna Email Status": "Sent - Quote Ready" });
    return { ok: true, status: 200, recordId, logRecordId, delivery: "sent" };
  } catch (error) {
    if (stateReservation && stateReservation.delivery) projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "failed", error: error.message });
    if (logRecordId) {
      await updateCommunicationLog(logRecordId, {
        "Delivery Status": "Failed",
        Summary: `Render delivery failed: ${error.message}`
      }).catch(() => {});
    }
    await sendFailureAlert({ workflow: "QUOTE READY", recordId, error });
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
  let stateReservation = null;
  try {
    const priorDeliveries = await findClientQuoteDeliveries(recordId);
    if (priorDeliveries.length) return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    const job = await getJob(recordId);
    const target = messageRecipients(job, "client quote");
    if (!target.to.length) throw new Error("Client Email is missing");
    if (!Number.isFinite(Number(job.finalQuote)) || Number(job.finalQuote) <= 0) throw new Error("Approved quote amount is missing");
    let proposalUrl = "";
    let proposalSlots = [];
    if (clientQuoteSchedulingEnabled()) {
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
    if (shadowEnabled("CLIENT_QUOTE")) {
      return { ok: true, shadow: true, status: 200, recordId, subject: email.subject, delivery: "not-sent" };
    }
    const reservation = await createClientQuoteLog({
      recordId,
      clientName: job.clientName,
      subject: email.subject,
      status: "Pending",
      summary: `Reserved by Render for ${job.clientName || "client"}`
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");
    stateReservation = reserveRenderDelivery({ project: target.project, workflow: "CLIENT QUOTE", recipientType: target.project.contacts.policy, to: target.to, subject: email.subject });
    if (stateReservation.duplicate) return { ok: false, status: 409, error: "Duplicate delivery blocked", recordId, deliveryId: stateReservation.delivery.id };
    const delivery = await sendMail({
      to: target.to,
      replyTo: clean(process.env.SMTP_USER),
      subject: email.subject,
      html: email.html,
      text: email.text
    });
    projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
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
    if (stateReservation && stateReservation.delivery) projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "failed", error: error.message });
    if (logRecordId) {
      await updateCommunicationLog(logRecordId, {
        "Delivery Status": "Failed",
        Summary: `Render client quote delivery failed: ${error.message}`
      }).catch(() => {});
    }
    await sendFailureAlert({ workflow: "CLIENT QUOTE", recordId, error });
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

function appointmentPayload(input = {}) {
  const appointment = input && typeof input.appointment === "object" ? input.appointment : input;
  const start = clean(appointment.start || appointment.startAt || appointment.appointmentStart);
  const date = clean(appointment.date);
  const localStart = clean(appointment.localStart || appointment.time);
  if (!start && !(date && localStart)) throw new Error("Appointment date and time are required");
  return {
    start,
    end: clean(appointment.end || appointment.endAt),
    date,
    localStart,
    time: clean(appointment.time),
    worker: clean(appointment.worker || appointment.employee),
    calendarName: clean(appointment.calendarName),
    durationMinutes: Number.isFinite(Number(appointment.durationMinutes)) ? Number(appointment.durationMinutes) : undefined,
    accessNotes: clean(appointment.accessNotes || appointment.access),
    address: clean(appointment.address || appointment.propertyAddress)
  };
}

function projectLifecycleJob(project) {
  return {
    recordId: project.id,
    propertyAddress: project.propertyAddress,
    clientName: project.clientName,
    clientEmail: project.contacts && project.contacts.client && project.contacts.client[0],
    agentEmail: project.contacts && project.contacts.agent && project.contacts.agent[0],
    service: project.metadata && project.metadata.service,
    status: project.status,
    stage: project.stage
  };
}

async function deliverProjectAppointmentEmail(projectId, appointment, mode = "confirmation", reminderLabel = "Tomorrow") {
  const workflow = mode === "reminder" ? "APPOINTMENT REMINDER" : "APPOINTMENT CONFIRMATION";
  const lockKey = `${projectId}:${workflow}`;
  if (appointmentLifecycleLocks.has(lockKey)) return { ok: false, status: 409, error: "Delivery already in progress" };
  appointmentLifecycleLocks.add(lockKey);
  let reservation = null;
  try {
    const project = projectState.getProject(projectId);
    if (!project) return { ok: false, status: 404, error: "Project not found" };
    const to = recipientsFor(mode === "reminder" ? "appointment reminder" : "appointment confirmation", project.contacts);
    const job = projectLifecycleJob(project);
    const email = mode === "reminder"
      ? clientAppointmentReminderEmail(job, appointment, reminderLabel)
      : clientAppointmentConfirmationEmail(job, appointment);
    const version = mode === "reminder"
      ? (clean(appointment.date) || clean(appointment.start).slice(0, 10) || "next")
      : "v1";
    reservation = projectState.reserveDelivery({
      projectId,
      idempotencyKey: `${projectId}:${mode === "reminder" ? "appointment_reminder" : "appointment_confirmation"}:${version}`,
      workflow,
      recipientType: project.contacts.policy,
      recipients: to,
      subject: email.subject
    });
    if (reservation.duplicate) return { ok: false, status: 409, error: "Duplicate delivery blocked", deliveryId: reservation.delivery.id };
    const appointmentMetadata = {
      appointment: {
        start: appointment.start,
        end: appointment.end,
        date: appointment.date,
        localStart: appointment.localStart,
        worker: appointment.worker,
        calendarName: appointment.calendarName,
        durationMinutes: appointment.durationMinutes,
        address: appointment.address,
        accessNotes: appointment.accessNotes
      },
      ...(mode === "reminder" ? { lastReminderSentAt: new Date().toISOString() } : { confirmationSentAt: new Date().toISOString() })
    };
    projectState.updateProjectProgress(projectId, {
      status: "scheduled",
      stage: "scheduled",
      metadata: appointmentMetadata,
      note: `${workflow} queued by Render`
    }, "render");
    const delivery = await sendMail({ to, replyTo: clean(process.env.SMTP_USER), subject: email.subject, html: email.html, text: email.text });
    projectState.updateDelivery(reservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
    return { ok: true, status: 200, projectId, workflow, recipients: to, delivery: "sent", messageId: delivery.messageId };
  } catch (error) {
    if (reservation && reservation.delivery) projectState.updateDelivery(reservation.delivery.idempotencyKey, { status: "failed", error: error.message });
    await sendFailureAlert({ workflow, recordId: projectId, error });
    return { ok: false, status: 502, error: `${workflow} delivery failed`, detail: error.message };
  } finally {
    appointmentLifecycleLocks.delete(lockKey);
  }
}

async function pollAppointmentReminders() {
  if (!appointmentReminderEnabled() || appointmentReminderPollRunning) return;
  appointmentReminderPollRunning = true;
  try {
    const nowMs = Date.now();
    for (const project of projectState.listProjects({ stage: "scheduled", limit: 500 })) {
      const appointment = project.metadata && project.metadata.appointment;
      const start = appointment && appointment.start;
      if (!start || project.metadata.lastReminderSentAt) continue;
      const startMs = new Date(start).getTime();
      const hours = (startMs - nowMs) / 3600000;
      if (!Number.isFinite(hours) || hours < 20 || hours > 28) continue;
      const result = await deliverProjectAppointmentEmail(project.id, appointment, "reminder", "Tomorrow");
      console.log(`APPOINTMENT REMINDER poll ${project.id}: ${result.ok ? "sent" : result.error}`);
    }
  } catch (error) {
    console.error(`APPOINTMENT REMINDER poll failed: ${error.message}`);
  } finally {
    appointmentReminderPollRunning = false;
  }
}

async function deliverInternalNotification(recordId, eventType, buildEmail, statusStamp) {
  const lockKey = `${eventType}:${recordId}`;
  if (internalNotificationLocks.has(lockKey)) return { ok: false, status: 409, error: "Delivery already in progress" };
  internalNotificationLocks.add(lockKey);
  let logRecordId = "";
  let stateReservation = null;
  try {
    const priorDeliveries = await findNotificationDeliveries(recordId, eventType);
    if (priorDeliveries.length) return { ok: false, status: 409, error: "Duplicate delivery blocked" };
    const job = await getJob(recordId);
    const project = syncProjectState(job);
    const internalTo = [clean(process.env.SMTP_USER)];
    if (!internalTo[0]) throw new Error("SMTP_USER is not configured");
    const email = buildEmail(job);
    if (shadowEnabled(eventType)) {
      return { ok: true, shadow: true, status: 200, recordId, eventType, subject: email.subject, delivery: "not-sent" };
    }
    const reservation = await createNotificationLog({
      recordId,
      eventType,
      subject: email.subject,
      status: "Pending",
      summary: `Reserved by Render before ${eventType} delivery`
    });
    logRecordId = reservation.records && reservation.records[0] && reservation.records[0].id;
    if (!logRecordId) throw new Error("Airtable did not return the reserved Communication Log ID");
    stateReservation = reserveRenderDelivery({ project, workflow: eventType, recipientType: "internal", to: internalTo, subject: email.subject });
    if (stateReservation.duplicate) return { ok: false, status: 409, error: "Duplicate delivery blocked", recordId, deliveryId: stateReservation.delivery.id };
    const delivery = await sendMail({ to: internalTo, subject: email.subject, html: email.html, text: email.text });
    projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
    await updateCommunicationLog(logRecordId, {
      "Delivery Status": "Sent",
      Summary: `Delivered by Render via SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}`
    });
    await updateJob(recordId, { "Anna Email Status": statusStamp });
    return { ok: true, status: 200, recordId, logRecordId, delivery: "sent" };
  } catch (error) {
    if (stateReservation && stateReservation.delivery) projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "failed", error: error.message });
    if (logRecordId) await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Render delivery failed: ${error.message}` }).catch(() => {});
    await sendFailureAlert({ workflow: eventType, recordId, error });
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
    if (shadowEnabled("FOLLOW_UP")) {
      followUpRunDate = today;
      console.log(`FOLLOW-UP shadow run: ${jobs.length} candidate${jobs.length === 1 ? "" : "s"}; no email sent`);
      return;
    }
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
    const followUpProject = projectState.upsertProject({
      id: "daily-follow-up",
      source: "airtable",
      sourceId: "daily-follow-up",
      status: "active",
      stage: "delivery",
      contacts: { internal: clean(process.env.SMTP_USER), policy: "internal" },
      metadata: { count: jobs.length, date: today }
    });
    const followUpTo = [clean(process.env.SMTP_USER)];
    if (!followUpTo[0]) throw new Error("SMTP_USER is not configured");
    const stateReservation = reserveRenderDelivery({ project: followUpProject, workflow: "FOLLOW-UP", recipientType: "internal", to: followUpTo, subject: email.subject, version: today });
    if (stateReservation.duplicate) {
      followUpRunDate = today;
      return;
    }
    try {
      const delivery = await sendMail({ to: followUpTo, subject: email.subject, html: email.html, text: email.text });
      projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "sent", attempts: delivery.attempts, provider: delivery.provider, messageId: delivery.messageId });
      await updateCommunicationLog(logRecordId, { "Delivery Status": "Sent", Summary: `Delivered by Render via SMTP${delivery.messageId ? `; message ${delivery.messageId}` : ""}` });
      followUpRunDate = today;
    } catch (error) {
      projectState.updateDelivery(stateReservation.delivery.idempotencyKey, { status: "failed", error: error.message });
      await updateCommunicationLog(logRecordId, { "Delivery Status": "Failed", Summary: `Render follow-up delivery failed: ${error.message}` }).catch(() => {});
      await sendFailureAlert({ workflow: "FOLLOW-UP", recordId: "daily-follow-up", error });
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

function buildTestAppointmentSlots() {
  const slots = [];
  const cursor = new Date(`${localDate()}T12:00:00Z`);
  const workers = ["corrie", "ricky", "sarah"];
  const starts = ["11:00", "13:00", "11:00"];
  while (slots.length < workers.length) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = cursor.toISOString().slice(0, 10);
    slots.push({
      date,
      localStart: starts[slots.length],
      worker: workers[slots.length],
      durationMinutes: 90,
      deliveryTarget: { label: "Target delivery to be confirmed" }
    });
  }
  return slots;
}

function testSchedulingPreviewJob() {
  return {
    clientName: "Eric Greenburg",
    propertyAddress: "349 Mount Washington Dr, Los Angeles, CA 90065",
    service: "Color Interior + Exterior"
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

  if (req.method === "GET" && url.pathname === "/api/email/test-scheduling-preview") {
    const job = testSchedulingPreviewJob();
    const email = clientAvailabilityProposalEmail(job, "", buildTestAppointmentSlots());
    return html(res, 200, email.html.replace("</body>", "<p style=\"max-width:680px;margin:0 auto 24px;padding:0 16px;color:#6b7067;font:13px/20px Arial,sans-serif;text-align:center;\">TEST ONLY — no appointment was requested or recorded.</p></body>"));
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/email/test-scheduling-board") {
    const startDate = weekStartDate(url.searchParams.get("startDate") || localDate());
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const selected = Array.isArray(body.slot) ? body.slot : body.slot ? [body.slot] : [];
      if (!selected.length) return html(res, 400, appointmentBoardPage(testAppointmentBoard(startDate), "test-board", "test", "Select at least one open appointment option first."));
      return html(res, 200, `<!doctype html><html><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:620px;margin:10vh auto;padding:36px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / scheduling</div><h1 style="color:#173F36;">Test selection received</h1><p>No email was sent, no Airtable record changed, and no calendar event was created.</p><p><a href="${escapeHtml(appointmentReviewUrl("test-board", "test", startDate))}">Return to test board</a></p></main></body></html>`);
    }
    return html(res, 200, appointmentBoardPage(testAppointmentBoard(startDate), "test-board", "test"));
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, {
      service: SERVICE_NAME,
      status: "ok",
      integrations: integrationStatus()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/intake") {
    if (!intakeAuthorized(req.headers)) return json(res, 401, { ok: false, error: "Unauthorized" });
    try {
      const body = await readJsonBody(req);
      const validation = validateIntakeEnvelope(body);
      if (!validation.ok) return json(res, 400, { ok: false, error: validation.error });
      const headerKey = clean(req.headers["x-intake-idempotency-key"]);
      if (headerKey && headerKey !== validation.idempotencyKey) {
        return json(res, 400, { ok: false, error: "Idempotency key mismatch" });
      }
      const result = await createAirtableIntakeRecord({ fields: body.fields });
      const intakeFields = result.record && result.record.fields ? result.record.fields : body.fields;
      const project = projectState.upsertProject({
        id: result.record && result.record.id,
        source: "netlify-fpd-intake",
        sourceId: body.idempotencyKey || (result.record && result.record.id),
        propertyAddress: intakeFields["Property Address"] || intakeFields.Address,
        clientName: intakeFields["Client Name"] || intakeFields.Name,
        contacts: {
          client: intakeFields["Client Email"] || intakeFields.Email,
          agent: intakeFields["Agent Email"] || intakeFields["Realtor Email"],
          policy: intakeFields["Recipient Policy"] || "",
          policyExplicit: Boolean(intakeFields["Recipient Policy"])
        },
        metadata: {
          workflow: intakeFields["Website Workflow"] || intakeFields.Workflow || "Order",
          service: intakeFields["Drawing Style"] || intakeFields["Service Requested"]
        }
      });
      return json(res, result.duplicate ? 200 : 201, {
        ok: true,
        source: "render-intake",
        persistence: "airtable",
        duplicate: result.duplicate,
        id: result.record.id,
        projectId: project.id,
        omittedFields: result.omittedFields,
        status: result.record.fields && result.record.fields.Status,
        address: result.record.fields && result.record.fields["Property Address"]
      });
    } catch (error) {
      console.error("Render intake failed", error.message);
      return json(res, Number.isInteger(error.status) && error.status >= 400 ? 502 : 503, {
        ok: false,
        error: "Render intake unavailable"
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/ops/delivery-failures") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const failures = await listFailedDeliveries({ maxRecords: url.searchParams.get("limit") });
      return json(res, 200, { ok: true, readOnly: true, failures });
    } catch (error) {
      return json(res, 502, { error: "Delivery failure log unavailable", detail: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/ops/projects") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { ok: true, readOnly: true, projects: projectState.listProjects({ status: url.searchParams.get("status"), stage: url.searchParams.get("stage"), limit: url.searchParams.get("limit") }) });
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/icloud/calendar-sync") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const input = {
        ...body,
        startDate: body.startDate || url.searchParams.get("startDate") || "",
        days: body.days || url.searchParams.get("days") || "",
        dryRun: req.method === "GET" ? true : body.dryRun === undefined ? true : body.dryRun
      };
      return json(res, 200, await syncCalendarToAirtable(input));
    } catch (error) {
      console.error(`Calendar sync failed: ${error.message}`);
      return json(res, 502, { ok: false, error: "Calendar sync failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ops/projects") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = await readJsonBody(req);
      const project = projectState.upsertProject(body);
      return json(res, 201, { ok: true, project });
    } catch (error) {
      return json(res, 400, { error: "Project state could not be saved", detail: error.message });
    }
  }

  const projectProgressMatch = url.pathname.match(/^\/api\/ops\/projects\/([^/]+)\/progress$/);
  if (req.method === "POST" && projectProgressMatch) {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const projectId = decodeURIComponent(projectProgressMatch[1]);
      const body = await readJsonBody(req);
      const project = projectState.updateProjectProgress(projectId, {
        status: clean(body.status),
        stage: clean(body.stage),
        metadata: body.metadata,
        note: clean(body.note)
      }, clean(body.actor) || "anna");
      if (!project) return json(res, 404, { error: "Project not found" });
      return json(res, 200, { ok: true, project, event: projectState.listEvents({ projectId, type: "project.progressed", limit: 1 })[0] || null });
    } catch (error) {
      return json(res, 400, { error: "Project progress could not be saved", detail: error.message });
    }
  }

  const confirmationMatch = url.pathname.match(/^\/api\/ops\/projects\/([^/]+)\/appointment-confirmation$/);
  if (req.method === "POST" && confirmationMatch) {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!appointmentConfirmationEnabled()) return json(res, 503, { error: "Appointment confirmations are disabled" });
    try {
      const body = await readJsonBody(req);
      const appointment = appointmentPayload(body);
      const result = await deliverProjectAppointmentEmail(decodeURIComponent(confirmationMatch[1]), appointment, "confirmation");
      return json(res, result.status, result);
    } catch (error) {
      return json(res, 400, { error: "Appointment confirmation could not be sent", detail: error.message });
    }
  }

  const reminderMatch = url.pathname.match(/^\/api\/ops\/projects\/([^/]+)\/appointment-reminder$/);
  if (req.method === "POST" && reminderMatch) {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    if (!appointmentReminderEnabled()) return json(res, 503, { error: "Appointment reminders are disabled" });
    try {
      const body = await readJsonBody(req);
      const appointment = appointmentPayload(body);
      const result = await deliverProjectAppointmentEmail(decodeURIComponent(reminderMatch[1]), appointment, "reminder", clean(body.reminderLabel) || "Tomorrow");
      return json(res, result.status, result);
    } catch (error) {
      return json(res, 400, { error: "Appointment reminder could not be sent", detail: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/ops/events") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { ok: true, readOnly: true, events: projectState.listEvents({ projectId: url.searchParams.get("projectId"), type: url.searchParams.get("type"), limit: url.searchParams.get("limit") }) });
  }

  if (req.method === "GET" && url.pathname === "/api/ops/deliveries") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { ok: true, readOnly: true, deliveries: projectState.listDeliveries({ projectId: url.searchParams.get("projectId"), status: url.searchParams.get("status"), limit: url.searchParams.get("limit") }) });
  }

  if (req.method === "POST" && url.pathname === "/api/gmail/intake/poll") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      return json(res, 200, await pollGmailIntake());
    } catch (error) {
      console.error(`Gmail intake poll failed: ${error.message}`);
      return json(res, 502, { ok: false, error: "Gmail intake poll failed", detail: error.message });
    }
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/scheduling/proposal/start") {
    const recordId = clean(url.searchParams.get("recordId"));
    const providedToken = clean(url.searchParams.get("token"));
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId) || !providedToken) return html(res, 400, proposalPage({ address: "this quote", slots: [] }, "", "This scheduling link is incomplete."));
    try {
      await authorizeProposalStart(recordId, providedToken);
      if (req.method === "GET") {
        const built = await buildAppointmentBoard(recordId, { startDate: clean(url.searchParams.get("startDate")) || localDate() });
        return html(res, 200, appointmentBoardPage(built, recordId, providedToken));
      }
      if (!appointmentProposalEnabled()) return html(res, 503, proposalPage({ address: "this quote", slots: [] }, "", "Appointment proposals are not enabled yet. No email or calendar event was created."));
      const body = await readJsonBody(req);
      const selectedValues = Array.isArray(body.slot) ? body.slot : body.slot ? [body.slot] : [];
      const selectedSlots = selectedValues.map(parseSlotSelection);
      if (!selectedSlots.length || selectedSlots.some((slot) => !slot)) {
        const built = await buildAppointmentBoard(recordId, { startDate: clean(body.startDate) || localDate() });
        return html(res, 400, appointmentBoardPage(built, recordId, providedToken, "Select at least one open appointment option first."));
      }
      const result = await sendAvailabilityProposal(recordId, { startDate: clean(body.startDate) || localDate(), days: 7, selectedSlots });
      const options = result.options.map((slot) => `<li>${escapeHtml(formatProposalSlot(slot))}</li>`).join("");
      return html(res, 200, `<!doctype html><html><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:620px;margin:10vh auto;padding:36px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / scheduling</div><h1 style="color:#173F36;">Appointment options sent</h1><p>The selected options were emailed to the client. No calendar event was created.</p><ul>${options}</ul><p><a href="${escapeHtml(appointmentReviewUrl(recordId, providedToken, weekStartDate(localDate())))}">Return to availability</a></p></main></body></html>`);
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

  if (req.method === "GET" && url.pathname === "/api/airtable/client-quote-preview") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const recordId = clean(url.searchParams.get("recordId"));
      const job = await getJob(recordId);
      const preview = clientQuoteEmail(job);
      if (url.searchParams.get("format") === "html") return html(res, 200, preview.html);
      return json(res, 200, {
        ok: true,
        readOnly: true,
        dryRun: true,
        emailSent: false,
        airtableRecordChanged: false,
        recordId: job.recordId,
        recipient: job.clientEmail || null,
        subject: preview.subject,
        html: preview.html,
        text: preview.text
      });
    } catch (error) {
      return json(res, 502, { error: "Client quote preview failed", detail: error.message });
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

  if (req.method === "POST" && (url.pathname === "/api/email/test-appointment-confirmation" || url.pathname === "/api/email/test-appointment-reminder")) {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    const recipient = TEST_EMAIL_RECIPIENT;
    try {
      const sampleJob = await buildTestQuote();
      const appointment = {
        start: "2026-09-15T18:00:00.000Z",
        date: "2026-09-15",
        localStart: "11:00 AM",
        worker: "Corrie",
        durationMinutes: 90,
        address: sampleJob.propertyAddress,
        accessNotes: "Please make sure the agent or homeowner can provide access on arrival."
      };
      const isReminder = url.pathname.endsWith("reminder");
      const sample = isReminder
        ? clientAppointmentReminderEmail(sampleJob, appointment, "Tomorrow")
        : clientAppointmentConfirmationEmail(sampleJob, appointment);
      const delivery = await sendMail({
        to: recipient,
        subject: `[TEST — NO WORKFLOW] ${sample.subject}`,
        html: sample.html,
        text: sample.text
      });
      return json(res, 200, { ok: true, test: true, workflow: isReminder ? "APPOINTMENT REMINDER" : "APPOINTMENT CONFIRMATION", recipient, propertyAddress: sampleJob.propertyAddress, ...delivery });
    } catch (error) {
      return json(res, 502, { error: "Appointment lifecycle test email failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/test-scheduling") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    const recipient = TEST_EMAIL_RECIPIENT;
    try {
      const sampleJob = await buildTestQuote();
      const slots = buildTestAppointmentSlots();
      const proposalUrl = "https://floor-plan-drawings.onrender.com/api/email/test-scheduling-preview";
      const sample = clientAvailabilityProposalEmail(sampleJob, proposalUrl, slots);
      const delivery = await sendMail({
        to: recipient,
        subject: `[TEST — NO WORKFLOW] ${sample.subject}`,
        html: sample.html,
        text: sample.text
      });
      return json(res, 200, { ok: true, test: true, workflow: "APPOINTMENT OPTIONS", recipient, propertyAddress: sampleJob.propertyAddress, options: slots.length, ...delivery });
    } catch (error) {
      return json(res, 502, { error: "Scheduling test email delivery failed", detail: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/test-quote-with-scheduling") {
    if (!isAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
    const recipient = TEST_EMAIL_RECIPIENT;
    try {
      const sampleJob = await buildTestQuote();
      const reviewUrl = appointmentReviewUrl("test-board", "test", weekStartDate(localDate()));
      const sample = quoteReadyEmail({ ...sampleJob, availabilityReviewUrl: reviewUrl });
      const delivery = await sendMail({
        to: recipient,
        subject: `[TEST — NO WORKFLOW] ${sample.subject}`,
        html: sample.html,
        text: sample.text
      });
      return json(res, 200, { ok: true, test: true, workflow: "QUOTE READY + SCHEDULING BOARD", recipient, propertyAddress: sampleJob.propertyAddress, reviewUrl, ...delivery });
    } catch (error) {
      return json(res, 502, { error: "Quote scheduling test email delivery failed", detail: error.message });
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
  if (appointmentReminderEnabled()) {
    setTimeout(() => pollAppointmentReminders().catch((error) => console.error(`APPOINTMENT REMINDER poll failed: ${error.message}`)), 15000).unref();
    setInterval(() => pollAppointmentReminders().catch((error) => console.error(`APPOINTMENT REMINDER poll failed: ${error.message}`)), Number(process.env.APPOINTMENT_REMINDER_POLL_MS) || 900000).unref();
  }
  if (calendarAirtableSyncEnabled()) {
    setTimeout(() => pollCalendarAirtableSync().catch((error) => console.error(`CALENDAR sync failed: ${error.message}`)), 18000).unref();
    setInterval(() => pollCalendarAirtableSync().catch((error) => console.error(`CALENDAR sync failed: ${error.message}`)), Number(process.env.CALENDAR_SYNC_POLL_MS) || 1800000).unref();
  }
  if (gmailIntakePollEnabled()) {
    setTimeout(() => pollGmailIntake().catch((error) => console.error(`Gmail intake poll failed: ${error.message}`)), 12000).unref();
    setInterval(() => pollGmailIntake().catch((error) => console.error(`Gmail intake poll failed: ${error.message}`)), Number(process.env.GMAIL_INTAKE_POLL_MS) || 120000).unref();
  }
});

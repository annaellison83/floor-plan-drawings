const crypto = require("node:crypto");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function signingSecret(env = process.env) {
  return clean(env.PROPOSAL_SIGNING_SECRET) || clean(env.INTERNAL_ADMIN_TOKEN);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function signProposal(payload, env = process.env) {
  const secret = signingSecret(env);
  if (!secret) throw new Error("PROPOSAL_SIGNING_SECRET or INTERNAL_ADMIN_TOKEN is required");
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyProposal(token, env = process.env) {
  const secret = signingSecret(env);
  const [body, provided] = String(token || "").split(".");
  if (!secret || !body || !provided || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(provided)) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || !payload.recordId || !Array.isArray(payload.slots) || Number(payload.expiresAt) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function proposalTtlMs(env = process.env) {
  const hours = Number(env.APPOINTMENT_PROPOSAL_TTL_HOURS);
  const bounded = Number.isFinite(hours) ? Math.min(72, Math.max(1, hours)) : 48;
  return bounded * 60 * 60 * 1000;
}

function slotKey(slot) {
  return [clean(slot && slot.worker), clean(slot && slot.start), clean(slot && slot.end)].join("|");
}

function proposalPayload({ recordId, address, clientName, squareFeet, service, slots, env = process.env } = {}) {
  const safeSlots = (Array.isArray(slots) ? slots : []).slice(0, 5).map((slot) => ({
    date: clean(slot.date),
    localStart: clean(slot.localStart),
    start: clean(slot.start),
    end: clean(slot.end),
    durationMinutes: Number(slot.durationMinutes) || null,
    worker: clean(slot.worker),
    calendarName: clean(slot.calendarName),
    deliveryTarget: slot.deliveryTarget || null,
    rationale: clean(slot.rationale)
  }));
  return {
    version: 1,
    recordId: clean(recordId),
    address: clean(address),
    clientName: clean(clientName),
    squareFeet: Number(squareFeet) || null,
    service: clean(service),
    slots: safeSlots,
    createdAt: Date.now(),
    expiresAt: Date.now() + proposalTtlMs(env)
  };
}

module.exports = { proposalPayload, proposalTtlMs, signProposal, slotKey, verifyProposal };

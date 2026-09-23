const crypto = require("node:crypto");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function signingSecret(env = process.env) {
  return clean(env.EMAIL_DRAFT_SIGNING_SECRET) || clean(env.PROPOSAL_SIGNING_SECRET) || clean(env.INTERNAL_ADMIN_TOKEN);
}

function publicBaseUrl(env = process.env) {
  return clean(env.EMAIL_DRAFT_PUBLIC_BASE_URL)
    || `${clean(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL) || "https://master.floorplandrawings.com"}/api/email/client-draft`;
}

function signClientDraft(payload, env = process.env) {
  const secret = signingSecret(env);
  const recordId = clean(payload && payload.recordId);
  const expiresAt = Number(payload && payload.expiresAt);
  if (!secret || !recordId || !Number.isFinite(expiresAt)) throw new Error("Email draft signing is not configured");
  const body = Buffer.from(JSON.stringify({ version: 1, recordId, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyClientDraft(token, env = process.env) {
  const secret = signingSecret(env);
  const [body, provided] = String(token || "").split(".");
  if (!secret || !body || !provided || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(provided)) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || payload.version !== 1 || !clean(payload.recordId) || Number(payload.expiresAt) <= Date.now()) return null;
    return { ...payload, recordId: clean(payload.recordId) };
  } catch {
    return null;
  }
}

function clientDraftUrl(recordId, env = process.env) {
  const address = publicBaseUrl(env).replace(/\/$/, "");
  if (!address || !clean(recordId)) return "";
  const expiresAt = Date.now() + (14 * 24 * 60 * 60 * 1000);
  const token = signClientDraft({ recordId, expiresAt }, env);
  return `${address}?token=${encodeURIComponent(token)}`;
}

module.exports = { clientDraftUrl, publicBaseUrl, signClientDraft, verifyClientDraft };

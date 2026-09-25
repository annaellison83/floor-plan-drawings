const crypto = require("node:crypto");

const COOKIE_NAME = "fpd_portal_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function sessionSecret(env = process.env) {
  return clean(env.PORTAL_SESSION_SECRET) || clean(env.INTERNAL_ADMIN_TOKEN);
}

function configuredCredentials(env = process.env) {
  return {
    username: clean(env.PORTAL_USERNAME),
    password: clean(env.PORTAL_PASSWORD)
  };
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, env = process.env) {
  const secret = sessionSecret(env);
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function createSession(username, env = process.env, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret || !clean(username)) return null;
  const payload = Buffer.from(JSON.stringify({
    username: clean(username),
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

function parseCookies(header = "") {
  return String(header).split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
    return cookies;
  }, {});
}

function verifySession(value, env = process.env, now = Date.now()) {
  const token = clean(value);
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(payload, env);
  if (!expected || !timingSafeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || !clean(data.username) || Number(data.expiresAt) <= Math.floor(now / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionFromRequest(req, env = process.env, now = Date.now()) {
  const cookies = parseCookies(req && req.headers && req.headers.cookie);
  return verifySession(cookies[COOKIE_NAME], env, now);
}

function credentialsMatch(username, password, env = process.env) {
  const configured = configuredCredentials(env);
  return Boolean(configured.username && configured.password
    && timingSafeEqual(clean(username).toLowerCase(), configured.username.toLowerCase())
    && timingSafeEqual(clean(password), configured.password));
}

function sessionCookie(session, secure = true) {
  return `${COOKIE_NAME}=${session}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure = true) {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  configuredCredentials,
  credentialsMatch,
  createSession,
  parseCookies,
  sessionCookie,
  sessionFromRequest,
  sessionSecret,
  verifySession
};

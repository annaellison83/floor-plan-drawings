const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  credentialsMatch,
  createSession,
  parseCookies,
  sessionCookie,
  sessionFromRequest,
  verifySession
} = require("./portal-auth");

const env = {
  PORTAL_USERNAME: "anna",
  PORTAL_PASSWORD: "correct horse battery staple",
  PORTAL_SESSION_SECRET: "test-session-secret"
};

test("portal credentials compare without exposing the password", () => {
  assert.equal(credentialsMatch("anna", env.PORTAL_PASSWORD, env), true);
  assert.equal(credentialsMatch("anna", "wrong", env), false);
  assert.equal(credentialsMatch("eric", env.PORTAL_PASSWORD, env), false);
});

test("signed sessions verify and expire", () => {
  const now = Date.parse("2026-09-14T20:00:00Z");
  const session = createSession("anna", env, now);
  assert.ok(session);
  const verified = verifySession(session, env, now);
  assert.equal(verified.username, "anna");
  assert.equal(verified.expiresAt, Math.floor(now / 1000) + SESSION_TTL_SECONDS);
  assert.match(verified.nonce, /^[a-f0-9]{32}$/);
  assert.equal(verifySession(session, env, now + SESSION_TTL_SECONDS * 1000 + 1), null);
  const [payload, signature] = session.split(".");
  const tampered = `${payload.slice(0, -1)}${payload.endsWith("a") ? "b" : "a"}.${signature}`;
  assert.equal(verifySession(tampered, env, now), null);
});

test("cookies round-trip through a request", () => {
  const session = createSession("anna", env, Date.now());
  const header = sessionCookie(session, true);
  assert.match(header, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  const request = { headers: { cookie: header.split(";")[0] } };
  assert.equal(sessionFromRequest(request, env).username, "anna");
  assert.deepEqual(parseCookies("a=1; b=two"), { a: "1", b: "two" });
});

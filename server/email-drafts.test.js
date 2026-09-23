const assert = require("node:assert/strict");
const test = require("node:test");
const { signClientDraft, verifyClientDraft } = require("./email-drafts");

test("signed client draft links verify and reject tampering", () => {
  const env = { INTERNAL_ADMIN_TOKEN: "test-secret" };
  const expiresAt = Date.now() + 60_000;
  const token = signClientDraft({ recordId: "rec123", expiresAt }, env);
  assert.deepEqual(verifyClientDraft(token, env), { version: 1, recordId: "rec123", expiresAt });
  assert.equal(verifyClientDraft(`${token}x`, env), null);
  assert.equal(verifyClientDraft(signClientDraft({ recordId: "rec123", expiresAt: Date.now() - 1 }, env), env), null);
});

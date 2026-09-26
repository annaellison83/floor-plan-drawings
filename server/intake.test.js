const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAirtableIntakeRecord,
  intakeAuthorized,
  validateIntakeEnvelope
} = require("./intake");

test("intake authentication requires the configured bearer secret", () => {
  assert.equal(intakeAuthorized({ authorization: "Bearer intake-secret" }, "intake-secret"), true);
  assert.equal(intakeAuthorized({ authorization: "Bearer wrong" }, "intake-secret"), false);
  assert.equal(intakeAuthorized({}, "intake-secret"), false);
  assert.equal(intakeAuthorized({ authorization: "Bearer intake-secret" }, ""), false);
});

test("intake envelope validation rejects spoofed or incomplete payloads", () => {
  assert.equal(validateIntakeEnvelope({}).ok, false);
  assert.equal(validateIntakeEnvelope({ version: 1, source: "other", fields: {} }).ok, false);
  assert.equal(validateIntakeEnvelope({
    version: 1,
    source: "netlify-fpd-intake",
    fields: { "Property Address": "123 Main St" },
    idempotencyKey: "WEB-123"
  }).ok, true);
});

test("intake idempotency keys are carried in the versioned envelope", () => {
  const result = validateIntakeEnvelope({
    version: 1,
    source: "netlify-fpd-intake",
    idempotencyKey: "WEB-abc_123",
    fields: { "Property Address": "123 Main St" }
  });
  assert.equal(result.idempotencyKey, "WEB-abc_123");
});

test("Render intake creates once and returns the existing record on retry", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let records = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      return new Response(JSON.stringify({ records }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(options.body);
    const record = { id: "recIntake123", fields: body.fields };
    records = [record];
    return new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const options = { AIRTABLE_TOKEN: "pat-test", AIRTABLE_BASE_ID: "app-test", AIRTABLE_JOBS_TABLE: "Jobs" };
    const fields = { "Job ID": "WEB-123", "Property Address": "123 Main St", Status: "Needs Quote" };
    const first = await createAirtableIntakeRecord({ fields, env: options });
    const second = await createAirtableIntakeRecord({ fields, env: options });
    assert.equal(first.duplicate, false);
    assert.equal(first.record.id, "recIntake123");
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, "recIntake123");
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Render intake matches a fresh website job ID to a recent address and client", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let records = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      return new Response(JSON.stringify({ records }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(options.body);
    const record = { id: "recIntakeMatch", createdTime: new Date().toISOString(), fields: body.fields };
    records = [record];
    return new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const options = { AIRTABLE_TOKEN: "pat-test", AIRTABLE_BASE_ID: "app-test", AIRTABLE_JOBS_TABLE: "Jobs" };
    const first = await createAirtableIntakeRecord({ fields: {
      "Job ID": "WEB-first",
      "Property Address": "941 Fortune Way, Los Angeles, CA 90042",
      "Client Email": "lisa@example.com",
      Status: "Needs Quote"
    }, env: options });
    const second = await createAirtableIntakeRecord({ fields: {
      "Job ID": "WEB-second",
      "Property Address": "941 FORTUNE WAY LOS ANGELES CA 90042",
      "Client Email": "lisa@example.com",
      Status: "Needs Quote"
    }, env: options });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, "recIntakeMatch");
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

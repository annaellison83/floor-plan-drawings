const assert = require("node:assert/strict");
const test = require("node:test");
const { maybeCreateRenderRecord } = require("../netlify/functions/fpd-intake");

test("Netlify intake posts normalized fields to Render when configured", async () => {
  const originalFetch = global.fetch;
  const previousUrl = process.env.RENDER_INTAKE_URL;
  const previousToken = process.env.RENDER_INTAKE_TOKEN;
  let received;
  process.env.RENDER_INTAKE_URL = "https://render.example/api/intake";
  process.env.RENDER_INTAKE_TOKEN = "intake-secret";
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({ ok: true, id: "recRender123", status: "Needs Quote" }), { status: 201 });
  };
  try {
    const result = await maybeCreateRenderRecord({ "Job ID": "WEB-123", "Property Address": "123 Main St" });
    assert.equal(result.ok, true);
    assert.equal(result.id, "recRender123");
    assert.equal(received.url, "https://render.example/api/intake");
    assert.equal(received.options.headers.Authorization, "Bearer intake-secret");
    assert.equal(received.options.headers["X-Intake-Idempotency-Key"], "WEB-123");
    assert.deepEqual(JSON.parse(received.options.body), {
      version: 1,
      source: "netlify-fpd-intake",
      idempotencyKey: "WEB-123",
      fields: { "Job ID": "WEB-123", "Property Address": "123 Main St" }
    });
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.RENDER_INTAKE_URL;
    else process.env.RENDER_INTAKE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.RENDER_INTAKE_TOKEN;
    else process.env.RENDER_INTAKE_TOKEN = previousToken;
  }
});

test("Netlify intake skips Render cleanly when the handoff is not configured", async () => {
  const previousUrl = process.env.RENDER_INTAKE_URL;
  const previousToken = process.env.RENDER_INTAKE_TOKEN;
  delete process.env.RENDER_INTAKE_URL;
  delete process.env.RENDER_INTAKE_TOKEN;
  try {
    const result = await maybeCreateRenderRecord({ "Job ID": "WEB-123" });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  } finally {
    if (previousUrl === undefined) delete process.env.RENDER_INTAKE_URL;
    else process.env.RENDER_INTAKE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.RENDER_INTAKE_TOKEN;
    else process.env.RENDER_INTAKE_TOKEN = previousToken;
  }
});

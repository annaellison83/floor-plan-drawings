const test = require("node:test");
const assert = require("node:assert/strict");
const { addressParts, classifyContacts, createGmailClient, extractClientName, extractPropertyAddress, gmailConfig, isLikelyFloorPlanIntake, parseGmailMessage, processIntakeMessages } = require("./gmail-runtime");

test("gmailConfig reads OAuth and intake settings", () => {
  const config = gmailConfig({ GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret", GMAIL_REFRESH_TOKEN: "refresh", GMAIL_INTAKE_LABEL_ID: "Label_29", ENABLE_GMAIL_AUTO_LABEL: "true", GMAIL_AUTO_LABEL_QUERY: "floor plan", GMAIL_AGENT_EMAILS: "anna@example.com, worker@example.com" });
  assert.equal(config.clientId, "id"); assert.equal(config.intakeLabelId, "Label_29");
  assert.equal(config.autoLabelEnabled, true); assert.equal(config.autoLabelQuery, "floor plan");
  assert.deepEqual(config.agentEmails, ["anna@example.com", "worker@example.com"]);
});

test("address parsing handles display names and bare addresses", () => {
  assert.deepEqual(addressParts('Anna Ellison <anna@example.com>, client@example.com'), [{ name: "Anna Ellison", email: "anna@example.com" }, { name: "", email: "client@example.com" }]);
});

test("contacts keep source, agent, and client roles separate", () => {
  const result = classifyContacts({ from: [{ name: "Conrad", email: "conrad@example.com" }], to: [{ name: "Anna", email: "anna@example.com" }, { name: "Client", email: "client@example.com" }], agentEmails: ["anna@example.com", "conrad@example.com"], clientEmails: ["client@example.com"] });
  assert.equal(result.source.role, "agent"); assert.deepEqual(result.agent.map((item) => item.email), ["conrad@example.com", "anna@example.com"]); assert.deepEqual(result.client.map((item) => item.email), ["client@example.com"]);
});

test("structured intake extraction handles floor plan and site map subjects", () => {
  assert.equal(extractPropertyAddress("Floor Plan Request | 4111 Edgehill Drive | Ali Jack", ""), "4111 Edgehill Drive");
  assert.equal(extractClientName("Floor Plan Request | 4111 Edgehill Drive | Ali Jack", ""), "Ali Jack");
  assert.equal(extractPropertyAddress("317-321 Ocean Park Blvd & 2528 4th St - Site Map Requested", ""), "317-321 Ocean Park Blvd & 2528 4th St");
});

test("parseGmailMessage preserves thread and reply metadata and decodes bodies", () => {
  const parsed = parseGmailMessage({ id: "m1", threadId: "t1", historyId: "h1", internalDate: "10", labelIds: ["Label_29"], payload: { headers: [{ name: "From", value: "Agent <agent@example.com>" }, { name: "To", value: "Anna <anna@example.com>" }, { name: "Subject", value: "Floor plan request" }, { name: "Message-ID", value: "<m1@example.com>" }, { name: "References", value: "<old@example.com>" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hello").toString("base64url") } }] } }, { agentEmails: ["agent@example.com"] });
  assert.equal(parsed.threadId, "t1"); assert.equal(parsed.messageId, "<m1@example.com>"); assert.equal(parsed.text, "Hello"); assert.equal(parsed.contacts.source.role, "agent");
});

test("FPD auto-label heuristic requires a marker plus an address and rejects unrelated mail", () => {
  assert.equal(isLikelyFloorPlanIntake({ subject: "Floor Plan Request", text: "Please measure 4111 Edgehill Drive.", propertyAddress: "4111 Edgehill Drive" }), true);
  assert.equal(isLikelyFloorPlanIntake({ subject: "Appointment Confirmation", text: "Kaiser appointment at 4111 Edgehill Drive", propertyAddress: "4111 Edgehill Drive" }), false);
  assert.equal(isLikelyFloorPlanIntake({ subject: "Quick hello", text: "Can you do Tuesday?", propertyAddress: "4111 Edgehill Drive" }), false);
});

test("parseGmailMessage collects attachment names for intake heuristics", () => {
  const parsed = parseGmailMessage({ id: "m1", payload: { headers: [], parts: [{ mimeType: "application/pdf", filename: "floorplan.pdf", body: {} }] } });
  assert.deepEqual(parsed.attachmentNames, ["floorplan.pdf"]);
});

test("processIntakeMessages passes role configuration to the parser", async () => {
  let parserOptions;
  const client = { listMessages: async () => ({ messages: [{ id: "m1" }] }), getMessage: async () => ({ id: "m1", payload: { headers: [] } }) };
  await processIntakeMessages({ client, options: { agentEmails: ["agent@example.com"] }, parser: (message, options) => { parserOptions = options; return message; }, onMessage: async () => {} });
  assert.deepEqual(parserOptions, { agentEmails: ["agent@example.com"] });
});

test("Gmail client refreshes OAuth and scopes intake listing to configured label", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); if (url.includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "access" }) }; return { ok: true, json: async () => ({ messages: [] }) }; };
  const client = createGmailClient({ fetchImpl: fakeFetch, env: { GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret", GMAIL_REFRESH_TOKEN: "refresh", GMAIL_INTAKE_LABEL_ID: "Label_29" } });
  await client.listMessages(); assert.match(calls[1].url, /labelIds=Label_29/); assert.equal(calls[1].options.headers.Authorization, "Bearer access");
});

test("Gmail client can read a complete thread for label reconciliation", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ messages: [{ id: "m1" }, { id: "m2" }] }) }; };
  const client = createGmailClient({ fetchImpl: fakeFetch, env: { GMAIL_ACCESS_TOKEN: "access", GMAIL_INTAKE_LABEL_ID: "Label_29" } });
  const thread = await client.getThread("t1");
  assert.deepEqual(thread.messages.map((item) => item.id), ["m1", "m2"]);
  assert.match(calls[0].url, /threads\/t1\?format=full/);
});

test("processIntakeMessages is idempotent and marks only after hook succeeds", async () => {
  const calls = [], client = { listMessages: async () => ({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }), getMessage: async (id) => ({ id, threadId: `t-${id}`, payload: { headers: [], body: {} } }) };
  const store = { seen: new Set(["gmail:m2"]), has: async (key) => store.seen.has(key), mark: async (key) => store.seen.add(key) };
  const result = await processIntakeMessages({ client, store, onMessage: async (message) => calls.push(message.id) });
  assert.deepEqual(calls, ["m1"]); assert.deepEqual(result.skipped, ["m2", "m1"]); assert.deepEqual(result.processed.map((item) => item.id), ["m1"]);
});

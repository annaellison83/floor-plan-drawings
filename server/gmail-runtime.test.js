const test = require("node:test");
const assert = require("node:assert/strict");
const { addressParts, classifyContacts, createGmailClient, extractClientName, extractPropertyAddress, gmailConfig, isLikelyFloorPlanIntake, isWeTransferPaymentConfirmation, parseGmailMessage, processIntakeMessages, resolveIntakeContacts } = require("./gmail-runtime");

test("gmailConfig reads OAuth and intake settings", () => {
  const config = gmailConfig({ GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret", GMAIL_REFRESH_TOKEN: "refresh", GMAIL_INTAKE_LABEL_ID: "Label_29", ENABLE_GMAIL_AUTO_LABEL: "true", GMAIL_AUTO_LABEL_QUERY: "floor plan", GMAIL_AGENT_EMAILS: "anna@example.com, worker@example.com" });
  assert.equal(config.clientId, "id"); assert.equal(config.intakeLabelId, "Label_29");
  assert.equal(config.autoLabelEnabled, true); assert.equal(config.autoLabelQuery, "floor plan");
  assert.match(config.paymentQuery, /wetransfer/i); assert.match(config.deliveryQuery, /wetransfer/i);
  assert.deepEqual(config.agentEmails, ["anna@example.com", "worker@example.com"]);
});

test("address parsing handles display names and bare addresses", () => {
  assert.deepEqual(addressParts('Anna Ellison <anna@example.com>, client@example.com'), [{ name: "Anna Ellison", email: "anna@example.com" }, { name: "", email: "client@example.com" }]);
});

test("contacts keep source, agent, and client roles separate", () => {
  const result = classifyContacts({ from: [{ name: "Conrad", email: "conrad@example.com" }], to: [{ name: "Anna", email: "anna@example.com" }, { name: "Client", email: "client@example.com" }], agentEmails: ["anna@example.com", "conrad@example.com"], clientEmails: ["client@example.com"] });
  assert.equal(result.source.role, "agent"); assert.deepEqual(result.agent.map((item) => item.email), ["conrad@example.com", "anna@example.com"]); assert.deepEqual(result.client.map((item) => item.email), ["client@example.com"]);
});

test("resolves a single external intake sender as the client", () => {
  const result = resolveIntakeContacts({
    contacts: {
      source: { name: "Sara Kaye", email: "sara@example.com", role: "unknown" },
      agent: [],
      client: [],
      unknown: [{ name: "Sara Kaye", email: "sara@example.com", role: "unknown" }]
    },
    subject: "Floor plan request | 1917 Eden Ave",
    text: "Please quote this floor plan.",
    clientName: "Sara Kaye"
  });
  assert.equal(result.roleResolution, "inferred-external-intake-sender");
  assert.deepEqual(result.client.map((item) => item.email), ["sara@example.com"]);
  assert.equal(result.unknown.length, 0);
});

test("keeps a sender for review when the message is clearly from a broker", () => {
  const result = resolveIntakeContacts({
    contacts: {
      source: { name: "Broker Name", email: "broker@example.com", role: "unknown" },
      agent: [],
      client: [],
      unknown: [{ name: "Broker Name", email: "broker@example.com", role: "unknown" }]
    },
    subject: "Floor plan request | 1917 Eden Ave",
    text: "I am the listing agent requesting this on behalf of the client.",
    clientName: ""
  });
  assert.equal(result.roleResolution, "needs-review");
  assert.equal(result.client.length, 0);
  assert.equal(result.unknown.length, 1);
});

test("structured intake extraction handles floor plan and site map subjects", () => {
  assert.equal(extractPropertyAddress("Floor Plan Request | 4111 Edgehill Drive | Ali Jack", ""), "4111 Edgehill Drive");
  assert.equal(extractClientName("Floor Plan Request | 4111 Edgehill Drive | Ali Jack", ""), "Ali Jack");
  assert.equal(extractPropertyAddress("317-321 Ocean Park Blvd & 2528 4th St - Site Map Requested", ""), "317-321 Ocean Park Blvd & 2528 4th St");
  assert.equal(extractPropertyAddress("NEW JOB: 921 Thayer Avenue", ""), "921 Thayer Avenue");
  assert.equal(extractPropertyAddress("Floor plan needed - 1624 Hillcrest Ave in Glendale", ""), "1624 Hillcrest Ave");
});

test("client extraction reads the explicit client line in a Gmail request", () => {
  assert.equal(extractClientName("Floor plan request", "1917 Eden Ave, Pasadena, CA 91103\nClient: Deborah Wolsh · deborah.wolsh@compass.com · 310-433-0385"), "Deborah Wolsh");
});

test("structured intake extraction removes inline map links from an address", () => {
  assert.equal(extractPropertyAddress("", "150 El Camino Drive, Suite 300, Beverly Hills, CA 90212<https://www.google.com/maps/search/150+El+Camino>"), "150 El Camino Drive, Suite 300, Beverly Hills, CA 90212");
});

test("address parsing ignores a signature-only brokerage address", () => {
  assert.equal(extractPropertyAddress("Floor plan request", "4111 Edgehill Drive\n\nThanks,\nBrokerage Team\n680 E Colorado Blvd, Suite 400, Pasadena, CA 91101"), "4111 Edgehill Drive");
  assert.equal(extractPropertyAddress("Floor plan request", "Please measure the home.\n\nThanks,\nBrokerage Team\n680 E Colorado Blvd, Suite 400, Pasadena, CA 91101"), "");
  assert.equal(extractPropertyAddress("Floor plan request", "Thanks for sending the address.\n680 E Colorado Blvd, Suite 400, Pasadena, CA 91101"), "680 E Colorado Blvd, Suite 400, Pasadena, CA 91101");
});

test("parseGmailMessage preserves thread and reply metadata and decodes bodies", () => {
  const parsed = parseGmailMessage({ id: "m1", threadId: "t1", historyId: "h1", internalDate: "10", labelIds: ["Label_29"], payload: { headers: [{ name: "From", value: "Agent <agent@example.com>" }, { name: "To", value: "Anna <anna@example.com>" }, { name: "Subject", value: "Floor plan request" }, { name: "Message-ID", value: "<m1@example.com>" }, { name: "References", value: "<old@example.com>" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hello").toString("base64url") } }] } }, { agentEmails: ["agent@example.com"] });
  assert.equal(parsed.threadId, "t1"); assert.equal(parsed.messageId, "<m1@example.com>"); assert.equal(parsed.text, "Hello"); assert.equal(parsed.contacts.source.role, "agent");
});

test("parseGmailMessage carries inferred client role for an unconfigured sender", () => {
  const parsed = parseGmailMessage({ id: "m2", threadId: "t2", payload: { headers: [
    { name: "From", value: "Sara Kaye <sara@example.com>" },
    { name: "Subject", value: "Floor plan request | 1917 Eden Ave" }
  ], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Please quote this floor plan.").toString("base64url") } }] } });
  assert.deepEqual(parsed.contacts.client.map((item) => item.email), ["sara@example.com"]);
  assert.equal(parsed.contacts.roleResolution, "inferred-external-intake-sender");
});

test("FPD auto-label heuristic requires a marker plus an address and rejects unrelated mail", () => {
  assert.equal(isLikelyFloorPlanIntake({ subject: "Floor Plan Request", text: "Please measure 4111 Edgehill Drive.", propertyAddress: "4111 Edgehill Drive" }), true);
  assert.equal(isLikelyFloorPlanIntake({ subject: "NEW JOB: 921 Thayer Avenue", text: "Please let me know your next available date for this home to get measured.", propertyAddress: "921 Thayer Avenue" }), true);
  assert.equal(isLikelyFloorPlanIntake({ subject: "Appointment Confirmation", text: "Kaiser appointment at 4111 Edgehill Drive", propertyAddress: "4111 Edgehill Drive" }), false);
  assert.equal(isLikelyFloorPlanIntake({ subject: "Quick hello", text: "Can you do Tuesday?", propertyAddress: "4111 Edgehill Drive" }), false);
  assert.equal(isLikelyFloorPlanIntake({ subject: "FloorPlanDrawings quote | 3960 Verdugo View Dr", text: "Please review the quote for this floor plan.", propertyAddress: "3960 Verdugo View Dr", contacts: { source: { role: "agent" } } }), false);
  assert.equal(isLikelyFloorPlanIntake({ subject: "FloorPlanDrawings quote | 3960 Verdugo View Dr", text: "Please review the quote for this floor plan.", propertyAddress: "3960 Verdugo View Dr" }), false);
  assert.equal(isLikelyFloorPlanIntake({ subject: "[TEST — NO WORKFLOW] FloorPlanDrawings | QUOTE READY | 4968 VINCENT AVE LOS ANGELES CA 90041", text: "4968 VINCENT AVE LOS ANGELES CA 90041 floor plan", propertyAddress: "4968 VINCENT AVE LOS ANGELES CA 90041" }), false);
});

test("Gmail intake ignores outgoing floor plan quote drafts", () => {
  assert.equal(isLikelyFloorPlanIntake({ subject: "Floor plan quote for 4968 Vincent Ave", text: "Quote: $345", propertyAddress: "4968 Vincent Ave" }), false);
});

test("WeTransfer acceptance is a payment signal, but expiry is not", () => {
  const base = { contacts: { source: { email: "notifications@wetransfer.com" } } };
  assert.equal(isWeTransferPaymentConfirmation({ ...base, subject: "Your transfer has been downloaded", text: "Good news — your transfer was downloaded." }), true);
  assert.equal(isWeTransferPaymentConfirmation({ ...base, subject: "Your transfer has expired", text: "The transfer was not downloaded." }), false);
  assert.equal(isWeTransferPaymentConfirmation({ contacts: { source: { email: "client@example.com" } }, subject: "Your transfer has been downloaded", text: "WeTransfer" }), false);
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

test("Gmail client can create a formatted draft", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: "draft-1", message: { id: "message-1" } }) };
  };
  const client = createGmailClient({ fetchImpl: fakeFetch, env: { GMAIL_ACCESS_TOKEN: "access", GMAIL_INTAKE_LABEL_ID: "Label_29" } });
  const draft = await client.createDraft({ raw: "encoded-html-message", threadId: "thread-1" });
  assert.equal(draft.id, "draft-1");
  assert.match(calls[0].url, /\/drafts$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: { raw: "encoded-html-message", threadId: "thread-1" } });
});

test("processIntakeMessages is idempotent and marks only after hook succeeds", async () => {
  const calls = [], client = { listMessages: async () => ({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }), getMessage: async (id) => ({ id, threadId: `t-${id}`, payload: { headers: [], body: {} } }) };
  const store = { seen: new Set(["gmail:m2"]), has: async (key) => store.seen.has(key), mark: async (key) => store.seen.add(key) };
  const result = await processIntakeMessages({ client, store, onMessage: async (message) => calls.push(message.id) });
  assert.deepEqual(calls, ["m1"]); assert.deepEqual(result.skipped, ["m2", "m1"]); assert.deepEqual(result.processed.map((item) => item.id), ["m1"]);
});

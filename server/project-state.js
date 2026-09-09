const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Render is intentionally the workflow engine, while Airtable remains the
// rollback/shadow source during cutover.  This store is a small persistence
// boundary: it is durable when STATE_FILE is mounted, and safe in-memory when
// it is not.  Secrets, message bodies, and credentials are never stored here.

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validEmail(value) {
  const email = clean(value).toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function uniqueEmails(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(validEmail).filter(Boolean))];
}

function checkedEmails(values, field) {
  const supplied = Array.isArray(values) ? values : [values];
  const nonEmpty = supplied.filter((value) => clean(value));
  const result = uniqueEmails(values);
  if (nonEmpty.length && result.length !== nonEmpty.length) throw new Error(`recipient ${field} contains an invalid email address`);
  return result;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(password|token|secret|credential|api.?key)/i.test(key))
    .map(([key, item]) => [key, typeof item === "object" && item !== null ? safeMetadata(item) : item]));
}

function recipients(input = {}) {
  const client = checkedEmails(input.client || input.clientEmail, "client");
  const agent = checkedEmails(input.agent || input.agentEmail, "agent");
  const internal = checkedEmails(input.internal || input.internalEmail, "internal");
  const custom = checkedEmails(input.custom || input.customEmail, "custom");
  const policyValue = clean(input.policy || input.recipientPolicy || "");
  // Never assume an unclassified intake sender is the client. Unknown or
  // agent-only projects stay internal until Anna explicitly sets a policy.
  const policy = policyValue.toLowerCase() || (client.length ? "client" : "internal");
  const allowedPolicies = new Set(["client", "agent", "both", "internal", "custom"]);
  if (!allowedPolicies.has(policy)) throw new Error("recipientPolicy must be client, agent, both, internal, or custom");
  return { client, agent, internal, custom, policy, policyExplicit: Boolean(input.policyExplicit || policyValue) };
}

function recipientsFor(purpose, contactSet) {
  const contacts = recipients(contactSet);
  const clientFacing = /client|appointment|confirmation|reminder/i.test(clean(purpose));
  if (clientFacing && contacts.client.length && contacts.agent.length && !contacts.policyExplicit) {
    throw new Error(`Recipient policy is required for ${clean(purpose) || "this message"}; client and agent contacts are both present`);
  }
  const list = contacts.policy === "client" ? contacts.client
    : contacts.policy === "agent" ? contacts.agent
      : contacts.policy === "both" ? [...contacts.client, ...contacts.agent]
        : contacts.policy === "internal" ? contacts.internal
          : contacts.custom;
  if (!list.length) {
    throw new Error(`No recipient is configured for ${clean(purpose) || "this message"}`);
  }
  return [...new Set(list)];
}

function safeProject(input = {}) {
  const contactSet = recipients(input.contacts || input);
  return {
    id: clean(input.id || input.recordId) || id("project"),
    source: clean(input.source) || "render",
    sourceId: clean(input.sourceId || input.recordId),
    status: clean(input.status) || "new",
    stage: clean(input.stage) || "intake",
    propertyAddress: clean(input.propertyAddress || input.address),
    clientName: clean(input.clientName),
    contacts: contactSet,
    metadata: safeMetadata(input.metadata),
    createdAt: clean(input.createdAt) || now(),
    updatedAt: now()
  };
}

class ProjectStateStore {
  constructor(options = {}) {
    this.filePath = clean(options.filePath || process.env.STATE_FILE);
    this.projects = new Map();
    this.events = [];
    this.deliveries = new Map();
    this.processedMessages = new Map();
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const project of parsed.projects || []) this.projects.set(project.id, project);
      this.events = Array.isArray(parsed.events) ? parsed.events : [];
      for (const delivery of parsed.deliveries || []) this.deliveries.set(delivery.idempotencyKey, delivery);
      for (const message of parsed.processedMessages || []) this.processedMessages.set(message.key, message);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Project state could not be loaded: ${error.message}`);
    }
  }

  _persist() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({
        projects: [...this.projects.values()],
        events: this.events.slice(-5000),
        deliveries: [...this.deliveries.values()].slice(-2000),
        processedMessages: [...this.processedMessages.values()].slice(-5000)
      }, null, 2), { mode: 0o600 });
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      console.warn(`Project state could not be persisted: ${error.message}`);
    }
  }

  upsertProject(input = {}) {
    const existing = this.projects.get(clean(input.id || input.recordId));
    const project = safeProject({ ...(existing || {}), ...input, contacts: { ...(existing && existing.contacts), ...(input.contacts || {}) } });
    this.projects.set(project.id, project);
    this.event({ projectId: project.id, type: existing ? "project.updated" : "project.created", data: { status: project.status, stage: project.stage } });
    return project;
  }

  getProject(projectId) {
    return this.projects.get(clean(projectId)) || null;
  }

  listProjects({ status, stage, limit = 100 } = {}) {
    return [...this.projects.values()]
      .filter((project) => (!status || project.status === status) && (!stage || project.stage === stage))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  event(input = {}) {
    const record = {
      id: id("evt"),
      projectId: clean(input.projectId),
      type: clean(input.type) || "event",
      actor: clean(input.actor) || "render",
      data: input.data && typeof input.data === "object" ? input.data : {},
      createdAt: now()
    };
    this.events.push(record);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    this._persist();
    return record;
  }

  listEvents({ projectId, type, limit = 100 } = {}) {
    return this.events.filter((event) => (!projectId || event.projectId === projectId) && (!type || event.type === type)).slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse();
  }

  reserveDelivery(input = {}) {
    const key = clean(input.idempotencyKey);
    if (!key) throw new Error("idempotencyKey is required");
    const existing = this.deliveries.get(key);
    if (existing) return { duplicate: true, delivery: existing };
    const delivery = {
      id: id("delivery"),
      idempotencyKey: key,
      projectId: clean(input.projectId),
      workflow: clean(input.workflow),
      channel: clean(input.channel) || "email",
      recipientType: clean(input.recipientType) || "client",
      recipients: uniqueEmails(input.recipients),
      subject: clean(input.subject),
      status: "pending",
      attempts: 0,
      provider: "",
      messageId: "",
      error: "",
      createdAt: now(),
      updatedAt: now()
    };
    this.deliveries.set(key, delivery);
    this.event({ projectId: delivery.projectId, type: "delivery.reserved", data: { deliveryId: delivery.id, workflow: delivery.workflow, recipientType: delivery.recipientType } });
    this._persist();
    return { duplicate: false, delivery };
  }

  updateDelivery(idempotencyKey, patch = {}) {
    const delivery = this.deliveries.get(clean(idempotencyKey));
    if (!delivery) return null;
    const allowed = ["status", "attempts", "provider", "messageId", "error", "nextAttemptAt"];
    for (const field of allowed) if (patch[field] !== undefined) delivery[field] = patch[field];
    delivery.updatedAt = now();
    this.event({ projectId: delivery.projectId, type: `delivery.${delivery.status}`, data: { deliveryId: delivery.id, workflow: delivery.workflow, error: delivery.error } });
    this._persist();
    return delivery;
  }

  listDeliveries({ projectId, status, limit = 100 } = {}) {
    return [...this.deliveries.values()]
      .filter((delivery) => (!projectId || delivery.projectId === projectId) && (!status || delivery.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  hasProcessedMessage(key) {
    return this.processedMessages.has(clean(key));
  }

  markProcessedMessage(key, data = {}) {
    const normalized = clean(key);
    if (!normalized) throw new Error("message key is required");
    const existing = this.processedMessages.get(normalized);
    if (existing) return existing;
    const record = { key: normalized, ...safeMetadata(data), processedAt: now() };
    this.processedMessages.set(normalized, record);
    this._persist();
    return record;
  }
}

const store = new ProjectStateStore();

module.exports = {
  ProjectStateStore,
  projectState: store,
  recipients,
  recipientsFor,
  safeProject,
  uniqueEmails
};

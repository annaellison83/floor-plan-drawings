const assert = require("node:assert/strict");
const test = require("node:test");
const { ProjectStateStore, recipients, recipientsFor, safeProject } = require("./project-state");

test("keeps client and agent contacts separate and requires an explicit policy", () => {
  const project = safeProject({
    id: "rec-project",
    clientName: "Ali",
    clientEmail: "client@example.com",
    agentEmail: "agent@example.com",
    recipientPolicy: "client"
  });
  assert.deepEqual(project.contacts.client, ["client@example.com"]);
  assert.deepEqual(project.contacts.agent, ["agent@example.com"]);
  assert.deepEqual(recipientsFor("client confirmation", project.contacts), ["client@example.com"]);
  assert.deepEqual(recipientsFor("agent notice", { ...project.contacts, policy: "agent" }), ["agent@example.com"]);
  assert.throws(() => recipientsFor("confirmation", { client: [], agent: ["agent@example.com"], policy: "client" }), /No recipient/);
  assert.throws(() => recipients({ clientEmail: "not-an-email" }), /recipient/);
});

test("reserves delivery idempotently and records an auditable lifecycle", () => {
  const store = new ProjectStateStore();
  const project = store.upsertProject({ id: "project-1", address: "1 Main St", clientEmail: "client@example.com" });
  assert.equal(project.id, "project-1");
  const first = store.reserveDelivery({
    idempotencyKey: "project-1:quote:v1",
    projectId: project.id,
    workflow: "QUOTE READY",
    recipientType: "internal",
    recipients: ["anna@example.com"],
    subject: "QUOTE READY"
  });
  assert.equal(first.duplicate, false);
  const second = store.reserveDelivery({ idempotencyKey: "project-1:quote:v1", projectId: project.id });
  assert.equal(second.duplicate, true);
  assert.equal(second.delivery.id, first.delivery.id);
  const failed = store.updateDelivery("project-1:quote:v1", { status: "failed", attempts: 3, error: "timeout" });
  assert.equal(failed.status, "failed");
  assert.equal(store.listDeliveries({ status: "failed" }).length, 1);
  const events = store.listEvents({ projectId: project.id });
  assert.ok(events.some((event) => event.type === "project.created"));
  assert.ok(events.some((event) => event.type === "delivery.reserved"));
  assert.ok(events.some((event) => event.type === "delivery.failed"));
});

test("progress updates persist status, stage, metadata, and a progress event", () => {
  const store = new ProjectStateStore();
  const project = store.upsertProject({ id: "project-progress", address: "1 Main St", clientEmail: "client@example.com" });
  const updated = store.updateProjectProgress(project.id, {
    status: "scheduled",
    stage: "scheduled",
    metadata: { appointmentStart: "2026-09-14T18:00:00.000Z", worker: "Corrie" },
    note: "Client selected the confirmed appointment"
  }, "anna");
  assert.equal(updated.status, "scheduled");
  assert.equal(updated.stage, "scheduled");
  assert.equal(updated.metadata.worker, "Corrie");
  const event = store.listEvents({ projectId: project.id, type: "project.progressed" })[0];
  assert.equal(event.actor, "anna");
  assert.equal(event.data.after.stage, "scheduled");
  assert.equal(event.data.note, "Client selected the confirmed appointment");
});

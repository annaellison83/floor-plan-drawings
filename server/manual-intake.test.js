const test = require("node:test");
const assert = require("node:assert/strict");
const { extractAddress, manualIntakeKey, parseManualIntake } = require("./manual-intake");

test("manual intake extracts an address from a short text message", () => {
  const parsed = parseManualIntake("hi Anna can we schedule floorplans at 150 Arlington Dr Pasadena");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.propertyAddress, "150 Arlington Dr Pasadena");
  assert.match(parsed.fields["Google Maps Link"], /google\.com\/maps/);
  assert.match(parsed.fields["ZIMAS Link"], /zimas\.lacity\.org/);
  assert.match(parsed.fields["Aerial Map URL"], /earth\.google\.com/);
});

test("manual intake requires an address and rejects unsafe photo URLs", () => {
  const missing = parseManualIntake("Can we schedule a floorplan next week?");
  assert.equal(missing.ok, false);
  assert.equal(missing.needsAddress, true);
  const unsafe = parseManualIntake("floorplan at 150 Arlington Dr Pasadena", { photoUrl: "javascript:alert(1)" });
  assert.equal(unsafe.ok, false);
});

test("manual intake key is deterministic", () => {
  assert.equal(manualIntakeKey("150 Arlington Dr Pasadena", "request"), manualIntakeKey("150 Arlington Dr Pasadena", "request"));
  assert.notEqual(manualIntakeKey("150 Arlington Dr Pasadena", "request"), manualIntakeKey("151 Arlington Dr Pasadena", "request"));
  assert.equal(extractAddress("floorplans at 150 Arlington Dr Pasadena"), "150 Arlington Dr Pasadena");
});

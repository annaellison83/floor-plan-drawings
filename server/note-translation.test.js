const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLine, translateClientNotes } = require("./note-translation");

test("normalizes common shorthand without changing meaning", () => {
  assert.equal(normalizeLine("  B/W   + 3d tour  "), "Black & White + 3D tour");
});

test("creates a concise internal scope note with review flags", () => {
  const result = translateClientNotes("Upstairs unit only. Rush by Friday. Include site plan.", {
    service: "B&W Interior",
    propertyAddress: "123 Main St, Los Angeles, CA"
  });
  assert.match(result, /Internal scope summary \(Render\)/);
  assert.match(result, /Timing or rush request needs review/);
  assert.match(result, /Non-standard or partial scope needs review/);
  assert.match(result, /Additional site or orientation deliverables mentioned/);
  assert.match(result, /• Upstairs unit only\./);
});

test("returns empty output for empty notes", () => {
  assert.equal(translateClientNotes("", {}), "");
});

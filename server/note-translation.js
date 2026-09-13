function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeLine(value) {
  return clean(value)
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bB\s*\/\s*W\b/gi, "Black & White")
    .replace(/\bB&W\b/gi, "Black & White")
    .replace(/\b3d\b/gi, "3D")
    .trim();
}

function unique(values) {
  return [...new Set(values.map(normalizeLine).filter(Boolean))];
}

function translateClientNotes(notes, job = {}) {
  const source = clean(notes);
  if (!source) return "";

  const lines = unique(source.split(/\r?\n|(?<=[.!?])\s+/));
  const flags = [];
  const searchable = source.toLowerCase();
  if (/\b(rush|urgent|asap|quickly|as soon as possible|by\s+\d|deadline)\b/.test(searchable)) {
    flags.push("Timing or rush request needs review");
  }
  if (/\b(adu|duplex|triplex|multi[- ]?unit|apartment|suite|commercial|unit\b|upstairs|downstairs|carriage house)\b/.test(searchable)) {
    flags.push("Non-standard or partial scope needs review");
  }
  if (/\b(site plan|color site|exterior|elevation|north|south|east|west|n\/s\/e\/w)\b/.test(searchable)) {
    flags.push("Additional site or orientation deliverables mentioned");
  }
  if (/\b(matterport|3D\s*(tour|scan)|virtual tour)\b/i.test(source)) {
    flags.push("3D or Matterport service mentioned");
  }
  if (/\b(access|parking|gate|lockbox|occup|photographer|agent will|meet)\b/.test(searchable)) {
    flags.push("Access or on-site coordination details mentioned");
  }

  const context = [
    clean(job.service) && `Service: ${normalizeLine(job.service)}`,
    clean(job.propertyAddress) && `Property: ${normalizeLine(job.propertyAddress)}`
  ].filter(Boolean);
  return [
    "Internal scope summary (Render)",
    ...context,
    flags.length ? `Review flags: ${flags.join("; ")}` : "Review flags: none detected",
    "Client notes:",
    ...lines.map((line) => `• ${line}`)
  ].join("\n");
}

module.exports = { normalizeLine, translateClientNotes };

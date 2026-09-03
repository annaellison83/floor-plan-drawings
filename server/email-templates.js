const { resolveQuoteZone } = require("./quote-zone");
const { resolveSquareFootage, sizeResearchLinks } = require("./square-footage");

function text(value, fallback = "—") {
  const cleaned = value === undefined || value === null ? "" : String(value).trim();
  return cleaned || fallback;
}

function escapeHtml(value) {
  return text(value, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value) {
  const candidate = text(value, "");
  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount)
    : "Needs review";
}

function quotePricing(job) {
  const resolvedZone = resolveQuoteZone(job);
  const zoneNumber = resolvedZone.zoneNumber;
  const zoneMinimum = resolvedZone.minimum;
  const basePrice = Number(job.baseServiceQuote ?? job.suggestedQuote);
  const finalPrice = Number.isFinite(basePrice) ? Math.max(basePrice, zoneMinimum || 0) : null;
  return { ...resolvedZone, zoneMinimum, basePrice, finalPrice };
}

function detail(label, value) {
  return `<td class="detail-cell" width="50%" valign="top"><div class="detail"><div class="eyebrow">${escapeHtml(label)}</div><div class="detail-value">${escapeHtml(value)}</div></div></td>`;
}

function imageCard(number, label, imageUrl, linkUrl) {
  const image = safeUrl(imageUrl);
  const link = safeUrl(linkUrl || imageUrl);
  if (!image) return "";

  const imageTag = `<img src="${escapeHtml(image)}" alt="${escapeHtml(label)}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;margin:0 auto;border:0;border-radius:14px;">`;
  const content = link ? `<a href="${escapeHtml(link)}" style="display:block;width:100%;text-decoration:none;">${imageTag}</a>` : imageTag;
  return `<tr><td class="image-wrap"><div class="eyebrow image-label">${escapeHtml(number)} &nbsp; ${escapeHtml(label)}</div>${content}</td></tr>`;
}

function sizeLookupPanel(address, squareFootage) {
  if (squareFootage.verified) return "";
  const links = sizeResearchLinks(address)
    .map(({ label, url }) => `<a href="${escapeHtml(url)}" style="display:inline-block;margin:6px 10px 0 0;color:#0b57d0;font-weight:700;">${escapeHtml(label)}</a>`)
    .join("");
  return `<div class="size-lookup"><strong>Building size needs verification</strong><br><span>Listing sites are leads only—confirm the number before automatic pricing.</span><div>${links}</div></div>`;
}

function quoteReadyEmail(job) {
  const address = text(job.propertyAddress);
  const pricing = quotePricing(job);
  const squareFootage = resolveSquareFootage(job);
  const zone = pricing.zoneLabel;
  const addressMapUrl = safeUrl(job.propertyMapUrl)
    || `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(address)}`;
  const recordUrl = safeUrl(job.recordUrl);
  const approvalUrl = safeUrl(job.approvalUrl);
  const availabilityReviewUrl = safeUrl(job.availabilityReviewUrl);
  const mapUrl = safeUrl(job.mapUrl);
  const contextMapUrl = safeUrl(job.contextMapUrl);
  const subject = `QUOTE READY | ${address}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0!important;padding:0!important;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:1100px;margin:0 auto}.pad{padding:28px 0}.card{background:#fbf8f1;border:1px solid #ddd7ca;border-radius:20px}.card-pad{padding:40px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.section-title{font-size:16px;line-height:22px;color:#53635c}.property-head{margin-top:22px;padding:28px;background:#b8c9ae;border-radius:18px}.address{margin:10px 0 8px;font-size:31px;line-height:38px;font-weight:700}.address a{color:#0b57d0!important;text-decoration:underline}.muted{color:#53635c;font-size:15px;line-height:23px}.summary{width:100%;margin-top:22px;border-collapse:collapse}.detail-cell{padding:6px}.detail{background:#e3eadf;border-radius:14px;padding:20px}.detail-value{margin-top:8px;color:#173f36;font-size:18px;line-height:25px;font-weight:700}.size-lookup{margin:14px 6px 0;padding:18px 20px;background:#fff4d6;border:1px solid #e4cf91;border-radius:14px;color:#394842;font-size:14px;line-height:21px}.quote{margin:22px 6px 0;background:#b8c9ae;border-radius:16px;text-align:center;padding:25px}.quote-value{margin-top:8px;color:#173f36;font-size:34px;line-height:40px;font-weight:700}.image-wrap{padding:26px 6px 0;text-align:center}.image-label{padding-bottom:9px;text-align:left}.button-wrap{text-align:center;padding:30px 0 4px}.button{display:inline-block;min-width:260px;background:#173f36;color:#fff!important;text-decoration:none;border-radius:10px;padding:16px 28px;font-size:16px;line-height:20px;font-weight:700;text-align:center}.secondary{margin-top:16px;text-align:center;font-size:13px;line-height:20px}.secondary a{color:#173f36}.notes{margin:26px 6px 0;padding:22px;background:#fff;border:1px solid #e2ddd2;border-radius:14px;color:#394842;font-size:14px;line-height:21px;white-space:pre-line}
@media only screen and (max-width:640px){.canvas{width:100%!important;max-width:none!important}.pad{padding:12px!important}.card-pad{padding:22px 13px!important}.property-head{margin:16px 5px 0!important;padding:19px 16px!important}.address{font-size:23px!important;line-height:29px!important}.summary tr,.detail-cell{display:block!important;width:auto!important}.detail-cell{padding:5px!important}.detail{padding:16px!important}.size-lookup{margin:10px 5px 0!important;padding:16px!important}.quote{margin:13px 5px 0!important;padding:20px 14px!important}.quote-value{font-size:29px!important;line-height:35px!important}.image-wrap{padding:18px 5px 0!important}.button{display:block!important;min-width:0!important;padding:15px 18px!important}.notes{margin:18px 5px 0!important;padding:17px!important}}
</style></head><body><table role="presentation" class="shell" width="100%" cellspacing="0" cellpadding="0"><tr><td class="pad"><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0"><tr><td class="card"><div class="card-pad"><div class="eyebrow section-title">QUOTE READY</div><div class="property-head"><div class="eyebrow">Property address</div><h1 class="address"><a href="${addressMapUrl}">${escapeHtml(address)}</a></h1><div class="muted">· ${escapeHtml(text(job.workflow, "Quick Quote"))} · ${escapeHtml(text(job.status, "Needs Quote"))}</div></div><table role="presentation" class="summary" width="100%"><tr>${detail("Service requested", text(job.service))}${detail("Quote zone", zone)}</tr><tr>${detail(squareFootage.verified ? "Verified size" : "Size status", squareFootage.label)}${detail("3D tour", text(job.tourRequested, "No"))}</tr>${job.clientName || job.clientEmail || job.clientPhone ? `<tr>${detail("Client", text(job.clientName))}${detail("Contact", [job.clientEmail, job.clientPhone].map((value) => text(value, "")).filter(Boolean).join(" · "))}</tr>` : ""}</table>${sizeLookupPanel(address, squareFootage)}<div class="quote"><div class="eyebrow">Suggested quote</div><div class="quote-value">${escapeHtml(money(pricing.finalPrice))}</div><div class="muted">${pricing.zoneMinimum ? `Base service ${escapeHtml(money(pricing.basePrice))}; Zone ${pricing.zoneNumber} sets a ${escapeHtml(money(pricing.zoneMinimum))} minimum. The higher amount wins.` : "Assign a zone before approval. Zone minimums are floors, never add-ons."}</div></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${imageCard("01", "Property close-up", job.mapUrl, job.mapUrl)}${imageCard("02", "Greater LA context", job.contextMapUrl, job.contextMapUrl)}</table>${job.quoteNotes ? `<div class="notes"><strong>Pricing review</strong><br>${escapeHtml(job.quoteNotes)}</div>` : ""}${approvalUrl ? `<div class="button-wrap"><a class="button" href="${escapeHtml(approvalUrl)}">Review &amp; approve quote</a></div>` : ""}${recordUrl ? `<div class="secondary"><a href="${escapeHtml(recordUrl)}">Open Airtable record</a></div>` : ""}</div></td></tr></table></td></tr></table></body></html>`;

  const plainText = [
    "QUOTE READY",
    address,
    `Service: ${text(job.service)}`,
    `Quote zone: ${zone}`,
    `${squareFootage.verified ? "Verified size" : "Size status"}: ${squareFootage.label}`,
    job.clientName && `Client: ${job.clientName}`,
    (job.clientEmail || job.clientPhone) && `Contact: ${[job.clientEmail, job.clientPhone].filter(Boolean).join(" · ")}`,
    `Suggested quote: ${money(pricing.finalPrice)}`,
    pricing.zoneMinimum && `Pricing rule: base ${money(pricing.basePrice)}; Zone ${pricing.zoneNumber} minimum ${money(pricing.zoneMinimum)}; the higher amount wins.`,
    job.quoteNotes && `Pricing review: ${job.quoteNotes}`,
    availabilityReviewUrl && `Check availability and send appointment options: ${availabilityReviewUrl}`,
    approvalUrl && `Review and approve: ${approvalUrl}`,
    recordUrl && `Airtable record: ${recordUrl}`
  ].filter(Boolean).join("\n\n");

  const renderedHtml = availabilityReviewUrl
    ? html.replace("</body>", `<div style="max-width:1100px;margin:0 auto 24px;text-align:center;font-family:Arial,Helvetica,sans-serif;"><a class="button" href="${escapeHtml(availabilityReviewUrl)}">Check availability &amp; send options</a></div></body>`)
    : html;
  return { subject, html: renderedHtml, text: plainText };
}

function clientQuoteEmail(job, proposalUrl = "", slots = []) {
  const name = text(job.clientName, "there");
  const address = text(job.propertyAddress);
  const service = text(job.service, "Floor plan drawing");
  const scope = text(job.scope, "As requested");
  const quote = money(job.finalQuote);
  const subject = `Your floor plan quote - ${address}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f1eb;"><tr><td style="padding:24px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;margin:0 auto;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:18px;"><tr><td style="padding:38px 32px;"><div style="color:#53635c;font-size:12px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;">FloorPlanDrawings</div><h1 style="margin:14px 0 18px;font-size:30px;line-height:38px;color:#173f36;">Your floor plan quote</h1><p style="font-size:16px;line-height:25px;margin:0 0 20px;">Hi ${escapeHtml(name)},</p><p style="font-size:16px;line-height:25px;margin:0 0 22px;">Thanks for reaching out to FloorPlanDrawings. Anna reviewed your request and approved the following quote.</p><div style="background:#b8c9ae;border-radius:14px;padding:24px;"><div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#53635c;">Property</div><div style="margin-top:8px;font-size:22px;line-height:30px;font-weight:700;">${escapeHtml(address)}</div><div style="margin-top:16px;font-size:15px;line-height:24px;"><strong>Service:</strong> ${escapeHtml(service)}<br><strong>Scope:</strong> ${escapeHtml(scope)}</div><div style="margin-top:20px;font-size:34px;line-height:40px;font-weight:700;color:#173f36;">${escapeHtml(quote)}</div></div><p style="font-size:16px;line-height:25px;margin:24px 0 0;">If you would like to move forward, reply to this email with your preferred appointment day/time and access details. We will confirm the appointment after we hear back.</p><p style="font-size:16px;line-height:25px;margin:24px 0 0;">Thank you,<br>FloorPlanDrawings</p></td></tr></table></td></tr></table></body></html>`;
  const options = (Array.isArray(slots) ? slots : []).slice(0, 5);
  const appointmentPanel = proposalUrl ? `<div style="margin-top:24px;padding:20px;background:#e3eadf;border-radius:14px;"><div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#53635c;">Appointment options</div><p style="font-size:16px;line-height:25px;margin:10px 0 14px;color:#394842;">Choose a preferred time and we will re-check availability before confirming it.</p>${options.map((slot, index) => `<div style="padding:10px 0;border-top:1px solid #cbd7c5;font-size:15px;line-height:23px;color:#394842;"><strong>Option ${index + 1}:</strong> ${escapeHtml(formatSlot(slot))}</div>`).join("")}<div style="text-align:center;margin-top:16px;"><a href="${escapeHtml(proposalUrl)}" style="display:inline-block;background:#173f36;color:#fff!important;text-decoration:none;border-radius:9px;padding:14px 22px;font-size:16px;line-height:21px;font-weight:700;">Choose an appointment time</a></div></div>` : "";
  const renderedHtml = proposalUrl ? html.replace("</body>", `${appointmentPanel}</body>`) : html;
  const plainText = [`Hi ${name},`, "Thanks for reaching out to FloorPlanDrawings. Anna reviewed your request and approved the following quote.", `Property: ${address}`, `Service: ${service}`, `Scope: ${scope}`, `Quote: ${quote}`, options.length && options.map((slot, index) => `Option ${index + 1}: ${formatSlot(slot)}`).join("\n"), proposalUrl && `Choose an appointment time: ${proposalUrl}`, "If you would like to move forward, reply to this email with access details. We will confirm the appointment after we hear back.", "Thank you,\nFloorPlanDrawings"].filter(Boolean).join("\n\n");
  return { subject, html: renderedHtml, text: plainText };
}

function formatSlot(slot) {
  const date = new Date(`${text(slot.date)}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? text(slot.date)
    : date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const duration = slot.durationMinutes ? `${slot.durationMinutes} minutes` : "scheduled visit";
  return `${dateLabel} at ${text(slot.localStart)} · ${text(slot.worker)} · ${duration}`;
}

function clientAvailabilityProposalEmail(job, proposalUrl, slots = []) {
  const name = text(job.clientName, "there");
  const address = text(job.propertyAddress);
  const service = text(job.service, "Floor plan drawing");
  const options = (Array.isArray(slots) ? slots : []).slice(0, 5);
  const optionRows = options.map((slot, index) => `<tr><td style="padding:15px 16px;border:1px solid #d9d5ca;background:#fff;vertical-align:top;"><div style="font-size:16px;line-height:24px;font-weight:700;color:#173f36;">Option ${index + 1}</div><div style="margin-top:4px;font-size:15px;line-height:23px;color:#394842;">${escapeHtml(formatSlot(slot))}</div><div style="margin-top:4px;font-size:13px;line-height:20px;color:#53635c;">Target delivery: ${escapeHtml(slot.deliveryTarget && slot.deliveryTarget.label || "To be confirmed")}</div></td></tr>`).join("");
  const subject = `APPOINTMENT OPTIONS | ${address}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:760px;margin:0 auto}.card{margin:24px auto;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:18px}.pad{padding:34px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.title{margin:12px 0 14px;font-size:31px;line-height:39px;color:#173f36}.copy{font-size:16px;line-height:25px;color:#394842}.property{margin:22px 0;padding:20px;background:#b8c9ae;border-radius:14px;font-size:18px;line-height:26px;font-weight:700}.options{width:100%;border-collapse:separate;border-spacing:0 10px}.button-wrap{text-align:center;padding:25px 0 10px}.button{display:inline-block;background:#173f36;color:#fff!important;text-decoration:none;border-radius:10px;padding:16px 26px;font-size:16px;line-height:21px;font-weight:700}.fine{font-size:13px;line-height:20px;color:#6b7067}@media only screen and (max-width:640px){.canvas{width:100%!important}.card{margin:8px 0;border-radius:12px}.pad{padding:23px 16px!important}.title{font-size:27px;line-height:34px}.property{padding:17px;font-size:16px;line-height:23px}.button{display:block;text-align:center}.options td{padding:13px!important}}</style></head><body><table role="presentation" class="shell" width="100%" cellspacing="0" cellpadding="0"><tr><td><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0"><tr><td class="card"><div class="pad"><div class="eyebrow">FloorPlanDrawings / scheduling</div><h1 class="title">Choose an appointment time</h1><p class="copy">Hi ${escapeHtml(name)},</p><p class="copy">Anna reviewed your ${escapeHtml(service)} request. These appointment options are currently available for the property below.</p><div class="property">${escapeHtml(address)}</div><table role="presentation" class="options" width="100%" cellspacing="0" cellpadding="0">${optionRows}</table>${proposalUrl ? `<div class="button-wrap"><a class="button" href="${escapeHtml(proposalUrl)}">Review and choose a time</a></div>` : ""}<p class="fine">Selecting a time requests that slot; we will re-check availability and confirm it before the appointment is final. These options expire automatically.</p><p class="copy">Thank you,<br>FloorPlanDrawings</p></div></td></tr></table></td></tr></table></body></html>`;
  const plainText = [`APPOINTMENT OPTIONS`, `Hi ${name},`, `Anna reviewed your ${service} request.`, `Property: ${address}`, options.map((slot, index) => `Option ${index + 1}: ${formatSlot(slot)} · Target delivery: ${slot.deliveryTarget && slot.deliveryTarget.label || "To be confirmed"}`).join("\n"), proposalUrl && `Review and choose a time: ${proposalUrl}`, "Selecting a time requests that slot; we will re-check availability and confirm it before the appointment is final."].filter(Boolean).join("\n\n");
  return { subject, html, text: plainText };
}

function internalLink(label, href) {
  const safe = safeUrl(href);
  return safe ? `<a href="${escapeHtml(safe)}" style="color:#0b57d0;font-weight:700;">${escapeHtml(label)}</a>` : "";
}

function internalEmailShell(label, title, intro, bodyHtml, bodyText) {
  const subject = `${label} | ${title}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:1100px;margin:0 auto}.card{margin:24px auto;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:18px}.pad{padding:32px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.title{margin:12px 0 10px;font-size:32px;line-height:40px;color:#173f36}.intro{font-size:16px;line-height:25px;color:#53635c}.table{width:100%;border-collapse:collapse;margin-top:24px}.table th,.table td{padding:13px 12px;border:1px solid #d9d5ca;text-align:left;vertical-align:top;font-size:14px;line-height:21px}.table th{background:#e3eadf;color:#394842;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.panel{margin-top:22px;padding:18px 20px;background:#e3eadf;border-radius:14px;font-size:15px;line-height:24px}@media only screen and (max-width:640px){.canvas{width:100%!important}.card{margin:8px 0;border-radius:12px}.pad{padding:20px 14px!important}.title{font-size:26px;line-height:33px}.table{display:block;overflow-wrap:anywhere}.table thead{display:none}.table tbody,.table tr,.table td{display:block;width:auto!important}.table tr{margin:12px 0;border:1px solid #d9d5ca}.table td{border:0;border-bottom:1px solid #e4e0d6}.table td:last-child{border-bottom:0}.table td:before{display:block;margin-bottom:3px;color:#53635c;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.table td:nth-child(1):before{content:"Client"}.table td:nth-child(2):before{content:"Contact"}.table td:nth-child(3):before{content:"Property"}.table td:nth-child(4):before{content:"Details"}.table td:nth-child(5):before{content:"Action"}}</style></head><body><table role="presentation" class="shell" width="100%"><tr><td><table role="presentation" class="canvas" width="100%"><tr><td class="card"><div class="pad"><div class="eyebrow">${escapeHtml(label)}</div><h1 class="title">${escapeHtml(title)}</h1><p class="intro">${escapeHtml(intro)}</p>${bodyHtml}</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text: [label, title, intro, bodyText].filter(Boolean).join("\n\n") };
}

function newRequestEmail(job) {
  const title = text(job.clientName, "New website request");
  const rows = `<table class="table" role="presentation"><tr><th>Client</th><th>Contact</th><th>Property</th><th>Details</th><th>Action</th></tr><tr><td>${escapeHtml(text(job.clientName))}</td><td>${escapeHtml([job.clientEmail, job.clientPhone].filter(Boolean).join(" · "))}</td><td>${escapeHtml(text(job.propertyAddress))}</td><td>${escapeHtml([job.service, job.scope, job.tourRequested && `3D tour: ${job.tourRequested}`].filter(Boolean).join("\n"))}</td><td>${internalLink("Open Airtable record", job.recordUrl)}</td></tr></table>`;
  const bodyText = `Client: ${text(job.clientName)}\nContact: ${[job.clientEmail, job.clientPhone].filter(Boolean).join(" · ")}\nProperty: ${text(job.propertyAddress)}\nDetails: ${[job.service, job.scope].filter(Boolean).join(" · ")}\nAirtable: ${job.recordUrl || ""}`;
  return internalEmailShell("NEW REQUEST", title, "A new website order is ready for review.", rows, bodyText);
}

function propertyReviewEmail(job) {
  const title = text(job.propertyAddress, "Property review needed");
  const rows = `<div class="panel"><strong>${escapeHtml(text(job.propertyCheckStatus, "Property match needs review"))}</strong><br>${escapeHtml(text(job.quoteNotes, "The property research did not produce a confident match."))}<br><br>${internalLink("Open Airtable record", job.recordUrl)}${job.mapUrl ? ` &nbsp; ${internalLink("Open aerial map", job.mapUrl)}` : ""}</div>`;
  const bodyText = `${text(job.propertyCheckStatus, "Property match needs review")}\n${text(job.quoteNotes, "The property research did not produce a confident match.")}\nAirtable: ${job.recordUrl || ""}\nAerial: ${job.mapUrl || ""}`;
  return internalEmailShell("PROPERTY REVIEW NEEDED", title, "Render found a property-research result that needs Anna's review before quoting.", rows, bodyText);
}

function followUpEmail(jobs, dateLabel) {
  const list = Array.isArray(jobs) ? jobs : [];
  const title = list.length ? `${list.length} follow-up${list.length === 1 ? "" : "s"} due today` : "No follow-ups due today";
  const rows = list.length ? `<table class="table" role="presentation"><tr><th>Client</th><th>Contact</th><th>Property</th><th>Details</th><th>Action</th></tr>${list.map((job) => `<tr><td>${escapeHtml(text(job.clientName))}</td><td>${escapeHtml([job.clientEmail, job.clientPhone].filter(Boolean).join(" · "))}</td><td>${escapeHtml(text(job.propertyAddress))}</td><td>${escapeHtml([job.service, job.quoteSentDate && `Quote sent: ${job.quoteSentDate}`, job.followUpDate && `Due: ${job.followUpDate}`].filter(Boolean).join("\n"))}</td><td>${internalLink("Open Airtable record", job.recordUrl)}</td></tr>`).join("")}</table>` : `<div class="panel">No client follow-up messages are due on ${escapeHtml(dateLabel)}. No email should be sent by the scheduled job.</div>`;
  const bodyText = list.length ? list.map((job) => `${text(job.clientName)} | ${[job.clientEmail, job.clientPhone].filter(Boolean).join(" · ")} | ${text(job.propertyAddress)} | ${job.recordUrl || ""}`).join("\n") : "No follow-ups due; no email should be sent.";
  return internalEmailShell("FOLLOW-UP", title, `Quote follow-ups due on ${dateLabel}.`, rows, bodyText);
}

module.exports = {
  clientAvailabilityProposalEmail,
  clientQuoteEmail,
  escapeHtml,
  followUpEmail,
  newRequestEmail,
  propertyReviewEmail,
  quotePricing,
  quoteReadyEmail,
  safeUrl
};

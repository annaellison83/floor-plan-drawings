const { resolveQuoteZone } = require("./quote-zone");

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
  return `<td class="detail" width="50%" valign="top"><div class="eyebrow">${escapeHtml(label)}</div><div class="detail-value">${escapeHtml(value)}</div></td>`;
}

function imageCard(number, label, imageUrl, linkUrl) {
  const image = safeUrl(imageUrl);
  const link = safeUrl(linkUrl || imageUrl);
  if (!image) return "";

  const imageTag = `<img src="${escapeHtml(image)}" alt="${escapeHtml(label)}" width="900" style="display:block;width:100%;max-width:900px;height:auto;border:0;border-radius:14px;">`;
  const content = link ? `<a href="${escapeHtml(link)}" style="display:block;text-decoration:none;">${imageTag}</a>` : imageTag;
  return `<tr><td class="image-wrap"><div class="eyebrow image-label">${escapeHtml(number)} &nbsp; ${escapeHtml(label)}</div>${content}</td></tr>`;
}

function quoteReadyEmail(job) {
  const address = text(job.propertyAddress);
  const pricing = quotePricing(job);
  const zone = pricing.zoneLabel;
  const recordUrl = safeUrl(job.recordUrl);
  const approvalUrl = safeUrl(job.approvalUrl);
  const mapUrl = safeUrl(job.mapUrl);
  const contextMapUrl = safeUrl(job.contextMapUrl);
  const subject = `QUOTE READY | Review: ${address}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0!important;padding:0!important;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:1100px;margin:0 auto}.pad{padding:28px 0}.badge-wrap{text-align:center;padding:0 0 22px}.badge{display:inline-block;background:#173f36;color:#fff;border-radius:999px;padding:13px 30px;font-size:15px;line-height:18px;font-weight:700;letter-spacing:.16em}.card{background:#fbf8f1;border:1px solid #ddd7ca;border-radius:20px}.card-pad{padding:40px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.address{margin:12px 0 8px;color:#173f36;font-size:30px;line-height:37px;font-weight:700}.muted{color:#66736e;font-size:15px;line-height:23px}.summary{width:100%;margin-top:28px;border-collapse:separate;border-spacing:12px 0}.detail{background:#e3eadf;border-radius:14px;padding:20px}.detail-value{margin-top:8px;color:#173f36;font-size:18px;line-height:25px;font-weight:700}.quote{margin:28px 0 0;background:#b8c9ae;border-radius:16px;text-align:center;padding:25px}.quote-value{margin-top:8px;color:#173f36;font-size:34px;line-height:40px;font-weight:700}.image-wrap{padding-top:26px}.image-label{padding-bottom:9px}.button-wrap{text-align:center;padding:30px 0 4px}.button{display:inline-block;min-width:260px;background:#173f36;color:#fff!important;text-decoration:none;border-radius:10px;padding:16px 28px;font-size:16px;line-height:20px;font-weight:700;text-align:center}.secondary{margin-top:16px;text-align:center;font-size:13px;line-height:20px}.secondary a{color:#173f36}.notes{margin-top:26px;padding:22px;background:#fff;border:1px solid #e2ddd2;border-radius:14px;color:#394842;font-size:14px;line-height:21px;white-space:pre-line}
@media only screen and (max-width:640px){.canvas{width:100%!important;max-width:none!important}.pad{padding:12px!important}.card-pad{padding:22px 18px!important}.badge-wrap{padding-bottom:14px!important}.badge{padding:11px 22px!important;font-size:13px!important}.address{font-size:23px!important;line-height:29px!important}.summary{border-spacing:0!important}.summary tr,.summary td{display:block!important;width:auto!important}.detail{margin-top:10px!important;padding:16px!important}.quote{margin-top:18px!important;padding:20px 14px!important}.quote-value{font-size:29px!important;line-height:35px!important}.image-wrap{padding-top:18px!important}.button{display:block!important;min-width:0!important;padding:15px 18px!important}.notes{margin-top:18px!important;padding:17px!important}}
</style></head><body><table role="presentation" class="shell" width="100%" cellspacing="0" cellpadding="0"><tr><td class="pad"><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0"><tr><td class="badge-wrap"><span class="badge">QUOTE READY</span></td></tr><tr><td class="card"><div class="card-pad"><div class="eyebrow">FloorPlanDrawings / internal review</div><h1 class="address">${escapeHtml(address)}</h1><div class="muted">${escapeHtml(text(job.workflow, "Quick Quote"))} · ${escapeHtml(text(job.status, "Needs Quote"))}</div><table role="presentation" class="summary" width="100%"><tr>${detail("Service requested", text(job.service))}${detail("Quote zone", zone)}</tr><tr>${detail("Verified size", job.verifiedSqFt ? `${Number(job.verifiedSqFt).toLocaleString()} sq ft` : "Needs verification")}${detail("3D tour", text(job.tourRequested, "No"))}</tr>${job.clientName || job.clientEmail || job.clientPhone ? `<tr>${detail("Client", text(job.clientName))}${detail("Contact", [job.clientEmail, job.clientPhone].map((value) => text(value, "")).filter(Boolean).join(" · "))}</tr>` : ""}</table><div class="quote"><div class="eyebrow">Suggested quote</div><div class="quote-value">${escapeHtml(money(pricing.finalPrice))}</div><div class="muted">${pricing.zoneMinimum ? `Base service ${escapeHtml(money(pricing.basePrice))}; Zone ${pricing.zoneNumber} sets a ${escapeHtml(money(pricing.zoneMinimum))} minimum. The higher amount wins.` : "Assign a zone before approval. Zone minimums are floors, never add-ons."}</div></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${imageCard("01", "Property close-up", job.mapUrl, job.mapUrl)}${imageCard("02", "Greater LA context", job.contextMapUrl, job.contextMapUrl)}</table>${job.quoteNotes ? `<div class="notes"><strong>Pricing review</strong><br>${escapeHtml(job.quoteNotes)}</div>` : ""}${approvalUrl ? `<div class="button-wrap"><a class="button" href="${escapeHtml(approvalUrl)}">Review &amp; approve quote</a></div>` : ""}${recordUrl ? `<div class="secondary"><a href="${escapeHtml(recordUrl)}">Open Airtable record</a></div>` : ""}</div></td></tr></table></td></tr></table></body></html>`;

  const plainText = [
    "QUOTE READY",
    address,
    `Service: ${text(job.service)}`,
    `Quote zone: ${zone}`,
    `Verified size: ${job.verifiedSqFt ? `${Number(job.verifiedSqFt).toLocaleString()} sq ft` : "Needs verification"}`,
    job.clientName && `Client: ${job.clientName}`,
    (job.clientEmail || job.clientPhone) && `Contact: ${[job.clientEmail, job.clientPhone].filter(Boolean).join(" · ")}`,
    `Suggested quote: ${money(pricing.finalPrice)}`,
    pricing.zoneMinimum && `Pricing rule: base ${money(pricing.basePrice)}; Zone ${pricing.zoneNumber} minimum ${money(pricing.zoneMinimum)}; the higher amount wins.`,
    job.quoteNotes && `Pricing review: ${job.quoteNotes}`,
    approvalUrl && `Review and approve: ${approvalUrl}`,
    recordUrl && `Airtable record: ${recordUrl}`
  ].filter(Boolean).join("\n\n");

  return { subject, html, text: plainText };
}

module.exports = { escapeHtml, quotePricing, quoteReadyEmail, safeUrl };

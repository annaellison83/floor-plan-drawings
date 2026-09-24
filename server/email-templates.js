const { resolveQuoteZone } = require("./quote-zone");
const { resolveSquareFootage, sizeResearchLinks } = require("./square-footage");
const { clientDraftUrl } = require("./email-drafts");
const { largeColorProjectFloor } = require("./quote-pricing");
const { propertyAerialUrlFor } = require("./image-assets");

function text(value, fallback = "—") {
  const cleaned = value === undefined || value === null ? "" : String(value).trim();
  return cleaned || fallback;
}

function normalizedEmail(value) {
  const candidate = text(value, "").toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

function mailtoUrl(email, subject = "", body = "") {
  const address = normalizedEmail(email);
  if (!address) return "";
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const query = params.toString() ? `?${params.toString()}` : "";
  return `mailto:${address}${query}`;
}

function gmailComposeUrl(email, subject = "", body = "") {
  const address = normalizedEmail(email);
  if (!address) return "";
  const params = new URLSearchParams({ view: "cm", fs: "1", to: address });
  if (subject) params.set("su", subject);
  if (body) params.set("body", body);
  return `https://mail.google.com/mail/u/0/?${params.toString()}`;
}

function gmailAppComposeUrl(email, subject = "", body = "") {
  const address = normalizedEmail(email);
  if (!address) return "";
  const params = new URLSearchParams({ to: address });
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  // Gmail's iOS custom URL scheme uses `co` as the host. The previous
  // triple-slash form is treated as an unknown path by current Gmail builds.
  return `googlegmail://co?${params.toString()}`;
}

function clientReplyPanel(email, subject, body) {
  const address = normalizedEmail(email);
  const href = gmailComposeUrl(address, subject, body) || mailtoUrl(address, subject, body);
  if (!address || !href) return "";
  return `<div style="margin:24px 6px 0;padding:20px;background:#e3eadf;border:1px solid #cbd7c5;border-radius:14px;"><div style="color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;">Draft a clean client reply</div><div style="margin-top:8px;color:#394842;font-size:15px;line-height:23px;">This email contains private internal review details. Use this button to open a fresh Gmail draft addressed to the client. It does not quote this internal email.</div><div style="margin-top:14px;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#173f36;color:#fff!important;text-decoration:none;border-radius:9px;padding:13px 20px;font-size:15px;line-height:20px;font-weight:700;">Draft reply to client</a></div><div style="margin-top:10px;color:#6b7067;font-size:12px;line-height:18px;">To: ${escapeHtml(address)}</div></div>`;
}

function clientFacingQuote(job) {
  const candidates = [job.clientFacingQuote, job.presentedQuote, job.approvedQuote, job.finalQuote];
  const value = candidates
    .map((candidate) => Number(String(candidate ?? "").replace(/[$,]/g, "").trim()))
    .find((candidate) => Number.isFinite(candidate) && candidate > 0);
  return value === undefined ? "" : money(value);
}

function clientReplyDraft(job) {
  const name = text(job.clientName, "there");
  const address = text(job.propertyAddress, "the property");
  const squareFootage = resolveSquareFootage(job);
  // Seed the client draft with the automatic quote when Anna has not entered
  // an approved/presented amount yet. She can edit the number before sending.
  const quote = clientFacingQuote(job) || (() => {
    const calculated = quotePricing(job).finalPrice;
    return calculated === null ? "" : money(calculated);
  })();
  const details = [job.service && `Service: ${text(job.service)}`, job.scope && `Scope: ${text(job.scope)}`, `Property size: ${squareFootage.label}`, quote ? `Quote: ${quote}` : "Quote: [Add the amount Anna wants to present]"];
  const clientNote = text(job.clientNotes || job.originalRequest, "").slice(0, 2400);
  return `Hi ${name},\n\nThanks for reaching out about ${address}.\n\n${details.join("\n")}\n${clientNote ? `\nYour note: ${clientNote}\n` : ""}\n[Add or edit any message before sending.]\n\nBest,\nAnna`;
}

function clientReplyHtml(job) {
  const name = text(job.clientName, "there");
  const address = text(job.propertyAddress, "the property");
  const squareFootage = resolveSquareFootage(job);
  const quote = clientFacingQuote(job) || (() => {
    const calculated = quotePricing(job).finalPrice;
    return calculated === null ? "" : money(calculated);
  })();
  const clientNote = text(job.clientNotes || job.originalRequest, "").slice(0, 2400);
  const row = (label, value) => value ? `<tr><td style="padding:6px 16px 6px 0;color:#53635c;font-size:13px;line-height:19px;font-weight:700;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;color:#22332e;font-size:14px;line-height:20px;">${escapeHtml(value)}</td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:680px;margin:0 auto;padding:24px 16px;"><div style="background:#fbf8f1;border:1px solid #ddd7ca;border-radius:14px;padding:26px;"><div style="color:#53635c;font-size:11px;line-height:16px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;">FloorPlanDrawings</div><p style="margin:16px 0 0;font-size:16px;line-height:25px;">Hi ${escapeHtml(name)},</p><p style="margin:14px 0 18px;font-size:16px;line-height:25px;">Thanks for reaching out about ${escapeHtml(address)}.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${row("Property", address)}${row("Service", [job.service, job.scope].filter(Boolean).join(" · "))}${row("Property size", squareFootage.label)}${quote ? row("Quote", quote) : ""}${clientNote ? row("Your note", clientNote) : ""}</table><p style="margin:20px 0 0;font-size:14px;line-height:22px;">[Add or edit any message before sending.]</p><p style="margin:20px 0 0;font-size:16px;line-height:25px;">Best,<br>Anna</p></div></div></body></html>`;
}

function buildClientReplySubject(job) {
  return `FloorPlanDrawings quote | ${text(job.propertyAddress)}`;
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
    // ArcGIS PrintingTools output URLs are temporary job artifacts. They
    // often remain in Airtable after the artifact has expired, so never emit
    // them directly as email image sources.
    if (url.hostname === "utility.arcgisonline.com" && url.pathname.includes("/arcgisoutput/")) return "";
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
  const squareFootage = resolveSquareFootage(job);
  const sizeFloor = largeColorProjectFloor(squareFootage.value, job.service || job.scope);
  const candidates = [basePrice, zoneMinimum, sizeFloor].filter((value) => Number.isFinite(value));
  const finalPrice = candidates.length ? Math.max(...candidates) : null;
  return { ...resolvedZone, zoneMinimum, basePrice, sizeFloor, finalPrice };
}

function detail(label, value) {
  return `<td class="detail-cell" width="50%" valign="top"><div class="detail"><div class="eyebrow">${escapeHtml(label)}</div><div class="detail-value">${escapeHtml(value)}</div></div></td>`;
}

function imageCard(number, label, imageUrl, linkUrl, fallbackUrl) {
  const candidate = safeUrl(imageUrl);
  const image = candidate && !/earth\.google\.com|google\.com\/maps\/search/i.test(candidate) ? candidate : "";
  const link = safeUrl(linkUrl || imageUrl);
  if (!image) {
    const fallback = safeUrl(fallbackUrl || linkUrl);
    if (!fallback) return "";
    return `<tr><td class="image-wrap"><div class="eyebrow image-label">${escapeHtml(number)} &nbsp; ${escapeHtml(label)}</div><div class="image-fallback" style="padding:22px;background:#e3eadf;border:1px solid #cbd7c5;border-radius:14px;text-align:center;"><span style="display:block;color:#53635c;font-size:14px;line-height:21px;margin-bottom:10px;">Preview unavailable</span><a href="${escapeHtml(fallback)}" style="color:#0b57d0;font-weight:700;text-decoration:underline;">Open aerial view</a></div></td></tr>`;
  }

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

function canonicalReviewEmail(job, options = {}) {
  const address = text(job.propertyAddress);
  const pricing = quotePricing(job);
  const size = resolveSquareFootage(job);
  const subject = `FloorPlanDrawings | ${text(options.label, "Quote ready")} | ${address}`;
  const maps = safeUrl(job.propertyMapUrl || job.googleMapsLink)
    || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  // Always point new emails at the stable Render proxy first. Direct Airtable
  // attachments and ArcGIS exports can expire, or disappear when Render's
  // ephemeral filesystem is replaced during a deploy.
  const stableAerial = propertyAerialUrlFor(address);
  const aerial = safeUrl(stableAerial || job.emailAerialUrl || job.aerialAttachmentUrl || job.mapUrl);
  const context = safeUrl(job.contextMapUrl);
  const aerialLink = safeUrl(stableAerial || job.emailAerialLink) || aerial || maps;
  const zimas = safeUrl(job.zimasLink);
  const approval = safeUrl(job.approvalUrl);
  const availability = safeUrl(job.availabilityReviewUrl);
  const record = safeUrl(job.recordUrl);
  const thread = safeUrl(job.gmailThreadUrl);
  const replyEmail = normalizedEmail(job.clientEmail);
  let formattedDraftUrl = safeUrl(job.clientDraftUrl);
  if (!formattedDraftUrl && job.recordId) {
    try {
      formattedDraftUrl = clientDraftUrl(job.recordId);
    } catch {
      // Keep the review email usable if draft signing has not been configured.
      // The URL-based compose fallback remains available below.
      formattedDraftUrl = "";
    }
  }
  const clientReplySubject = buildClientReplySubject(job);
  const clientReplyBody = clientReplyDraft(job);
  const clientReplyUrl = gmailComposeUrl(replyEmail, clientReplySubject, clientReplyBody);
  const clientReplyAppUrl = gmailAppComposeUrl(replyEmail, clientReplySubject, clientReplyBody);
  const clientReplyMailtoUrl = mailtoUrl(replyEmail, clientReplySubject, clientReplyBody);
  const row = (label, value, emphasize = false) => value ? `<tr><td valign="top" style="width:100px;padding:8px 12px 8px 0;border-bottom:1px solid #e4dfd5;color:#53635c;font-size:14px;line-height:20px;${emphasize ? "font-weight:700;" : ""}">${escapeHtml(label)}</td><td style="padding:8px 0;border-bottom:1px solid #e4dfd5;font-size:14px;line-height:20px;overflow-wrap:anywhere;white-space:pre-line;${emphasize ? "font-weight:600;" : ""}">${escapeHtml(value)}</td></tr>` : "";
  const link = (label, url) => url ? `<a href="${escapeHtml(url)}" style="color:#0b57d0;text-decoration:underline;">${escapeHtml(label)}</a>` : "";
  const image = (label, source, destination) => {
    const valid = source && !/earth\.google\.com|google\.com\/maps\/search/i.test(source);
    return `<td width="50%" valign="top" style="width:50%;padding:0 4px;"><a href="${escapeHtml(valid ? source : destination)}" target="_blank" style="display:block;color:#0b57d0;text-decoration:none;">${valid ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)}" width="480" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:8px;">` : `<div style="padding:28px 8px;background:#e3eadf;border-radius:8px;text-align:center;font-size:13px;">Preview unavailable<br>Open ${escapeHtml(label.toLowerCase())}</div>`}</a></td>`;
  };
  const clientNote = text(job.clientNotes || job.originalRequest, "");
  const serviceDetails = [
    job.service,
    job.scope && `Scope: ${job.scope}`,
    job.tourRequested && `3D tour: ${job.tourRequested}`
  ].filter(Boolean).join("\n• ");
  const details = [
    row("Client", [job.clientName, job.clientEmail, job.clientPhone].filter(Boolean).join(" · "), true),
    row("Service", serviceDetails, true),
    row("Size / zone", `${size.label} · ${size.verified ? "Confirmed" : "Needs verification"} · ${pricing.zoneLabel}`, true),
    row("Suggested quote", pricing.finalPrice === null ? "Needs review" : money(pricing.finalPrice), true),
    row("Client note", clientNote, true),
    row("Notes", job.quoteNotes, true)
  ].join("");
  const sizeLinks = size.verified ? "" : `<div style="font-size:12px;line-height:18px;margin:5px 0;">Verify size: ${sizeResearchLinks(address).map(item => link(item.label, item.url)).join(" · ")}</div>`;
  const actions = [
    options.includeApproval !== false && approval && link("Review & approve quote", approval),
    availability && link("Check availability & send options", availability),
    link("Open Airtable record", record),
    link("Open Gmail thread", thread)
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const draftButtonStyle = "display:inline-block;padding:11px 18px;margin:0 8px 8px 0;border-radius:8px;background:#173f36;color:#fff!important;font-size:14px;font-weight:700;text-decoration:none;";
  const reply = formattedDraftUrl
    ? `<div class="reply" style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd7ca;"><a href="${escapeHtml(formattedDraftUrl)}" style="${draftButtonStyle}">Draft Reply on Desktop</a><a href="${escapeHtml(clientReplyAppUrl)}" style="${draftButtonStyle}">Draft Reply on iPhone</a><div style="margin-top:2px;font-size:12px;line-height:17px;color:#53635c;">To: ${escapeHtml(replyEmail)} · Desktop opens the saved formatted draft; iPhone opens a clean Gmail compose.</div></div>`
    : clientReplyUrl ? `<div class="reply" style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd7ca;"><a href="${escapeHtml(clientReplyUrl)}" style="${draftButtonStyle}">Draft Reply on Desktop</a><a href="${escapeHtml(clientReplyMailtoUrl)}" style="${draftButtonStyle}">Draft Reply on iPhone</a><div style="margin-top:2px;font-size:12px;line-height:17px;color:#53635c;">To: ${escapeHtml(replyEmail)} · The fallback buttons open a new draft with the client-safe details.</div></div>` : "";
  const pricingNote = [
    Number.isFinite(pricing.basePrice) && `Base service ${money(pricing.basePrice)}`,
    Number.isFinite(pricing.sizeFloor) && `large-project size floor ${money(pricing.sizeFloor)}`,
    pricing.zoneMinimum && `Zone ${pricing.zoneNumber} minimum ${money(pricing.zoneMinimum)}`
  ].filter(Boolean).join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;padding:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}
.canvas{width:100%;max-width:1100px;margin:0 auto}.pad{padding:12px}.content{padding:18px;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:12px}.address{margin:0;font-size:23px;line-height:29px}.property-head{padding:12px 14px;background:#b8c9ae;border-radius:8px;margin-bottom:8px}.address a{color:#0b57d0;text-decoration:underline}
@media only screen and (max-width:640px){.pad{padding:6px!important}.content{padding:10px!important}.address{font-size:19px!important;line-height:25px!important}}
</style></head><body><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="pad"><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0"><tr><td class="content"><div class="property-head"><h1 class="address">${link(address, maps)}</h1></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${details}</table>${sizeLinks}<table role="presentation" class="property-images" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;margin-top:10px;"><tr>${image("Aerial view", aerial, aerialLink)}${image("Google Maps overview", context, maps)}</tr></table><div style="text-align:center;font-size:12px;line-height:20px;padding:6px 0;">${[link("Google Maps ↗", maps), link("Aerial view ↗", aerialLink), link("ZIMAS ↗", zimas)].filter(Boolean).join(" &nbsp;·&nbsp; ")}</div>${pricingNote ? `<div style="font-size:12px;line-height:18px;color:#53635c;padding:2px 0 6px;">${escapeHtml(pricingNote)}</div>` : ""}${actions ? `<div style="font-size:13px;line-height:23px;">${actions}</div>` : ""}${reply}</td></tr></table></td></tr></table></body></html>`;
  const plainText = [address, `Client: ${[job.clientName, job.clientEmail, job.clientPhone].filter(Boolean).join(" · ")}`, `Service: ${text(job.service)}`, job.scope && `Scope: ${job.scope}`, `Size: ${size.label}; ${size.verified ? "Confirmed" : "Needs verification"}`, `Quote zone: ${pricing.zoneLabel}`, `Suggested quote: ${pricing.finalPrice === null ? "Needs review" : money(pricing.finalPrice)}`, clientNote && `Client note: ${clientNote}`, job.quoteNotes && `Notes: ${job.quoteNotes}`, `Google Maps: ${maps}`, `Aerial: ${aerialLink}`, zimas && `ZIMAS: ${zimas}`, approval && `Review and approve: ${approval}`, availability && `Check availability and send appointment options: ${availability}`, record && `Airtable record: ${record}`, thread && `Gmail thread: ${thread}`, clientReplyUrl && `Draft a clean client reply: ${clientReplyUrl}`].filter(Boolean).join("\n\n");
  return { subject, html, text: plainText, clientReplyUrl, clientReplyAppUrl, clientReplyMailtoUrl, formattedDraftUrl };
}

function quoteReadyEmail(job) {
  return canonicalReviewEmail(job, { label: "QUOTE READY", title: "Review this quote" });
  /* Legacy implementation retained below until the next cleanup pass. */
  const address = text(job.propertyAddress);
  const pricing = quotePricing(job);
  const squareFootage = resolveSquareFootage(job);
  const zone = pricing.zoneLabel;
  const addressMapUrl = safeUrl(job.propertyMapUrl)
    || `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(address)}`;
  const recordUrl = safeUrl(job.recordUrl);
  const approvalUrl = safeUrl(job.approvalUrl);
  const availabilityReviewUrl = safeUrl(job.availabilityReviewUrl);
  const mapUrl = safeUrl(job.emailAerialUrl || job.aerialAttachmentUrl || job.mapUrl);
  // Keep the inline image source limited to a preflighted cache URL or a
  // currently-live Airtable attachment. A stale ArcGIS URL must never reach
  // the email client as an <img> source.
  job = { ...job, mapUrl: mapUrl || safeUrl(job.emailAerialLink) || "", aerialAttachmentUrl: mapUrl || safeUrl(job.emailAerialLink) || "" };
  const contextMapUrl = safeUrl(job.contextMapUrl);
  const subject = `QUOTE READY | ${address}`;
  const clientReplyEmail = normalizedEmail(job.clientEmail);
  const clientReplyBody = clientReplyDraft(job);
  const clientReplyUrl = gmailComposeUrl(clientReplyEmail, `Re: ${subject}`, clientReplyBody);
  const clientReplyPanelHtml = clientReplyPanel(clientReplyEmail, `Re: ${subject}`, clientReplyBody);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0!important;padding:0!important;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:1100px;margin:0 auto}.pad{padding:28px 0}.card{background:#fbf8f1;border:1px solid #ddd7ca;border-radius:20px}.card-pad{padding:40px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.section-title{font-size:16px;line-height:22px;color:#53635c}.property-head{margin-top:22px;padding:28px;background:#b8c9ae;border-radius:18px}.address{margin:10px 0 8px;font-size:31px;line-height:38px;font-weight:700}.address a{color:#0b57d0!important;text-decoration:underline}.muted{color:#53635c;font-size:15px;line-height:23px}.summary{width:100%;margin-top:22px;border-collapse:collapse}.detail-cell{padding:6px}.detail{background:#e3eadf;border-radius:14px;padding:20px}.detail-value{margin-top:8px;color:#173f36;font-size:18px;line-height:25px;font-weight:700}.size-lookup{margin:14px 6px 0;padding:18px 20px;background:#fff4d6;border:1px solid #e4cf91;border-radius:14px;color:#394842;font-size:14px;line-height:21px}.quote{margin:22px 6px 0;background:#b8c9ae;border-radius:16px;text-align:center;padding:25px}.quote-value{margin-top:8px;color:#173f36;font-size:34px;line-height:40px;font-weight:700}.image-wrap{padding:26px 6px 0;text-align:center}.image-label{padding-bottom:9px;text-align:left}.button-wrap{text-align:center;padding:30px 0 4px}.button{display:inline-block;min-width:260px;background:#173f36;color:#fff!important;text-decoration:none;border-radius:10px;padding:16px 28px;font-size:16px;line-height:20px;font-weight:700;text-align:center}.availability{margin:26px 6px 0;padding:22px;background:#e3eadf;border:1px solid #cbd7c5;border-radius:14px}.availability .button-wrap{padding:18px 0 0}.secondary{margin-top:16px;text-align:center;font-size:13px;line-height:20px}.secondary a{color:#173f36}.notes{margin:26px 6px 0;padding:22px;background:#fff;border:1px solid #e2ddd2;border-radius:14px;color:#394842;font-size:14px;line-height:21px;white-space:pre-line}
@media only screen and (max-width:640px){.canvas{width:100%!important;max-width:none!important}.pad{padding:12px!important}.card-pad{padding:22px 13px!important}.property-head{margin:16px 5px 0!important;padding:19px 16px!important}.address{font-size:23px!important;line-height:29px!important}.summary tr,.detail-cell{display:block!important;width:auto!important}.detail-cell{padding:5px!important}.detail{padding:16px!important}.size-lookup{margin:10px 5px 0!important;padding:16px!important}.quote{margin:13px 5px 0!important;padding:20px 14px!important}.quote-value{font-size:29px!important;line-height:35px!important}.image-wrap{padding:18px 5px 0!important}.availability{margin:18px 5px 0!important;padding:17px!important}.button{display:block!important;min-width:0!important;padding:15px 18px!important}.notes{margin:18px 5px 0!important;padding:17px!important}}
</style></head><body><table role="presentation" class="shell" width="100%" cellspacing="0" cellpadding="0"><tr><td class="pad"><table role="presentation" class="canvas" width="100%"><tr><td class="card"><div class="card-pad"><div class="eyebrow section-title">QUOTE READY</div><div class="property-head"><div class="eyebrow">Property address</div><h1 class="address"><a href="${addressMapUrl}">${escapeHtml(address)}</a></h1><div class="muted">· ${escapeHtml(text(job.workflow, "Quick Quote"))} · ${escapeHtml(text(job.status, "Needs Quote"))}</div></div><table role="presentation" class="summary" width="100%"><tr>${detail("Service requested", text(job.service))}${detail("Quote zone", zone)}</tr><tr>${detail(squareFootage.verified ? "Verified size" : "Size status", squareFootage.label)}${detail("3D tour", text(job.tourRequested, "No"))}</tr>${job.clientName || job.clientEmail || job.clientPhone ? `<tr>${detail("Client", text(job.clientName))}${detail("Contact", [job.clientEmail, job.clientPhone].map((value) => text(value, "")).filter(Boolean).join(" · "))}</tr>` : ""}</table>${clientReplyPanelHtml}${sizeLookupPanel(address, squareFootage)}<div class="quote"><div class="eyebrow">Suggested quote</div><div class="quote-value">${escapeHtml(money(pricing.finalPrice))}</div><div class="muted">${pricing.zoneMinimum ? `Base service ${escapeHtml(money(pricing.basePrice))}; Zone ${pricing.zoneNumber} sets a ${escapeHtml(money(pricing.zoneMinimum))} minimum. The higher amount wins.` : "Assign a zone before approval. Zone minimums are floors, never add-ons."}</div></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${imageCard("01", "Property close-up", job.mapUrl, job.mapUrl)}${imageCard("02", "Greater LA context", job.contextMapUrl, job.contextMapUrl)}</table>${job.quoteNotes ? `<div class="notes"><strong>Pricing review</strong><br>${escapeHtml(job.quoteNotes)}</div>` : ""}${approvalUrl ? `<div class="button-wrap"><a class="button" href="${escapeHtml(approvalUrl)}">Review &amp; approve quote</a></div>` : ""}${recordUrl ? `<div class="secondary"><a href="${escapeHtml(recordUrl)}">Open Airtable record</a></div>` : ""}</div></td></tr></table></td></tr></table></body></html>`;

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
    recordUrl && `Airtable record: ${recordUrl}`,
    clientReplyUrl && `Draft a clean client reply: ${clientReplyUrl}`
  ].filter(Boolean).join("\n\n");

  const availabilityPanel = availabilityReviewUrl
    ? `<div class="availability"><div class="eyebrow">Optional appointment availability</div><div class="muted" style="margin-top:8px;">Review the live employee calendars and send the client up to three recommended appointment times. No calendar event is created by this step.</div><div class="button-wrap"><a class="button" href="${escapeHtml(availabilityReviewUrl)}">Check availability &amp; send options</a></div></div>`
    : "";
  const renderedHtml = availabilityPanel
    ? html.replace("</div></td></tr></table></td></tr></table></body>", `${availabilityPanel}</div></td></tr></table></td></tr></table></body>`)
    : html;
  return { subject, html: renderedHtml, text: plainText, clientReplyUrl };
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
  const rawTime = text(slot.localStart).match(/(?:T|\s)(\d{1,2}:\d{2})$/);
  const time = rawTime ? rawTime[1] : text(slot.localStart);
  const [hour, minute] = time.split(":").map(Number);
  const timeLabel = Number.isFinite(hour) && Number.isFinite(minute)
    ? `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`
    : time;
  const duration = slot.durationMinutes ? `${slot.durationMinutes} minutes` : "scheduled visit";
  return `${dateLabel} at ${timeLabel} · ${text(slot.worker)} · ${duration}`;
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

function appointmentDetails(appointment = {}) {
  const start = appointment.start || appointment.startAt || appointment.appointmentStart;
  let dateLabel = text(appointment.date);
  let timeLabel = text(appointment.localStart || appointment.time);
  if (start) {
    const parsed = new Date(start);
    if (!Number.isNaN(parsed.getTime())) {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
      const parts = Object.fromEntries(format.formatToParts(parsed).map(({ type, value }) => [type, value]));
      dateLabel = `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`;
      timeLabel = `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
    }
  }
  return {
    dateLabel: dateLabel || "Date to be confirmed",
    timeLabel: timeLabel || "Time to be confirmed",
    worker: text(appointment.worker || appointment.employee, "FloorPlanDrawings team"),
    duration: appointment.durationMinutes ? `${appointment.durationMinutes} minutes` : "scheduled visit",
    address: text(appointment.address || appointment.propertyAddress),
    accessNotes: text(appointment.accessNotes || appointment.access, "Reply to this email with any access instructions.")
  };
}

function clientAppointmentEmail(job, appointment, mode = "confirmation", reminderLabel = "Tomorrow") {
  const details = appointmentDetails({ ...appointment, propertyAddress: job.propertyAddress });
  const name = text(job.clientName, "there");
  const address = details.address || text(job.propertyAddress);
  const isReminder = mode === "reminder";
  const eyebrow = isReminder ? "REMINDER" : "APPOINTMENT CONFIRMED";
  const title = isReminder ? `${reminderLabel}: your appointment` : "Your appointment is confirmed";
  const subject = isReminder ? `REMINDER | ${address} | ${details.dateLabel}` : `APPOINTMENT CONFIRMED | ${address}`;
  const intro = isReminder
    ? `A quick reminder from FloorPlanDrawings about your upcoming visit.`
    : `Thanks — your FloorPlanDrawings appointment is on the calendar.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>body{margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:760px;margin:0 auto}.card{margin:24px auto;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:20px}.pad{padding:38px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.title{margin:12px 0 12px;color:#173f36;font-size:32px;line-height:40px}.copy{color:#394842;font-size:16px;line-height:25px}.property{margin:24px 0;padding:24px;background:#b8c9ae;border-radius:16px}.property-label{color:#39564b;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.address{margin-top:8px;color:#173f36;font-size:23px;line-height:31px;font-weight:700}.details{width:100%;margin-top:20px;border-collapse:separate;border-spacing:8px}.details td{width:50%;padding:18px;background:#e3eadf;border-radius:12px;vertical-align:top}.label{color:#53635c;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.value{margin-top:7px;color:#173f36;font-size:16px;line-height:23px;font-weight:700}.note{margin-top:22px;padding:18px 20px;background:#fff;border:1px solid #e2ddd2;border-radius:12px;color:#394842;font-size:14px;line-height:22px}.fine{margin-top:23px;color:#6b7067;font-size:13px;line-height:20px}@media only screen and (max-width:640px){.canvas{width:100%!important}.card{margin:8px 0;border-radius:13px}.pad{padding:24px 16px!important}.title{font-size:27px;line-height:34px}.property{padding:19px}.address{font-size:21px;line-height:28px}.details{display:block!important;margin-top:14px}.details tr,.details td{display:block!important;width:auto!important}.details td{margin:8px 0;padding:15px}.copy{font-size:15px;line-height:24px}.note{padding:16px}.button{display:block!important;width:auto!important;text-align:center}}</style></head><body><table role="presentation" class="shell" width="100%" cellspacing="0" cellpadding="0"><tr><td><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0"><tr><td class="card"><div class="pad"><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1 class="title">${escapeHtml(title)}</h1><p class="copy">Hi ${escapeHtml(name)},</p><p class="copy">${escapeHtml(intro)}</p><div class="property"><div class="property-label">Property</div><div class="address">${escapeHtml(address)}</div></div><table role="presentation" class="details" width="100%" cellspacing="0" cellpadding="0"><tr><td><div class="label">Date</div><div class="value">${escapeHtml(details.dateLabel)}</div></td><td><div class="label">Time</div><div class="value">${escapeHtml(details.timeLabel)} · ${escapeHtml(details.duration)}</div></td></tr><tr><td><div class="label">Team member</div><div class="value">${escapeHtml(details.worker)}</div></td><td><div class="label">Service</div><div class="value">${escapeHtml(text(job.service, "Floor plan drawing"))}</div></td></tr></table><div class="note"><strong>Access and next steps</strong><br>${escapeHtml(details.accessNotes)}</div><p class="fine">Need to make a change? Reply to this email and Anna's team will help. Please do not use this message to reschedule without confirmation.</p><p class="copy">Thank you,<br>FloorPlanDrawings</p></div></td></tr></table></td></tr></table></body></html>`;
  const plainText = [eyebrow, `Hi ${name},`, intro, `Property: ${address}`, `Date: ${details.dateLabel}`, `Time: ${details.timeLabel} · ${details.duration}`, `Team member: ${details.worker}`, `Service: ${text(job.service, "Floor plan drawing")}`, `Access and next steps: ${details.accessNotes}`, "Need to make a change? Reply to this email and Anna's team will help."].join("\n\n");
  return { subject, html, text: plainText };
}

function clientAppointmentConfirmationEmail(job, appointment) {
  return clientAppointmentEmail(job, appointment, "confirmation");
}

function clientAppointmentReminderEmail(job, appointment, reminderLabel = "Tomorrow") {
  return clientAppointmentEmail(job, appointment, "reminder", reminderLabel);
}

function internalLink(label, href) {
  const safe = safeUrl(href);
  return safe ? `<a href="${escapeHtml(safe)}" style="color:#0b57d0;font-weight:700;">${escapeHtml(label)}</a>` : "";
}

function internalEmailShell(label, title, intro, bodyHtml, bodyText) {
  const subject = `${label} | ${title}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>body{margin:0;background:#f3f1eb;color:#22332e;font-family:Arial,Helvetica,sans-serif}.shell{width:100%;background:#f3f1eb}.canvas{width:calc(100% - 32px);max-width:1100px;margin:0 auto}.card{margin:24px auto;background:#fbf8f1;border:1px solid #ddd7ca;border-radius:18px}.pad{padding:32px}.eyebrow{color:#53635c;font-size:12px;line-height:17px;font-weight:700;letter-spacing:.15em;text-transform:uppercase}.title{margin:12px 0 10px;font-size:32px;line-height:40px;color:#173f36}.intro{font-size:16px;line-height:25px;color:#53635c}.property-head{margin-top:22px;padding:28px;background:#b8c9ae;border-radius:18px}.address{margin:10px 0 8px;font-size:31px;line-height:38px;font-weight:700}.address a{color:#0b57d0!important;text-decoration:underline}.muted{color:#53635c;font-size:15px;line-height:23px}.summary{width:100%;margin-top:22px;border-collapse:collapse}.detail-cell{padding:6px}.detail{background:#e3eadf;border-radius:14px;padding:20px}.detail-value{margin-top:8px;color:#173f36;font-size:18px;line-height:25px;font-weight:700;white-space:pre-line}.size-lookup{margin:14px 6px 0;padding:18px 20px;background:#fff4d6;border:1px solid #e4cf91;border-radius:14px;color:#394842;font-size:14px;line-height:21px}.quote{margin:22px 6px 0;background:#b8c9ae;border-radius:16px;text-align:center;padding:25px}.quote-value{margin-top:8px;color:#173f36;font-size:34px;line-height:40px;font-weight:700}.image-wrap{padding:26px 6px 0;text-align:center}.image-wrap img{display:block;width:100%;max-width:100%;height:auto;margin:0 auto;border:0;border-radius:14px}.image-label{padding-bottom:9px;text-align:left}.button-wrap{text-align:center;padding:30px 0 4px}.button{display:inline-block;min-width:260px;background:#173f36;color:#fff!important;text-decoration:none;border-radius:10px;padding:16px 28px;font-size:16px;line-height:20px;font-weight:700;text-align:center}.availability{margin:26px 6px 0;padding:22px;background:#e3eadf;border:1px solid #cbd7c5;border-radius:14px}.availability .button-wrap{padding:18px 0 0}.secondary{margin-top:16px;text-align:center;font-size:13px;line-height:20px}.secondary a{color:#173f36}.notes{margin:26px 6px 0;padding:22px;background:#fff;border:1px solid #e2ddd2;border-radius:14px;color:#394842;font-size:14px;line-height:21px;white-space:pre-line}.table{width:100%;border-collapse:collapse;margin-top:24px}.table th,.table td{padding:13px 12px;border:1px solid #d9d5ca;text-align:left;vertical-align:top;font-size:14px;line-height:21px}.table th{background:#e3eadf;color:#394842;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.panel{margin-top:22px;padding:18px 20px;background:#e3eadf;border-radius:14px;font-size:15px;line-height:24px}@media (prefers-color-scheme:dark){body,.shell{background:#f3f1eb!important;color:#22332e!important}.card{background:#fbf8f1!important}.title{color:#173f36!important}.intro,.muted{color:#53635c!important}}@media only screen and (max-width:640px){.canvas{width:100%!important}.card{margin:8px 0;border-radius:12px}.pad{padding:20px 14px!important}.title{font-size:26px;line-height:33px}.property-head{margin:16px 5px 0!important;padding:19px 16px!important}.address{font-size:23px!important;line-height:29px!important}.summary tr,.detail-cell{display:block!important;width:auto!important}.detail-cell{padding:5px!important}.detail{padding:16px!important}.size-lookup{margin:10px 5px 0!important;padding:16px!important}.quote{margin:13px 5px 0!important;padding:20px 14px!important}.quote-value{font-size:29px!important;line-height:35px!important}.image-wrap{padding:18px 5px 0!important}.availability{margin:18px 5px 0!important;padding:17px!important}.button{display:block!important;min-width:0!important;padding:15px 18px!important}.notes{margin:18px 5px 0!important;padding:17px!important}.table{display:block;overflow-wrap:anywhere}.table thead{display:none}.table tbody,.table tr,.table td{display:block;width:auto!important}.table tr{margin:12px 0;border:1px solid #d9d5ca}.table td{border:0;border-bottom:1px solid #e4e0d6}.table td:last-child{border-bottom:0}.table td:before{display:block;margin-bottom:3px;color:#53635c;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.table td:nth-child(1):before{content:"Client"}.table td:nth-child(2):before{content:"Contact"}.table td:nth-child(3):before{content:"Property"}.table td:nth-child(4):before{content:"Details"}.table td:nth-child(5):before{content:"Action"}}</style></head><body><table role="presentation" class="shell" width="100%"><tr><td><table role="presentation" class="canvas" width="100%"><tr><td class="card"><div class="pad"><div class="eyebrow">${escapeHtml(label)}</div><h1 class="title">${escapeHtml(title)}</h1><p class="intro">${escapeHtml(intro)}</p>${bodyHtml}</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text: [label, title, intro, bodyText].filter(Boolean).join("\n\n") };
}

function newRequestEmail(job) {
  return canonicalReviewEmail(job, { label: "NEW REQUEST", title: text(job.clientName, "New website request") });
  /* Legacy implementation retained below until the next cleanup pass. */
  const address = text(job.propertyAddress);
  const pricing = quotePricing(job);
  const squareFootage = resolveSquareFootage(job);
  const addressMapUrl = safeUrl(job.propertyMapUrl)
    || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const recordUrl = safeUrl(job.recordUrl);
  const approvalUrl = safeUrl(job.approvalUrl);
  const availabilityReviewUrl = safeUrl(job.availabilityReviewUrl);
  const clientReplyEmail = normalizedEmail(job.clientEmail);
  const clientReplySubject = `Re: NEW REQUEST | ${text(job.clientName, "FloorPlanDrawings request")}`;
  const clientReplyBody = clientReplyDraft(job);
  const clientReplyUrl = gmailComposeUrl(clientReplyEmail, clientReplySubject, clientReplyBody);
  const clientReplyPanelHtml = clientReplyPanel(clientReplyEmail, clientReplySubject, clientReplyBody);
  const details = [job.service, job.scope, job.tourRequested && `3D tour: ${job.tourRequested}`].filter(Boolean).join("\n");
  const contact = [job.clientEmail, job.clientPhone].filter(Boolean).join(" · ");
  const emailAerialUrl = safeUrl(job.emailAerialUrl || job.aerialAttachmentUrl || job.mapUrl);
  job = { ...job, mapUrl: emailAerialUrl || safeUrl(job.emailAerialLink) || "" };
  const imageRows = `${imageCard("01", "Property close-up", job.mapUrl, job.mapUrl)}${imageCard("02", "Greater LA context", job.contextMapUrl, job.contextMapUrl)}`;
  const availabilityPanel = availabilityReviewUrl
    ? `<div class="availability"><div class="eyebrow">Optional appointment availability</div><div class="muted" style="margin-top:8px;">Review the live employee calendars and send the client up to three recommended appointment times. No calendar event is created by this step.</div><div class="button-wrap"><a class="button" href="${escapeHtml(availabilityReviewUrl)}">Check availability &amp; send options</a></div></div>`
    : "";
  const bodyHtml = `<div class="property-head"><div class="eyebrow">Property address</div><h2 class="address"><a href="${escapeHtml(addressMapUrl)}">${escapeHtml(address)}</a></h2><div class="muted">· ${escapeHtml(text(job.workflow, "Quick Quote"))} · ${escapeHtml(text(job.status, "Needs Quote"))}</div></div><table role="presentation" class="summary" width="100%"><tr>${detail("Client", text(job.clientName))}${detail("Contact", contact)}</tr><tr>${detail("Service requested", text(job.service))}${detail("Scope & options", details)}</tr><tr>${detail("Quote zone", pricing.zoneLabel)}${detail(squareFootage.verified ? "Verified size" : "Size status", squareFootage.label)}</tr></table>${clientReplyPanelHtml}${sizeLookupPanel(address, squareFootage)}<div class="quote"><div class="eyebrow">Suggested quote</div><div class="quote-value">${escapeHtml(money(pricing.finalPrice))}</div><div class="muted">${pricing.zoneMinimum ? `Base service ${escapeHtml(money(pricing.basePrice))}; Zone ${pricing.zoneNumber} sets a ${escapeHtml(money(pricing.zoneMinimum))} minimum. The higher amount wins.` : "Assign a zone before approval. Zone minimums are floors, never add-ons."}</div></div>${imageRows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${imageRows}</table>` : ""}${job.quoteNotes ? `<div class="notes"><strong>Review notes</strong><br>${escapeHtml(job.quoteNotes)}</div>` : ""}${availabilityPanel}${approvalUrl ? `<div class="button-wrap"><a class="button" href="${escapeHtml(approvalUrl)}">Review &amp; approve quote</a></div>` : ""}<div class="button-wrap">${internalLink("Open Airtable record", recordUrl)}${job.gmailThreadUrl ? ` &nbsp; ${internalLink("Open Gmail thread", job.gmailThreadUrl)}` : ""}</div>`;
  const bodyText = [
    `Client: ${text(job.clientName)}`,
    `Contact: ${contact}`,
    `Property: ${address}`,
    `Service: ${text(job.service)}`,
    `Scope & options: ${details}`,
    `Quote zone: ${pricing.zoneLabel}`,
    `${squareFootage.verified ? "Verified size" : "Size status"}: ${squareFootage.label}`,
    `Suggested quote: ${money(pricing.finalPrice)}`,
    pricing.zoneMinimum && `Pricing rule: base ${money(pricing.basePrice)}; Zone ${pricing.zoneNumber} minimum ${money(pricing.zoneMinimum)}; the higher amount wins.`,
    job.quoteNotes && `Review notes: ${job.quoteNotes}`,
    availabilityReviewUrl && `Check availability and send appointment options: ${availabilityReviewUrl}`,
    approvalUrl && `Review and approve quote: ${approvalUrl}`,
    recordUrl && `Airtable record: ${recordUrl}`,
    job.gmailThreadUrl && `Gmail thread: ${job.gmailThreadUrl}`,
    clientReplyUrl && `Draft a clean client reply: ${clientReplyUrl}`,
    `Map: ${addressMapUrl}`
  ].filter(Boolean).join("\n\n");
  return { ...internalEmailShell("NEW REQUEST", text(job.clientName, "New website request"), "A new website order is ready for review with the same property, pricing, and research context used by the quote workflow.", bodyHtml, bodyText), clientReplyUrl };
}

function propertyReviewEmail(job) {
  const title = text(job.propertyAddress, "Property review needed");
  const rows = `<div class="panel"><strong>${escapeHtml(text(job.propertyCheckStatus, "Property match needs review"))}</strong><br>${escapeHtml(text(job.quoteNotes, "The property research did not produce a confident match."))}<br><br>${internalLink("Open Airtable record", job.recordUrl)}${job.mapUrl ? ` &nbsp; ${internalLink("Open aerial map", job.mapUrl)}` : ""}</div>`;
  const bodyText = `${text(job.propertyCheckStatus, "Property match needs review")}\n${text(job.quoteNotes, "The property research did not produce a confident match.")}\nAirtable: ${job.recordUrl || ""}\nAerial: ${job.mapUrl || ""}`;
  return internalEmailShell("PROPERTY REVIEW NEEDED", title, "Render found a property-research result that needs Anna's review before quoting.", rows, bodyText);
}

function roleClarificationEmail({ propertyAddress = "", contacts = [], recordUrl = "" } = {}) {
  const people = (Array.isArray(contacts) ? contacts : []).map((contact) => `${text(contact.name, "Unknown contact")} · ${text(contact.email)}`).join("\n");
  const rows = `<div class="property-head"><div class="eyebrow">Property address</div><h2 class="address">${escapeHtml(propertyAddress)}</h2></div><div class="panel"><strong>INTERNAL ONLY — ANNA ACTION REQUIRED</strong><br>Render paused client-facing messages because it cannot tell who is the client and who is the agent.<br><br>Reply to this email with one line per contact, for example: <strong>Conrad — AGENT</strong> or <strong>Alex — CLIENT</strong>.</div><div class="notes"><strong>Contacts needing classification</strong><br>${escapeHtml(people || "No contact address was extracted.")}</div><div class="secondary">${internalLink("Open Airtable record", recordUrl)}</div>`;
  const bodyText = [`INTERNAL ONLY — ANNA ACTION REQUIRED`, `Property: ${text(propertyAddress)}`, "Reply to this email with one line per contact: NAME — CLIENT, AGENT, or INTERNAL. No client-facing email will be sent until the role is explicit.", people && `Contacts:\n${people}`, recordUrl && `Airtable record: ${recordUrl}`].filter(Boolean).join("\n\n");
  return internalEmailShell("ACTION NEEDED", `Clarify contact roles | ${text(propertyAddress, "Unclassified Gmail intake")}`, "Render paused this job until Anna identifies the client and agent. This message is internal and is not sent to either contact.", rows, bodyText);
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
  clientAppointmentConfirmationEmail,
  clientAppointmentReminderEmail,
  clientReplyDraft,
  clientReplyHtml,
  buildClientReplySubject,
  clientQuoteEmail,
  escapeHtml,
  followUpEmail,
  newRequestEmail,
  propertyReviewEmail,
  roleClarificationEmail,
  quotePricing,
  quoteReadyEmail,
  safeUrl
};

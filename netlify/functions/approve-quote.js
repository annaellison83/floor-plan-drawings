const crypto = require("crypto");

const AIRTABLE_API_URL = "https://api.airtable.com/v0";
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store"
};

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function cleanEnv(value) {
  return clean(value).replace(/^=\s*/, "").replace(/^['"]|['"]$/g, "").trim();
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(statusCode, title, message) {
  return {
    statusCode,
    headers: HTML_HEADERS,
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:620px;margin:12vh auto;padding:40px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings</div><h1 style="font-size:30px;line-height:38px;margin:12px 0 18px;">${escapeHtml(title)}</h1><p style="font-size:17px;line-height:27px;margin:0;color:#4A4A40;">${escapeHtml(message)}</p></main></body></html>`
  };
}

function approvalPage(recordId, token, fields, notice = "") {
  const address = fields["Property Address"] || "this property";
  const service = fields["Drawing Style"] || fields["Plan Type"] || "requested floor plan";
  const quote = fields["Final Quote Preview"] || fields["Quote Amount"] || fields["Suggested Quote"] || "";
  const quoteZone = fields["Quote Zone"] || "";
  const verifiedSqFt = fields["Verified Sq Ft"] || "";
  const expiresAt = Date.parse(clean(fields["Quote Approval Expires At"]));
  const expiryText = Number.isFinite(expiresAt)
    ? new Date(expiresAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "soon";

  return {
    statusCode: 200,
    headers: HTML_HEADERS,
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review quote | FloorPlanDrawings</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:720px;margin:5vh auto;padding:40px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / internal review</div><h1 style="font-size:30px;line-height:38px;margin:12px 0 24px;">Review and approve quote</h1>${notice ? `<div role="status" style="margin:0 0 20px;padding:14px 16px;background:#E4F1DE;border:1px solid #9FBC91;border-radius:8px;color:#1F3A34;font-size:15px;font-weight:bold;">${escapeHtml(notice)}</div>` : ""}<div style="background:#B4C4AA;border-radius:10px;padding:20px 22px;margin-bottom:24px;"><div style="font-size:11px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:#3D5348;padding-bottom:7px;">Property</div><div style="font-size:22px;line-height:30px;font-weight:bold;">${escapeHtml(address)}</div></div><form method="post" action="/.netlify/functions/approve-quote?recordId=${encodeURIComponent(recordId)}&amp;token=${encodeURIComponent(token)}"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;"><label style="font-size:13px;font-weight:bold;color:#3D5348;">Quote amount ($)<input name="quoteAmount" type="number" min="1" step="1" required value="${escapeHtml(quote)}" style="display:block;box-sizing:border-box;width:100%;margin-top:7px;padding:13px;border:1px solid #CFC9BA;border-radius:8px;font:inherit;"></label><label style="font-size:13px;font-weight:bold;color:#3D5348;">Quote zone<select name="quoteZone" style="display:block;box-sizing:border-box;width:100%;margin-top:7px;padding:13px;border:1px solid #CFC9BA;border-radius:8px;background:#fff;font:inherit;"><option value="">Needs review</option>${[1,2,3,4].map((zone) => `<option value="Zone ${zone}"${quoteZone === `Zone ${zone}` ? " selected" : ""}>Zone ${zone}</option>`).join("")}</select></label><label style="font-size:13px;font-weight:bold;color:#3D5348;">Service description<input name="drawingStyle" maxlength="120" value="${escapeHtml(service)}" style="display:block;box-sizing:border-box;width:100%;margin-top:7px;padding:13px;border:1px solid #CFC9BA;border-radius:8px;font:inherit;"></label><label style="font-size:13px;font-weight:bold;color:#3D5348;">Verified square feet<input name="verifiedSqFt" type="number" min="1" step="1" value="${escapeHtml(verifiedSqFt)}" style="display:block;box-sizing:border-box;width:100%;margin-top:7px;padding:13px;border:1px solid #CFC9BA;border-radius:8px;font:inherit;"></label></div><p style="font-size:15px;line-height:24px;color:#4A4A40;margin:24px 0;">Save edits to Airtable without sending, or approve when the quote is ready. Approval triggers the separate client-email workflow.</p><div style="display:flex;flex-wrap:wrap;gap:12px;"><button type="submit" name="action" value="save" style="border:1px solid #1F3A34;border-radius:8px;background:#fff;color:#1F3A34;font-size:16px;line-height:22px;font-weight:bold;padding:14px 20px;cursor:pointer;">Save changes</button><button type="submit" name="action" value="approve" style="border:0;border-radius:8px;background:#1F3A34;color:#F5F1E8;font-size:16px;line-height:22px;font-weight:bold;padding:15px 22px;cursor:pointer;">Approve quote and send to client</button></div></form><p style="font-size:13px;line-height:20px;color:#8A897C;margin:18px 0 0;">This approval link expires ${escapeHtml(expiryText)} and can be used once.</p></main></body></html>`
  };
}

function savedPage(recordId, token, fields) {
  const address = fields["Property Address"] || "this property";
  const quote = fields["Quote Amount"] || fields["Suggested Quote"] || "";
  const zone = fields["Quote Zone"] || "Needs review";
  const service = fields["Drawing Style"] || "Requested floor plan";
  const sqFt = fields["Verified Sq Ft"] || "";
  const action = `/.netlify/functions/approve-quote?recordId=${encodeURIComponent(recordId)}&amp;token=${encodeURIComponent(token)}`;
  return {
    statusCode: 200,
    headers: HTML_HEADERS,
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Changes saved | FloorPlanDrawings</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:680px;margin:8vh auto;padding:40px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / internal review</div><div style="margin:18px 0;padding:14px 16px;background:#E4F1DE;border:1px solid #9FBC91;border-radius:8px;color:#1F3A34;font-size:17px;font-weight:bold;">✓ Changes saved to Airtable</div><h1 style="font-size:30px;line-height:38px;margin:20px 0 12px;">Nothing has been sent yet.</h1><p style="font-size:17px;line-height:27px;color:#4A4A40;margin:0 0 24px;">Review the saved details below, then continue editing or approve the quote.</p><div style="background:#B4C4AA;border-radius:10px;padding:20px 22px;margin-bottom:24px;"><strong style="font-size:20px;line-height:28px;">${escapeHtml(address)}</strong><div style="margin-top:10px;line-height:25px;color:#3D5348;">$${escapeHtml(quote)} &middot; ${escapeHtml(zone)}<br>${escapeHtml(service)}${sqFt ? ` &middot; ${escapeHtml(sqFt)} sq ft` : ""}</div></div><div style="display:flex;flex-wrap:wrap;gap:12px;"><a href="${action}" style="display:inline-block;border:1px solid #1F3A34;border-radius:8px;background:#fff;color:#1F3A34;text-decoration:none;font-size:16px;line-height:22px;font-weight:bold;padding:14px 20px;">Continue editing</a><form method="post" action="${action}" style="margin:0;"><input type="hidden" name="quoteAmount" value="${escapeHtml(quote)}"><input type="hidden" name="quoteZone" value="${escapeHtml(fields["Quote Zone"] || "")}"><input type="hidden" name="drawingStyle" value="${escapeHtml(service)}"><input type="hidden" name="verifiedSqFt" value="${escapeHtml(sqFt)}"><button type="submit" name="action" value="approve" style="border:0;border-radius:8px;background:#1F3A34;color:#F5F1E8;font-size:16px;line-height:22px;font-weight:bold;padding:15px 22px;cursor:pointer;">Approve quote and send to client</button></form></div></main></body></html>`
  };
}

function parseEdits(event) {
  const body = new URLSearchParams(event.body || "");
  const quoteAmount = Number(body.get("quoteAmount"));
  const verifiedSqFtRaw = clean(body.get("verifiedSqFt"));
  const verifiedSqFt = verifiedSqFtRaw ? Number(verifiedSqFtRaw) : null;
  const quoteZone = clean(body.get("quoteZone"));
  const drawingStyle = clean(body.get("drawingStyle")).slice(0, 120);
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) throw new Error("Enter a valid quote amount.");
  if (quoteZone && !/^Zone [1-4]$/.test(quoteZone)) throw new Error("Choose a valid quote zone.");
  if (verifiedSqFtRaw && (!Number.isFinite(verifiedSqFt) || verifiedSqFt <= 0)) throw new Error("Enter valid square footage.");
  return {
    action: clean(body.get("action")),
    fields: {
      "Quote Amount": Math.round(quoteAmount),
      "Quote Zone": quoteZone,
      "Drawing Style": drawingStyle,
      ...(verifiedSqFt ? { "Verified Sq Ft": Math.round(verifiedSqFt) } : {})
    }
  };
}

function tokensMatch(expected, provided) {
  if (!expected || !provided || expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

async function airtableRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body.error && body.error.message) || `Airtable request failed with status ${response.status}`);
  }
  return body;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return page(405, "That link cannot be used", "Please use the approval button in Anna's email.");
  }

  const query = event.queryStringParameters || {};
  const recordId = clean(query.recordId);
  const providedToken = clean(query.token);
  const airtableToken = cleanEnv(process.env.AIRTABLE_TOKEN).replace(/^Bearer\s+/i, "");
  const baseId = cleanEnv(process.env.AIRTABLE_BASE_ID);
  const tableName = cleanEnv(process.env.AIRTABLE_JOBS_TABLE) || "Jobs";

  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId) || !/^[a-f0-9]{48}$/.test(providedToken)) {
    return page(400, "Approval link is incomplete", "Please use the newest approval email for this quote.");
  }
  if (!airtableToken || !baseId) {
    console.error("Approval endpoint is missing Airtable configuration");
    return page(500, "Approval is temporarily unavailable", "Please open Airtable and approve this quote there.");
  }

  const recordUrl = `${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`;
  try {
    const record = await airtableRequest(recordUrl, airtableToken);
    const fields = record.fields || {};
    const address = fields["Property Address"] || "this property";

    if (fields["Website Workflow"] !== "Quick Quote") {
      return page(409, "This is not a Quick Quote", "This approval button only applies to Quick Quote records.");
    }
    if (fields["Anna Decision"] === "Approved" || fields["Quote Approval Used At"] || fields["Quote Sent Date"]) {
      return page(200, "Already approved", `${address} has already been approved or sent. No second client email was sent.`);
    }
    if (fields["Anna Decision"] && fields["Anna Decision"] !== "Pending") {
      return page(409, "Approval needs review", `This quote is currently marked ${fields["Anna Decision"]}. Open Airtable if you need to change it.`);
    }

    const expiresAt = Date.parse(clean(fields["Quote Approval Expires At"]));
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return page(410, "Approval link expired", "Open the Airtable record and use the current approval workflow for this quote.");
    }
    if (!tokensMatch(clean(fields["Quote Approval Token"]), providedToken)) {
      return page(403, "Approval link is no longer valid", "Please use the newest approval email for this quote.");
    }

    if (event.httpMethod === "GET") {
      return approvalPage(recordId, providedToken, fields);
    }

    let edits;
    try {
      edits = parseEdits(event);
    } catch (error) {
      return page(400, "Check the quote details", error.message);
    }

    if (edits.action === "save") {
      await airtableRequest(recordUrl, airtableToken, {
        method: "PATCH",
        body: JSON.stringify({ fields: edits.fields, typecast: true })
      });
      return savedPage(recordId, providedToken, { ...fields, ...edits.fields });
    }

    if (edits.action !== "approve") {
      return page(400, "Choose an action", "Save the changes or approve the quote.");
    }

    await airtableRequest(recordUrl, airtableToken, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          ...edits.fields,
          "Anna Decision": "Approved",
          "Quote Review": "Approved",
          "Quote Approval Used At": new Date().toISOString(),
          "Quote Approval Token": ""
        },
        typecast: true
      })
    });

    return page(200, "Quote approved", `The approved quote for ${address} is now being sent to the client. This button can no longer be used again.`);
  } catch (error) {
    console.error("Quote approval failed", error.message);
    return page(500, "Approval could not be completed", "Please open the Airtable record and approve this quote there.");
  }
};

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

function approvalPage(recordId, token, fields) {
  const address = fields["Property Address"] || "this property";
  const service = fields["Drawing Style"] || fields["Plan Type"] || "requested floor plan";
  const quote = fields["Final Quote"] || fields["Quote"] || "See Airtable record";
  const expiresAt = Date.parse(clean(fields["Quote Approval Expires At"]));
  const expiryText = Number.isFinite(expiresAt)
    ? new Date(expiresAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "soon";

  return {
    statusCode: 200,
    headers: HTML_HEADERS,
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve quote | FloorPlanDrawings</title></head><body style="margin:0;background:#F5F1E8;color:#22261F;font-family:Helvetica,Arial,sans-serif;"><main style="max-width:620px;margin:8vh auto;padding:40px 28px;background:#fff;border:1px solid #DCD7C9;border-radius:14px;box-shadow:0 8px 30px rgba(34,38,31,.08);"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#6B6B5F;">FloorPlanDrawings / internal review</div><h1 style="font-size:30px;line-height:38px;margin:12px 0 24px;">Approve this quote?</h1><div style="background:#B4C4AA;border-radius:10px;padding:20px 22px;margin-bottom:24px;"><div style="font-size:11px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:#3D5348;padding-bottom:7px;">Property</div><div style="font-size:22px;line-height:30px;font-weight:bold;">${escapeHtml(address)}</div><div style="font-size:16px;line-height:24px;color:#3D5348;padding-top:8px;">${escapeHtml(service)} &middot; ${escapeHtml(quote)}</div></div><p style="font-size:16px;line-height:25px;color:#4A4A40;margin:0 0 24px;">Pressing the button will mark this Quick Quote approved in Airtable. The existing Airtable automation will then send the approved quote to the client.</p><form method="post" action="/.netlify/functions/approve-quote?recordId=${encodeURIComponent(recordId)}&amp;token=${encodeURIComponent(token)}"><button type="submit" style="border:0;border-radius:8px;background:#1F3A34;color:#F5F1E8;font-size:16px;line-height:22px;font-weight:bold;padding:15px 22px;cursor:pointer;">Approve quote and send to client</button></form><p style="font-size:13px;line-height:20px;color:#8A897C;margin:18px 0 0;">This approval link expires ${escapeHtml(expiryText)} and can be used once.</p></main></body></html>`
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

    await airtableRequest(recordUrl, airtableToken, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
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

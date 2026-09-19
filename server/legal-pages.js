function legalLayout(title, eyebrow, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · FloorPlanDrawings</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f1e8; color: #23372f; }
    body { margin: 0; padding: 48px 20px; }
    main { max-width: 760px; margin: 0 auto; padding: 42px; background: #fffdf8; border: 1px solid #d9d7cc; border-radius: 24px; box-shadow: 0 16px 40px rgba(35, 55, 47, .08); }
    .eyebrow { margin: 0 0 14px; font-size: 12px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #6b786f; }
    h1 { margin: 0 0 24px; font-size: clamp(30px, 5vw, 46px); line-height: 1.05; color: #17483e; }
    h2 { margin: 30px 0 10px; font-size: 20px; color: #17483e; }
    p, li { font-size: 16px; line-height: 1.65; }
    a { color: #145ec8; }
    footer { margin-top: 34px; padding-top: 18px; border-top: 1px solid #e2dfd5; color: #6b786f; font-size: 13px; }
  </style>
</head>
<body><main><p class="eyebrow">FloorPlanDrawings · Operations</p><h1>${title}</h1>${body}<footer>Questions: <a href="mailto:annaellisonmail@gmail.com">annaellisonmail@gmail.com</a></footer></main></body>
</html>`;
}

function privacyPage() {
  return legalLayout("Privacy Policy", "Privacy", `
    <p>This policy describes the limited data handling for the private FloorPlanDrawings operations tools and Gmail intake integration.</p>
    <h2>What the integration accesses</h2>
    <p>With Anna Ellison's authorization, the service reads Gmail messages and threads needed to identify FloorPlanDrawings requests, apply the FPD Intake label, and keep the related job record up to date. It does not sell inbox data or use it for advertising.</p>
    <h2>Where information is stored</h2>
    <p>Operational job information and communication metadata may be stored in Render's protected service environment and the FloorPlanDrawings Airtable base. OAuth credentials and tokens are stored as secrets in Render and are not included in email messages or user-facing pages.</p>
    <h2>Sharing and retention</h2>
    <p>Information is shared only with the service providers required to operate FloorPlanDrawings (including Google, Render, Airtable, and email delivery providers) and with the people Anna designates for a job. Anna can request correction or deletion of operational records by contacting the address below.</p>
    <h2>Contact</h2>
    <p>For privacy questions or access requests, email <a href="mailto:annaellisonmail@gmail.com">annaellisonmail@gmail.com</a>.</p>`);
}

function termsPage() {
  return legalLayout("Terms of Service", "Terms", `
    <p>These terms apply to the private FloorPlanDrawings operations tools used by Anna Ellison and authorized workers.</p>
    <h2>Authorized use</h2>
    <p>The tools are for organizing FloorPlanDrawings requests, appointments, communications, quotes, and deliverables. Access is limited to people Anna authorizes. Users must not share credentials or use the tools to access another person's account.</p>
    <h2>Automation limits</h2>
    <p>Automated matching, property research, square-foot estimates, scheduling suggestions, and message drafting are assistive features. A human must review quotes, assignments, appointment commitments, and client-facing messages before they are finalized.</p>
    <h2>Availability</h2>
    <p>The service is provided as an operational aid and may be unavailable or require manual fallback. Existing Airtable, Netlify, and email workflows remain the source of truth during staged migrations.</p>
    <h2>Contact</h2>
    <p>For account or service questions, email <a href="mailto:annaellisonmail@gmail.com">annaellisonmail@gmail.com</a>.</p>`);
}

module.exports = { privacyPage, termsPage };

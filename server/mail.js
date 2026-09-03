const nodemailer = require("nodemailer");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function smtpConfig(prefix = null) {
  const icloudConfigured = Boolean(
    clean(process.env.ICLOUD_SMTP_HOST) &&
      clean(process.env.ICLOUD_SMTP_USER) &&
      clean(process.env.ICLOUD_SMTP_APP_PASSWORD)
  );
  const selectedPrefix = prefix || (icloudConfigured ? "ICLOUD_SMTP_" : "SMTP_");
  const port = Number(clean(process.env[`${selectedPrefix}PORT`]) || "465");

  return {
    host: clean(process.env[`${selectedPrefix}HOST`]) || "smtp.gmail.com",
    port,
    secure: clean(process.env[`${selectedPrefix}SECURE`]).toLowerCase() !== "false",
    auth: {
      user: clean(process.env[`${selectedPrefix}USER`]),
      pass: clean(process.env[`${selectedPrefix}APP_PASSWORD`]).replace(/\s+/g, "")
    }
  };
}

function configured(config) {
  return Boolean(config.host && config.port && config.auth.user && config.auth.pass);
}

function smtpConfigs() {
  const primaryPrefix = clean(process.env.ICLOUD_SMTP_HOST) ? "ICLOUD_SMTP_" : "SMTP_";
  const primary = smtpConfig(primaryPrefix);
  const fallback = smtpConfig("FALLBACK_SMTP_");
  return [primary, configured(fallback) ? fallback : null].filter(Boolean);
}

function isSmtpConfigured() {
  return configured(smtpConfig());
}

function createTransport(config = smtpConfig()) {
  if (!configured(config)) {
    throw new Error("SMTP is not configured");
  }

  return nodemailer.createTransport(config);
}

async function verifySmtp() {
  const transport = createTransport();
  await transport.verify();

  return {
    provider: clean(process.env.ICLOUD_SMTP_HOST) ? "icloud" : "smtp",
    authenticated: true,
    sender: clean(process.env.MAIL_FROM) || clean(process.env.SMTP_USER)
  };
}

function retryable(error) {
  const code = clean(error && error.code).toUpperCase();
  if (["EAUTH", "EENVELOPE", "EINVALID", "EMESSAGE", "ENOTFOUND"].includes(code)) return false;
  const responseCode = Number(error && error.responseCode);
  return ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE"].includes(code)
    || (responseCode >= 500 && responseCode !== 535);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMail(message) {
  const configs = smtpConfigs();
  if (!configs.length || !configured(configs[0])) throw new Error("SMTP is not configured");
  const configuredAttempts = Number(clean(process.env.MAIL_MAX_ATTEMPTS));
  const configuredDelay = Number(clean(process.env.MAIL_RETRY_DELAY_MS));
  const maxAttempts = Math.max(1, Math.min(4, Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 3));
  const delayMs = Math.max(0, Math.min(5000, Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 500));
  const from = clean(process.env.MAIL_FROM) || configs[0].auth.user;
  let lastError;

  for (let providerIndex = 0; providerIndex < configs.length; providerIndex += 1) {
    const transport = createTransport(configs[providerIndex]);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await transport.sendMail({ from, ...message });

        return {
          accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
          messageId: result.messageId,
          provider: providerIndex === 0 ? "primary" : "fallback",
          attempts: attempt
        };
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === maxAttempts) break;
        await wait(delayMs * attempt);
      }
    }
  }

  throw lastError || new Error("SMTP delivery failed");
}

async function sendFailureAlert({ workflow, recordId, error }) {
  const recipient = clean(process.env.DELIVERY_ALERT_EMAIL);
  if (!recipient) return { skipped: true, reason: "DELIVERY_ALERT_EMAIL is not configured" };
  const safeWorkflow = clean(workflow) || "email workflow";
  const safeRecordId = clean(recordId) || "unknown record";
  const detail = clean(error && error.message) || "Unknown delivery error";
  try {
    return await sendMail({
      to: recipient,
      subject: `DELIVERY FAILURE | ${safeWorkflow} | ${safeRecordId}`,
      text: `Render could not deliver ${safeWorkflow}.\n\nRecord: ${safeRecordId}\nError: ${detail}\n\nCheck the Render delivery log before retrying.`,
      html: `<p><strong>Render delivery failure</strong></p><p>Workflow: ${safeWorkflow}<br>Record: ${safeRecordId}<br>Error: ${clean(detail).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p><p>Check the Render delivery log before retrying.</p>`
    });
  } catch (alertError) {
    console.error(`Delivery failure alert could not be sent: ${alertError.message}`);
    return { skipped: true, reason: "Alert delivery failed" };
  }
}

module.exports = { isSmtpConfigured, sendFailureAlert, sendMail, verifySmtp };

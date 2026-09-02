const nodemailer = require("nodemailer");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function smtpConfig() {
  const port = Number(clean(process.env.SMTP_PORT) || "465");

  return {
    host: clean(process.env.SMTP_HOST) || "smtp.gmail.com",
    port,
    secure: clean(process.env.SMTP_SECURE).toLowerCase() !== "false",
    auth: {
      user: clean(process.env.SMTP_USER),
      pass: clean(process.env.SMTP_APP_PASSWORD).replace(/\s+/g, "")
    }
  };
}

function isSmtpConfigured() {
  const config = smtpConfig();
  return Boolean(config.host && config.port && config.auth.user && config.auth.pass);
}

function createTransport() {
  if (!isSmtpConfigured()) {
    throw new Error("Gmail SMTP is not configured");
  }

  return nodemailer.createTransport(smtpConfig());
}

async function verifySmtp() {
  const transport = createTransport();
  await transport.verify();

  return {
    provider: "gmail",
    authenticated: true,
    sender: clean(process.env.MAIL_FROM) || clean(process.env.SMTP_USER)
  };
}

async function sendMail(message) {
  const transport = createTransport();
  const from = clean(process.env.MAIL_FROM) || clean(process.env.SMTP_USER);
  const result = await transport.sendMail({ from, ...message });

  return {
    accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
    messageId: result.messageId
  };
}

module.exports = { isSmtpConfigured, sendMail, verifySmtp };

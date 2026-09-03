const nodemailer = require("nodemailer");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function smtpConfig() {
  const icloudConfigured = Boolean(
    clean(process.env.ICLOUD_SMTP_HOST) &&
      clean(process.env.ICLOUD_SMTP_USER) &&
      clean(process.env.ICLOUD_SMTP_APP_PASSWORD)
  );
  const prefix = icloudConfigured ? "ICLOUD_SMTP_" : "SMTP_";
  const port = Number(clean(process.env[`${prefix}PORT`]) || "465");

  return {
    host: clean(process.env[`${prefix}HOST`]) || "smtp.gmail.com",
    port,
    secure: clean(process.env[`${prefix}SECURE`]).toLowerCase() !== "false",
    auth: {
      user: clean(process.env[`${prefix}USER`]),
      pass: clean(process.env[`${prefix}APP_PASSWORD`]).replace(/\s+/g, "")
    }
  };
}

function isSmtpConfigured() {
  const config = smtpConfig();
  return Boolean(config.host && config.port && config.auth.user && config.auth.pass);
}

function createTransport() {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP is not configured");
  }

  return nodemailer.createTransport(smtpConfig());
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

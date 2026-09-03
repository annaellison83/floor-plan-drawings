const assert = require("node:assert/strict");
const test = require("node:test");
const nodemailer = require("nodemailer");
const { sendMail } = require("./mail");

function withEnv(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(callback).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("retries transient SMTP failures and reports attempts", async () => {
  const original = nodemailer.createTransport;
  let attempts = 0;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporary connection issue");
        error.code = "ECONNECTION";
        throw error;
      }
      return { accepted: ["client@example.com"], messageId: "retry-ok" };
    }
  });
  try {
    await withEnv({
      ICLOUD_SMTP_HOST: undefined,
      ICLOUD_SMTP_USER: undefined,
      ICLOUD_SMTP_APP_PASSWORD: undefined,
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "sender@example.com",
      SMTP_APP_PASSWORD: "app-password",
      MAIL_MAX_ATTEMPTS: "3",
      MAIL_RETRY_DELAY_MS: "0",
      FALLBACK_SMTP_HOST: undefined,
      FALLBACK_SMTP_USER: undefined,
      FALLBACK_SMTP_APP_PASSWORD: undefined
    }, async () => {
      const result = await sendMail({ to: "client@example.com", subject: "test", text: "test" });
      assert.equal(result.attempts, 3);
      assert.equal(result.provider, "primary");
      assert.equal(attempts, 3);
    });
  } finally {
    nodemailer.createTransport = original;
  }
});

test("uses the configured fallback provider after primary retries fail", async () => {
  const original = nodemailer.createTransport;
  const providers = [];
  nodemailer.createTransport = (config) => {
    providers.push(config.host);
    return {
      sendMail: async () => {
        if (config.host === "primary.example.com") {
          const error = new Error("temporary connection issue");
          error.code = "ECONNECTION";
          throw error;
        }
        return { accepted: ["client@example.com"], messageId: "fallback-ok" };
      }
    };
  };
  try {
    await withEnv({
      ICLOUD_SMTP_HOST: undefined,
      ICLOUD_SMTP_USER: undefined,
      ICLOUD_SMTP_APP_PASSWORD: undefined,
      SMTP_HOST: "primary.example.com",
      SMTP_USER: "primary@example.com",
      SMTP_APP_PASSWORD: "primary-password",
      FALLBACK_SMTP_HOST: "fallback.example.com",
      FALLBACK_SMTP_USER: "fallback@example.com",
      FALLBACK_SMTP_APP_PASSWORD: "fallback-password",
      MAIL_MAX_ATTEMPTS: "2",
      MAIL_RETRY_DELAY_MS: "0"
    }, async () => {
      const result = await sendMail({ to: "client@example.com", subject: "test", text: "test" });
      assert.equal(result.provider, "fallback");
      assert.deepEqual(providers, ["primary.example.com", "fallback.example.com"]);
    });
  } finally {
    nodemailer.createTransport = original;
  }
});

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function safeHttpsUrl(value) {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function assetDirectory(env = process.env) {
  const stateFile = clean(env.STATE_FILE);
  const root = stateFile ? path.dirname(stateFile) : path.join(os.tmpdir(), "floorplan-drawings");
  return path.join(root, "email-assets");
}

function publicBaseUrl(env = process.env) {
  return (clean(env.EMAIL_ASSET_BASE_URL)
    || clean(env.RENDER_EXTERNAL_URL)
    || (clean(env.RENDER_EXTERNAL_HOSTNAME) ? `https://${clean(env.RENDER_EXTERNAL_HOSTNAME)}` : "")
    || "https://floor-plan-drawings.onrender.com").replace(/\/$/, "");
}

function assetFilename(url) {
  const digest = crypto.createHash("sha256").update(url).digest("hex");
  return `aerial-${digest}.jpg`;
}

function assetUrlFor(url, env = process.env) {
  return `${publicBaseUrl(env)}/assets/email/${assetFilename(url)}`;
}

function candidateUrls(job = {}) {
  return [...new Set([
    job.aerialAttachmentUrl,
    job.mapUrl,
    job.satellitePhotoLink,
    job.aerialLinkUrl
  ].map(safeHttpsUrl).filter(Boolean))];
}

async function cacheRemoteImage(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const directory = options.directory || assetDirectory(options.env || process.env);
  const filename = assetFilename(url);
  const filePath = path.join(directory, filename);
  try {
    const existing = await fsp.stat(filePath);
    if (existing.isFile() && existing.size > 0) return { ok: true, url: assetUrlFor(url, options.env || process.env), filePath, cached: true };
  } catch {
    // Cache miss; fetch the source below.
  }

  const response = await fetchImpl(url, { headers: { Accept: "image/*" } });
  if (!response || !response.ok) throw new Error(`image source returned ${response && response.status || "an error"}`);
  const contentType = clean(response.headers && response.headers.get && response.headers.get("content-type")).toLowerCase();
  if (contentType && !contentType.startsWith("image/")) throw new Error(`image source returned ${contentType}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length || body.length > 10 * 1024 * 1024) throw new Error("image source returned an invalid size");
  await fsp.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporaryPath, body, { mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
  return { ok: true, url: assetUrlFor(url, options.env || process.env), filePath, cached: false };
}

async function prepareEmailAssets(job = {}, options = {}) {
  const candidates = candidateUrls(job);
  const failures = [];
  for (const sourceUrl of candidates) {
    try {
      const cached = await cacheRemoteImage(sourceUrl, options);
      return {
        ...job,
        emailAerialUrl: cached.url,
        emailAerialLink: sourceUrl,
        emailAssetSource: sourceUrl,
        emailAssetError: ""
      };
    } catch (error) {
      failures.push(`${sourceUrl}: ${error.message}`);
    }
  }
  return {
    ...job,
    emailAerialUrl: "",
    emailAerialLink: job.propertyAddress
      ? `https://earth.google.com/web/search/${encodeURIComponent(clean(job.propertyAddress))}`
      : "",
    emailAssetSource: "",
    emailAssetError: failures.join("; ")
  };
}

function readAsset(filename, env = process.env) {
  if (!/^aerial-[a-f0-9]{64}\.jpg$/.test(filename)) return null;
  const filePath = path.join(assetDirectory(env), filename);
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

module.exports = {
  assetDirectory,
  assetFilename,
  assetUrlFor,
  cacheRemoteImage,
  candidateUrls,
  prepareEmailAssets,
  publicBaseUrl,
  readAsset,
  safeHttpsUrl
};

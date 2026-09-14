const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assetFilename, prepareEmailAssets } = require("./image-assets");

test("email assets prefer an Airtable attachment and cache it behind a stable URL", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "fpd-email-assets-"));
  const source = "https://v5.airtableusercontent.com/attachment.jpg";
  const result = await prepareEmailAssets({
    propertyAddress: "1 Test Street, Los Angeles, CA",
    aerialAttachmentUrl: source,
    mapUrl: "https://utility.arcgisonline.com/temporary-output.jpg"
  }, {
    directory,
    env: { EMAIL_ASSET_BASE_URL: "https://floor-plan-drawings.onrender.com" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Buffer.from("jpeg-bytes")
    })
  });

  assert.equal(result.emailAssetSource, source);
  assert.equal(result.emailAerialUrl, `https://floor-plan-drawings.onrender.com/assets/email/${assetFilename(source)}`);
  assert.equal(await fsp.readFile(path.join(directory, assetFilename(source)), "utf8"), "jpeg-bytes");
});

test("email asset preparation skips a failed temporary source and uses the next valid source", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "fpd-email-assets-"));
  const calls = [];
  const result = await prepareEmailAssets({
    propertyAddress: "1 Test Street, Los Angeles, CA",
    mapUrl: "https://utility.arcgisonline.com/temporary-output.jpg",
    satellitePhotoLink: "https://example.com/fallback.jpg"
  }, {
    directory,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("temporary-output")) return { ok: false, status: 500 };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => Buffer.from("fallback-bytes")
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(result.emailAssetSource, "https://example.com/fallback.jpg");
  assert.match(result.emailAerialUrl, /\/assets\/email\/aerial-[a-f0-9]{64}\.jpg$/);
});

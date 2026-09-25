const { isGeneratedPropertyFallback } = require("./gmail-airtable-sync");

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPropertyAerialProxy(value) {
  try { return new URL(clean(value)).pathname === "/assets/property-aerial"; } catch { return false; }
}

const RESEARCH_FIELDS = new Set([
  "Property Check Status", "Property Data Source URL", "Google Sq Ft Search URL",
  "Property Research Complete", "LA City Match Status", "APN", "PIN", "Lot Size",
  "Zoning", "Neighborhood / LA Area", "Miles From North Hollywood",
  "Miles From Monterey Park", "Aerial Map URL", "Satellite Photo Link",
  "Aerial Parcel Preview", "LA Context Map URL", "LA Context Map Preview",
  "ZIMAS Link", "Google Maps Link"
]);

function checkbox(value) {
  return value === true || value === 1 || /^true|yes|1$/i.test(clean(value));
}

function replaceable(key, current, address, priorFailure) {
  if (!clean(current)) return true;
  if (isGeneratedPropertyFallback(key, current, address)) return true;
  return priorFailure && (key === "Property Check Status" || key === "LA City Match Status");
}

function attachmentUrl(value) {
  if (!Array.isArray(value)) return "";
  const item = value.find((entry) => entry && (entry.url || entry.thumbnails && entry.thumbnails.full && entry.thumbnails.full.url));
  return clean(item && (item.url || item.thumbnails && item.thumbnails.full && item.thumbnails.full.url));
}

async function enrichGmailProperty({ recordId, fields = {}, researchAddress, buildUpdateFields, prepareEmailAssets, updateJob }) {
  const address = clean(fields["Property Address"] || fields["Full Address"]);
  if (!recordId || !address) return { ok: false, skipped: true, reason: "property address is missing" };
  const priorFailure = !checkbox(fields["Property Research Complete"])
    && clean(fields["Property Check Status"]) === "Needs Manual Review";
  if (checkbox(fields["Property Research Complete"]) && clean(fields["Property Check Status"]) && !priorFailure) {
    return { ok: true, skipped: true, reason: "already researched" };
  }
  try {
    const research = await researchAddress(address, { mapQuery: fields["Map Query"] });
    const built = buildUpdateFields(research, fields);
    const update = {};
    for (const [key, value] of Object.entries(built)) {
      if (!RESEARCH_FIELDS.has(key) || value === "" || value === null || value === undefined) continue;
      if (key === "Property Research Complete") continue;
      if (replaceable(key, fields[key], address, priorFailure)) update[key] = value;
    }

    let assetReady = false;
    if (research.ok) {
      // Include the stored attachment and every stored/generated URL. This lets
      // a retry recover from a previously expired export without replacing a
      // manually supplied satellite link.
      const storedMap = fields["Aerial Map URL"];
      const storedSatellite = fields["Satellite Photo Link"];
      const prepared = await prepareEmailAssets({
        propertyAddress: address,
        aerialAttachmentUrl: attachmentUrl(fields["Aerial Parcel Preview"]),
        mapUrl: isGeneratedPropertyFallback("Aerial Map URL", storedMap, address) || isPropertyAerialProxy(storedMap) ? built["Aerial Map URL"] : (storedMap || built["Aerial Map URL"]),
        satellitePhotoLink: isGeneratedPropertyFallback("Satellite Photo Link", storedSatellite, address) || isPropertyAerialProxy(storedSatellite) ? built["Satellite Photo Link"] : (storedSatellite || built["Satellite Photo Link"])
      }, { regenerate: true }).catch(() => null);
      assetReady = Boolean(prepared && prepared.emailAerialUrl);
      if (assetReady) {
        if (replaceable("Aerial Map URL", fields["Aerial Map URL"], address, false)) update["Aerial Map URL"] = prepared.emailAerialUrl;
        if (replaceable("Satellite Photo Link", fields["Satellite Photo Link"], address, false)) update["Satellite Photo Link"] = prepared.emailAerialUrl;
        if (!attachmentUrl(fields["Aerial Parcel Preview"])) {
          update["Aerial Parcel Preview"] = [{ url: prepared.emailAerialUrl, filename: `aerial-${address.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "property"}.jpg` }];
        }
      }
    }
    update["Property Research Complete"] = Boolean(research.ok && assetReady);
    if (Object.keys(update).length) await updateJob(recordId, update);
    return { ok: Boolean(research.ok && assetReady), researchOk: Boolean(research.ok), assetReady, status: research.status, researchFields: Object.keys(update) };
  } catch (error) {
    try { await updateJob(recordId, { "Property Research Complete": false, "Property Check Status": "Needs Manual Review" }); } catch { /* retain original failure */ }
    return { ok: false, retryable: true, error: error.message };
  }
}

module.exports = { enrichGmailProperty, attachmentUrl, replaceable, isPropertyAerialProxy };

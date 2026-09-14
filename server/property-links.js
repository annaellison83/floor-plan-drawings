function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function buildGoogleMapsLink(address) {
  const value = clean(address);
  return value
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`
    : "";
}

// ZIMAS can resolve an address interactively even when the parcel/PIN lookup
// is unavailable. Property research replaces this with a PIN-specific URL
// whenever it finds a verified Los Angeles parcel.
function buildZimasAddressLink(address) {
  const value = clean(address);
  return value
    ? `https://zimas.lacity.org/map.asp?address=${encodeURIComponent(value)}`
    : "";
}

// Google Earth is a stable, no-key fallback for a clickable aerial view.
// Property research replaces this with a direct county imagery export when
// coordinates are available.
function buildAerialFallbackLink(address) {
  const value = clean(address);
  return value
    ? `https://earth.google.com/web/search/${encodeURIComponent(value)}`
    : "";
}

function ensurePropertyLinks(fields = {}, address = "") {
  const value = clean(address || fields["Property Address"] || fields.Address);
  const aerial = clean(fields["Aerial Map URL"] || fields["Satellite Photo Link"]);
  return {
    ...fields,
    "Google Maps Link": clean(fields["Google Maps Link"]) || buildGoogleMapsLink(value),
    "ZIMAS Link": clean(fields["ZIMAS Link"]) || buildZimasAddressLink(value),
    "Aerial Map URL": clean(fields["Aerial Map URL"]) || aerial || buildAerialFallbackLink(value),
    "Satellite Photo Link": clean(fields["Satellite Photo Link"]) || aerial || buildAerialFallbackLink(value)
  };
}

module.exports = {
  buildAerialFallbackLink,
  buildGoogleMapsLink,
  buildZimasAddressLink,
  ensurePropertyLinks
};

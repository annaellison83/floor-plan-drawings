const ZONE_MINIMUMS = { 1: 200, 2: 230, 3: 260, 4: 300 };
const ZONE_LIMITS_MILES = { 1: 8, 2: 15, 3: 24, 4: 35 };
const BOUNDARY_REVIEW_MILES = 1;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function explicitZone(value) {
  const match = String(value || "").trim().match(/(?:zone|z)?\s*([1-4])\b/i);
  return match ? Number(match[1]) : null;
}

function resolveQuoteZone(input = {}) {
  const manual = explicitZone(input.quoteZone);
  if (manual) {
    return {
      zoneNumber: manual,
      zoneLabel: `Zone ${manual}`,
      minimum: ZONE_MINIMUMS[manual],
      source: "manual",
      needsReview: false
    };
  }

  const northHollywood = number(input.milesFromNorthHollywood);
  const montereyPark = number(input.milesFromMontereyPark);
  const distances = [northHollywood, montereyPark].filter((value) => value !== null);
  if (!distances.length) {
    return { zoneNumber: null, zoneLabel: "Needs zone assignment", minimum: null, source: "missing-distance", needsReview: true };
  }

  const nearestHubMiles = Math.min(...distances);
  const zoneNumber = Object.entries(ZONE_LIMITS_MILES)
    .find(([, limit]) => nearestHubMiles <= limit)?.[0];
  if (!zoneNumber) {
    return {
      zoneNumber: null,
      zoneLabel: "Outside mapped service area — review",
      minimum: null,
      nearestHubMiles,
      source: "map-approximation",
      needsReview: true
    };
  }

  const numericZone = Number(zoneNumber);
  const nearBoundary = Object.values(ZONE_LIMITS_MILES)
    .some((limit) => Math.abs(nearestHubMiles - limit) <= BOUNDARY_REVIEW_MILES);

  return {
    zoneNumber: numericZone,
    zoneLabel: `Zone ${numericZone}${nearBoundary ? " — boundary review" : ""}`,
    minimum: ZONE_MINIMUMS[numericZone],
    nearestHubMiles,
    source: "supplied-map approximation",
    needsReview: nearBoundary
  };
}

module.exports = { resolveQuoteZone, ZONE_LIMITS_MILES, ZONE_MINIMUMS };

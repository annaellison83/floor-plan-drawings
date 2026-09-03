function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function resolveSquareFootage(input = {}) {
  const assessorSqFt = positiveNumber(input.assessorSqFt ?? input.verifiedSqFt);
  if (assessorSqFt) {
    return {
      value: assessorSqFt,
      label: `${assessorSqFt.toLocaleString()} sq ft`,
      source: "LA County Assessor public record",
      verified: true,
      canAutoQuote: true
    };
  }

  // Listing data is a useful recovery path when the assessor record is
  // missing, but it remains explicitly unverified so it cannot silently drive
  // automatic pricing.
  const listingSources = [
    ["Redfin", input.redfinSqFt],
    ["Zillow", input.zillowSqFt],
    ["Realtor.com", input.realtorSqFt],
    ["Homes.com", input.homesSqFt],
    ["Listing", input.listingSqFt]
  ];
  const listing = listingSources.find(([, value]) => positiveNumber(value));
  if (listing) {
    const [source, value] = listing;
    const sqft = positiveNumber(value);
    return {
      value: sqft,
      label: `${sqft.toLocaleString()} sq ft — ${source} estimate`,
      source: `${source} listing estimate; verification required`,
      verified: false,
      canAutoQuote: false
    };
  }

  const submittedSqFt = positiveNumber(input.submittedSqFt ?? input.approxSqFt);
  if (submittedSqFt) {
    return {
      value: submittedSqFt,
      label: `${submittedSqFt.toLocaleString()} sq ft — client estimate`,
      source: "Client-provided estimate; verification required",
      verified: false,
      canAutoQuote: false
    };
  }

  return {
    value: null,
    label: "Manual size confirmation needed",
    source: "No building square footage found; lot size was not used",
    verified: false,
    canAutoQuote: false
  };
}

function sizeResearchLinks(address) {
  const property = String(address || "").trim();
  if (!property) return [];
  const sizeTerms = '("square feet" OR "sq ft" OR "sq. ft." OR "sq feet")';
  const searches = [
    ["Google square-footage search", `"${property}" ${sizeTerms}`],
    ["Zillow results", `site:zillow.com "${property}" ${sizeTerms}`],
    ["Redfin results", `site:redfin.com "${property}" ${sizeTerms}`],
    ["Realtor.com results", `site:realtor.com "${property}" ${sizeTerms}`],
    ["Homes.com results", `site:homes.com "${property}" ${sizeTerms}`]
  ];
  return searches.map(([label, query]) => ({
    label,
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`
  }));
}

module.exports = { resolveSquareFootage, sizeResearchLinks };

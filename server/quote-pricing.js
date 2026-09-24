const LARGE_PROJECT_SQ_FT = 3000;
const COLOR_SIZE_RATE = 0.10;
const PRICE_INCREMENT = 25;

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isColorService(value) {
  const service = clean(value).toLowerCase();
  return /color/.test(service) && !/matterport|3d|tour/.test(service);
}

/**
 * Starting size rule for larger color projects. This is intentionally a
 * floor, not an add-on: the configured pricing table or a manually entered
 * quote can still be higher. It keeps a 4,000 sq ft color project near $400
 * when a stale/missing pricing-table row would otherwise fall back to a zone
 * minimum such as $200.
 */
function largeColorProjectFloor(squareFeet, service) {
  const size = Number(squareFeet);
  if (!Number.isFinite(size) || size < LARGE_PROJECT_SQ_FT || !isColorService(service)) return null;
  const raw = size * COLOR_SIZE_RATE;
  return Math.max(PRICE_INCREMENT, Math.round(raw / PRICE_INCREMENT) * PRICE_INCREMENT);
}

module.exports = { largeColorProjectFloor, LARGE_PROJECT_SQ_FT, COLOR_SIZE_RATE, PRICE_INCREMENT };

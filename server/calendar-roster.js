const OWNER_NAME = "anna";
const WORKER_NAMES = new Set(["corrie", "sarah", "ricardo"]);
const EXCLUDED_NAMES = new Set(["home", "reminders"]);

function normalizeName(name) {
  return String(name || "").trim().toLocaleLowerCase();
}

function buildRoster(calendars) {
  const owner = [];
  const workers = [];
  const excluded = [];
  const unknown = [];

  for (const calendar of calendars) {
    const name = normalizeName(calendar.name);
    if (name === OWNER_NAME) owner.push(calendar);
    else if (WORKER_NAMES.has(name)) workers.push(calendar);
    else if (EXCLUDED_NAMES.has(name)) excluded.push(calendar);
    else unknown.push(calendar);
  }

  return {
    owner: owner[0] || null,
    workers,
    excluded,
    unknown,
    missingWorkers: [...WORKER_NAMES].filter(
      (workerName) => !workers.some((calendar) => normalizeName(calendar.name) === workerName)
    )
  };
}

module.exports = { buildRoster };

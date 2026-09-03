const {
  appointmentDurationMinutes,
  deliveryTargetForWeekday,
  rankWorkers
} = require("./scheduling-policy");

const CALENDAR_TO_POLICY = { ricardo: "ricky" };

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function policyWorkerName(calendarName) {
  const normalized = normalize(calendarName);
  return CALENDAR_TO_POLICY[normalized] || normalized;
}

function weekdayForDate(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function planAppointments({
  availability,
  squareFeet,
  service,
  nearbyToSarah = false,
  milesFromSarah,
  bookedThisWeek = {},
  bookedToday = {},
  count = 1
} = {}) {
  const durationMinutes = appointmentDurationMinutes(squareFeet);
  if (!durationMinutes) {
    return { readOnly: true, dryRun: true, recommendations: [], unassignedReason: "A verified square-footage estimate is required" };
  }

  const calendars = (availability && availability.calendars) || [];
  const candidates = [];
  for (const calendar of calendars) {
    const worker = policyWorkerName(calendar.name);
    for (const slot of calendar.slots || []) {
      if (!slot.available) continue;
      const weekday = weekdayForDate(slot.date);
      const ranked = rankWorkers({
        weekday,
        squareFeet,
        nearbyToSarah,
        milesFromSarah,
        bookedThisWeek,
        bookedToday
      });
      const rank = ranked.find((item) => item.name === worker);
      if (!rank) continue;
      candidates.push({
        ...slot,
        worker,
        calendarName: calendar.name,
        calendarUrl: calendar.url,
        workerScore: rank.score,
        deliveryTarget: deliveryTargetForWeekday(weekday)
      });
    }
  }

  candidates.sort((left, right) => left.workerScore - right.workerScore || left.start.localeCompare(right.start));
  const recommendations = [];
  const selectedByDay = {};
  const weeklyCounts = { ...bookedThisWeek };
  for (const candidate of candidates) {
    if (recommendations.length >= Math.max(1, Number(count) || 1)) break;
    const dayKey = candidate.date;
    const dayCount = selectedByDay[dayKey] || 0;
    // Each recommendation is one appointment. Worker-specific daily limits were
    // already applied by rankWorkers using the supplied bookedToday snapshot.
    if (dayCount >= 2) continue;
    if (recommendations.some((item) => item.date === candidate.date && item.worker === candidate.worker)) continue;
    recommendations.push({
      date: candidate.date,
      localStart: candidate.localStart,
      start: candidate.start,
      end: candidate.end,
      durationMinutes,
      worker: candidate.worker,
      calendarName: candidate.calendarName,
      calendarUrl: candidate.calendarUrl,
      deliveryTarget: candidate.deliveryTarget,
      rationale: candidate.worker === "corrie"
        ? "Corrie is salaried and prioritized for coverage"
        : candidate.worker === "ricky"
          ? "Ricky/Ricardo is the secondary open-capacity worker"
          : "Sarah is reserved for nearby small-house spillover"
    });
    selectedByDay[dayKey] = dayCount + 1;
    weeklyCounts[candidate.worker] = (Number(weeklyCounts[candidate.worker]) || 0) + 1;
  }

  return {
    readOnly: true,
    dryRun: true,
    durationMinutes,
    request: { squareFeet: Number(squareFeet), service: service || null, nearbyToSarah, milesFromSarah: milesFromSarah ?? null },
    recommendations,
    unassignedReason: recommendations.length ? null : "No policy-compliant available slot found"
  };
}

module.exports = { planAppointments, policyWorkerName };

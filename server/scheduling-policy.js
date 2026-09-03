const DEFAULT_APPOINTMENT_STARTS = ["11:00", "13:00"];
const DEFAULT_APPOINTMENT_MINUTES = 90;
const SMALL_PROJECT_SQ_FT = 3000;
const LARGE_PROJECT_SQ_FT = 5000;
const DELIVERY_DAYS = { blackAndWhite: 2, color: 3 };
const BATCH_BOOKING_POLICY = {
  bookingWeekdays: [1, 2], // Monday and Tuesday
  targetAppointments: 8,
  targetDeliveryWeekday: 5, // Friday
  targetDeliveryLabel: "Friday"
};

const WORKER_POLICY = {
  corrie: {
    preferredWeekdays: [1, 2, 4], // Monday, Tuesday, Thursday
    weeklyTarget: 3,
    weeklySoftCap: 4,
    maxAppointmentsPerDay: 2,
    largeProjectMaxPerDay: 1
  },
  ricky: {
    preferredWeekdays: [1, 2, 3, 4, 5],
    weeklyTarget: 2,
    weeklySoftCap: 2,
    maxAppointmentsPerDay: 2,
    largeProjectMaxPerDay: 2
  },
  sarah: {
    preferredWeekdays: [1, 2, 3, 4, 5],
    weeklyTarget: 0,
    weeklySoftCap: null,
    maxAppointmentsPerDay: 1,
    largeProjectMaxPerDay: 0,
    smallProjectOnly: true,
    nearbyOnly: true,
    spilloverOnly: true
  }
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function weekdayNumber(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 6) return value;
  const match = String(value || "").trim().toLowerCase().slice(0, 3);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(match);
}

function appointmentDurationMinutes(squareFeet) {
  const sqFt = number(squareFeet);
  if (sqFt === null) return null;
  // Anna's stated 1.5-hour default applies to projects up to 3,000 sq ft.
  // Larger projects need an explicit duration until a larger-project estimate is set.
  return sqFt <= SMALL_PROJECT_SQ_FT ? DEFAULT_APPOINTMENT_MINUTES : null;
}

function deliveryDaysForService(service) {
  const value = String(service || "").trim().toLowerCase();
  if (/(?:b\s*[&+]|black\s+and\s+white|black\s*&\s*white)/.test(value)) return DELIVERY_DAYS.blackAndWhite;
  return DELIVERY_DAYS.color;
}

function deliveryTargetForWeekday(weekday) {
  const day = weekdayNumber(weekday);
  if (day === 1 || day === 2) return { weekday: 5, label: "Friday", endOfDay: false };
  if (day === 3) return { weekday: 6, label: "Saturday", endOfDay: false };
  if (day === 4 || day === 5) return { weekday: 1, label: "Monday", endOfDay: true };
  return { weekday: null, label: "Needs scheduling review", endOfDay: false };
}

function canWorkerTake(workerName, { squareFeet, nearbyToSarah = false, appointmentsToday = 0 } = {}) {
  const name = String(workerName || "").trim().toLowerCase();
  const policy = WORKER_POLICY[name];
  if (!policy) return false;

  const sqFt = number(squareFeet);
  if (policy.smallProjectOnly && (sqFt === null || sqFt > SMALL_PROJECT_SQ_FT)) return false;
  if (policy.nearbyOnly && nearbyToSarah !== true) return false;
  if (sqFt !== null && sqFt >= LARGE_PROJECT_SQ_FT && policy.largeProjectMaxPerDay < 1) return false;

  const dailyLimit = sqFt !== null && sqFt >= LARGE_PROJECT_SQ_FT
    ? policy.largeProjectMaxPerDay
    : policy.maxAppointmentsPerDay;
  return appointmentsToday < dailyLimit;
}

function rankWorkers({ weekday, squareFeet, nearbyToSarah = false, bookedThisWeek = {}, bookedToday = {} } = {}) {
  const day = weekdayNumber(weekday);
  const candidates = Object.entries(WORKER_POLICY)
    .filter(([name]) => canWorkerTake(name, {
      squareFeet,
      nearbyToSarah,
      appointmentsToday: Number(bookedToday[name]) || 0
    }))
    .map(([name, policy]) => {
      const weekCount = Number(bookedThisWeek[name]) || 0;
      const preferredDay = day >= 0 && policy.preferredWeekdays.includes(day);
      const atSoftCap = policy.weeklySoftCap !== null && weekCount >= policy.weeklySoftCap;
      // Corrie's salary makes her the primary assignment until her soft cap;
      // Ricky is next, and Sarah is reserved for spillover.
      const staffingPriority = name === "corrie" ? -40 : name === "ricky" ? -20 : 100;
      const spilloverPenalty = policy.spilloverOnly ? 100 : 0;
      return {
        name,
        weekCount,
        preferredDay,
        atSoftCap,
        score: staffingPriority + spilloverPenalty + (atSoftCap ? 80 : 0) + (preferredDay ? -10 : 0) + weekCount
      };
    })
    .sort((left, right) => left.score - right.score);

  return candidates;
}

function schedulingPolicy() {
  return {
    appointmentStarts: [...DEFAULT_APPOINTMENT_STARTS],
    defaultAppointmentMinutes: DEFAULT_APPOINTMENT_MINUTES,
    defaultAppointmentScope: `projects at or under ${SMALL_PROJECT_SQ_FT.toLocaleString()} sq ft`,
    largerProjectDuration: "needs review",
    delivery: {
      serviceDays: { ...DELIVERY_DAYS },
      weekdayTargets: {
        Monday: deliveryTargetForWeekday(1),
        Tuesday: deliveryTargetForWeekday(2),
        Wednesday: deliveryTargetForWeekday(3),
        Thursday: deliveryTargetForWeekday(4),
        Friday: deliveryTargetForWeekday(5)
      },
      batchBooking: { ...BATCH_BOOKING_POLICY }
    },
    workers: WORKER_POLICY,
    assumptions: [
      "Ricky is represented by the Ricardo calendar.",
      "Sarah requires an explicit nearbyToSarah=true flag; no mileage threshold was supplied.",
      "Projects at or above 5,000 sq ft are large-project appointments."
    ]
  };
}

module.exports = {
  appointmentDurationMinutes,
  canWorkerTake,
  deliveryDaysForService,
  deliveryTargetForWeekday,
  rankWorkers,
  schedulingPolicy,
  DEFAULT_APPOINTMENT_STARTS,
  DEFAULT_APPOINTMENT_MINUTES,
  SMALL_PROJECT_SQ_FT,
  LARGE_PROJECT_SQ_FT,
  DELIVERY_DAYS,
  BATCH_BOOKING_POLICY
};

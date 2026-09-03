const CALDAV_URL = "https://caldav.icloud.com/";

const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function xmlEscape(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteHref(href, base) {
  const value = clean(href);
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch (error) {
    return "";
  }
}

function tagValue(xml, tagName) {
  const match = xml.match(new RegExp(`<[^>]*${tagName}[^>]*>([\\s\\S]*?)</[^>]*${tagName}>`, "i"));
  return match ? clean(match[1].replace(/<[^>]+>/g, "")) : "";
}

function nestedHref(xml, containerTag) {
  const container = xml.match(
    new RegExp(`<[^>]*${containerTag}[^>]*>([\\s\\S]*?)</[^>]*${containerTag}>`, "i")
  );
  return container ? tagValue(container[1], "href") : "";
}

function responseBlocks(xml) {
  return xml.match(/<[^>]*response[^>]*>[\s\S]*?<\/[^>]*response>/gi) || [];
}

function displayName(xml) {
  return tagValue(xml, "displayname") || tagValue(xml, "display-name");
}

function hrefs(xml) {
  return [...xml.matchAll(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/gi)]
    .map((match) => clean(match[1].replace(/<[^>]+>/g, "")))
    .filter(Boolean);
}

function hasCalendarResource(xml) {
  return /<(?:[^:>]+:)?calendar(?:\s[^>]*)?(?:\/|>)/i.test(xml)
    && !/<(?:[^:>]+:)?calendar-home-set/i.test(xml);
}

function requestBody(properties) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}">
  <d:prop>${properties}</d:prop>
</d:propfind>`;
}

function authHeaders(email, password) {
  return {
    Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`,
    "Content-Type": "application/xml; charset=utf-8",
    Depth: "0"
  };
}

async function davRequest(url, email, password, body, depth = "0", method = "PROPFIND") {
  const response = await fetch(url, {
    method,
    headers: { ...authHeaders(email, password), Depth: depth },
    body,
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  if (!response.ok && response.status !== 207) {
    throw new Error(`iCloud CalDAV returned HTTP ${response.status}`);
  }
  return text;
}

function decodeXml(value) {
  return clean(value)
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagRaw(xml, tagName) {
  const match = xml.match(new RegExp(`<[^>]*${tagName}[^>]*>([\\s\\S]*?)</[^>]*${tagName}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function unfoldIcsLines(ics) {
  return String(ics || "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unescapeIcs(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

function parseIcsDate(rawValue, timeZone) {
  const value = String(rawValue || "").trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const guess = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
    return timeZone ? new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone)) : guess;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return null;
  const guess = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])));
  if (match[7] || !timeZone) return guess;
  return new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
}

function parseIcsEvents(ics) {
  const lines = unfoldIcsLines(ics);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current && current.start && current.end) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const property = line.slice(0, separator);
    const value = unescapeIcs(line.slice(separator + 1));
    const [name, ...parameters] = property.split(";");
    if (name === "SUMMARY") current.summary = value;
    if (name === "UID") current.uid = value;
    if (name === "DTSTART") {
      const tzid = parameters.find((parameter) => parameter.toUpperCase().startsWith("TZID="));
      current.start = parseIcsDate(value, tzid ? tzid.slice(5) : "America/Los_Angeles");
      current.allDay = /VALUE=DATE/i.test(parameters.join(";"));
    }
    if (name === "DTEND") {
      const tzid = parameters.find((parameter) => parameter.toUpperCase().startsWith("TZID="));
      current.end = parseIcsDate(value, tzid ? tzid.slice(5) : "America/Los_Angeles");
    }
  }
  return events;
}

function calendarQueryBody(start, end) {
  const toCalDav = (value) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="${toCalDav(start)}" end="${toCalDav(end)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${toCalDav(start)}" end="${toCalDav(end)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
}

async function listCalendarEvents({ calendar, email, password, start, end }) {
  const xml = await davRequest(calendar.url, email, password, calendarQueryBody(start, end), "1", "REPORT");
  return responseBlocks(xml).flatMap((block) => parseIcsEvents(tagRaw(block, "calendar-data")));
}

function localDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function localDateTime(dateString, timeString) {
  return parseIcsDate(`${dateString.replace(/-/g, "")}T${timeString.replace(":", "")}00`, "America/Los_Angeles");
}

function dateRange(startDate, days) {
  const start = new Date(`${startDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    return date.toISOString().slice(0, 10);
  });
}

async function getCalendarAvailability({ email, password, calendars, startDate, days = 7, durationMinutes = 90, appointmentStarts = ["11:00", "13:00"] }) {
  if (!email || !password) throw new Error("ICLOUD_EMAIL and ICLOUD_APP_PASSWORD are required");
  const dates = dateRange(startDate, days);
  const rangeStart = localDateTime(dates[0], "00:00");
  const rangeEnd = localDateTime(dates[dates.length - 1], "23:59");
  const results = await Promise.all(calendars.map(async (calendar) => {
    const events = await listCalendarEvents({ calendar, email, password, start: rangeStart, end: rangeEnd });
    const busy = events.map((event) => ({
      uid: event.uid || null,
      summary: event.summary || "Busy",
      start: event.start.toISOString(),
      end: event.end.toISOString(),
      allDay: Boolean(event.allDay)
    }));
    const slots = dates.flatMap((date) => appointmentStarts.map((time) => {
      const start = localDateTime(date, time);
      const end = new Date(start.getTime() + durationMinutes * 60000);
      const conflicts = events.filter((event) => event.start < end && event.end > start);
      return {
        date,
        start: start.toISOString(),
        end: end.toISOString(),
        localStart: `${date} ${time}`,
        available: conflicts.length === 0,
        conflicts: conflicts.map((event) => event.summary || "Busy")
      };
    }));
    return { name: calendar.name, url: calendar.url, busy, slots };
  }));
  return { readOnly: true, startDate, days, durationMinutes, calendars: results };
}

async function discoverCalendars({ email, password }) {
  if (!email || !password) {
    throw new Error("ICLOUD_EMAIL and ICLOUD_APP_PASSWORD are required");
  }

  const principalXml = await davRequest(
    CALDAV_URL,
    email,
    password,
    requestBody("<d:current-user-principal/><d:principal-URL/>")
  );
  const principalHref = absoluteHref(
    nestedHref(principalXml, "current-user-principal") || nestedHref(principalXml, "principal-URL"),
    CALDAV_URL
  );
  if (!principalHref) throw new Error("iCloud did not return a calendar principal");

  const principalXmlDetails = await davRequest(
    principalHref,
    email,
    password,
    requestBody("<c:calendar-home-set/>")
  );
  const calendarHomeHref = absoluteHref(
    nestedHref(principalXmlDetails, "calendar-home-set"),
    principalHref
  );
  if (!calendarHomeHref) throw new Error("iCloud did not return a calendar home");

  const homeXml = await davRequest(
    calendarHomeHref,
    email,
    password,
    requestBody("<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/" + ">"),
    "1"
  );

  const calendars = responseBlocks(homeXml)
    .map((block) => {
      const href = absoluteHref(hrefs(block)[0], calendarHomeHref);
      return {
        name: displayName(block) || "Unnamed calendar",
        url: href,
        writable: /<[^>]*current-user-privilege-set/i.test(block) ? true : null,
        isCalendar: hasCalendarResource(block)
      };
    })
    .filter((calendar) => calendar.isCalendar && calendar.url)
    .map(({ name, url, writable }) => ({ name, url, writable }));

  return {
    calendarHomeUrl: calendarHomeHref,
    calendars
  };
}

module.exports = { discoverCalendars, getCalendarAvailability, parseIcsEvents };

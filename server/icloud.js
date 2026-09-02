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
  return /<(?:[^:>]+:)?calendar\s*(?:\/|>)/i.test(xml)
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

async function davRequest(url, email, password, body, depth = "0") {
  const response = await fetch(url, {
    method: "PROPFIND",
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
    tagValue(principalXml, "href"),
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
    tagValue(principalXmlDetails, "href"),
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

module.exports = { discoverCalendars };

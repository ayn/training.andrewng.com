import ICAL from 'ical.js';

const MAX_BYTES = 2_000_000;
const encoder = new TextEncoder();
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

function parseCalendar(text) {
  if (encoder.encode(text).length > MAX_BYTES) throw new Error('Calendar exceeds size limit');
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean.startsWith('BEGIN:VCALENDAR') || !clean.endsWith('END:VCALENDAR')) {
    throw new Error('Invalid calendar envelope');
  }
  const calendar = new ICAL.Component(ICAL.parse(clean));
  if (calendar.name !== 'vcalendar' || calendar.getFirstPropertyValue('version') !== '2.0') {
    throw new Error('Expected iCalendar 2.0');
  }
  const seen = new Set();
  const events = calendar.getAllSubcomponents('vevent').map(event => {
    const uid = event.getFirstPropertyValue('uid');
    const recurrence = event.getFirstProperty('recurrence-id');
    // Include TZID/value type so distinct recurrence identities cannot collide.
    const recurrence_id = recurrence ? JSON.stringify(recurrence.toJSON()) : '';
    if (typeof uid !== 'string' || !uid.trim()) throw new Error('Event is missing UID');
    if (!event.hasProperty('dtstart') && event.getFirstPropertyValue('status') !== 'CANCELLED') {
      throw new Error('Event is missing DTSTART');
    }
    if (event.hasProperty('dtstart')) event.getFirstPropertyValue('dtstart').toString();
    const identity = JSON.stringify([uid, recurrence_id]);
    if (seen.has(identity)) throw new Error('Duplicate event identity');
    seen.add(identity);
    return { uid, recurrence_id, component: JSON.stringify(event.toJSON()) };
  });
  if (events.length > 5000) throw new Error('Too many events');
  const zones = calendar.getAllSubcomponents('vtimezone').map(zone => {
    const tzid = zone.getFirstPropertyValue('tzid');
    if (!tzid) throw new Error('Timezone is missing TZID');
    return { tzid, component: JSON.stringify(zone.toJSON()) };
  });
  return { events, zones };
}

async function hash(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function ingest(db, text, observedAt = Date.now()) {
  const { events, zones } = parseCalendar(text);
  const digest = await hash(text);
  // One atomic batch: a malformed feed or SQL failure leaves the old archive intact.
  // JSON bulk inserts avoid one D1 query per event during historical imports.
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO snapshots (hash, content, first_seen) VALUES (?, ?, ?)')
      .bind(digest, text, observedAt),
    db.prepare(`INSERT INTO events (uid, recurrence_id, component, first_seen, last_seen)
      SELECT json_extract(value, '$.uid'), json_extract(value, '$.recurrence_id'),
        json_extract(value, '$.component'), ?, ? FROM json_each(?) WHERE true
      ON CONFLICT (uid, recurrence_id) DO UPDATE SET component = excluded.component,
        last_seen = excluded.last_seen
      WHERE excluded.last_seen >= events.last_seen`)
      .bind(observedAt, observedAt, JSON.stringify(events)),
    db.prepare(`INSERT INTO timezones (tzid, component, last_seen)
      SELECT json_extract(value, '$.tzid'), json_extract(value, '$.component'), ?
        FROM json_each(?) WHERE true
      ON CONFLICT (tzid) DO UPDATE SET component = excluded.component, last_seen = excluded.last_seen
      WHERE excluded.last_seen >= timezones.last_seen`)
      .bind(observedAt, JSON.stringify(zones)),
    db.prepare(`INSERT INTO status (id, last_success, last_attempt, last_error) VALUES (1, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET last_success = excluded.last_success,
        last_attempt = excluded.last_attempt, last_error = NULL
      WHERE excluded.last_attempt >= COALESCE(status.last_attempt, 0)`)
      .bind(observedAt, observedAt),
  ]);
  return { fetched_events: events.length };
}

export async function renderCalendar(db, name = 'Training archive') {
  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//Calendar Archive Worker//EN');
  calendar.addPropertyWithValue('calscale', 'GREGORIAN');
  calendar.addPropertyWithValue('x-wr-calname', name);
  // A subscription, never METHOD:REQUEST or METHOD:CANCEL for the whole calendar.
  for (const table of ['timezones', 'events']) {
    const { results } = await db.prepare(`SELECT component FROM ${table} ORDER BY ${table === 'events' ? 'uid, recurrence_id' : 'tzid'}`).all();
    for (const row of results) calendar.addSubcomponent(new ICAL.Component(JSON.parse(row.component)));
  }
  return calendar.toString() + '\r\n';
}

async function limitedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Calendar exceeds size limit');
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('Calendar exceeds size limit');
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function refresh(env, fetcher = fetch) {
  const attempt = Date.now();
  let failure = 'SOURCE_CONFIGURATION';
  try {
    if (new URL(env.SOURCE_URL).protocol !== 'https:') throw new Error('HTTPS required');
    failure = 'FETCH_FAILED';
    const response = await fetcher(env.SOURCE_URL, {
      // workerd supports manual/follow, but not the standard Fetch "error" mode.
      // Manual still rejects redirects below through the response.ok check.
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'text/calendar', 'User-Agent': 'CalendarArchive/1.0' },
    });
    if (!response.ok) {
      failure = `UPSTREAM_HTTP_${response.status}`;
      throw new Error('Upstream request failed');
    }
    failure = 'SOURCE_BODY_INVALID';
    const text = await limitedText(response);
    failure = 'SOURCE_IMPORT_FAILED';
    return await ingest(env.DB, text, attempt);
  } catch {
    // Never persist or log raw fetch/parser exceptions: they may contain the source URL.
    await env.DB.prepare(`INSERT INTO status (id, last_attempt, last_error) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_attempt = excluded.last_attempt, last_error = excluded.last_error
      WHERE excluded.last_attempt >= COALESCE(status.last_attempt, 0)`)
      .bind(attempt, `Refresh failed (${failure}); previous archive retained`).run();
    throw new Error('Calendar refresh failed');
  }
}

async function tokenMatches(candidate, expected) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  const a = await hash(candidate); const b = await hash(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function reply(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...headers, ...extra } });
}
function json(body, status = 200) {
  return reply(JSON.stringify(body), status, { 'Content-Type': 'application/json' });
}

export default {
  async scheduled(_controller, env) {
    await refresh(env);
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return reply('Private calendar archive. Subscription link required.');
    if (path === '/health' && request.method === 'GET') return json({ ok: true });
    if (path.startsWith('/admin/')) {
      if (!await tokenMatches(request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '', env.ADMIN_TOKEN)) {
        return reply('Not found', 404);
      }
      if (request.method !== 'POST') return reply('Method not allowed', 405, { Allow: 'POST' });
      try {
        if (path === '/admin/refresh') return json(await refresh(env));
        if (path === '/admin/import') return json(await ingest(env.DB, await limitedText(request)));
      } catch { return json({ error: 'Import or refresh failed; previous archive retained' }, 502); }
      return reply('Not found', 404);
    }
    const calendar = path.match(/^\/calendar\/([A-Za-z0-9_-]+)\.ics$/);
    const status = path.match(/^\/status\/([A-Za-z0-9_-]+)$/);
    if (!await tokenMatches((calendar ?? status)?.[1] ?? '', env.FEED_TOKEN)) return reply('Not found', 404);
    if (!calendar && !status) return reply('Not found', 404);
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed', 405, { Allow: 'GET, HEAD' });
    const health = await env.DB.prepare('SELECT last_success, last_attempt, last_error FROM status WHERE id = 1').first();
    if (status) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first();
      return json({ events: count.n, ...health });
    }
    if (!health?.last_success) return reply('Archive not initialized', 503, { 'Retry-After': '3600' });
    return reply(request.method === 'HEAD' ? null : await renderCalendar(env.DB, env.CALENDAR_NAME), 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="training-archive.ics"',
      'X-Archive-Last-Success': new Date(health.last_success).toISOString(),
    });
  },
};

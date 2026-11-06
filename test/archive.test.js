import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import ICAL from 'ical.js';
import { readFileSync } from 'node:fs';
import worker, { ingest, renderCalendar, refresh } from '../src/index.js';

// Run the production SQL against SQLite, with D1's asynchronous interface.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) {
    const make = (args = []) => ({
      bind: (...values) => make(values),
      run: async () => sqlite.prepare(sql).run(...args),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    });
    return make();
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  }};
  return db;
}
const event = (uid, title = 'Easy run', extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:${title}\r\nDESCRIPTION:Warm up\\n3 x 1000m\\; easy recovery\r\n${extra}END:VEVENT\r\n`;
const feed = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic fixtures//EN\r\n${events.join('')}END:VCALENDAR\r\n`;
const components = text => new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent');
const key = 'a'.repeat(43);
const envFor = DB => ({ DB, FEED_TOKEN: key, ADMIN_TOKEN: 'b'.repeat(43), SOURCE_URL: 'https://example.org/private.ics', CALENDAR_NAME: 'Training archive' });

test('retains past and future events that fall out of a rolling feed', async () => {
  const db = database();
  await ingest(db, feed(event('old'), event('future', 'Future run', 'DTEND;VALUE=DATE:20261102\r\n')), 100);
  await ingest(db, feed(event('new')), 200);
  assert.deepEqual(components(await renderCalendar(db)).map(x => x.getFirstPropertyValue('uid')).sort(), ['future', 'new', 'old']);
});

test('edits replace the same UID, including date, text and cancellation, without duplicates', async () => {
  const db = database();
  await ingest(db, feed(event('one')), 100);
  await ingest(db, feed(event('one', 'Updated run', 'STATUS:CANCELLED\r\n').replace('20261101\r\nSUMMARY', '20261102\r\nSUMMARY')), 200);
  const events = components(await renderCalendar(db));
  assert.equal(events.length, 1);
  assert.equal(events[0].getFirstPropertyValue('summary'), 'Updated run');
  assert.equal(events[0].getFirstPropertyValue('dtstart').toString(), '2026-11-02');
  assert.equal(events[0].getFirstPropertyValue('status'), 'CANCELLED');
  assert.equal(events[0].getFirstPropertyValue('description'), 'Warm up\n3 x 1000m; easy recovery');
});

test('keeps recurrence exceptions distinct and preserves recurrence rules', async () => {
  const db = database();
  await ingest(db, feed(event('series', 'Weekly', 'RRULE:FREQ=WEEKLY;COUNT=3\r\n'), event('series', 'Exception', 'RECURRENCE-ID;VALUE=DATE:20261108\r\n')), 100);
  assert.equal(components(await renderCalendar(db)).length, 2);
  await ingest(db, feed(event('series', 'Edited exception', 'RECURRENCE-ID;VALUE=DATE:20261108\r\n')), 200);
  const events = components(await renderCalendar(db));
  assert.equal(events.length, 2);
  assert.ok(events.some(x => x.hasProperty('rrule')));
  assert.ok(events.some(x => x.getFirstPropertyValue('summary') === 'Edited exception'));
});

test('preserves timezone definitions and nested components across refreshes', async () => {
  const db = database();
  const zone = 'BEGIN:VTIMEZONE\r\nTZID:Test/Zone\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
  const alarm = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nDESCRIPTION:Run\r\nEND:VALARM\r\n';
  await ingest(db, feed(zone, event('zoned', 'Run', alarm).replace('DTSTART;VALUE=DATE:20261101', 'DTSTART;TZID=Test/Zone:20261101T180000')), 100);
  await ingest(db, feed(), 200);
  const calendar = new ICAL.Component(ICAL.parse(await renderCalendar(db)));
  assert.equal(calendar.getAllSubcomponents('vtimezone').length, 1);
  assert.equal(calendar.getFirstSubcomponent('vevent').getFirstSubcomponent('valarm').name, 'valarm');
});

test('invalid or duplicate-identity feeds cannot partially overwrite the archive', async () => {
  const db = database();
  await ingest(db, feed(event('one')), 100);
  for (const bad of ['<html>Login</html>', feed(event('one', 'bad'), event('one', 'duplicate')), feed(event('').replace('UID:\r\n', '')), feed(event('one')).replace('END:VCALENDAR', '')]) {
    await assert.rejects(() => ingest(db, bad, 200));
  }
  assert.equal(components(await renderCalendar(db))[0].getFirstPropertyValue('summary'), 'Easy run');
});

test('an older concurrent refresh cannot overwrite a newer event', async () => {
  const db = database();
  await ingest(db, feed(event('one', 'New')), 200);
  await ingest(db, feed(event('one', 'Old')), 100);
  assert.equal(components(await renderCalendar(db))[0].getFirstPropertyValue('summary'), 'New');
});

test('identical snapshots are deduplicated and empty valid feeds retain history', async () => {
  const db = database();
  await ingest(db, feed(event('one')), 100);
  await ingest(db, feed(event('one')), 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM snapshots').first()).n, 1);
  await ingest(db, feed(), 300);
  assert.equal(components(await renderCalendar(db)).length, 1);
});

test('calendar is private, uncached, read-only and unavailable before first import', async () => {
  const env = envFor(database());
  assert.equal((await worker.fetch(new Request('https://example.org/calendar/wrong.ics'), env)).status, 404);
  const url = `https://example.org/calendar/${key}.ics`;
  assert.equal((await worker.fetch(new Request(url), env)).status, 503);
  await ingest(env.DB, feed(event('one')), 100);
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/calendar/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), env)).status, 405);
  assert.equal(components(await response.text()).length, 1);
});

test('refresh failure leaves a readable archive and sanitized failure status', async () => {
  const env = envFor(database());
  await ingest(env.DB, feed(event('one')), 100);
  await assert.rejects(() => refresh(env, async () => { throw new Error('secret feed URL'); }));
  const r = await worker.fetch(new Request(`https://example.org/status/${key}`), env);
  const s = await r.json();
  assert.equal(s.events, 1);
  assert.ok(s.last_error);
  assert.ok(!JSON.stringify(s).includes('secret feed URL'));
  assert.equal((await worker.fetch(new Request(`https://example.org/calendar/${key}.ics`), env)).status, 200);
});

test('refresh rejects upstream errors, insecure sources and oversized bodies', async () => {
  const env = envFor(database());
  await assert.rejects(() => refresh(env, async () => new Response('failure', { status: 500 })));
  await assert.rejects(() => refresh({ ...env, SOURCE_URL: 'http://example.org/feed' }, async () => new Response(feed())));
  await assert.rejects(() => refresh(env, async () => new Response('x'.repeat(2_000_001))));
});

test('operator refresh requires a separate bearer token; subscriptions cannot write', async () => {
  const env = envFor(database());
  for (const headers of [{}, { Authorization: `Bearer ${key}` }]) {
    assert.equal((await worker.fetch(new Request('https://example.org/admin/refresh', { method: 'POST', headers }), env)).status, 404);
  }
});

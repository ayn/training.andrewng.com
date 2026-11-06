import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import ICAL from 'ical.js';
import { historyCalendar } from '../scripts/import-history.js';

function source() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE finalsurge_days (workout_date TEXT, planned_title TEXT, planned_items_json TEXT, description TEXT)');
  const add = (date, items, description = '') => db.prepare('INSERT INTO finalsurge_days VALUES (?, ?, ?, ?)').run(date, items.map(x => x.title).join('; '), JSON.stringify(items), description);
  return { db, add };
}
const events = text => new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent');
test('history import keeps separate workouts, notes, all-day dates, stable UIDs and excludes future days', () => {
  const { db, add } = source();
  add('2025-01-01', [{ title: 'Run: 5 miles', distance_miles: 5 }, { title: 'Bike: 30 min' }], 'Coach note; easy\nStay relaxed');
  add('2026-11-06', [{ title: 'Future run' }]);
  const first = historyCalendar(db, { before: '2026-11-06' });
  assert.equal(events(first.text).length, 2);
  assert.equal(events(first.text)[0].getFirstPropertyValue('dtstart').toString(), '2025-01-01');
  assert.match(events(first.text)[0].getFirstPropertyValue('description'), /Coach note; easy\nStay relaxed/);
  assert.equal(first.text, historyCalendar(db, { before: '2026-11-06' }).text);
  db.prepare('UPDATE finalsurge_days SET planned_items_json = ? WHERE workout_date = ?').run(JSON.stringify([{ title: 'Edited title' }, { title: 'Bike: 30 min' }]), '2025-01-01');
  assert.equal(events(first.text)[0].getFirstPropertyValue('uid'), events(historyCalendar(db, { before: '2026-11-06' }).text)[0].getFirstPropertyValue('uid'));
});

test('history import skips dates already represented in original ICS snapshots', () => {
  const { db, add } = source();
  add('2025-01-01', [{ title: 'Run' }]);
  add('2025-01-02', [{ title: 'Next run' }]);
  const existing = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:original\r\nDTSTART;VALUE=DATE:20250101\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const result = historyCalendar(db, { before: '2026-11-06', existing });
  assert.equal(events(result.text).length, 1);
  assert.equal(events(result.text)[0].getFirstPropertyValue('dtstart').toString(), '2025-01-02');
  assert.equal(result.skippedDays, 1);
});

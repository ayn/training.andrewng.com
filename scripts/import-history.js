import ICAL from 'ical.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function historyCalendar(db, { before, existing = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before ?? '')) throw new Error('An explicit exclusive cutoff date is required');
  const existingDates = new Set();
  if (existing) {
    for (const event of new ICAL.Component(ICAL.parse(existing)).getAllSubcomponents('vevent')) {
      // Only original calendar identities suppress PDF reconstruction on a date.
      if (event.getFirstPropertyValue('x-archive-origin') === 'pdf') continue;
      const start = event.getFirstPropertyValue('dtstart');
      if (start) existingDates.add(start.toString().slice(0, 10));
    }
  }
  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//Calendar Archive PDF History Import//EN');
  let count = 0; let skippedDays = 0;
  const rows = db.prepare('SELECT workout_date, planned_title, planned_items_json, description FROM finalsurge_days WHERE workout_date < ? ORDER BY workout_date').all(before);
  for (const row of rows) {
    if (existingDates.has(row.workout_date)) { skippedDays++; continue; }
    const items = JSON.parse(row.planned_items_json);
    const planned = items.length ? items : row.planned_title.trim() ? [{ title: row.planned_title }] : [];
    for (const [index, item] of planned.entries()) {
      if (!item.title?.trim()) continue;
      const event = new ICAL.Component(['vevent', [], []]);
      event.addPropertyWithValue('uid', `pdf-${row.workout_date}-${index}@calendar-archive.invalid`);
      const day = ICAL.Time.fromDateString(row.workout_date);
      event.addPropertyWithValue('dtstart', day);
      const end = day.clone(); end.adjust(1, 0, 0, 0);
      event.addPropertyWithValue('dtend', end);
      // Deterministic output: actual workout dates and source notes are preserved;
      // PDF exports do not contain original ICS UIDs, exact event times or revisions.
      event.addPropertyWithValue('dtstamp', ICAL.Time.fromString('2026-01-01T00:00:00Z'));
      event.addPropertyWithValue('summary', item.title);
      event.addPropertyWithValue('description', [row.description, item.distance_miles ? `Planned distance: ${item.distance_miles} miles` : '', 'Reconstructed from a Final Surge PDF export; original event time unavailable.'].filter(Boolean).join('\n\n'));
      event.addPropertyWithValue('x-archive-origin', 'pdf');
      calendar.addSubcomponent(event);
      count++;
    }
  }
  return { text: calendar.toString() + '\r\n', count, skippedDays };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, before: { type: 'string' },
    existing: { type: 'string' }, output: { type: 'string' },
  }});
  if (!values.database || !values.output) throw new Error('Required: --database PATH --before YYYY-MM-DD --output PATH [--existing archive.ics]');
  const db = new DatabaseSync(values.database, { readOnly: true });
  try {
    const result = historyCalendar(db, { before: values.before, existing: values.existing ? readFileSync(values.existing, 'utf8') : '' });
    writeFileSync(values.output, result.text, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ events: result.count, skipped_days: result.skippedDays }));
  } finally { db.close(); }
}

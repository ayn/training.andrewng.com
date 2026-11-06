import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('workerd refresh imports a source into D1 and rejects redirects without losing history', async () => {
  const admin = 'b'.repeat(43); const token = 'a'.repeat(43);
  let redirect = false; let outboundRequests = 0;
  const fixture = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:runtime-fixture\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Synthetic run\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../.wrangler/test-bundle/index.js', import.meta.url)),
    compatibilityDate: '2026-11-06',
    d1Databases: ['DB'],
    bindings: { SOURCE_URL: 'https://source.example.org/calendar.ics', FEED_TOKEN: token, ADMIN_TOKEN: admin },
    outboundService: async request => {
      outboundRequests++;
      assert.equal(request.url, 'https://source.example.org/calendar.ics');
      return redirect ? new Response(null, { status: 302, headers: { Location: 'https://other.example.org/private' } }) : new Response(fixture);
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const sql = readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
    const refresh = () => mf.dispatchFetch('https://archive.example.org/admin/refresh', {
      method: 'POST', headers: { Authorization: `Bearer ${admin}` },
    });
    const response = await refresh();
    assert.equal(response.status, 200, await response.text());
    assert.equal(outboundRequests, 1);
    let calendar = await mf.dispatchFetch(`https://archive.example.org/calendar/${token}.ics`);
    assert.match(await calendar.text(), /SUMMARY:Synthetic run/);
    redirect = true;
    assert.equal((await refresh()).status, 502);
    assert.equal(outboundRequests, 2, 'redirect must not be followed');
    const status = await mf.dispatchFetch(`https://archive.example.org/status/${token}`);
    assert.match((await status.json()).last_error, /UPSTREAM_HTTP_302/);
    calendar = await mf.dispatchFetch(`https://archive.example.org/calendar/${token}.ics`);
    assert.match(await calendar.text(), /SUMMARY:Synthetic run/);
  } finally { await mf.dispose(); }
});

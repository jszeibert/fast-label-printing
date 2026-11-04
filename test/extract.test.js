import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFields, matchesTrigger, hasTrigger, splitName, recomputeDerived, pageExtract } from '../src/lib/extract.js';
import { createDefaultLibrary, byId } from '../src/lib/model.js';

test('splitName matches v2 behaviour', () => {
  assert.deepEqual(splitName('short'), ['short', '']);
  assert.deepEqual(splitName('my-long-server-name'), ['my-long', '-server-name']);
  assert.deepEqual(splitName('abcdefghijklmnop'), ['abcdefghijk', 'lmnop']);
  assert.deepEqual(splitName(''), ['', '']);
});

test('triggers are bound to a website; regex alone never triggers', () => {
  const trigger = { urlPrefix: 'https://netbox.corp', urlContains: '', urlRegex: '/dcim/devices/\\d+/' };
  assert.ok(matchesTrigger(trigger, 'https://netbox.corp/dcim/devices/12/'));
  assert.ok(!matchesTrigger(trigger, 'https://netbox.corp/dcim/sites/12/'));
  assert.ok(!matchesTrigger(trigger, 'https://evil.example/dcim/devices/12/'));
  assert.ok(!matchesTrigger({ urlRegex: '.*' }, 'https://anything'));
  assert.ok(!hasTrigger({ urlPrefix: '  ', urlRegex: '.*' }));
  assert.ok(!matchesTrigger({ urlPrefix: 'https://x', urlRegex: '(' }, 'https://x/'));
});

test('default I-Doit job extracts like v2', async () => {
  const job = byId(createDefaultLibrary().jobs, 'job-idoit-inventory');
  const page = {
    url: 'https://idoit.example.com/?objID=4711&viewMode=1',
    title: 'i-doit > Development Server > backup-storage-01'
  };
  assert.ok(matchesTrigger(job.trigger, page.url));
  const { values, errors } = await extractFields(job.extract, page);
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    url: 'https://idoit.example.com',
    id: '4711',
    qr: 'https://idoit.example.com/?objID=4711',
    type: 'Dev Server',
    name: 'backup-storage-01',
    line1: 'backup',
    line2: '-storage-01'
  });
});

test('broken rules report errors without stopping other fields', async () => {
  const { values, errors } = await extractFields({
    a: { from: 'nope' },
    b: { from: 'urlRegex', pattern: '/devices/(\\d+)/' },
    c: { from: 'field', field: 'b', post: [{ op: 'replace', search: '1', replace: 'X' }, { op: 'upper' }] }
  }, { url: 'https://n/dcim/devices/12/', title: '' });
  assert.equal(errors.length, 1);
  assert.deepEqual(values, { a: '', b: '12', c: 'X2' });
});

test('Netbox job: url/title in extension, role via page API', async () => {
  const job = byId(createDefaultLibrary().jobs, 'job-netbox-inventory');
  const page = { url: 'https://netbox.example.com/dcim/devices/123/?tab=main', title: 'srv-backup-01 | NetBox' };
  assert.ok(matchesTrigger(job.trigger, page.url));
  assert.ok(!matchesTrigger(job.trigger, 'https://netbox.example.com/dcim/sites/1/'));

  const calls = [];
  const resolvePage = async rule => { calls.push(rule); return 'Development Server'; };
  const { values, errors } = await extractFields(job.extract, page, resolvePage);
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    id: '123',
    qr: 'https://netbox.example.com/dcim/devices/123/',
    name: 'srv-backup-01',
    type: 'Dev Server',
    line1: 'srv-backup',
    line2: '-01'
  });
  assert.equal(calls[0].url, '/api/dcim/devices/123/'); // {{id}} interpolated
  assert.equal(calls[0].path, 'role.name');
});

test('page sources without resolver report an error', async () => {
  const { values, errors } = await extractFields({ x: { from: 'css', selector: 'h1' } }, { url: '', title: '' });
  assert.equal(values.x, '');
  assert.match(errors[0], /nur im Popup/);
});

test('recomputeDerived updates template/field values but keeps edited ones', () => {
  const rules = byId(createDefaultLibrary().jobs, 'job-manual-inventory').extract;
  const values = { url: 'https://idoit.example.com', qr: 'https://idoit.example.com/?objID=', id: '99' };
  assert.equal(recomputeDerived(rules, values).qr, 'https://idoit.example.com/?objID=99');
  assert.equal(recomputeDerived(rules, { ...values, qr: 'custom' }, new Set(['qr'])).qr, 'custom');
});

test('pageExtract: api path + cache, css, errors', async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.location = { href: 'https://netbox.example.com/dcim/devices/5/' };
  globalThis.fetch = async url => {
    fetches++;
    assert.equal(url, 'https://netbox.example.com/api/dcim/devices/5/');
    return { ok: true, json: async () => ({ name: 'x', role: { name: 'Server' }, tags: [1] }) };
  };
  globalThis.document = { querySelector: sel => (sel === 'h1' ? { textContent: ' Hi ', getAttribute: () => 'attr' } : null) };
  try {
    assert.deepEqual(await pageExtract({ from: 'api', url: '/api/dcim/devices/5/', path: 'role.name' }), { value: 'Server' });
    assert.deepEqual(await pageExtract({ from: 'api', url: '/api/dcim/devices/5/', path: 'tags' }), { value: '[1]' });
    assert.equal(fetches, 1);
    assert.deepEqual(await pageExtract({ from: 'css', selector: 'h1' }), { value: 'Hi' });
    assert.deepEqual(await pageExtract({ from: 'css', selector: 'h1', attr: 'title' }), { value: 'attr' });
    assert.deepEqual(await pageExtract({ from: 'css', selector: 'h2' }), { value: '' });

    globalThis.fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden' });
    assert.deepEqual(await pageExtract({ from: 'api', url: '/api/other/', path: 'x' }), { error: 'API 403 Forbidden' });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.location; delete globalThis.document; delete globalThis.__fastLabelApiCache;
  }
});

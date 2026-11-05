import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printerOriginPattern, loadLibrary, LIBRARY_KEY } from '../src/lib/store.js';
import { SCHEMA_VERSION } from '../src/lib/model.js';

// Minimal stand-in for browser.storage.local (get with a key list, set merges).
function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    }
  };
}

test('printerOriginPattern covers the printer host (any port/path)', () => {
  assert.equal(printerOriginPattern('http://10.0.0.5/pstprnt'), 'http://10.0.0.5/*');
  assert.equal(printerOriginPattern('http://zebra.local:8080/pstprnt'), 'http://zebra.local/*');
  assert.throws(() => printerOriginPattern('kein url'));
});

test('first start creates and saves the default library', async () => {
  const storage = createStorage();
  const library = await loadLibrary(storage);
  assert.equal(library.schemaVersion, SCHEMA_VERSION);
  assert.ok(library.jobs.length > 0);
  assert.deepEqual(storage.data[LIBRARY_KEY], library);
});

test('first start after v2 migrates old settings and keeps the v2 keys', async () => {
  const storage = createStorage({ 'printer-url': 'http://10.0.0.9/pstprnt', 'idoit-base-url': 'https://cmdb.local/' });
  const library = await loadLibrary(storage);
  assert.equal(library.printers[0].url, 'http://10.0.0.9/pstprnt');
  assert.equal(library.jobs.find(job => job.id === 'job-idoit-inventory').trigger.urlPrefix, 'https://cmdb.local');
  assert.deepEqual(storage.data[LIBRARY_KEY], library);
  assert.equal(storage.data['printer-url'], 'http://10.0.0.9/pstprnt'); // downgrade still works
});

test('a stored library wins over v2 keys and is not rewritten', async () => {
  const stored = { schemaVersion: SCHEMA_VERSION, printers: [{ id: 'p', name: 'Mein Drucker' }] };
  const storage = createStorage({ [LIBRARY_KEY]: stored, 'printer-url': 'http://old/pstprnt' });
  const library = await loadLibrary(storage);
  assert.equal(library.printers[0].name, 'Mein Drucker');
  assert.deepEqual(library.jobs, []);
  assert.deepEqual(storage.data[LIBRARY_KEY], stored);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFields, matchesTrigger, hasTrigger, splitName } from '../src/lib/extract.js';
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

test('default I-Doit job extracts like v2', () => {
  const job = byId(createDefaultLibrary().jobs, 'job-idoit-inventory');
  const page = {
    url: 'https://idoit.example.com/?objID=4711&viewMode=1',
    title: 'i-doit > Development Server > backup-storage-01'
  };
  assert.ok(matchesTrigger(job.trigger, page.url));
  const { values, errors } = extractFields(job.extract, page);
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    url: 'https://idoit.example.com',
    id: '4711',
    type: 'Dev Server',
    name: 'backup-storage-01',
    line1: 'backup',
    line2: '-storage-01'
  });
});

test('broken rules report errors without stopping other fields', () => {
  const { values, errors } = extractFields({
    a: { from: 'nope' },
    b: { from: 'urlRegex', pattern: '/devices/(\\d+)/' },
    c: { from: 'field', field: 'b', post: [{ op: 'replace', search: '1', replace: 'X' }, { op: 'upper' }] }
  }, { url: 'https://n/dcim/devices/12/', title: '' });
  assert.equal(errors.length, 1);
  assert.deepEqual(values, { a: '', b: '12', c: 'X2' });
});

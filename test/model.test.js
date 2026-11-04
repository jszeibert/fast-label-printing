import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLibrary, migrateFromV2, normalizeLibrary, findReferences, byId,
  LEGACY_DEFAULT_TEMPLATE, INVENTORY_ZPL, parseReplaceList, convertLegacyPlaceholders
} from '../src/lib/model.js';

function assertConsistent(lib) {
  for (const layout of lib.layouts) assert.ok(byId(lib.formats, layout.formatId), `format of ${layout.id}`);
  for (const job of lib.jobs) {
    assert.ok(byId(lib.layouts, job.layoutId), `layout of ${job.id}`);
    assert.ok(byId(lib.printers, job.printerId), `printer of ${job.id}`);
  }
}

test('default library is consistent and contains the Dymo formats', () => {
  const lib = createDefaultLibrary();
  assertConsistent(lib);
  assert.equal(lib.printers.length, 2);
  assert.deepEqual(lib.formats.map(f => f.id), ['fmt-inventory', 'fmt-dymo-s0722540', 'fmt-dymo-14681']);
  assert.equal(byId(lib.formats, 'fmt-dymo-14681').shape, 'round');
  assert.ok(byId(lib.jobs, lib.settings.defaultJobId));
});

test('default jobs: I-Doit, Netbox and manual inventory share the QR layout; text label on Dymo', () => {
  const lib = createDefaultLibrary();
  for (const id of ['job-idoit-inventory', 'job-netbox-inventory', 'job-manual-inventory']) {
    assert.equal(byId(lib.jobs, id).layoutId, 'layout-inventory');
  }
  const text = byId(lib.jobs, 'job-manual-text-32x57');
  assert.equal(byId(lib.layouts, text.layoutId).formatId, 'fmt-dymo-s0722540');
  assert.equal(byId(lib.printers, text.printerId).printMethod, 'direct');
  assert.match(byId(lib.layouts, 'layout-inventory').zpl, /\{\{qr\}\}/);
});

test('migrates v2 settings with unchanged default template', () => {
  const lib = migrateFromV2({
    'idoit-base-url': 'https://idoit.corp/',
    'zpl-template': LEGACY_DEFAULT_TEMPLATE.replace(/\n/g, '\r\n'),
    'preview-api-url': 'http://api.labelary.com/v1/printers/8dpmm/labels/0.94x0.55/0/',
    'replace-list': 'Development=Dev,Temperature=Temp.',
    'printer-url': 'http://zebra/pstprnt'
  });
  assertConsistent(lib);
  assert.equal(lib.printers[0].url, 'http://zebra/pstprnt');
  assert.equal(lib.printers[0].dpmm, 8);
  assert.equal(lib.layouts[0].zpl, INVENTORY_ZPL);
  assert.equal(lib.layouts[0].dpmm, 8);
  assert.equal(byId(lib.formats, 'fmt-inventory').widthMm, 25);
  const job = byId(lib.jobs, 'job-idoit-inventory');
  assert.equal(job.trigger.urlPrefix, 'https://idoit.corp');
  assert.equal(job.extract.url.value, 'https://idoit.corp');
  assert.equal(job.extract.type.post.length, 2);
});

test('migration keeps a custom template and converts placeholders', () => {
  const lib = migrateFromV2({ 'zpl-template': '^XA^FO1,1^FD{ID} {line1}^FS^XZ', 'printer-url': 'x' });
  assert.equal(lib.layouts[0].zpl, '^XA^FO1,1^FD{{id}} {{line1}}^FS^XZ');
});

test('parseReplaceList / convertLegacyPlaceholders', () => {
  assert.deepEqual(parseReplaceList('a=b, broken ,c = d'), [
    { op: 'replace', search: 'a', replace: 'b', regex: true },
    { op: 'replace', search: 'c', replace: 'd', regex: true }
  ]);
  assert.equal(convertLegacyPlaceholders('{URL}/{TYPE}{OTHER}'), '{{url}}/{{type}}{OTHER}');
});

test('normalizeLibrary fills collections and rejects newer schemas', () => {
  assert.deepEqual(normalizeLibrary({ schemaVersion: 3, printers: [] }).jobs, []);
  assert.throws(() => normalizeLibrary({ schemaVersion: 99 }));
  assert.throws(() => normalizeLibrary(null));
});

test('findReferences reports users of an entity', () => {
  const lib = createDefaultLibrary();
  assert.deepEqual(findReferences(lib, 'formats', 'fmt-inventory'), ['Inventarlabel (QR)']);
  assert.equal(findReferences(lib, 'layouts', 'layout-inventory').length, 3);
  assert.deepEqual(findReferences(lib, 'formats', 'fmt-dymo-14681'), []);
});

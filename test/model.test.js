import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLibrary, migrateFromV2, normalizeLibrary, findReferences, byId,
  LEGACY_DEFAULT_TEMPLATE, INVENTORY_ZPL, TEXT_LABEL_ZPL, parseReplaceList, convertLegacyPlaceholders,
  formatFieldList, parseFieldList, printerForFormat
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
  assert.deepEqual(lib.formats.map(f => f.id), ['fmt-inventory', 'fmt-text-75x50', 'fmt-dymo-s0722540', 'fmt-dymo-14681']);
  assert.equal(byId(lib.formats, 'fmt-dymo-14681').shape, 'round');
  assert.ok(byId(lib.jobs, lib.settings.defaultJobId));
});

test('default jobs: I-Doit, Netbox and manual inventory share the QR layout; text label 75x50 on the second printer', () => {
  const lib = createDefaultLibrary();
  for (const id of ['job-idoit-inventory', 'job-netbox-inventory', 'job-manual-inventory']) {
    assert.equal(byId(lib.jobs, id).layoutId, 'layout-inventory');
  }
  const text = byId(lib.jobs, 'job-manual-text-75x50');
  assert.equal(byId(lib.layouts, text.layoutId).formatId, 'fmt-text-75x50');
  assert.equal(text.printerId, lib.printers[1].id);
  assert.notEqual(text.printerId, byId(lib.jobs, 'job-manual-inventory').printerId);
  assert.match(byId(lib.layouts, 'layout-inventory').zpl, /\{\{qr\}\}/);
});

test('inventory label: one multi-line name field the printer never wraps by itself', () => {
  const layout = byId(createDefaultLibrary().layouts, 'layout-inventory');
  assert.deepEqual(layout.fields, [
    { key: 'id', label: 'ID' },
    { key: 'type', label: 'Type' },
    { key: 'name', label: 'Name', multiline: true }
  ]);
  assert.match(layout.zpl, /\^FB1000,3,8,L\^FD\{\{name\}\}/); // block far wider than the label
  assert.doesNotMatch(layout.zpl, /line1|line2/);
});

test('text label 75x50: single-line headline, auto-wrapping multi-line second line', () => {
  const lib = createDefaultLibrary();
  const layout = byId(lib.layouts, 'layout-text-75x50');
  const format = byId(lib.formats, 'fmt-text-75x50');
  assert.deepEqual(layout.fields, [
    { key: 'line1', label: 'Headline' },
    { key: 'line2', label: 'Line 2', multiline: true }
  ]);
  assert.equal(format.offsetXMm, 0);
  assert.equal(format.offsetYMm, 5);
  assert.equal(layout.zpl, TEXT_LABEL_ZPL);
  assert.doesNotMatch(layout.zpl, /line3/);
  assert.match(layout.zpl, /\^FB840,1,0,C\^FD\{\{line1\}\}/);
  assert.match(layout.zpl, /\^FB840,3,10,C\^FD\{\{line2\}\}/);
});

test('field list text round-trips, "| multiline" marks multi-line fields', () => {
  const fields = [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name = Device', multiline: true }];
  assert.equal(formatFieldList(fields), 'id = ID\nname = Name = Device | multiline');
  assert.deepEqual(parseFieldList(formatFieldList(fields)), fields);
  assert.deepEqual(parseFieldList('  text  \n\nnote = Note |Multiline '), [
    { key: 'text', label: 'text' },
    { key: 'note', label: 'Note', multiline: true }
  ]);
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
  // the custom template still uses line1/line2, so those fields and rules stay
  assert.deepEqual(lib.layouts[0].fields.map(field => field.key), ['id', 'type', 'line1', 'line2']);
  assert.ok(byId(lib.jobs, 'job-idoit-inventory').extract.line2);
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
  assert.deepEqual(findReferences(lib, 'formats', 'fmt-inventory'), ['Inventory label (QR)']);
  assert.equal(findReferences(lib, 'layouts', 'layout-inventory').length, 3);
  assert.deepEqual(findReferences(lib, 'formats', 'fmt-dymo-14681'), []);
});

test('test frame printer: default printer of a job using the label type, else first printer with URL', () => {
  const lib = createDefaultLibrary();
  assert.equal(printerForFormat(lib, 'fmt-text-75x50').id, lib.printers[1].id); // text label printer
  assert.equal(printerForFormat(lib, 'fmt-inventory').id, lib.printers[0].id);
  assert.equal(printerForFormat(lib, 'fmt-dymo-14681').id, lib.printers[0].id); // unused label type

  lib.printers[1].url = ''; // a printer without URL cannot print
  assert.equal(printerForFormat(lib, 'fmt-text-75x50').id, lib.printers[0].id);
  lib.printers[0].url = '';
  assert.equal(printerForFormat(lib, 'fmt-text-75x50'), null);
});

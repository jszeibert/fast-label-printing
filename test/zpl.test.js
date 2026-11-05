import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLabel, buildHeader, fillPlaceholders, checkCompatibility } from '../src/lib/zpl.js';

const printer = { name: 'P', dpmm: 12, printMethod: 'direct', darkness: null, speed: null };
const format = { name: 'F', widthMm: 23.9, lengthMm: 14, media: 'any', sensing: '', offsetXMm: 0, offsetYMm: 0 };
const layout = { dpmm: 12, zpl: '^XA\n^FO1,1^FD{{id}}^FS\n^XZ' };

test('header is derived from format and printer', () => {
  assert.equal(buildHeader(printer, format), '^PW287^LL168');
  assert.equal(
    buildHeader({ ...printer, dpmm: 8, speed: 3 }, { ...format, sensing: 'gap', offsetXMm: 1, offsetYMm: 0 }),
    '^PW191^LL112^LH8,0^MNY^PR3'
  );
});

test('compileLabel inserts header, values, copies and darkness', () => {
  const zpl = compileLabel({ layout, format, printer: { ...printer, darkness: 5 }, values: { id: '42' }, copies: 3 });
  assert.equal(zpl, '~SD05\n^XA\n^PW287^LL168\n^FO1,1^FD42^FS\n^PQ3\n^XZ');
});

test('compileLabel wraps bodies without ^XA', () => {
  const zpl = compileLabel({ layout: { zpl: '^FDx^FS' }, format, printer });
  assert.equal(zpl, '^XA\n^PW287^LL168\n^FDx^FS\n^XZ');
});

test('placeholders are filled and ZPL control chars stripped', () => {
  assert.equal(fillPlaceholders('{{a}}|{{ b }}|{{missing}}', { a: 'x^y~z', b: 1 }), 'x y z|1|');
});

test('line breaks of multi-line fields become ^FB line breaks (\\&)', () => {
  assert.equal(fillPlaceholders('^FD{{name}}^FS', { name: 'srv-\nbackup-01\r\nRack 3' }), '^FDsrv-\\&backup-01\\&Rack 3^FS');
});

test('compatibility warnings', () => {
  assert.deepEqual(checkCompatibility({ layout, format, printer }), []);
  const warnings = checkCompatibility({
    layout: { dpmm: 8 },
    format: { ...format, media: 'direct' },
    printer: { ...printer, printMethod: 'transfer' }
  });
  assert.equal(warnings.length, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printerOriginPattern } from '../src/lib/store.js';

test('printerOriginPattern covers the printer host (any port/path)', () => {
  assert.equal(printerOriginPattern('http://10.0.0.5/pstprnt'), 'http://10.0.0.5/*');
  assert.equal(printerOriginPattern('http://zebra.local:8080/pstprnt'), 'http://zebra.local/*');
  assert.throws(() => printerOriginPattern('kein url'));
});

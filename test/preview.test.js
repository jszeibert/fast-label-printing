import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviewUrl } from '../src/lib/preview.js';
import { previewUrlToTemplate, migrateFromV2, normalizeLibrary, DEFAULT_PREVIEW_URL } from '../src/lib/model.js';

const format = { widthMm: 23.9, lengthMm: 14 };

test('preview URL is filled from printer resolution and label size', () => {
  assert.equal(
    buildPreviewUrl(DEFAULT_PREVIEW_URL, { printer: { dpmm: 8 }, format, zpl: '^XA^XZ' }),
    'https://api.labelary.com/v1/printers/8dpmm/labels/0.94x0.55/0/%5EXA%5EXZ'
  );
  assert.equal(buildPreviewUrl('', { printer: { dpmm: 8 }, format, zpl: '' }), '');
});

test('v2 preview URL becomes a template, keeping a custom host', () => {
  assert.equal(
    previewUrlToTemplate('https://labelary.corp/v1/printers/12dpmm/labels/0.94x0.55/0/'),
    'https://labelary.corp/v1/printers/{dpmm}dpmm/labels/{widthIn}x{lengthIn}/0/'
  );
  assert.equal(previewUrlToTemplate(''), DEFAULT_PREVIEW_URL);
  assert.equal(
    migrateFromV2({ 'preview-api-url': 'http://api.labelary.com/v1/printers/12dpmm/labels/0.94x0.55/0/' }).settings.previewApiUrl,
    DEFAULT_PREVIEW_URL
  );
});

test('libraries without settings get the default preview URL', () => {
  assert.equal(normalizeLibrary({ schemaVersion: 3 }).settings.previewApiUrl, DEFAULT_PREVIEW_URL);
  assert.equal(normalizeLibrary({ schemaVersion: 3, settings: { previewApiUrl: '' } }).settings.previewApiUrl, '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, textWidth } from '../src/lib/wrap.js';

const INVENTORY = { maxWidth: 150, fontSize: 27, maxLines: 2 };
const widths = text => text.split('\n').map(line => textWidth(line, 27));

test('width depends on the characters, not only their count', () => {
  assert.ok(textWidth('WWWWW') > 2.5 * textWidth('iiiii'));
  assert.equal(textWidth('ABC', 54), 2 * textWidth('ABC', 27));
  assert.equal(textWidth('ABC', 27, 54), 2 * textWidth('ABC', 27, 27));
  assert.equal(textWidth(''), 0);
});

test('short names stay on one line', () => {
  assert.equal(wrapText('srv-01', INVENTORY), 'srv-01');
  assert.equal(wrapText('iiiiiiiiiiiiiiiiiiii', INVENTORY), 'iiiiiiiiiiiiiiiiiiii'); // 20 narrow chars fit
});

test('breaks after - _ . / or at spaces, balanced, every line fits', () => {
  for (const [name, expected] of [
    ['srv-backup-01', 'srv-\nbackup-01'],
    ['backup-storage-01', 'backup-\nstorage-01'],
    ['esx01.fast-lta.local', 'esx01.fast-\nlta.local'],
    ['Café cooling unit 2', 'Café cooling\nunit 2']
  ]) {
    const wrapped = wrapText(name, INVENTORY);
    assert.equal(wrapped, expected);
    assert.ok(widths(wrapped).every(width => width <= 150), name);
  }
});

test('wide characters wrap earlier than the old 11-character rule', () => {
  const wrapped = wrapText('MEINBERGNTPSERVER', INVENTORY);
  assert.ok(wrapped.split('\n')[0].length < 11);
  assert.ok(widths(wrapped).every(width => width <= 150));
});

test('text too long for maxLines: first lines are filled, the rest overflows the last line', () => {
  assert.equal(wrapText('Switch Core 1 Rack A12 oben', INVENTORY), 'Switch Core 1\nRack A12 oben');
  const long = 'W'.repeat(30);
  const wrapped = wrapText(long, INVENTORY);
  assert.equal(wrapped.split('\n').length, 2);
  assert.equal(wrapped.replace('\n', ''), long); // nothing dropped
});

test('existing line breaks are kept', () => {
  assert.equal(wrapText('Line 1\nLine 2', INVENTORY), 'Line 1\nLine 2');
  assert.equal(wrapText('a\nb\nc', INVENTORY), 'a\nb c');
  assert.equal(wrapText('', INVENTORY), '');
});

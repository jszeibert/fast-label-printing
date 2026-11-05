import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableJobs, pickInitialJob, initialValues, toggledDefaultJobId } from '../src/lib/job-selection.js';
import { createDefaultLibrary } from '../src/lib/model.js';

const ids = jobs => jobs.map(job => job.id);
const { jobs } = createDefaultLibrary();
const IDOIT_PAGE = 'https://idoit.example.com/?objID=42';

test('popup offers matching jobs of this site plus all manual jobs, never jobs of other sites', () => {
  const onIdoit = availableJobs(jobs, IDOIT_PAGE);
  assert.deepEqual(ids(onIdoit.matched), ['job-idoit-inventory']);
  assert.deepEqual(ids(onIdoit.manual), ['job-manual-inventory', 'job-manual-text-75x50']);

  const elsewhere = availableJobs(jobs, 'https://example.org/');
  assert.deepEqual(elsewhere.matched, []);
  assert.deepEqual(ids(elsewhere.manual), ['job-manual-inventory', 'job-manual-text-75x50']);
});

test('preselection: matching job, then default manual job, then first manual job', () => {
  const pick = (url, defaultId) => pickInitialJob(availableJobs(jobs, url), defaultId)?.id;

  assert.equal(pick(IDOIT_PAGE, 'job-manual-text-75x50'), 'job-idoit-inventory');
  assert.equal(pick('https://example.org/', 'job-manual-text-75x50'), 'job-manual-text-75x50');
  assert.equal(pick('https://example.org/', ''), 'job-manual-inventory');
  // a job bound to a site (or a deleted one) is ignored as default
  assert.equal(pick('https://example.org/', 'job-idoit-inventory'), 'job-manual-inventory');
  assert.equal(pick('https://example.org/', 'job-gone'), 'job-manual-inventory');
  assert.equal(pickInitialJob({ matched: [], manual: [] }, ''), null);
});

test('saved texts override extracted values only for manual jobs', () => {
  const manual = jobs.find(job => job.id === 'job-manual-inventory');
  const idoit = jobs.find(job => job.id === 'job-idoit-inventory');
  const extracted = { url: 'https://idoit.example.com', qr: 'https://idoit.example.com/?objID=' };
  const saved = { id: '7', qr: 'https://idoit.example.com/?objID=7' };

  assert.deepEqual(initialValues(manual, extracted, saved), { url: 'https://idoit.example.com', id: '7', qr: 'https://idoit.example.com/?objID=7' });
  assert.deepEqual(initialValues(idoit, { id: '42' }, { id: '7' }), { id: '42' });
});

test('default star toggles manual jobs and ignores jobs bound to a site', () => {
  const manual = jobs.find(job => job.id === 'job-manual-text-75x50');
  const idoit = jobs.find(job => job.id === 'job-idoit-inventory');

  assert.equal(toggledDefaultJobId('job-manual-inventory', manual), 'job-manual-text-75x50');
  assert.equal(toggledDefaultJobId('job-manual-text-75x50', manual), '');
  assert.equal(toggledDefaultJobId('job-manual-inventory', idoit), 'job-manual-inventory');
});

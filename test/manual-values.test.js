import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualLabelValues, MANUAL_VALUES_KEY } from '../src/lib/manual-values.js';

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, values);
    }
  };
}

test('manual label values persist separately by job and can be cleared', async () => {
  const storage = createStorage();
  const values = new ManualLabelValues(storage);
  await values.load();

  await values.save('text-label', { line1: 'Server', line2: 'Rack 1' });
  await values.save('inventory-label', { id: '123' });

  const reopened = new ManualLabelValues(storage);
  await reopened.load();
  assert.deepEqual(reopened.get('text-label'), { line1: 'Server', line2: 'Rack 1' });
  assert.deepEqual(reopened.get('inventory-label'), { id: '123' });

  await reopened.clear('text-label');
  const cleared = new ManualLabelValues(storage);
  await cleared.load();
  assert.deepEqual(cleared.get('text-label'), {});
  assert.deepEqual(cleared.get('inventory-label'), { id: '123' });
  assert.deepEqual(Object.keys(storage.data), [MANUAL_VALUES_KEY]);
});

test('manual value writes remain ordered when edited and cleared quickly', async () => {
  let releaseFirstWrite;
  let markFirstWriteStarted;
  const firstWriteStarted = new Promise(resolve => { markFirstWriteStarted = resolve; });
  const data = {};
  let writeCount = 0;
  const storage = {
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      writeCount += 1;
      if (writeCount === 1) {
        markFirstWriteStarted();
        await new Promise(resolve => { releaseFirstWrite = resolve; });
      }
      Object.assign(data, values);
    }
  };
  const values = new ManualLabelValues(storage);
  await values.load();
  const save = values.save('text-label', { line1: 'Text' });
  const clear = values.clear('text-label');
  await firstWriteStarted;
  releaseFirstWrite();
  await Promise.all([save, clear]);
  assert.deepEqual(data[MANUAL_VALUES_KEY], {});
});

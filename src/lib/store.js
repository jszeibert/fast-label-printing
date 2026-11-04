import { browserAPI } from './browser.js';
import { createDefaultLibrary, migrateFromV2, normalizeLibrary, LEGACY_KEYS } from './model.js';

const LIBRARY_KEY = 'library';

// Loads the library; on first run migrates v2 settings or creates defaults.
// The old v2 keys are left untouched so a downgrade still works.
export async function loadLibrary() {
  const stored = await browserAPI.storage.local.get([LIBRARY_KEY, ...LEGACY_KEYS]);
  if (stored[LIBRARY_KEY]) return normalizeLibrary(stored[LIBRARY_KEY]);

  const hasLegacy = LEGACY_KEYS.some(key => stored[key]);
  const library = hasLegacy ? migrateFromV2(stored) : createDefaultLibrary();
  await saveLibrary(library);
  return library;
}

export async function saveLibrary(library) {
  await browserAPI.storage.local.set({ [LIBRARY_KEY]: library });
}

export async function sendToPrinter(printerUrl, zpl) {
  const response = await fetch(printerUrl, {
    method: 'POST',
    body: zpl,
    headers: { 'Content-Type': 'application/x-zpl' }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

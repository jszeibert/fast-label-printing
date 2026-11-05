import { browserAPI } from './browser.js';
import { createDefaultLibrary, migrateFromV2, normalizeLibrary, LEGACY_KEYS } from './model.js';

export const LIBRARY_KEY = 'library';

// Loads the library; on first run migrates v2 settings or creates defaults.
// The old v2 keys are left untouched so a downgrade still works.
export async function loadLibrary(storage = browserAPI.storage.local) {
  const stored = await storage.get([LIBRARY_KEY, ...LEGACY_KEYS]);
  if (stored[LIBRARY_KEY]) return normalizeLibrary(stored[LIBRARY_KEY]);

  const hasLegacy = LEGACY_KEYS.some(key => stored[key]);
  const library = hasLegacy ? migrateFromV2(stored) : createDefaultLibrary();
  await saveLibrary(library, storage);
  return library;
}

export async function saveLibrary(library, storage = browserAPI.storage.local) {
  await storage.set({ [LIBRARY_KEY]: library });
}

// Match pattern for the printer host, e.g. http://10.0.0.5/pstprnt -> http://10.0.0.5/*
export function printerOriginPattern(printerUrl) {
  const url = new URL(printerUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

// Firefox treats MV3 host_permissions as optional, so access to the printer may not be
// granted. Without it the browser sends a CORS preflight (OPTIONS), which Zebra printers
// don't answer -> "NetworkError". permissions.request() needs a user gesture, so this must
// run before any other await in the click handler.
function ensurePrinterPermission(printerUrl) {
  const permissions = browserAPI.permissions;
  if (!permissions?.request) return Promise.resolve(true);
  return permissions.request({ origins: [printerOriginPattern(printerUrl)] });
}

export async function sendToPrinter(printerUrl, zpl) {
  const granted = await ensurePrinterPermission(printerUrl);
  if (!granted) {
    throw new Error(`Access to ${new URL(printerUrl).host} was not allowed.`);
  }
  let response;
  try {
    response = await fetch(printerUrl, {
      method: 'POST',
      body: zpl,
      headers: { 'Content-Type': 'application/x-zpl' }
    });
  } catch (error) {
    throw new Error(`Printer not reachable (${error.message}). Check address and network; in Firefox allow website access under about:addons → Permissions.`);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

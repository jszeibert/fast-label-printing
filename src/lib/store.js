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
    throw new Error(`Zugriff auf ${new URL(printerUrl).host} wurde nicht erlaubt.`);
  }
  let response;
  try {
    response = await fetch(printerUrl, {
      method: 'POST',
      body: zpl,
      headers: { 'Content-Type': 'application/x-zpl' }
    });
  } catch (error) {
    throw new Error(`Drucker nicht erreichbar (${error.message}). Adresse und Netzwerk prüfen; in Firefox unter about:addons → Berechtigungen den Zugriff auf Websites erlauben.`);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

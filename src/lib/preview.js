// Label preview via a Labelary-compatible HTTP API (GET, ZPL appended to the URL, returns PNG).
// Note: the ZPL (label content) is sent to that service.
// TODO (later): local preview without external service.

const toInches = mm => (Math.round((Number(mm) / 25.4) * 100) / 100).toString();

export function buildPreviewUrl(template, { printer, format, zpl }) {
  if (!template) return '';
  const base = template
    .replace(/\{dpmm\}/g, String(Number(printer.dpmm) || 12))
    .replace(/\{widthIn\}/g, toInches(format.widthMm))
    .replace(/\{lengthIn\}/g, toInches(format.lengthMm));
  return `${base}${encodeURIComponent(zpl)}`;
}

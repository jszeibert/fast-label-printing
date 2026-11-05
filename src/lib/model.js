// Data model (schema v3) for printers, label formats, layouts and print jobs.
// Pure functions only – no browser APIs – so everything here is unit-testable.
//
// Library shape:
// {
//   schemaVersion: 3,
//   settings: { previewApiUrl, defaultJobId },
//   printers: [{ id, name, url, dpmm, printMethod, darkness, speed }],
//   formats:  [{ id, name, articleNo, widthMm, lengthMm, shape, media, sensing, offsetXMm, offsetYMm }],
//   layouts:  [{ id, name, formatId, dpmm, type: 'zpl', fields: [{ key, label, multiline? }], zpl }],
//   jobs:     [{ id, name, trigger: { urlPrefix, urlContains, urlRegex }, extract: {...},
//                layoutId, printerId }]
// }

export const SCHEMA_VERSION = 3;

// Storage keys used by v2 (single flat settings).
export const LEGACY_KEYS = ['idoit-base-url', 'zpl-template', 'preview-api-url', 'replace-list', 'printer-url'];

// The default template shipped with v2 – used to detect "unchanged" templates during migration.
export const LEGACY_DEFAULT_TEMPLATE = `^XA
^PW280          ; Set print width (1.00 in)
^LL164          ; Set label length (0.50 in)
^CF0,27
^FO0,10^BQN,2,4^FDQA,{URL}/?objID={ID}^FS
^FO145,25^FD{LINE1}^FS
^FO145,60^FD{LINE2}^FS
^FO145,100^A0N,20,20^FD{TYPE}^FS
^FO145,130^A0N,27,27^FD{ID}^FS
^XZ`;

// Same layout as the v2 default; ^PW/^LL now come from the label format.
// The name is one multi-line field: ^FB keeps the user's line breaks (\&) but is far wider
// than the label, so the printer never wraps on its own – text may deliberately run over.
export const INVENTORY_ZPL = `^XA
^CI28
^CF0,27
^FO0,10^BQN,2,4^FDQA,{{qr}}^FS
^FO145,25^A0N,27,27^FB1000,3,8,L^FD{{name}}^FS
^FO145,100^A0N,20,20^FD{{type}}^FS
^FO145,130^A0N,27,27^FD{{id}}^FS
^XZ`;

// v2 layout with two fixed lines – only kept for migrated custom v2 templates.
const LEGACY_INVENTORY_FIELDS = [
  { key: 'id', label: 'ID' },
  { key: 'type', label: 'Type' },
  { key: 'line1', label: 'Line 1' },
  { key: 'line2', label: 'Line 2' }
];

// Automatic line breaks for the name when it is read from I-Doit / Netbox:
// text area from x=145 to the label edge (25 mm = 300 dots at 12 dpmm), font 0 at 27 dots.
const NAME_WRAP = { op: 'wrap', maxWidth: 150, fontSize: 27, maxLines: 2 };

// Labelary-compatible preview endpoint. {dpmm}, {widthIn}, {lengthIn} are filled per label;
// the URL-encoded ZPL is appended.
export const DEFAULT_PREVIEW_URL = 'https://api.labelary.com/v1/printers/{dpmm}dpmm/labels/{widthIn}x{lengthIn}/0/';

// Text label for box labels, 75×50 mm (75 mm across the head, 50 mm feed direction;
// 12 dpmm = 900×600 dots), no QR code.
// ^CI28 = UTF-8 (umlauts), ^FB = field block: centred inside the label.
// Headline: one line. Line 2: the printer wraps automatically (up to 3 lines); line breaks
// typed by the user (\&) are kept.
export const TEXT_LABEL_ZPL = `^XA
^CI28
^FO30,150^A0N,90,90^FB840,1,0,C^FD{{line1}}^FS
^FO30,300^A0N,60,60^FB840,3,10,C^FD{{line2}}^FS
^XZ`;

export const PRINT_METHODS = ['direct', 'transfer'];
export const SENSING_MODES = ['', 'gap', 'mark', 'continuous']; // '' = keep printer setting
export const SHAPES = ['rect', 'round'];
export const MEDIA = ['any', 'direct']; // 'direct' = thermal paper, needs a direct-thermal printer

export function newId(prefix = 'id') {
  const rnd = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${rnd.slice(0, 8)}`;
}

const TEXT_FIELDS = [
  { key: 'line1', label: 'Headline' },
  { key: 'line2', label: 'Line 2', multiline: true }
];

const INVENTORY_FIELDS = [
  { key: 'id', label: 'ID' },
  { key: 'type', label: 'Type' },
  { key: 'name', label: 'Name', multiline: true }
];

// v2 templates use {{line1}} / {{line2}}: split the name into these two fields.
const legacyLineRules = () => ({
  line1: { from: 'field', field: 'name', post: [{ op: 'line', maxChars: 11, line: 1 }] },
  line2: { from: 'field', field: 'name', post: [{ op: 'line', maxChars: 11, line: 2 }] }
});

function idoitExtractRules(idoitUrl, replaceOps, legacyLines) {
  return {
    url: { from: 'const', value: idoitUrl },
    id: { from: 'urlParam', name: 'objID' },
    qr: { from: 'template', value: '{{url}}/?objID={{id}}' },
    type: { from: 'title', split: ' > ', index: 1, post: replaceOps },
    name: legacyLines
      ? { from: 'title', split: ' > ', index: 2 }
      : { from: 'title', split: ' > ', index: 2, post: [{ ...NAME_WRAP }] },
    ...(legacyLines && legacyLineRules())
  };
}

// Netbox device page, e.g. https://netbox.example.com/dcim/devices/123/ ("srv-01 | NetBox").
// The role comes from the REST API using the user's logged-in session (no token).
function netboxExtractRules(replaceOps, legacyLines) {
  return {
    id: { from: 'urlRegex', pattern: '/dcim/devices/(\\d+)/' },
    qr: { from: 'urlRegex', pattern: '^([^?#]*/dcim/devices/\\d+/)' },
    name: legacyLines
      ? { from: 'title', regex: '^(.+?) \\| NetBox' }
      : { from: 'title', regex: '^(.+?) \\| NetBox', post: [{ ...NAME_WRAP }] },
    type: { from: 'api', url: '/api/dcim/devices/{{id}}/', path: 'role.name', post: replaceOps },
    ...(legacyLines && legacyLineRules())
  };
}

// "Development=Dev,Temperature=Temp." -> replace ops (v2 treated search terms as regex).
export function parseReplaceList(list) {
  if (!list) return [];
  return list.split(',')
    .map(pair => pair.split('='))
    .filter(parts => parts.length === 2 && parts[0].trim())
    .map(([search, replace]) => ({ op: 'replace', search: search.trim(), replace: replace.trim(), regex: true }));
}

function defaultFormats() {
  return [
    {
      // Same size exists as direct thermal (etiketten.shop 3052929) and thermal transfer roll.
      id: 'fmt-inventory', name: 'Inventory label 25×14 mm', articleNo: '3052929 (direct thermal)',
      widthMm: 25, lengthMm: 14, shape: 'rect', media: 'any',
      sensing: '', offsetXMm: 0, offsetYMm: 0
    },
    {
      // Box / text labels on the thermal transfer printer.
      id: 'fmt-text-75x50', name: 'Text label 75×50 mm', articleNo: '',
      widthMm: 75, lengthMm: 50, shape: 'rect', media: 'any',
      sensing: '', offsetXMm: 0, offsetYMm: 5
    },
    {
      id: 'fmt-dymo-s0722540', name: 'Dymo S0722540 57×32 mm', articleNo: 'S0722540',
      widthMm: 57, lengthMm: 32, shape: 'rect', media: 'direct',
      sensing: '', offsetXMm: 0, offsetYMm: 0
    },
    {
      id: 'fmt-dymo-14681', name: 'Dymo 14681 round Ø57 mm', articleNo: '14681',
      widthMm: 57, lengthMm: 57, shape: 'round', media: 'direct',
      sensing: '', offsetXMm: 0, offsetYMm: 0
    }
  ];
}

const NO_TRIGGER = () => ({ urlPrefix: '', urlContains: '', urlRegex: '' });

function buildLibrary({ printers, formats, inventoryZpl, idoitUrl, replaceOps, dpmm, previewApiUrl = DEFAULT_PREVIEW_URL, legacyLines = false }) {
  const printerId = printers[0].id;
  // Text labels go to the second printer if there is one.
  const textPrinterId = (printers[1] ?? printers[0]).id;
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { previewApiUrl, defaultJobId: 'job-manual-inventory' },
    printers,
    formats,
    layouts: [
      {
        id: 'layout-inventory', name: 'Inventory label (QR)', formatId: 'fmt-inventory', dpmm,
        type: 'zpl', fields: (legacyLines ? LEGACY_INVENTORY_FIELDS : INVENTORY_FIELDS).map(f => ({ ...f })), zpl: inventoryZpl
      },
      {
        id: 'layout-text-75x50', name: 'Text label 75×50 mm', formatId: 'fmt-text-75x50', dpmm: 12,
        type: 'zpl', fields: TEXT_FIELDS.map(f => ({ ...f })), zpl: TEXT_LABEL_ZPL
      }
    ],
    jobs: [
      {
        id: 'job-idoit-inventory', name: 'I-Doit inventory label',
        trigger: { urlPrefix: idoitUrl, urlContains: 'objID', urlRegex: '' },
        extract: idoitExtractRules(idoitUrl, replaceOps, legacyLines),
        layoutId: 'layout-inventory', printerId
      },
      {
        id: 'job-netbox-inventory', name: 'Netbox inventory label',
        trigger: { urlPrefix: 'https://netbox.example.com', urlContains: '', urlRegex: '/dcim/devices/\\d+/' },
        extract: netboxExtractRules(replaceOps, legacyLines),
        layoutId: 'layout-inventory', printerId
      },
      {
        id: 'job-manual-inventory', name: 'Inventory label (manual)',
        trigger: NO_TRIGGER(),
        extract: {
          url: { from: 'const', value: idoitUrl },
          qr: { from: 'template', value: '{{url}}/?objID={{id}}' }
        },
        layoutId: 'layout-inventory', printerId
      },
      {
        id: 'job-manual-text-75x50', name: 'Text label 75×50 mm (manual)',
        trigger: NO_TRIGGER(),
        extract: {},
        layoutId: 'layout-text-75x50', printerId: textPrinterId
      }
    ]
  };
}

export function createDefaultLibrary() {
  return buildLibrary({
    printers: [
      { id: 'printer-inventory', name: 'Zebra inventory label (thermal transfer)', url: 'http://zebra-inventory.example.local/pstprnt', dpmm: 12, printMethod: 'transfer', darkness: null, speed: null },
      { id: 'printer-text', name: 'Zebra text label (thermal transfer)', url: 'http://zebra-text.example.local/pstprnt', dpmm: 12, printMethod: 'transfer', darkness: null, speed: null }
    ],
    formats: defaultFormats(),
    inventoryZpl: INVENTORY_ZPL,
    idoitUrl: 'https://idoit.example.com',
    replaceOps: parseReplaceList('Development=Dev,Temperature=Temp.'),
    dpmm: 12
  });
}

const normalizeNewlines = s => (s || '').replace(/\r\n/g, '\n').trim();

// {URL} {ID} {LINE1} {LINE2} {TYPE} -> {{url}} ...
export function convertLegacyPlaceholders(zpl) {
  return zpl.replace(/\{(URL|ID|LINE1|LINE2|TYPE)\}/gi, (_, key) => `{{${key.toLowerCase()}}}`);
}

// Printer resolution from the v2 Labelary URL, e.g. …/printers/12dpmm/labels/0.94x0.55/0/
// (the label size in that URL was only approximate – the real size comes from the defaults).
function parsePreviewUrl(url) {
  return { dpmm: Number(/\/(\d+)dpmm\//.exec(url || '')?.[1]) || 12 };
}

// Turns the fixed v2 preview URL into a template, keeping a custom host.
export function previewUrlToTemplate(url) {
  if (!url) return DEFAULT_PREVIEW_URL;
  return url
    .replace(/^http:\/\/api\.labelary\.com\//, 'https://api.labelary.com/') // Labelary is https-only now
    .replace(/\/\d+dpmm\//, '/{dpmm}dpmm/')
    .replace(/\/labels\/[\d.]+x[\d.]+\//, '/labels/{widthIn}x{lengthIn}/');
}

// Converts the flat v2 settings into a v3 library.
export function migrateFromV2(old) {
  const idoitUrl = (old['idoit-base-url'] || 'https://idoit.example.com').replace(/\/+$/, '');
  const { dpmm } = parsePreviewUrl(old['preview-api-url']);
  const template = old['zpl-template'];
  const isDefaultTemplate = !template || normalizeNewlines(template) === normalizeNewlines(LEGACY_DEFAULT_TEMPLATE);
  // custom template: keep as-is (its own ^PW/^LL still win) together with its line1/line2 fields
  const inventoryZpl = isDefaultTemplate ? INVENTORY_ZPL : convertLegacyPlaceholders(template);

  return buildLibrary({
    printers: [
      { id: 'printer-1', name: 'Zebra (migrated from v2)', url: old['printer-url'] || '', dpmm, printMethod: 'direct', darkness: null, speed: null }
    ],
    formats: defaultFormats(),
    inventoryZpl,
    idoitUrl,
    replaceOps: parseReplaceList(old['replace-list']),
    dpmm,
    previewApiUrl: previewUrlToTemplate(old['preview-api-url']),
    legacyLines: !isDefaultTemplate
  });
}

// Makes sure a library loaded from storage/import has all collections.
export function normalizeLibrary(lib) {
  if (!lib || typeof lib !== 'object') throw new Error('Invalid library');
  if (lib.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Library version ${lib.schemaVersion} is newer than this extension (${SCHEMA_VERSION})`);
  }
  const out = {
    ...lib,
    schemaVersion: SCHEMA_VERSION,
    settings: { previewApiUrl: DEFAULT_PREVIEW_URL, defaultJobId: '', ...lib.settings }
  };
  for (const key of ['printers', 'formats', 'layouts', 'jobs']) {
    out[key] = Array.isArray(lib[key]) ? lib[key] : [];
  }
  return out;
}

export const byId = (list, id) => list.find(item => item.id === id);

// Template fields as edited on the options page: one per line, "key = Label" or
// "key = Label | multiline" for a multi-line text field.
const MULTILINE_FLAG = 'multiline';
const MULTILINE_SUFFIX = /\s*\|\s*multiline\s*$/i;

export function formatFieldList(fields) {
  return (fields || [])
    .map(field => `${field.key} = ${field.label}${field.multiline ? ` | ${MULTILINE_FLAG}` : ''}`)
    .join('\n');
}

export function parseFieldList(text) {
  return String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [key, ...rest] = line.split('=');
    let label = rest.join('=').trim();
    const multiline = MULTILINE_SUFFIX.test(label);
    label = label.replace(MULTILINE_SUFFIX, '').trim();
    return { key: key.trim(), label: label || key.trim(), ...(multiline && { multiline: true }) };
  });
}

// Which entities reference the given entity? Used to block deleting things still in use.
export function findReferences(lib, collection, id) {
  const refs = {
    printers: () => lib.jobs.filter(j => j.printerId === id),
    formats: () => lib.layouts.filter(l => l.formatId === id),
    layouts: () => lib.jobs.filter(j => j.layoutId === id),
    jobs: () => []
  };
  return (refs[collection]?.() ?? []).map(item => item.name);
}

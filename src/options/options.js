import { loadLibrary, saveLibrary, sendToPrinter } from '../lib/store.js';
import { createDefaultLibrary, normalizeLibrary, findReferences, newId, byId, DEFAULT_PREVIEW_URL, formatFieldList, parseFieldList } from '../lib/model.js';
import { buildPreviewUrl } from '../lib/preview.js';
import { mmToDots } from '../lib/zpl.js';

const $ = id => document.getElementById(id);

let library;
let activeTab = 'printers';
let selectedId = null;

// ---------------------------------------------------------------------------
// Entity definitions – each tab is a list editor driven by these field specs.
// ---------------------------------------------------------------------------

const DPMM_OPTIONS = [[8, '203 dpi (8 dpmm)'], [12, '300 dpi (12 dpmm)'], [24, '600 dpi (24 dpmm)']];
const refOptions = collection => () => library[collection].map(item => [item.id, item.name]);

const EXTRACT_HELP = `Rules are evaluated top to bottom. Sources:
  {"from":"const","value":"…"}            fixed value
  {"from":"urlParam","name":"objID"}       URL parameter
  {"from":"urlRegex","pattern":"/devices/(\\\\d+)/"}
  {"from":"title","split":" > ","index":1}  or {"from":"title","regex":"…"}
  {"from":"field","field":"name"}          value of an earlier field
  {"from":"template","value":"{{url}}/?objID={{id}}"}  text from earlier fields
On the page (popup only, with your login session):
  {"from":"css","selector":"h1","attr":"title"}   text/attribute of an element
  {"from":"api","url":"/api/dcim/devices/{{id}}/","path":"role.name"}  JSON API of the site
Post-processing via "post": [{"op":"trim"}, {"op":"upper"}, {"op":"lower"},
  {"op":"replace","search":"Development","replace":"Dev"},
  {"op":"wrap","maxWidth":150,"fontSize":27,"maxLines":2}]
    wrap = line breaks by estimated width in dots (font 0), for multi-line fields`;

const ENTITIES = {
  printers: {
    help: 'Zebra printers that receive ZPL via HTTP POST.',
    prefix: 'printer',
    create: () => ({ name: 'New printer', url: '', dpmm: 12, printMethod: 'direct', darkness: null, speed: null }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'url', label: 'URL', type: 'url', placeholder: 'http://192.168.1.50/pstprnt', help: 'Endpoint the ZPL is sent to.' },
      { key: 'dpmm', label: 'Resolution', type: 'select', number: true, options: () => DPMM_OPTIONS },
      { key: 'printMethod', label: 'Print method', type: 'select', options: () => [['direct', 'Direct thermal'], ['transfer', 'Thermal transfer']], help: 'Only used for checks (warning for direct thermal paper on a transfer printer); not sent to the printer.' },
      { key: 'darkness', label: 'Darkness (0–30)', type: 'number', min: 0, max: 30, optional: true, help: 'Empty = printer setting. Sent as ~SD.' },
      { key: 'speed', label: 'Speed (ips)', type: 'number', min: 1, max: 14, optional: true, help: 'Empty = printer setting. Sent as ^PR.' }
    ],
    actions: [{ label: 'Test print', run: testPrint }]
  },

  formats: {
    prefix: 'fmt',
    create: () => ({ name: 'New label type', articleNo: '', widthMm: 50, lengthMm: 25, shape: 'rect', media: 'any', sensing: '', offsetXMm: 0, offsetYMm: 0 }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'articleNo', label: 'Article number(s)', type: 'text', placeholder: 'e.g. 3052929', help: 'For information only, e.g. for reordering.' },
      { key: 'widthMm', label: 'Width (mm, across the print head)', type: 'number', step: 0.1, min: 1 },
      { key: 'lengthMm', label: 'Length (mm, in feed direction)', type: 'number', step: 0.1, min: 1 },
      { key: 'shape', label: 'Shape', type: 'select', options: () => [['rect', 'Rectangular'], ['round', 'Round']] },
      { key: 'media', label: 'Media', type: 'select', options: () => [['any', 'Any / thermal transfer'], ['direct', 'Direct thermal paper']] },
      { key: 'sensing', label: 'Media sensing', type: 'select', options: () => [['', 'Printer setting'], ['gap', 'Gap (^MNY)'], ['mark', 'Black mark (^MNM)'], ['continuous', 'Continuous (^MNN)']] },
      { key: 'offsetXMm', label: 'Offset X (mm)', type: 'number', step: 0.1, min: 0, help: 'Moves the origin (^LH), for fine adjustment.' },
      { key: 'offsetYMm', label: 'Offset Y (mm)', type: 'number', step: 0.1, min: 0 }
    ],
    actions: [{ label: 'Print test frame', run: testFrame }]
  },

  layouts: {
    help: 'Label content as ZPL. Placeholders: {{fieldname}}. The fields appear as inputs in the popup.',
    prefix: 'layout',
    create: () => ({
      name: 'New template', formatId: library.formats[0]?.id ?? '', dpmm: 12, type: 'zpl',
      fields: [{ key: 'text', label: 'Text' }],
      zpl: '^XA\n^CF0,40\n^FO20,20^FD{{text}}^FS\n^XZ'
    }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'formatId', label: 'Label type', type: 'select', options: refOptions('formats') },
      { key: 'dpmm', label: 'Built for resolution', type: 'select', number: true, options: () => DPMM_OPTIONS, help: 'ZPL coordinates are in dots – the popup warns if the printer differs.' },
      { key: 'fields', label: 'Fields (one per line: key = label)', type: 'fieldlist', rows: 5, help: '“| multiline” at the end of a line = text area with line breaks, e.g. “name = Name | multiline”. Line breaks become \\& in the ZPL – the field must be inside a ^FB block.' },
      { key: 'zpl', label: 'ZPL', type: 'code', rows: 14 }
    ]
  },

  jobs: {
    help: 'Links a template to a printer and – optionally – to a website from which the fields are filled automatically. Without a website, the label job can always be selected in the popup under “Manual”.',
    prefix: 'job',
    create: () => ({
      name: 'New label job', trigger: { urlPrefix: '', urlContains: '', urlRegex: '' },
      extract: {}, layoutId: library.layouts[0]?.id ?? '', printerId: library.printers[0]?.id ?? ''
    }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'layoutId', label: 'Template', type: 'select', options: refOptions('layouts') },
      { key: 'printerId', label: 'Default printer', type: 'select', options: refOptions('printers') },
      { key: 'trigger.urlPrefix', label: 'Website (URL prefix)', type: 'text', placeholder: 'https://netbox.example.com', help: 'Empty = manual label job. The label job is only offered on URLs starting with this prefix.' },
      { key: 'trigger.urlContains', label: 'URL must contain', type: 'text', placeholder: 'objID' },
      { key: 'trigger.urlRegex', label: 'URL must match (regex)', type: 'text', placeholder: '/dcim/devices/\\d+/', help: 'Only applies in addition to the website.' },
      { key: 'extract', label: 'Extraction (JSON)', type: 'json', rows: 12, help: EXTRACT_HELP }
    ]
  }
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

let statusTimer;
function showStatus(message, type = 'info') {
  const el = $('status');
  el.textContent = message;
  el.className = `status ${type}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 6000);
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ---------------------------------------------------------------------------
// Form rendering / reading
// ---------------------------------------------------------------------------

function renderInput(field, value) {
  const id = `f-${field.key}`;
  switch (field.type) {
    case 'select': {
      const select = el('select', { id });
      for (const [optValue, optLabel] of field.options()) select.append(new Option(optLabel, optValue));
      select.value = value ?? '';
      return select;
    }
    case 'code':
    case 'json':
    case 'fieldlist': {
      let text = value ?? '';
      if (field.type === 'json') text = JSON.stringify(value ?? {}, null, 2);
      if (field.type === 'fieldlist') text = formatFieldList(value);
      return el('textarea', { id, rows: field.rows || 6, className: 'code', spellcheck: false, value: text });
    }
    default:
      return el('input', {
        id, type: field.type === 'url' ? 'url' : field.type, value: value ?? '',
        placeholder: field.placeholder ?? '', ...(field.step && { step: field.step }),
        ...(field.min !== undefined && { min: field.min }), ...(field.max !== undefined && { max: field.max })
      });
  }
}

function readInput(field) {
  const raw = $(`f-${field.key}`).value;
  switch (field.type) {
    case 'number':
      if (raw === '') {
        if (field.optional) return null;
        throw new Error(`“${field.label}” is missing`);
      }
      return Number(raw);
    case 'select':
      return field.number ? Number(raw) : raw;
    case 'json':
      try {
        return JSON.parse(raw || '{}');
      } catch (error) {
        throw new Error(`“${field.label}”: invalid JSON – ${error.message}`);
      }
    case 'fieldlist':
      return parseFieldList(raw);
    default: {
      const value = raw.trim();
      if (field.required && !value) throw new Error(`“${field.label}” must not be empty`);
      return value;
    }
  }
}

function renderForm() {
  const form = $('entity-form');
  const def = ENTITIES[activeTab];
  const entity = byId(library[activeTab], selectedId);
  form.replaceChildren();
  $('extra-actions').replaceChildren();

  const hasEntity = Boolean(entity);
  for (const id of ['save-btn', 'duplicate-btn', 'delete-btn']) $(id).hidden = !hasEntity;
  if (!hasEntity) {
    form.append(el('p', { className: 'empty' }, 'Nothing selected – choose an entry on the left or create a “New” one.'));
    return;
  }

  for (const field of def.fields) {
    const group = el('div', { className: `form-group ${field.type}` });
    group.append(el('label', { htmlFor: `f-${field.key}` }, field.label));
    group.append(renderInput(field, getPath(entity, field.key)));
    if (field.help) group.append(el('small', {}, field.help));
    form.append(group);
  }

  for (const action of def.actions || []) {
    const button = el('button', { type: 'button', className: 'btn btn-secondary' }, action.label);
    button.addEventListener('click', () => action.run(entity));
    $('extra-actions').append(button);
  }
}

function renderList() {
  const list = $('entity-list');
  list.replaceChildren();
  for (const item of library[activeTab]) {
    const star = activeTab === 'jobs' && item.id === library.settings.defaultJobId ? ' ★' : '';
    const li = el('li', { className: item.id === selectedId ? 'active' : '' }, (item.name || '(no name)') + star);
    li.addEventListener('click', () => { selectedId = item.id; render(); });
    list.append(li);
  }
}

function render() {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  }
  const isGeneral = activeTab === 'general';
  $('general').hidden = !isGeneral;
  $('editor').hidden = isGeneral;
  $('tab-help').textContent = isGeneral ? '' : ENTITIES[activeTab].help ?? '';
  if (isGeneral) {
    renderGeneral();
    return;
  }
  renderList();
  renderForm();
}

function switchTab(tab) {
  activeTab = tab;
  selectedId = tab === 'general' ? null : library[tab][0]?.id ?? null;
  render();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function readForm(base) {
  const entity = structuredClone(base);
  for (const field of ENTITIES[activeTab].fields) setPath(entity, field.key, readInput(field));
  return entity;
}

async function persist(message) {
  await saveLibrary(library);
  render();
  showStatus(message, 'success');
}

async function saveCurrent() {
  const list = library[activeTab];
  const index = list.findIndex(item => item.id === selectedId);
  if (index < 0) return;
  try {
    list[index] = readForm(list[index]);
  } catch (error) {
    return showStatus(error.message, 'error');
  }
  await persist('Saved.');
}

async function addEntity() {
  const def = ENTITIES[activeTab];
  const entity = { id: newId(def.prefix), ...def.create() };
  library[activeTab].push(entity);
  selectedId = entity.id;
  await persist('New entry created.');
}

async function duplicateCurrent() {
  const original = byId(library[activeTab], selectedId);
  if (!original) return;
  const copy = { ...structuredClone(original), id: newId(ENTITIES[activeTab].prefix), name: `${original.name} (copy)` };
  library[activeTab].push(copy);
  selectedId = copy.id;
  await persist('Duplicated.');
}

async function deleteCurrent() {
  const entity = byId(library[activeTab], selectedId);
  if (!entity) return;
  const refs = findReferences(library, activeTab, entity.id);
  if (refs.length) return showStatus(`“${entity.name}” is still used by: ${refs.join(', ')}`, 'error');
  if (!confirm(`Really delete “${entity.name}”?`)) return;
  library[activeTab] = library[activeTab].filter(item => item.id !== entity.id);
  if (library.settings.defaultJobId === entity.id) library.settings.defaultJobId = '';
  selectedId = library[activeTab][0]?.id ?? null;
  await persist('Deleted.');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function testPrint(printer) {
  const url = $('f-url').value.trim();
  if (!url) return showStatus('Please enter a URL first.', 'error');
  try {
    await sendToPrinter(url, `^XA^FO20,20^A0N,30,30^FD${printer.name.replace(/[\^~]/g, ' ')}^FS^FO20,60^A0N,25,25^FDTest print^FS^XZ`);
    showStatus('Test print sent.', 'success');
  } catch (error) {
    showStatus(`Test print failed: ${error.message}`, 'error');
  }
}

// Prints a border along the label edges – handy to check size and offsets.
async function testFrame() {
  let format;
  try {
    format = readForm(byId(library.formats, selectedId));
  } catch (error) {
    return showStatus(error.message, 'error');
  }
  const printer = library.printers.find(p => p.url);
  if (!printer) return showStatus('No printer with a URL available.', 'error');
  if (!confirm(`Print frame on “${printer.name}”?`)) return;

  const w = mmToDots(format.widthMm, printer.dpmm);
  const l = mmToDots(format.lengthMm, printer.dpmm);
  const x = mmToDots(format.offsetXMm, printer.dpmm);
  const y = mmToDots(format.offsetYMm, printer.dpmm);
  const shape = format.shape === 'round'
    ? `^FO0,0^GC${Math.min(w, l)},3,B^FS`
    : `^FO0,0^GB${w},${l},3^FS`;
  try {
    await sendToPrinter(printer.url, `^XA^PW${w}^LL${l}^LH${x},${y}${shape}^XZ`);
    showStatus(`Frame sent to “${printer.name}”.`, 'success');
  } catch (error) {
    showStatus(`Printing failed: ${error.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// General settings
// ---------------------------------------------------------------------------

function renderGeneral() {
  $('preview-api-url').value = library.settings.previewApiUrl ?? '';
}

async function saveGeneral() {
  library.settings = {
    ...library.settings,
    previewApiUrl: $('preview-api-url').value.trim()
  };
  await persist('Saved.');
}

// Renders a test label for every label type with the first printer's resolution.
function testPreview() {
  const template = $('preview-api-url').value.trim();
  const container = $('preview-test');
  container.replaceChildren();
  if (!template) return showStatus('No preview URL entered.', 'error');
  const printer = library.printers[0] ?? { dpmm: 12 };

  for (const format of library.formats) {
    const w = mmToDots(format.widthMm, printer.dpmm);
    const l = mmToDots(format.lengthMm, printer.dpmm);
    const zpl = `^XA^FO0,0^GB${w},${l},3^FS^FO15,15^A0N,25,25^FDTest^FS^XZ`;
    const img = el('img', { alt: format.name, title: format.name });
    img.addEventListener('error', () => img.replaceWith(el('span', { className: 'error' }, `❌ ${format.name}`)));
    img.src = buildPreviewUrl(template, { printer, format, zpl });
    container.append(el('figure', {}, img, el('figcaption', {}, format.name)));
  }
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

function exportLibrary() {
  const blob = new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' });
  const link = el('a', { href: URL.createObjectURL(blob), download: `fast-label-printer-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importLibrary(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const imported = normalizeLibrary(JSON.parse(await file.text()));
    if (!confirm('The current configuration will be replaced completely. Continue?')) return;
    library = imported;
    await persist('Import successful.');
  } catch (error) {
    showStatus(`Import failed: ${error.message}`, 'error');
  }
}

async function resetLibrary() {
  if (!confirm('Reset all printers, label types, templates and label jobs to the defaults?')) return;
  library = createDefaultLibrary();
  await persist('Reset to defaults.');
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    library = await loadLibrary();
  } catch (error) {
    return showStatus(`Loading failed: ${error.message}`, 'error');
  }

  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }
  $('entity-form').addEventListener('submit', event => event.preventDefault());
  $('save-btn').addEventListener('click', saveCurrent);
  $('add-btn').addEventListener('click', addEntity);
  $('duplicate-btn').addEventListener('click', duplicateCurrent);
  $('delete-btn').addEventListener('click', deleteCurrent);
  $('export-btn').addEventListener('click', exportLibrary);
  $('import-file').addEventListener('change', importLibrary);
  $('reset-btn').addEventListener('click', resetLibrary);
  $('save-general-btn').addEventListener('click', saveGeneral);
  $('test-preview-btn').addEventListener('click', testPreview);
  $('default-preview-btn').addEventListener('click', () => { $('preview-api-url').value = DEFAULT_PREVIEW_URL; });

  switchTab(activeTab);
});

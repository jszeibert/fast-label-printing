import { loadLibrary, saveLibrary, sendToPrinter } from '../lib/store.js';
import { createDefaultLibrary, normalizeLibrary, findReferences, newId, byId, DEFAULT_PREVIEW_URL } from '../lib/model.js';
import { buildPreviewUrl } from '../lib/preview.js';
import { extractFields, matchesTrigger } from '../lib/extract.js';
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

const EXTRACT_HELP = `Regeln werden von oben nach unten ausgewertet. Quellen:
  {"from":"const","value":"…"}            fester Wert
  {"from":"urlParam","name":"objID"}       URL-Parameter
  {"from":"urlRegex","pattern":"/devices/(\\\\d+)/"}
  {"from":"title","split":" > ","index":1}  oder {"from":"title","regex":"…"}
  {"from":"field","field":"name"}          Wert eines vorherigen Feldes
Nachbearbeitung über "post": [{"op":"trim"}, {"op":"upper"}, {"op":"lower"},
  {"op":"replace","search":"Development","replace":"Dev"},
  {"op":"line","maxChars":11,"line":1}]`;

const ENTITIES = {
  printers: {
    help: 'Zebra-Drucker, an die per HTTP-POST (ZPL) gedruckt wird.',
    prefix: 'printer',
    create: () => ({ name: 'Neuer Drucker', url: '', dpmm: 12, printMethod: 'direct', darkness: null, speed: null }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'url', label: 'URL', type: 'url', placeholder: 'http://192.168.1.50/pstprnt', help: 'Endpoint, an den das ZPL gesendet wird.' },
      { key: 'dpmm', label: 'Auflösung', type: 'select', number: true, options: () => DPMM_OPTIONS },
      { key: 'printMethod', label: 'Druckverfahren', type: 'select', options: () => [['direct', 'Thermodirekt'], ['transfer', 'Thermotransfer']], help: 'Nur zur Prüfung (Warnung bei Thermodirekt-Papier auf Transferdrucker); wird nicht an den Drucker gesendet.' },
      { key: 'darkness', label: 'Schwärzung (0–30)', type: 'number', min: 0, max: 30, optional: true, help: 'Leer = Druckereinstellung. Wird als ~SD gesendet.' },
      { key: 'speed', label: 'Geschwindigkeit (ips)', type: 'number', min: 1, max: 14, optional: true, help: 'Leer = Druckereinstellung. Wird als ^PR gesendet.' }
    ],
    actions: [{ label: 'Testdruck', run: testPrint }]
  },

  formats: {
    help: 'Physische Etiketten. Breite/Länge ergeben ^PW/^LL – sie stehen nicht mehr im Template.',
    prefix: 'fmt',
    create: () => ({ name: 'Neuer Labeltyp', widthMm: 50, lengthMm: 25, shape: 'rect', media: 'any', sensing: '', offsetXMm: 0, offsetYMm: 0 }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'widthMm', label: 'Breite (mm, quer zum Druckkopf)', type: 'number', step: 0.1, min: 1 },
      { key: 'lengthMm', label: 'Länge (mm, in Laufrichtung)', type: 'number', step: 0.1, min: 1 },
      { key: 'shape', label: 'Form', type: 'select', options: () => [['rect', 'Rechteckig'], ['round', 'Rund']] },
      { key: 'media', label: 'Material', type: 'select', options: () => [['any', 'Beliebig / Thermotransfer'], ['direct', 'Thermodirekt-Papier']] },
      { key: 'sensing', label: 'Etikettenerkennung', type: 'select', options: () => [['', 'Druckereinstellung'], ['gap', 'Lücke (^MNY)'], ['mark', 'Schwarze Markierung (^MNM)'], ['continuous', 'Endlos (^MNN)']] },
      { key: 'offsetXMm', label: 'Versatz X (mm)', type: 'number', step: 0.1, min: 0, help: 'Verschiebt den Ursprung (^LH), zum Justieren.' },
      { key: 'offsetYMm', label: 'Versatz Y (mm)', type: 'number', step: 0.1, min: 0 }
    ],
    actions: [{ label: 'Rahmen testdrucken', run: testFrame }]
  },

  layouts: {
    help: 'Label-Inhalt als ZPL. Platzhalter: {{feldname}}. Die Felder erscheinen im Popup als Eingaben.',
    prefix: 'layout',
    create: () => ({
      name: 'Neues Template', formatId: library.formats[0]?.id ?? '', dpmm: 12, type: 'zpl',
      fields: [{ key: 'text', label: 'Text' }],
      zpl: '^XA\n^CF0,40\n^FO20,20^FD{{text}}^FS\n^XZ'
    }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'formatId', label: 'Labeltyp', type: 'select', options: refOptions('formats') },
      { key: 'dpmm', label: 'Gebaut für Auflösung', type: 'select', number: true, options: () => DPMM_OPTIONS, help: 'ZPL-Koordinaten sind in Dots – das Popup warnt bei abweichendem Drucker.' },
      { key: 'fields', label: 'Felder (eins pro Zeile: schluessel = Beschriftung)', type: 'fieldlist', rows: 5 },
      { key: 'zpl', label: 'ZPL', type: 'code', rows: 14 }
    ]
  },

  jobs: {
    help: 'Verknüpft ein Template mit einem Drucker und – optional – mit einer Website, aus der die Felder automatisch befüllt werden. Ohne Website ist der Labeldruck im Popup immer unter „Manuell“ wählbar.',
    prefix: 'job',
    create: () => ({
      name: 'Neuer Labeldruck', trigger: { urlPrefix: '', urlContains: '', urlRegex: '' },
      extract: {}, layoutId: library.layouts[0]?.id ?? '', printerId: library.printers[0]?.id ?? ''
    }),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'layoutId', label: 'Template', type: 'select', options: refOptions('layouts') },
      { key: 'printerId', label: 'Standard-Drucker', type: 'select', options: refOptions('printers') },
      { key: 'trigger.urlPrefix', label: 'Website (URL-Anfang)', type: 'text', placeholder: 'https://netbox.example.com', help: 'Leer = manueller Labeldruck. Nur auf URLs mit diesem Anfang wird der Labeldruck angeboten.' },
      { key: 'trigger.urlContains', label: 'URL muss enthalten', type: 'text', placeholder: 'objID' },
      { key: 'trigger.urlRegex', label: 'URL muss passen auf (Regex)', type: 'text', placeholder: '/dcim/devices/\\d+/', help: 'Wirkt nur zusätzlich zur Website.' },
      { key: 'extract', label: 'Extraktion (JSON)', type: 'json', rows: 12, help: EXTRACT_HELP }
    ],
    extraPanel: renderExtractionTester
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
      if (field.type === 'fieldlist') text = (value || []).map(f => `${f.key} = ${f.label}`).join('\n');
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
        throw new Error(`„${field.label}“ fehlt`);
      }
      return Number(raw);
    case 'select':
      return field.number ? Number(raw) : raw;
    case 'json':
      try {
        return JSON.parse(raw || '{}');
      } catch (error) {
        throw new Error(`„${field.label}“: ungültiges JSON – ${error.message}`);
      }
    case 'fieldlist':
      return raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const [key, ...rest] = line.split('=');
        return { key: key.trim(), label: rest.join('=').trim() || key.trim() };
      });
    default: {
      const value = raw.trim();
      if (field.required && !value) throw new Error(`„${field.label}“ darf nicht leer sein`);
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
  $('extra-panel').replaceChildren();

  const hasEntity = Boolean(entity);
  for (const id of ['save-btn', 'duplicate-btn', 'delete-btn']) $(id).hidden = !hasEntity;
  if (!hasEntity) {
    form.append(el('p', { className: 'empty' }, 'Nichts ausgewählt – links einen Eintrag wählen oder „Neu“ anlegen.'));
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
  def.extraPanel?.($('extra-panel'), entity);
}

function renderList() {
  const list = $('entity-list');
  list.replaceChildren();
  for (const item of library[activeTab]) {
    const li = el('li', { className: item.id === selectedId ? 'active' : '' }, item.name || '(ohne Name)');
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
  $('tab-help').textContent = isGeneral ? '' : ENTITIES[activeTab].help;
  if (isGeneral) {
    $('preview-api-url').value = library.settings.previewApiUrl ?? '';
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
  await persist('Gespeichert.');
}

async function addEntity() {
  const def = ENTITIES[activeTab];
  const entity = { id: newId(def.prefix), ...def.create() };
  library[activeTab].push(entity);
  selectedId = entity.id;
  await persist('Neuer Eintrag angelegt.');
}

async function duplicateCurrent() {
  const original = byId(library[activeTab], selectedId);
  if (!original) return;
  const copy = { ...structuredClone(original), id: newId(ENTITIES[activeTab].prefix), name: `${original.name} (Kopie)` };
  library[activeTab].push(copy);
  selectedId = copy.id;
  await persist('Dupliziert.');
}

async function deleteCurrent() {
  const entity = byId(library[activeTab], selectedId);
  if (!entity) return;
  const refs = findReferences(library, activeTab, entity.id);
  if (refs.length) return showStatus(`„${entity.name}“ wird noch verwendet von: ${refs.join(', ')}`, 'error');
  if (!confirm(`„${entity.name}“ wirklich löschen?`)) return;
  library[activeTab] = library[activeTab].filter(item => item.id !== entity.id);
  selectedId = library[activeTab][0]?.id ?? null;
  await persist('Gelöscht.');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function testPrint(printer) {
  const url = $('f-url').value.trim();
  if (!url) return showStatus('Bitte zuerst eine URL eintragen.', 'error');
  try {
    await sendToPrinter(url, `^XA^FO20,20^A0N,30,30^FD${printer.name.replace(/[\^~]/g, ' ')}^FS^FO20,60^A0N,25,25^FDTestdruck^FS^XZ`);
    showStatus('Testdruck gesendet.', 'success');
  } catch (error) {
    showStatus(`Testdruck fehlgeschlagen: ${error.message}`, 'error');
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
  if (!printer) return showStatus('Kein Drucker mit URL vorhanden.', 'error');
  if (!confirm(`Rahmen auf „${printer.name}“ drucken?`)) return;

  const w = mmToDots(format.widthMm, printer.dpmm);
  const l = mmToDots(format.lengthMm, printer.dpmm);
  const x = mmToDots(format.offsetXMm, printer.dpmm);
  const y = mmToDots(format.offsetYMm, printer.dpmm);
  const shape = format.shape === 'round'
    ? `^FO0,0^GC${Math.min(w, l)},3,B^FS`
    : `^FO0,0^GB${w},${l},3^FS`;
  try {
    await sendToPrinter(printer.url, `^XA^PW${w}^LL${l}^LH${x},${y}${shape}^XZ`);
    showStatus(`Rahmen an „${printer.name}“ gesendet.`, 'success');
  } catch (error) {
    showStatus(`Druck fehlgeschlagen: ${error.message}`, 'error');
  }
}

// Lets the user try trigger + extraction rules against a sample URL / page title.
function renderExtractionTester(container) {
  const url = el('input', { type: 'url', placeholder: 'https://idoit.example.com/?objID=123' });
  const title = el('input', { type: 'text', placeholder: 'i-doit > Server > srv-backup-01' });
  const output = el('pre', { className: 'test-results' });
  const button = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Testen');

  button.addEventListener('click', () => {
    let job;
    try {
      job = readForm(byId(library.jobs, selectedId));
    } catch (error) {
      output.textContent = `❌ ${error.message}`;
      return;
    }
    const page = { url: url.value.trim(), title: title.value };
    const { values, errors } = extractFields(job.extract, page);
    const triggered = matchesTrigger(job.trigger, page.url);
    output.textContent = [
      job.trigger?.urlPrefix ? `Trigger: ${triggered ? '✅ passt' : '❌ passt nicht'}` : 'Trigger: – (manueller Labeldruck)',
      ...errors.map(e => `❌ ${e}`),
      JSON.stringify(values, null, 2)
    ].join('\n');
  });

  container.append(el('div', { className: 'section tester' },
    el('h3', {}, 'Extraktion testen'),
    el('div', { className: 'form-group' }, el('label', {}, 'Beispiel-URL'), url),
    el('div', { className: 'form-group' }, el('label', {}, 'Beispiel-Seitentitel'), title),
    button,
    output));
}

// ---------------------------------------------------------------------------
// General settings
// ---------------------------------------------------------------------------

async function saveGeneral() {
  library.settings = { ...library.settings, previewApiUrl: $('preview-api-url').value.trim() };
  await persist('Gespeichert.');
}

// Renders a test label for every label type with the first printer's resolution.
function testPreview() {
  const template = $('preview-api-url').value.trim();
  const container = $('preview-test');
  container.replaceChildren();
  if (!template) return showStatus('Keine Vorschau-URL eingetragen.', 'error');
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
    if (!confirm('Die aktuelle Konfiguration wird komplett ersetzt. Fortfahren?')) return;
    library = imported;
    await persist('Import erfolgreich.');
  } catch (error) {
    showStatus(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

async function resetLibrary() {
  if (!confirm('Alle Drucker, Labeltypen, Templates und Labeldrucke auf den Standard zurücksetzen?')) return;
  library = createDefaultLibrary();
  await persist('Auf Standard zurückgesetzt.');
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    library = await loadLibrary();
  } catch (error) {
    return showStatus(`Laden fehlgeschlagen: ${error.message}`, 'error');
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

import { browserAPI } from '../lib/browser.js';
import { loadLibrary, sendToPrinter } from '../lib/store.js';
import { byId } from '../lib/model.js';
import { hasTrigger, matchesTrigger, extractFields } from '../lib/extract.js';
import { compileLabel, checkCompatibility } from '../lib/zpl.js';
import { buildPreviewUrl } from '../lib/preview.js';

const $ = id => document.getElementById(id);

let library;
let page = { url: '', title: '' };
let current = null; // { job, layout, format, values }
let zpl = '';

function setStatus(message, type = 'info') {
  $('status').textContent = message;
  $('status').className = `status ${type}`;
}

function openOptions() {
  browserAPI.runtime.openOptionsPage().then(() => window.close());
}

function addOptions(select, items, label) {
  if (!items.length) return;
  const group = document.createElement('optgroup');
  group.label = label;
  for (const item of items) group.append(new Option(item.name, item.id));
  select.append(group);
}

// Jobs bound to this website + jobs without URL (manual). Jobs of other sites are hidden.
function availableJobs() {
  return {
    matched: library.jobs.filter(job => matchesTrigger(job.trigger, page.url)),
    manual: library.jobs.filter(job => !hasTrigger(job.trigger))
  };
}

function selectJob(jobId) {
  const job = byId(library.jobs, jobId);
  const layout = byId(library.layouts, job?.layoutId);
  const format = byId(library.formats, layout?.formatId);
  if (!job || !layout || !format) {
    current = null;
    $('fields').replaceChildren();
    return setStatus('Labeldruck unvollständig: Layout oder Format fehlt.', 'error');
  }

  const { values, errors } = extractFields(job.extract, page);
  current = { job, layout, format, values };

  if (byId(library.printers, job.printerId)) $('printer-select').value = job.printerId;
  $('format-info').textContent =
    `${layout.name} · ${format.name}${format.shape === 'round' ? ' (rund)' : ''}`;
  shapePreview(format);

  renderFields();
  update();
  setStatus(errors.length ? `Extraktion: ${errors.join('; ')}` : '', errors.length ? 'error' : 'info');
}

// Preview box takes the label's aspect ratio (and is round for round labels).
function shapePreview(format) {
  const box = $('preview');
  const ratio = format.widthMm / format.lengthMm;
  box.style.aspectRatio = `${format.widthMm} / ${format.lengthMm}`;
  box.style.width = `min(100%, ${Math.round(200 * ratio)}px)`; // max. 200px high
  box.classList.toggle('round', format.shape === 'round');
}

let previewTimer;
let previewRequest = 0;
function schedulePreview(printer) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => loadPreview(printer), 400);
}

function loadPreview(printer) {
  const img = $('preview-img');
  const msg = $('preview-msg');
  const url = buildPreviewUrl(library.settings.previewApiUrl, { printer, format: current.format, zpl });
  if (!url) {
    img.hidden = true;
    msg.textContent = 'Keine Vorschau-URL eingestellt';
    return;
  }
  const request = ++previewRequest;
  msg.textContent = 'Vorschau wird geladen …';
  const next = new Image();
  next.onload = () => {
    if (request !== previewRequest) return;
    img.src = next.src;
    img.hidden = false;
    msg.textContent = '';
  };
  next.onerror = () => {
    if (request !== previewRequest) return;
    img.hidden = true;
    msg.textContent = 'Vorschau fehlgeschlagen – Vorschau-URL in den Einstellungen prüfen';
  };
  next.src = url;
}

function renderFields() {
  const container = $('fields');
  container.replaceChildren();
  for (const field of current.layout.fields || []) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const label = document.createElement('label');
    label.textContent = field.label || field.key;
    label.htmlFor = `field-${field.key}`;
    const input = document.createElement('input');
    input.id = `field-${field.key}`;
    input.value = current.values[field.key] ?? '';
    input.addEventListener('input', () => {
      current.values[field.key] = input.value;
      update();
    });
    wrapper.append(label, input);
    container.append(wrapper);
  }
}

function update() {
  if (!current) return;
  const printer = byId(library.printers, $('printer-select').value);
  const warnings = $('warnings');
  warnings.replaceChildren();
  if (!printer) {
    zpl = '';
    $('print-btn').disabled = true;
    return;
  }

  const { layout, format, values } = current;
  zpl = compileLabel({ layout, format, printer, values, copies: $('copies').value });
  $('zpl-output').textContent = zpl;
  schedulePreview(printer);

  const hints = checkCompatibility({ layout, format, printer });
  if (!printer.url) hints.unshift(`Für „${printer.name}“ ist keine URL eingetragen.`);
  for (const hint of hints) {
    const li = document.createElement('li');
    li.textContent = `⚠️ ${hint}`;
    warnings.append(li);
  }
  $('print-btn').disabled = !printer.url;
}

async function print() {
  const printer = byId(library.printers, $('printer-select').value);
  if (!zpl || !printer?.url) return;
  setStatus('Drucke …', 'loading');
  $('print-btn').disabled = true;
  try {
    await sendToPrinter(printer.url, zpl);
    setStatus(`An „${printer.name}“ gesendet.`, 'success');
  } catch (error) {
    setStatus(`Druck fehlgeschlagen: ${error.message}`, 'error');
  } finally {
    $('print-btn').disabled = false;
  }
}

async function init() {
  $('options-btn').addEventListener('click', openOptions);
  $('empty-settings-btn').addEventListener('click', openOptions);

  try {
    library = await loadLibrary();
  } catch (error) {
    return setStatus(`Einstellungen konnten nicht geladen werden: ${error.message}`, 'error');
  }

  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  page = { url: tab?.url || '', title: tab?.title || '' };

  const { matched, manual } = availableJobs();
  if (!matched.length && !manual.length) {
    $('empty').hidden = false;
    return;
  }

  const jobSelect = $('job-select');
  addOptions(jobSelect, matched, 'Passend zu dieser Seite');
  addOptions(jobSelect, manual, 'Manuell');

  const printerSelect = $('printer-select');
  for (const printer of library.printers) printerSelect.append(new Option(printer.name, printer.id));

  jobSelect.addEventListener('change', () => selectJob(jobSelect.value));
  printerSelect.addEventListener('change', update);
  $('copies').addEventListener('input', update);
  $('print-btn').addEventListener('click', print);

  $('main').hidden = false;
  selectJob((matched[0] ?? manual[0]).id);
}

document.addEventListener('DOMContentLoaded', init);

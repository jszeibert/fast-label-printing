import { browserAPI } from '../lib/browser.js';
import { loadLibrary, sendToPrinter } from '../lib/store.js';
import { byId } from '../lib/model.js';
import { hasTrigger, matchesTrigger, extractFields, recomputeDerived, pageExtract } from '../lib/extract.js';
import { compileLabel, checkCompatibility } from '../lib/zpl.js';
import { buildPreviewUrl } from '../lib/preview.js';
import { ManualLabelValues } from '../lib/manual-values.js';

const $ = id => document.getElementById(id);

let library;
let manualValues;
let page = { url: '', title: '', tabId: null };
let current = null; // { job, layout, format, values, edited }
let selectToken = 0;
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
  for (const item of items) {
    const star = item.id === library.settings.defaultJobId ? ' ★' : '';
    group.append(new Option(item.name + star, item.id));
  }
  select.append(group);
}

// Jobs bound to this website + jobs without URL (manual). Jobs of other sites are hidden.
function availableJobs() {
  return {
    matched: library.jobs.filter(job => matchesTrigger(job.trigger, page.url)),
    manual: library.jobs.filter(job => !hasTrigger(job.trigger))
  };
}

// Evaluates css/api rules inside the current tab (uses the user's logged-in session).
async function resolvePage(rule) {
  if (page.tabId == null) throw new Error('kein Tab');
  const [injection] = await browserAPI.scripting.executeScript({
    target: { tabId: page.tabId },
    func: pageExtract,
    args: [rule]
  });
  const result = injection?.result;
  if (!result) throw new Error('keine Antwort von der Seite');
  if (result.error) throw new Error(result.error);
  return result.value;
}

async function selectJob(jobId) {
  const token = ++selectToken;
  const job = byId(library.jobs, jobId);
  const layout = byId(library.layouts, job?.layoutId);
  const format = byId(library.formats, layout?.formatId);
  if (!job || !layout || !format) {
    current = null;
    $('fields').replaceChildren();
    return setStatus('Labeldruck unvollständig: Layout oder Format fehlt.', 'error');
  }

  // Page sources only run for jobs bound to this page.
  const onPage = matchesTrigger(job.trigger, page.url);
  setStatus('Daten werden gelesen …', 'loading');
  const { values, errors } = await extractFields(job.extract, page, onPage ? resolvePage : undefined);
  if (token !== selectToken) return; // another job was selected meanwhile
  const isManual = !hasTrigger(job.trigger);
  current = {
    job, layout, format,
    values: isManual ? { ...values, ...manualValues.get(job.id) } : values,
    edited: new Set()
  };

  if (byId(library.printers, job.printerId)) $('printer-select').value = job.printerId;
  $('clear-fields-btn').hidden = !isManual;
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
      current.edited.add(field.key);
      current.values = recomputeDerived(current.job.extract, current.values, current.edited);
      syncInputs(field.key);
      if (!hasTrigger(current.job.trigger)) {
        manualValues.save(current.job.id, current.values).catch(error => {
          setStatus(`Manuelle Texte konnten nicht gespeichert werden: ${error.message}`, 'error');
        });
      }
      update();
    });
    wrapper.append(label, input);
    container.append(wrapper);
  }
}

async function clearManualValues() {
  if (!current || hasTrigger(current.job.trigger)) return;
  try {
    await manualValues.clear(current.job.id);
    current.values = Object.fromEntries((current.layout.fields || []).map(field => [field.key, '']));
    current.edited.clear();
    renderFields();
    update();
    setStatus('Manuelle Eingaben gelöscht.', 'success');
  } catch (error) {
    setStatus(`Manuelle Texte konnten nicht gelöscht werden: ${error.message}`, 'error');
  }
}

// Show recomputed derived values in the other inputs.
function syncInputs(exceptKey) {
  for (const field of current.layout.fields || []) {
    if (field.key === exceptKey) continue;
    const input = $(`field-${field.key}`);
    if (input) input.value = current.values[field.key] ?? '';
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
    manualValues = new ManualLabelValues(browserAPI.storage.local);
    await manualValues.load();
  } catch (error) {
    return setStatus(`Einstellungen oder manuelle Texte konnten nicht geladen werden: ${error.message}`, 'error');
  }

  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  page = { url: tab?.url || '', title: tab?.title || '', tabId: tab?.id ?? null };

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
  $('clear-fields-btn').addEventListener('click', clearManualValues);

  $('main').hidden = false;
  // Matching job first; otherwise the default job (if it is a manual one); else first manual.
  const defaultJob = manual.find(job => job.id === library.settings.defaultJobId);
  const initial = matched[0] ?? defaultJob ?? manual[0];
  jobSelect.value = initial.id;
  selectJob(initial.id);
}

document.addEventListener('DOMContentLoaded', init);

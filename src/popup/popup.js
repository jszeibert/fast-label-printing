import { browserAPI } from '../lib/browser.js';
import { loadLibrary, saveLibrary, sendToPrinter } from '../lib/store.js';
import { byId } from '../lib/model.js';
import { hasTrigger, matchesTrigger, extractFields, recomputeDerived, pageExtract } from '../lib/extract.js';
import { compileLabel, checkCompatibility } from '../lib/zpl.js';
import { buildPreviewUrl } from '../lib/preview.js';
import { ManualLabelValues } from '../lib/manual-values.js';
import { availableJobs, pickInitialJob, initialValues, toggledDefaultJobId, hasFieldValues } from '../lib/job-selection.js';

const $ = id => document.getElementById(id);

let library;
let manualValues;
let page = { url: '', title: '', tabId: null };
let current = null; // { job, layout, format, values, edited }
let selectToken = 0;
let zpl = '';

// Browsers cap extension popups at 600px height; the preview shrinks so everything fits.
const POPUP_MAX_HEIGHT = 600;
const PREVIEW_MAX_HEIGHT = 200;
const PREVIEW_MIN_HEIGHT = 70;
let previewHeight = PREVIEW_MAX_HEIGHT;

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
  for (const item of items) group.append(new Option(jobLabel(item), item.id));
  select.append(group);
}

const jobLabel = job => job.name + (job.id === library.settings.defaultJobId ? ' ★' : '');

// ☆/★ buttons: default manual job (global) and default printer of the selected job.
function updateDefaultButtons() {
  const jobBtn = $('default-job-btn');
  const printerBtn = $('default-printer-btn');
  if (!current) {
    jobBtn.hidden = printerBtn.hidden = true;
    return;
  }
  const { job } = current;
  const isDefaultJob = job.id === library.settings.defaultJobId;
  jobBtn.hidden = hasTrigger(job.trigger); // only manual jobs can be the default
  jobBtn.textContent = isDefaultJob ? '★' : '☆';
  jobBtn.title = isDefaultJob
    ? 'Default label job – click to remove'
    : 'Set as default label job (preselected in the popup)';

  const printerId = $('printer-select').value;
  const isDefaultPrinter = printerId === job.printerId;
  printerBtn.hidden = !printerId;
  printerBtn.textContent = isDefaultPrinter ? '★' : '☆';
  printerBtn.title = isDefaultPrinter
    ? `Default printer for “${job.name}”`
    : `Set as default printer for “${job.name}”`;
}

async function persistDefault(apply, message) {
  const previous = structuredClone(library);
  apply();
  try {
    await saveLibrary(library);
    setStatus(message, 'success');
  } catch (error) {
    library = previous;
    current.job = byId(library.jobs, current.job.id);
    setStatus(`Could not save the default: ${error.message}`, 'error');
  }
  for (const option of $('job-select').options) {
    const job = byId(library.jobs, option.value);
    if (job) option.textContent = jobLabel(job);
  }
  updateDefaultButtons();
}

function toggleDefaultJob() {
  if (!current || hasTrigger(current.job.trigger)) return;
  const { job } = current;
  const next = toggledDefaultJobId(library.settings.defaultJobId, job);
  persistDefault(
    () => { library.settings.defaultJobId = next; },
    next ? `“${job.name}” is now the default label job.` : 'Default label job removed.'
  );
}

function setDefaultPrinter() {
  const printer = byId(library.printers, $('printer-select').value);
  if (!current || !printer || current.job.printerId === printer.id) return;
  const { job } = current;
  persistDefault(
    () => { job.printerId = printer.id; },
    `“${printer.name}” is now the default printer for “${job.name}”.`
  );
}

// Evaluates css/api rules inside the current tab (uses the user's logged-in session).
async function resolvePage(rule) {
  if (page.tabId == null) throw new Error('no tab');
  const [injection] = await browserAPI.scripting.executeScript({
    target: { tabId: page.tabId },
    func: pageExtract,
    args: [rule]
  });
  const result = injection?.result;
  if (!result) throw new Error('no response from the page');
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
    updateDefaultButtons();
    return setStatus('Label job incomplete: template or label type is missing.', 'error');
  }

  // Page sources only run for jobs bound to this page.
  const onPage = matchesTrigger(job.trigger, page.url);
  setStatus('Reading data …', 'loading');
  const { values, errors } = await extractFields(job.extract, page, onPage ? resolvePage : undefined);
  if (token !== selectToken) return; // another job was selected meanwhile
  const isManual = !hasTrigger(job.trigger);
  current = {
    job, layout, format,
    values: initialValues(job, values, manualValues.get(job.id)),
    edited: new Set()
  };

  if (byId(library.printers, job.printerId)) $('printer-select').value = job.printerId;
  $('clear-fields-btn').hidden = !isManual;
  $('format-info').textContent =
    `${layout.name} · ${format.name}${format.shape === 'round' ? ' (round)' : ''}`;
  shapePreview(format);

  renderFields();
  update();
  updateDefaultButtons();
  setStatus(errors.length ? `Extraction: ${errors.join('; ')}` : '', errors.length ? 'error' : 'info');
}

// Preview box takes the label's aspect ratio (and is round for round labels).
function shapePreview(format) {
  const box = $('preview');
  const ratio = format.widthMm / format.lengthMm;
  box.style.aspectRatio = `${format.widthMm} / ${format.lengthMm}`;
  box.style.width = `min(100%, ${Math.round(previewHeight * ratio)}px)`; // max. previewHeight high
  box.classList.toggle('round', format.shape === 'round');
}

// Shrinks (or grows back) the preview so the popup needs no vertical scrollbar.
function fitPopup() {
  if (!current || $('main').hidden) return;
  const overflow = document.documentElement.scrollHeight - POPUP_MAX_HEIGHT;
  const boxHeight = $('preview').getBoundingClientRect().height;
  const target = overflow > 0
    ? boxHeight - overflow
    : previewHeight - overflow; // free space: grow again (capped below)
  const next = Math.round(Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, target)));
  if (Math.abs(next - previewHeight) < 1) return;
  previewHeight = next;
  shapePreview(current.format);
}

let previewTimer;
let previewRequest = 0;
function schedulePreview(printer) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => loadPreview(printer), 400);
}

// All fields empty: show a hint instead of calling the preview service.
function clearPreview() {
  clearTimeout(previewTimer);
  previewRequest++; // ignore a preview that is still loading
  $('preview-img').hidden = true;
  $('preview-msg').textContent = 'Enter values to see a preview';
}

function loadPreview(printer) {
  const img = $('preview-img');
  const msg = $('preview-msg');
  const url = buildPreviewUrl(library.settings.previewApiUrl, { printer, format: current.format, zpl });
  if (!url) {
    img.hidden = true;
    msg.textContent = 'No preview URL configured';
    return;
  }
  const request = ++previewRequest;
  msg.textContent = 'Loading preview …';
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
    msg.textContent = 'Preview failed – check the preview URL in the settings';
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
    wrapper.classList.toggle('multiline', Boolean(field.multiline));
    const input = document.createElement(field.multiline ? 'textarea' : 'input');
    input.id = `field-${field.key}`;
    input.value = current.values[field.key] ?? '';
    if (field.multiline) input.rows = Math.max(2, input.value.split('\n').length);
    input.addEventListener('input', () => {
      current.values[field.key] = input.value;
      current.edited.add(field.key);
      current.values = recomputeDerived(current.job.extract, current.values, current.edited);
      syncInputs(field.key);
      if (!hasTrigger(current.job.trigger)) {
        manualValues.save(current.job.id, current.values).catch(error => {
          setStatus(`Could not save manual texts: ${error.message}`, 'error');
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
    setStatus('Manual inputs cleared.', 'success');
  } catch (error) {
    setStatus(`Could not clear manual texts: ${error.message}`, 'error');
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
  if (hasFieldValues(layout, values)) schedulePreview(printer);
  else clearPreview();

  const hints = checkCompatibility({ layout, format, printer });
  if (!printer.url) hints.unshift(`No URL is set for “${printer.name}”.`);
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
  setStatus('Printing …', 'loading');
  $('print-btn').disabled = true;
  try {
    await sendToPrinter(printer.url, zpl);
    setStatus(`Sent to “${printer.name}”.`, 'success');
  } catch (error) {
    setStatus(`Printing failed: ${error.message}`, 'error');
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
    return setStatus(`Could not load settings or manual texts: ${error.message}`, 'error');
  }

  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  page = { url: tab?.url || '', title: tab?.title || '', tabId: tab?.id ?? null };

  const jobs = availableJobs(library.jobs, page.url);
  const { matched, manual } = jobs;
  if (!matched.length && !manual.length) {
    $('empty').hidden = false;
    return;
  }

  const jobSelect = $('job-select');
  addOptions(jobSelect, matched, 'Matching this page');
  addOptions(jobSelect, manual, 'Manual');

  const printerSelect = $('printer-select');
  for (const printer of library.printers) printerSelect.append(new Option(printer.name, printer.id));

  jobSelect.addEventListener('change', () => selectJob(jobSelect.value));
  printerSelect.addEventListener('change', () => { update(); updateDefaultButtons(); });
  $('default-job-btn').addEventListener('click', toggleDefaultJob);
  $('default-printer-btn').addEventListener('click', setDefaultPrinter);
  new ResizeObserver(fitPopup).observe(document.body);
  $('copies').addEventListener('input', update);
  $('print-btn').addEventListener('click', print);
  $('clear-fields-btn').addEventListener('click', clearManualValues);

  $('main').hidden = false;
  const initial = pickInitialJob(jobs, library.settings.defaultJobId);
  jobSelect.value = initial.id;
  selectJob(initial.id);
}

document.addEventListener('DOMContentLoaded', init);

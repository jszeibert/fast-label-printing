import { wrapText } from './wrap.js';

// Declarative extraction of label values from the current page.
//
// A rule: { from: <source>, ...sourceOptions, post: [<op>, ...] }
// Sources (evaluated in the extension):
//   const {value} | urlParam {name} | urlRegex {pattern, group=1}
//   title {split, index} or {regex, group=1}
//   field {field}       value of an earlier key
//   template {value}    text with {{key}} placeholders of earlier keys
// Sources (evaluated inside the page, popup only):
//   css {selector, attr?}       text (or attribute) of the first matching element
//   api {url, path}             GET JSON from the site with the user's session; url may use {{key}}
// Post ops: trim | upper | lower | replace {search, replace, regex}
//           wrap {maxWidth (dots), fontSize=27, fontWidth, maxLines}  multi-line text for ^FB fields
//           line {maxChars, line: 1|2}  (old character-based split, kept for existing configs)
//
// Rules are evaluated in object order, so `field` / `template` can use keys defined above.

const PAGE_SOURCES = new Set(['css', 'api']);
const DERIVED_SOURCES = new Set(['field', 'template']);

// A trigger is bound to a website (urlPrefix). urlContains / urlRegex only narrow it down
// within that site – a regex alone never makes a job trigger.
export function hasTrigger(trigger) {
  return Boolean(trigger?.urlPrefix?.trim());
}

export function matchesTrigger(trigger, url) {
  if (!hasTrigger(trigger) || !url) return false;
  if (!url.startsWith(trigger.urlPrefix.trim())) return false;
  if (trigger.urlContains && !url.includes(trigger.urlContains)) return false;
  if (trigger.urlRegex) {
    try {
      if (!new RegExp(trigger.urlRegex).test(url)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export const interpolate = (text, values) =>
  String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => values[key] ?? '');

// Splits a name into two lines at the last break char within maxChars (v2 behaviour).
export function splitName(name, maxChars = 11) {
  if (!name || name.length <= maxChars) return [name || '', ''];
  let splitIndex = -1;
  for (const char of [' ', '-', '_', '.']) {
    splitIndex = Math.max(splitIndex, name.lastIndexOf(char, maxChars));
  }
  if (splitIndex <= 0) splitIndex = maxChars;
  return [name.substring(0, splitIndex).trim(), name.substring(splitIndex).trim()];
}

function readSource(rule, page, values) {
  switch (rule.from) {
    case 'const':
      return rule.value;
    case 'urlParam': {
      try {
        return new URL(page.url).searchParams.get(rule.name);
      } catch {
        return '';
      }
    }
    case 'urlRegex':
      return new RegExp(rule.pattern).exec(page.url || '')?.[rule.group ?? 1];
    case 'title':
      if (rule.regex) return new RegExp(rule.regex).exec(page.title || '')?.[rule.group ?? 1];
      return rule.split ? (page.title || '').split(rule.split)[rule.index ?? 0] : page.title;
    case 'field':
      return values[rule.field];
    case 'template':
      return interpolate(rule.value, values);
    default:
      throw new Error(`Unknown source “${rule.from}”`);
  }
}

function applyOp(op, value) {
  switch (op.op) {
    case 'trim': return value.trim();
    case 'upper': return value.toUpperCase();
    case 'lower': return value.toLowerCase();
    case 'replace':
      return op.regex
        ? value.replace(new RegExp(op.search, 'g'), op.replace ?? '')
        : value.split(op.search).join(op.replace ?? '');
    case 'wrap':
      return wrapText(value, op);
    case 'line':
      return splitName(value, op.maxChars ?? 11)[(op.line ?? 1) - 1] ?? '';
    default:
      throw new Error(`Unknown operation “${op.op}”`);
  }
}

const postProcess = (rule, raw) =>
  (rule.post || []).reduce((value, op) => applyOp(op, value), String(raw ?? ''));

// Returns { values, errors } – a broken rule never stops the other fields.
// `resolvePage(rule)` evaluates css/api rules inside the page; without it they report an error.
export async function extractFields(rules, page, resolvePage) {
  const values = {};
  const errors = [];
  for (const [key, rule] of Object.entries(rules || {})) {
    try {
      let raw;
      if (PAGE_SOURCES.has(rule.from)) {
        if (!resolvePage) throw new Error('only available in the popup on the page');
        raw = await resolvePage({ ...rule, url: rule.url && interpolate(rule.url, values) });
      } else {
        raw = readSource(rule, page, values);
      }
      values[key] = postProcess(rule, raw);
    } catch (error) {
      values[key] = '';
      errors.push(`${key}: ${error.message}`);
    }
  }
  return { values, errors };
}

// After the user edited fields: recompute derived (field/template) values from the current
// values, except for keys the user edited directly.
export function recomputeDerived(rules, values, editedKeys = new Set()) {
  const out = { ...values };
  for (const [key, rule] of Object.entries(rules || {})) {
    if (!DERIVED_SOURCES.has(rule.from) || editedKeys.has(key)) continue;
    try {
      out[key] = postProcess(rule, readSource(rule, {}, out));
    } catch {
      // keep previous value
    }
  }
  return out;
}

// Runs inside the web page (via scripting.executeScript) – must be self-contained.
// Returns { value } or { error }. API responses are cached per page so several fields
// can read the same object with one request.
export async function pageExtract(rule) {
  try {
    if (rule.from === 'css') {
      const element = document.querySelector(rule.selector);
      if (!element) return { value: '' };
      return { value: rule.attr ? element.getAttribute(rule.attr) ?? '' : element.textContent.trim() };
    }
    if (rule.from === 'api') {
      const url = new URL(rule.url, location.href).href;
      const cache = (globalThis.__fastLabelApiCache ??= {});
      cache[url] ??= fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(response => {
          if (!response.ok) throw new Error(`API ${response.status} ${response.statusText}`);
          return response.json();
        });
      let data;
      try {
        data = await cache[url];
      } catch (error) {
        delete cache[url];
        throw error;
      }
      const value = String(rule.path || '').split('.').filter(Boolean).reduce((obj, key) => obj?.[key], data);
      return { value: value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) };
    }
    return { error: `Unknown page source “${rule.from}”` };
  } catch (error) {
    return { error: error.message };
  }
}

// Declarative extraction of label values from the current page.
//
// A rule: { from: <source>, ...sourceOptions, post: [<op>, ...] }
// Sources:  const {value} | urlParam {name} | urlRegex {pattern, group=1}
//           title {split, index} or {regex, group=1} | field {field} (an earlier key)
// Post ops: trim | upper | lower | replace {search, replace, regex} | line {maxChars, line: 1|2}
//
// Rules are evaluated in object order, so `field` can reference keys defined above it.
// TODO (phase 4): css / meta / api sources evaluated in the page via scripting.executeScript
// (api uses the user's logged-in session cookies, no API tokens).

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
    default:
      throw new Error(`Unbekannte Quelle „${rule.from}“`);
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
    case 'line':
      return splitName(value, op.maxChars ?? 11)[(op.line ?? 1) - 1] ?? '';
    default:
      throw new Error(`Unbekannte Operation „${op.op}“`);
  }
}

// Returns { values, errors } – a broken rule never stops the other fields.
export function extractFields(rules, page) {
  const values = {};
  const errors = [];
  for (const [key, rule] of Object.entries(rules || {})) {
    try {
      let value = String(readSource(rule, page, values) ?? '');
      for (const op of rule.post || []) value = applyOp(op, value);
      values[key] = value;
    } catch (error) {
      values[key] = '';
      errors.push(`${key}: ${error.message}`);
    }
  }
  return { values, errors };
}

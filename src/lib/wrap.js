// Width-aware line wrapping for ZPL font 0 (CG Triumvirate Bold Condensed, proportional).
// Counting characters is not enough: "MWMW" is about three times wider than "il1.".
//
// Widths are estimates: Helvetica Bold advance widths (per 1000 em) scaled by a condensed
// factor, with em = font height in dots. If labels still overflow, lower `maxWidth`
// in the extraction rule (or CONDENSED here).

const CONDENSED = 0.82;
const DEFAULT_WIDTH = 611;

const WIDTHS = {
  ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
  '[': 333, ']': 333, '_': 556, '`': 333, '{': 389, '|': 280, '}': 389,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722,
  L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667,
  W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556,
  l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556,
  w: 778, x: 556, y: 556, z: 500,
  Ä: 722, Ö: 778, Ü: 722, ä: 556, ö: 611, ü: 611, ß: 611
};
for (const digit of '0123456789') WIDTHS[digit] = 556;

// Estimated printed width in dots of `text` with ^A0N,fontSize,fontWidth.
export function textWidth(text, fontSize = 27, fontWidth = fontSize) {
  let units = 0;
  for (const char of String(text ?? '')) units += WIDTHS[char] ?? DEFAULT_WIDTH;
  return (units / 1000) * CONDENSED * fontWidth;
}

// Words, each ending after a break char (-, _, ., /) or before whitespace.
// `space` = the word was preceded by whitespace (re-inserted when words share a line).
function words(text) {
  const out = [];
  let current = '';
  let space = false;
  const flush = () => {
    if (current) out.push({ text: current, space });
    current = '';
    space = false;
  };
  for (const char of text) {
    if (/\s/.test(char)) {
      flush();
      space = out.length > 0;
      continue;
    }
    current += char;
    if (/[-_./]/.test(char)) flush();
  }
  flush();
  return out;
}

// Cuts a word that is wider than a whole line into pieces that fit.
function splitWide(word, fits) {
  const pieces = [];
  let rest = word.text;
  let space = word.space;
  while (!fits(rest) && rest.length > 1) {
    let cut = 1;
    while (cut < rest.length && fits(rest.slice(0, cut + 1))) cut++;
    pieces.push({ text: rest.slice(0, cut), space });
    rest = rest.slice(cut);
    space = false;
  }
  pieces.push({ text: rest, space });
  return pieces;
}

// Lines of one paragraph: { text, space } where space = a space was dropped before the next line.
// Balanced wrapping: fewest lines first, then the shortest possible longest line
// ("srv-" / "backup-01" instead of "srv-backup-" / "01").
function wrapParagraph(text, fits, width, maxLines) {
  const parts = words(text).flatMap(word => splitWide(word, fits));
  const n = parts.length;
  if (!n) return [];
  const lineText = (from, to) =>
    parts.slice(from, to).map((part, i) => (i > 0 && part.space ? ' ' : '') + part.text).join('');
  const toLine = (from, to) => ({ text: lineText(from, to), space: parts[to]?.space ?? false });

  // best[j] = best way to put parts[0..j) on lines: { lines, max, from }
  const best = [{ lines: 0, max: 0, from: -1 }];
  for (let to = 1; to <= n; to++) {
    best[to] = null;
    for (let from = to - 1; from >= 0; from--) {
      const line = lineText(from, to);
      if (from < to - 1 && !fits(line)) break; // longer lines only get wider
      const prev = best[from];
      if (!prev) continue;
      const candidate = { lines: prev.lines + 1, max: Math.max(prev.max, width(line)), from };
      const current = best[to];
      if (!current || candidate.lines < current.lines ||
          (candidate.lines === current.lines && candidate.max < current.max)) {
        best[to] = candidate;
      }
    }
  }

  if (!maxLines || best[n].lines <= maxLines) {
    const lines = [];
    for (let to = n; to > 0; to = best[to].from) lines.unshift(toLine(best[to].from, to));
    return lines;
  }

  // Too long anyway: fill the first lines completely, everything else goes on the last line.
  const lines = [];
  let from = 0;
  while (lines.length < maxLines - 1 && from < n) {
    let to = from + 1;
    while (to < n && fits(lineText(from, to + 1))) to++;
    lines.push(toLine(from, to));
    from = to;
  }
  if (from < n) lines.push(toLine(from, n));
  return lines;
}

// Wraps text so each line fits `maxWidth` dots. Existing line breaks are kept.
// With maxLines, the remaining text goes onto the last line (and runs over the label edge –
// nothing is dropped, the user can still edit it).
export function wrapText(text, { maxWidth, fontSize = 27, fontWidth = fontSize, maxLines = 0 } = {}) {
  const width = line => textWidth(line, fontSize, fontWidth);
  const fits = line => width(line) <= maxWidth;
  const lines = String(text ?? '').split(/\r?\n/).flatMap(paragraph => {
    const wrapped = wrapParagraph(paragraph.trim(), fits, width, maxLines);
    if (!wrapped.length) return [{ text: '', space: false }];
    wrapped.at(-1).space = true; // paragraphs are joined with a space if they end up on one line
    return wrapped;
  });
  if (maxLines > 0 && lines.length > maxLines) {
    const rest = lines.splice(maxLines - 1);
    const last = rest.map((line, i) => line.text + (line.space && i < rest.length - 1 ? ' ' : '')).join('');
    lines.push({ text: last, space: false });
  }
  return lines.map(line => line.text).join('\n');
}

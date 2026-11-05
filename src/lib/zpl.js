// Compiles a layout + format + printer + field values into a ZPL job.

export const mmToDots = (mm, dpmm) => Math.round(Number(mm || 0) * dpmm);

const SENSING_CMD = { gap: '^MNY', mark: '^MNM', continuous: '^MNN' };

// ^ and ~ would start a new ZPL command inside field data.
// Line breaks become \& – the line break of a ^FB field block (multi-line fields).
const sanitize = value => String(value ?? '')
  .replace(/[\^~]/g, ' ')
  .replace(/\r?\n/g, '\\&');

export function fillPlaceholders(zpl, values) {
  return zpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => sanitize(values[key]));
}

// Commands derived from the physical medium and printer, inserted right after ^XA.
export function buildHeader(printer, format) {
  const dpmm = Number(printer.dpmm) || 12;
  const cmds = [
    `^PW${mmToDots(format.widthMm, dpmm)}`,
    `^LL${mmToDots(format.lengthMm, dpmm)}`
  ];
  const x = Math.max(0, mmToDots(format.offsetXMm, dpmm));
  const y = Math.max(0, mmToDots(format.offsetYMm, dpmm));
  if (x || y) cmds.push(`^LH${x},${y}`);
  if (SENSING_CMD[format.sensing]) cmds.push(SENSING_CMD[format.sensing]);
  if (isSet(printer.speed)) cmds.push(`^PR${printer.speed}`);
  return cmds.join('');
}

const isSet = v => v !== null && v !== undefined && v !== '';

export function compileLabel({ layout, format, printer, values = {}, copies = 1 }) {
  let body = fillPlaceholders(layout.zpl || '', values).trim();
  if (!/\^XA/i.test(body)) body = `^XA\n${body}\n^XZ`;

  body = body.replace(/\^XA/i, match => `${match}\n${buildHeader(printer, format)}`);

  const n = Math.floor(Number(copies));
  if (n > 1) {
    const end = body.toUpperCase().lastIndexOf('^XZ');
    if (end >= 0) body = `${body.slice(0, end)}^PQ${n}\n${body.slice(end)}`;
  }

  // ~SD (darkness) is a control command and must precede the format.
  if (isSet(printer.darkness)) body = `~SD${String(printer.darkness).padStart(2, '0')}\n${body}`;
  return body;
}

// Printer test print: a "+" whose top-left corner is at dot (1,1) – shows where the printer's
// origin lands on the label – plus the printer name.
export function compileTestPrint(printerName) {
  const size = 31; // odd, so the bars cross in the middle
  const bar = 3;
  const mid = 1 + (size - bar) / 2;
  return [
    '^XA',
    `^FO1,${mid}^GB${size},${bar},${bar}^FS`,
    `^FO${mid},1^GB${bar},${size},${bar}^FS`,
    `^FO45,20^A0N,30,30^FD${sanitize(printerName)}^FS`,
    '^FO45,60^A0N,25,25^FDTest print^FS',
    '^XZ'
  ].join('\n');
}

// Test frame for a label type: one frame on the label edge and one 0.5 mm inside, so it stays
// visible even if the edge is slightly off. Uses the printer's darkness/speed like a real label.
export function compileTestFrame(format, printer) {
  const dpmm = Number(printer.dpmm) || 12;
  const w = mmToDots(format.widthMm, dpmm);
  const l = mmToDots(format.lengthMm, dpmm);
  const inset = mmToDots(0.5, dpmm);
  const thickness = Math.max(3, mmToDots(0.3, dpmm));
  const frame = (offset) => {
    const fo = `^FO${offset},${offset}`;
    return format.shape === 'round'
      ? `${fo}^GC${Math.min(w, l) - 2 * offset},${thickness},B^FS`
      : `${fo}^GB${w - 2 * offset},${l - 2 * offset},${thickness}^FS`;
  };
  return compileLabel({ layout: { zpl: `^XA\n${frame(0)}\n${frame(inset)}\n^XZ` }, format, printer });
}

// Non-blocking hints shown before printing.
export function checkCompatibility({ layout, format, printer }) {
  const warnings = [];
  if (format.media === 'direct' && printer.printMethod === 'transfer') {
    warnings.push(`“${format.name}” is direct thermal paper, but “${printer.name}” is set up as a thermal transfer printer.`);
  }
  if (layout.dpmm && printer.dpmm && Number(layout.dpmm) !== Number(printer.dpmm)) {
    warnings.push(`The template is built for ${layout.dpmm} dpmm, “${printer.name}” has ${printer.dpmm} dpmm – positions and sizes will be off.`);
  }
  return warnings;
}

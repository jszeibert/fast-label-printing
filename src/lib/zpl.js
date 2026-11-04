// Compiles a layout + format + printer + field values into a ZPL job.

export const mmToDots = (mm, dpmm) => Math.round(Number(mm || 0) * dpmm);

const SENSING_CMD = { gap: '^MNY', mark: '^MNM', continuous: '^MNN' };

// ^ and ~ would start a new ZPL command inside field data.
const sanitize = value => String(value ?? '').replace(/[\^~]/g, ' ');

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

// Non-blocking hints shown before printing.
export function checkCompatibility({ layout, format, printer }) {
  const warnings = [];
  if (format.media === 'direct' && printer.printMethod === 'transfer') {
    warnings.push(`„${format.name}“ ist Thermodirekt-Papier, „${printer.name}“ ist als Thermotransfer-Drucker eingestellt.`);
  }
  if (layout.dpmm && printer.dpmm && Number(layout.dpmm) !== Number(printer.dpmm)) {
    warnings.push(`Layout ist für ${layout.dpmm} dpmm gebaut, „${printer.name}“ hat ${printer.dpmm} dpmm – Positionen und Größen stimmen nicht.`);
  }
  return warnings;
}

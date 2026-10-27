// Builds the OJT completion certificate (PDF). Uses the pure-JavaScript `pdf-lib` package.
let lib = null;
function load() {
  if (lib) return lib;
  try { lib = require('pdf-lib'); return lib; }
  catch { const e = new Error('The certificate feature needs one more package. Run "npm install" inside the backend folder once, then restart the server.'); e.code = 'PDF_LIB_MISSING'; throw e; }
}

const VIOLET = [0.427, 0.29, 1];
const INK = [0.07, 0.07, 0.13];
const GREY = [0.42, 0.42, 0.52];

/** info: { studentName, school, company, position, programType, hours, startDate, endDate, issuedOn, certNo, coordinator?: {name, position} } */
async function buildCertificate(info) {
  const { PDFDocument, StandardFonts, rgb } = load();
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of Completion — ${info.studentName}`);
  doc.setAuthor('ITern');
  const page = doc.addPage([842, 595]); // A4 landscape
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const color = (c) => rgb(...c);
  const W = 842;

  // Standard PDF fonts only cover Latin characters; replace anything else instead of crashing.
  const safe = (font, text) => {
    const ok = new Set(font.getCharacterSet());
    return [...String(text ?? '')].map((ch) => (ok.has(ch.codePointAt(0)) ? ch : '?')).join('');
  };
  const centered = (text, y, size, font, c = INK, maxWidth = 700) => {
    let t = safe(font, text), s = size;
    while (font.widthOfTextAtSize(t, s) > maxWidth && s > 9) s -= 1;
    page.drawText(t, { x: (W - font.widthOfTextAtSize(t, s)) / 2, y, size: s, font, color: color(c) });
  };
  const wrap = (text, font, size, maxWidth) => {
    const lines = []; let line = '';
    for (const word of safe(font, text).split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  // frame
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: 547, borderColor: color(VIOLET), borderWidth: 3 });
  page.drawRectangle({ x: 34, y: 34, width: W - 68, height: 527, borderColor: color(VIOLET), borderWidth: 0.75, opacity: 0.5, borderOpacity: 0.5 });
  page.drawRectangle({ x: 24, y: 541, width: W - 48, height: 30, color: color(VIOLET) });
  centered('ITern  ·  OJT / Internship Program', 551, 11, bold, [1, 1, 1]);

  centered('CERTIFICATE OF COMPLETION', 478, 34, bold, VIOLET);
  centered('This is to certify that', 440, 14, regular, GREY);
  centered(info.studentName, 392, 40, serif, INK, 640);
  page.drawLine({ start: { x: 221, y: 382 }, end: { x: 621, y: 382 }, thickness: 1, color: color(VIOLET) });
  centered(`of ${info.school || 'their school'}`, 357, 14, regular, GREY);

  const hours = Number(info.hours);
  const body = `has successfully completed ${Number.isInteger(hours) ? hours : hours.toFixed(2)} hours of ${info.programType || 'on-the-job training'} as ${info.position} at ${info.company}` +
    (info.startDate && info.endDate ? `, from ${info.startDate} to ${info.endDate}.` : '.');
  wrap(body, regular, 15, 640).forEach((line, i) => centered(line, 318 - i * 22, 15, regular, INK, 700));

  // signatures
  const sig = (cx, name, role) => {
    page.drawLine({ start: { x: cx - 120, y: 140 }, end: { x: cx + 120, y: 140 }, thickness: 0.8, color: color(INK) });
    const n = safe(bold, name), r = safe(regular, role);
    page.drawText(n, { x: cx - bold.widthOfTextAtSize(n, 12) / 2, y: 122, size: 12, font: bold, color: color(INK) });
    page.drawText(r, { x: cx - regular.widthOfTextAtSize(r, 10) / 2, y: 107, size: 10, font: regular, color: color(GREY) });
  };
  sig(info.coordinator ? 230 : 421, info.company, 'Host company');
  if (info.coordinator) sig(612, info.coordinator.name, `${info.coordinator.position || 'OJT Coordinator'}, ${info.school}`);

  centered(`Certificate No. ${info.certNo}   ·   Issued on ${info.issuedOn}`, 62, 10, regular, GREY);
  return Buffer.from(await doc.save());
}

module.exports = { buildCertificate };

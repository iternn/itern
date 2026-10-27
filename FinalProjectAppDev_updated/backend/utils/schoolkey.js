// Students type their school as free text ("TIP", "T.I.P.", "Technological Institute of the Philippines").
// A coordinator is matched to students through a normalised key so harmless differences in
// capitalisation, punctuation and spacing don't split one school into several.
const schoolKey = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // é -> e
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .slice(0, 160) || null;

module.exports = { schoolKey };

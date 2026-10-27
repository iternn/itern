// The documents a student must have on file BEFORE they can apply to any posting.
// To add / rename / remove a requirement, edit this list only — the API and the pages read from it.
// (The resume is checked too, but it lives on the Profile page, so it is not listed here.)
const REQUIRED_DOCS = [
  { key: 'application_letter', label: 'Application letter', hint: 'Addressed to the company, stating the position you want.' },
  { key: 'medical_certificate', label: 'Medical certificate', hint: 'Signed by a licensed physician / school clinic.' },
  { key: 'good_moral', label: 'Certificate of good moral character', hint: 'Issued by your school.' },
  { key: 'school_endorsement', label: 'School endorsement letter', hint: 'From your OJT coordinator or department.' },
];

const DOC_KEYS = REQUIRED_DOCS.map((d) => d.key);

// Skills rules (see routes/interns.js)
const MAX_SKILLS_TOTAL = 15;   // everything on the profile
const MAX_SELF_DECLARED = 5;   // skills typed in by hand (no proof behind them)
const MAX_SELF_LEVEL = 65;     // typed-in skills can't claim "Advanced"; that has to come from the resume / a test
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 +#.\/&()\-]{0,29}$/;

module.exports = { REQUIRED_DOCS, DOC_KEYS, MAX_SKILLS_TOTAL, MAX_SELF_DECLARED, MAX_SELF_LEVEL, SKILL_NAME_RE };

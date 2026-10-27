// Shared wording for posting details — pay, duration, schedule — so every page says it the same way.
import { esc } from './nav.js';

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });

/** 'YYYY-MM-DD' -> local Date (no timezone shift). */
export const parseDay = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtDay = (s) => s ? parseDay(s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function compensationLabel(p) {
  if (p.compensation_type === 'Paid') return `${peso(p.compensation_amount)} / ${p.compensation_period || 'month'}`;
  if (p.compensation_type === 'Allowance') return `${peso(p.compensation_amount)} / ${p.compensation_period || 'day'} allowance`;
  return p.compensation_type === 'Unpaid' ? 'Unpaid' : '';
}
export const compensationTone = (p) => ({ Paid: 'green', Allowance: 'violet', Unpaid: 'blue' }[p.compensation_type] || '');

/** "12 weeks (Jan 5 – Mar 27, 2027)" */
export function durationLabel(p) {
  if (!p.start_date || !p.end_date) return '';
  const days = Math.round((parseDay(p.end_date) - parseDay(p.start_date)) / 86400000) + 1;
  const weeks = Math.max(1, Math.round(days / 7));
  const span = weeks >= 9 ? `${Math.round(weeks / 4.345)} months · ${weeks} weeks` : `${weeks} week${weeks === 1 ? '' : 's'}`;
  return `${span} (${fmtDay(p.start_date)} – ${fmtDay(p.end_date)})`;
}
export const shortDuration = (p) => {
  if (!p.start_date || !p.end_date) return '';
  const weeks = Math.max(1, Math.round(((parseDay(p.end_date) - parseDay(p.start_date)) / 86400000 + 1) / 7));
  return `${weeks} wk${weeks === 1 ? '' : 's'}`;
};

/** ['Mon','Tue','Wed','Fri'] -> "Mon–Wed, Fri" */
export function daysLabel(csv) {
  const days = DAY_ORDER.filter((d) => String(csv || '').split(',').includes(d));
  if (!days.length) return '';
  const runs = []; let start = 0;
  for (let i = 1; i <= days.length; i++) {
    if (i === days.length || DAY_ORDER.indexOf(days[i]) !== DAY_ORDER.indexOf(days[i - 1]) + 1) {
      runs.push(i - 1 - start >= 2 ? `${days[start]}–${days[i - 1]}` : days.slice(start, i).join(', '));
      start = i;
    }
  }
  return runs.join(', ');
}
export function scheduleLabel(p) {
  const days = daysLabel(p.work_days);
  const time = p.shift_start && p.shift_end ? `${fmtTime(p.shift_start)} – ${fmtTime(p.shift_end)}` : '';
  return [days, time].filter(Boolean).join(' · ');
}

/** Days until the application deadline (negative = passed), or null. */
export function daysToDeadline(p) {
  if (!p.application_deadline) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((parseDay(p.application_deadline) - today) / 86400000);
}

/** Small summary chips for list rows. */
export function chipsHTML(p) {
  const chips = [];
  if (p.program_type) chips.push(`<span class="chip violet">${esc(p.program_type)}</span>`);
  const comp = compensationLabel(p);
  if (comp) chips.push(`<span class="chip ${compensationTone(p)}">${esc(comp)}</span>`);
  if (shortDuration(p)) chips.push(`<span class="chip">${esc(shortDuration(p))}</span>`);
  if (p.location) chips.push(`<span class="chip">${esc(p.location)}</span>`);
  const left = daysToDeadline(p);
  if (left !== null && left >= 0 && left <= 7) chips.push(`<span class="chip amber">${left === 0 ? 'Last day to apply' : `${left} day${left === 1 ? '' : 's'} left to apply`}</span>`);
  return chips.length ? `<div class="chips">${chips.join('')}</div>` : '';
}

/** The full details grid (label / value rows) — used in the details popup and on offers. */
export function factsHTML(p) {
  const rows = [
    ['Program', p.program_type],
    ['Work mode', [p.work_mode, p.location].filter(Boolean).join(' · ')],
    ['Duration', durationLabel(p)],
    ['Required hours', p.required_hours ? `${p.required_hours} hours` : ''],
    ['Schedule', scheduleLabel(p)],
    ['Schedule notes', p.schedule_notes],
    ['Pay', compensationLabel(p)],
    ['Benefits', p.benefits],
    ['Apply by', p.application_deadline ? fmtDay(p.application_deadline) : ''],
  ].filter(([, v]) => v);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

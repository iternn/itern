// Validation + helpers for posting details (program type, pay, duration, schedule, deadline).
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODES = ['Remote', 'Hybrid', 'Onsite'];
const STATUSES = ['Draft', 'Active', 'Closed'];
const PROGRAMS = ['OJT', 'Internship'];
const COMP_TYPES = ['Unpaid', 'Allowance', 'Paid'];
const PERIODS = ['day', 'week', 'month'];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const str = (v, max) => (blank(v) ? null : String(v).trim().slice(0, max));

/** Maps a DB row to the camelCase shape the validator works with. */
function fromRow(r = {}) {
  return {
    title: r.title, mode: r.work_mode, capacity: r.capacity, status: r.status,
    programType: r.program_type, location: r.location, description: r.description,
    compensationType: r.compensation_type, compensationAmount: r.compensation_amount,
    compensationPeriod: r.compensation_period, benefits: r.benefits,
    startDate: r.start_date, endDate: r.end_date, requiredHours: r.required_hours,
    workDays: r.work_days, shiftStart: r.shift_start, shiftEnd: r.shift_end,
    scheduleNotes: r.schedule_notes, applicationDeadline: r.application_deadline,
  };
}

/**
 * Validates the full posting state and returns { error } or { row } (DB column -> value).
 * `input` is the complete camelCase posting (for edits: existing values merged with the changes).
 */
function validatePosting(input) {
  const o = {};
  o.title = str(input.title, 160);
  if (!o.title) return { error: 'Give the posting a title.' };

  o.mode = input.mode || 'Remote';
  if (!MODES.includes(o.mode)) return { error: 'Work mode must be Remote, Hybrid or Onsite.' };

  o.capacity = Number(input.capacity ?? 1);
  if (!Number.isInteger(o.capacity) || o.capacity < 1 || o.capacity > 500) return { error: 'Capacity must be a whole number from 1 to 500.' };

  o.status = input.status || 'Draft';
  if (!STATUSES.includes(o.status)) return { error: 'Status must be Draft, Active or Closed.' };

  o.programType = blank(input.programType) ? null : input.programType;
  if (o.programType && !PROGRAMS.includes(o.programType)) return { error: 'Program type must be OJT or Internship.' };

  o.location = str(input.location, 160);
  o.description = str(input.description, 4000);
  o.benefits = str(input.benefits, 255);
  o.scheduleNotes = str(input.scheduleNotes, 255);

  // --- compensation: Unpaid needs no amount; Allowance / Paid need an amount and a period ---
  o.compensationType = blank(input.compensationType) ? null : input.compensationType;
  o.compensationAmount = null; o.compensationPeriod = null;
  if (o.compensationType && !COMP_TYPES.includes(o.compensationType)) return { error: 'Compensation must be Unpaid, Allowance or Paid.' };
  if (o.compensationType === 'Allowance' || o.compensationType === 'Paid') {
    const amount = Number(input.compensationAmount);
    if (blank(input.compensationAmount) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000)
      return { error: `Enter the ${o.compensationType === 'Paid' ? 'pay' : 'allowance'} amount in pesos (more than 0).` };
    o.compensationAmount = Math.round(amount * 100) / 100;
    o.compensationPeriod = input.compensationPeriod || (o.compensationType === 'Paid' ? 'month' : 'day');
    if (!PERIODS.includes(o.compensationPeriod)) return { error: 'Choose whether the amount is per day, week or month.' };
  }

  // --- dates ---
  for (const [key, label] of [['startDate', 'start date'], ['endDate', 'end date'], ['applicationDeadline', 'application deadline']]) {
    o[key] = blank(input[key]) ? null : String(input[key]).slice(0, 10);
    if (o[key] && !isDate(o[key])) return { error: `The ${label} isn't a valid date.` };
  }
  if (o.startDate && o.endDate && o.endDate < o.startDate) return { error: 'The end date must be on or after the start date.' };
  if (o.applicationDeadline && o.startDate && o.applicationDeadline > o.startDate)
    return { error: 'The application deadline must be on or before the start date.' };

  o.requiredHours = blank(input.requiredHours) ? null : Number(input.requiredHours);
  if (o.requiredHours !== null && (!Number.isInteger(o.requiredHours) || o.requiredHours < 1 || o.requiredHours > 2000))
    return { error: 'Required hours must be a whole number between 1 and 2000.' };

  // --- weekly schedule ---
  const dayList = Array.isArray(input.workDays) ? input.workDays : String(input.workDays || '').split(',');
  const days = DAYS.filter((d) => dayList.map((x) => String(x).trim()).includes(d));
  o.workDays = days.length ? days.join(',') : null;
  o.shiftStart = blank(input.shiftStart) ? null : String(input.shiftStart).slice(0, 5);
  o.shiftEnd = blank(input.shiftEnd) ? null : String(input.shiftEnd).slice(0, 5);
  if ((o.shiftStart && !isTime(o.shiftStart)) || (o.shiftEnd && !isTime(o.shiftEnd))) return { error: 'Shift times must look like 09:00.' };
  if (o.shiftStart && o.shiftEnd && o.shiftEnd <= o.shiftStart) return { error: 'The shift must end after it starts.' };

  // --- to publish, students must be able to see the full picture ---
  if (o.status === 'Active') {
    const missing = [];
    if (!o.programType) missing.push('program type');
    if (!o.compensationType) missing.push('compensation');
    if (!o.startDate) missing.push('start date');
    if (!o.endDate) missing.push('end date');
    if (!o.workDays) missing.push('work days');
    if (!o.shiftStart || !o.shiftEnd) missing.push('shift hours');
    if (o.mode !== 'Remote' && !o.location) missing.push('location');
    if (missing.length) return { error: `To publish this posting, add: ${missing.join(', ')}. (Save as Draft if you're not ready.)` };
  }

  return {
    row: {
      title: o.title, work_mode: o.mode, capacity: o.capacity, status: o.status,
      program_type: o.programType, location: o.location, description: o.description,
      compensation_type: o.compensationType, compensation_amount: o.compensationAmount,
      compensation_period: o.compensationPeriod, benefits: o.benefits,
      start_date: o.startDate, end_date: o.endDate, required_hours: o.requiredHours,
      work_days: o.workDays, shift_start: o.shiftStart, shift_end: o.shiftEnd,
      schedule_notes: o.scheduleNotes, application_deadline: o.applicationDeadline,
    },
  };
}

/** What a posting still lacks before an offer can be made (students must see duration + schedule). */
function missingForOffer(p) {
  const missing = [];
  if (!p.start_date || !p.end_date) missing.push('start and end dates');
  if (!p.work_days) missing.push('work days');
  if (!p.shift_start || !p.shift_end) missing.push('shift hours');
  return missing;
}

module.exports = { fromRow, validatePosting, missingForOffer, DAYS };

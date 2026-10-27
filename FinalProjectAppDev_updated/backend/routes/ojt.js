// OJT placement tracking, shared by the student, the host company and the school coordinator:
//   - daily hours (student logs, company approves)
//   - the document checklist (MOA, endorsement letter, waiver, evaluation form)
//   - completion + the PDF certificate
// A "placement" is simply an application whose offer the student accepted.
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { emitTo } = require('../utils/realtime');
const { todayStr, fmtDay } = require('../utils/format');
const { makeUpload, handleUpload, sendStored } = require('../utils/files');
const { buildCertificate } = require('../utils/certificate');
const router = express.Router();

router.use(requireAuth, (req, res, next) => {
  if (!['intern', 'company', 'coordinator'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
  if (req.user.role === 'coordinator' && req.user.accountStatus !== 'Approved')
    return res.status(403).json({ code: 'PENDING_APPROVAL', error: 'Your coordinator account is still waiting for approval by the ITern admin.' });
  next();
});

/* ------------------------------------------------------------------ definitions */

const DOC_TYPES = {
  Endorsement: { label: 'Endorsement letter', hint: 'Issued by your school to the company', uploaders: ['intern', 'coordinator'] },
  MOA: { label: 'Memorandum of Agreement (MOA)', hint: 'Agreement between the school and the company', uploaders: ['intern', 'company', 'coordinator'] },
  Waiver: { label: 'Waiver', hint: 'Signed waiver / parent consent', uploaders: ['intern', 'coordinator'] },
  Evaluation: { label: 'Evaluation form', hint: "The company's end-of-OJT evaluation of the student", uploaders: ['company', 'coordinator'] },
};
const DOC_EXTS = ['pdf', 'jpg', 'jpeg', 'png'];
const docUpload = makeUpload({ dir: process.env.DOCUMENT_UPLOAD_DIR || './uploads/documents', exts: DOC_EXTS, maxMb: 10 });

const PLACEMENT_SQL = `
  SELECT a.id AS application_id, a.completed_at, a.intern_id,
    i.name AS intern_name, i.school, i.school_key, i.program,
    p.id AS posting_id, p.title, p.program_type, p.start_date, p.end_date, p.required_hours,
    p.work_days, p.shift_start, p.shift_end, p.location, p.work_mode,
    c.id AS company_id, c.name AS company_name,
    (SELECT COALESCE(SUM(h.hours), 0) FROM hour_logs h WHERE h.application_id = a.id AND h.status = 'Approved') AS approved_hours,
    (SELECT COALESCE(SUM(h.hours), 0) FROM hour_logs h WHERE h.application_id = a.id AND h.status = 'Pending') AS pending_hours,
    (SELECT COUNT(*) FROM hour_logs h WHERE h.application_id = a.id AND h.status = 'Pending') AS pending_entries,
    (SELECT COUNT(*) FROM placement_documents d WHERE d.application_id = a.id AND d.status = 'Approved') AS docs_approved,
    (SELECT COUNT(*) FROM placement_documents d WHERE d.application_id = a.id AND d.status = 'Submitted') AS docs_submitted,
    (SELECT COUNT(*) FROM coordinators k WHERE k.school_key = i.school_key AND k.account_status = 'Approved') AS coordinators
  FROM applications a
  JOIN postings p ON p.id = a.posting_id
  JOIN companies c ON c.id = p.company_id
  JOIN interns i ON i.id = a.intern_id
  WHERE a.status = 'Accepted'`;

const num = (v) => Math.round(Number(v || 0) * 100) / 100;

/* ------------------------------------------------------------------ access + shaping */

async function coordinatorKey(userId) {
  const [[row]] = await pool.query('SELECT school_key FROM coordinators WHERE id = :id', { id: userId });
  return row?.school_key || '__none__';
}

/** The extra WHERE clause that limits placements to the ones the logged-in user may see. */
async function scope(req) {
  if (req.user.role === 'intern') return { sql: ' AND a.intern_id = :uid', params: { uid: req.user.id } };
  if (req.user.role === 'company') return { sql: ' AND p.company_id = :uid', params: { uid: req.user.id } };
  return { sql: ' AND i.school_key = :key', params: { key: await coordinatorKey(req.user.id) } };
}

async function loadPlacements(req, extraSql = '', extraParams = {}) {
  const sc = await scope(req);
  const [rows] = await pool.query(`${PLACEMENT_SQL}${sc.sql}${extraSql} ORDER BY i.name`, { ...sc.params, ...extraParams });
  return rows;
}
async function loadPlacement(req, applicationId) {
  return (await loadPlacements(req, ' AND a.id = :aid', { aid: applicationId }))[0] || null;
}

const reviewerOf = (row) => (Number(row.coordinators) > 0 ? 'coordinator' : 'company');

function hoursDone(row) {
  const approved = Number(row.approved_hours);
  if (row.required_hours) return approved >= row.required_hours;
  return !!(row.end_date && row.end_date <= todayStr() && approved > 0); // no hour target: done once the placement has ended
}

function shape(row) {
  const approved = num(row.approved_hours);
  const required = row.required_hours || null;
  return {
    id: row.application_id,
    student: { id: row.intern_id, name: row.intern_name, school: row.school, program: row.program },
    company: { id: row.company_id, name: row.company_name },
    posting: {
      id: row.posting_id, title: row.title, program_type: row.program_type, start_date: row.start_date, end_date: row.end_date,
      work_days: row.work_days, shift_start: row.shift_start, shift_end: row.shift_end, location: row.location, work_mode: row.work_mode,
    },
    hours: { approved, pending: num(row.pending_hours), pendingEntries: Number(row.pending_entries), required, percent: required ? Math.min(100, Math.round((approved / required) * 100)) : null },
    docs: { approved: Number(row.docs_approved), submitted: Number(row.docs_submitted), total: Object.keys(DOC_TYPES).length },
    reviewer: reviewerOf(row),
    completedAt: row.completed_at,
  };
}

async function coordinatorIds(schoolKey) {
  const [rows] = await pool.query("SELECT id FROM coordinators WHERE school_key = :k AND account_status = 'Approved'", { k: schoolKey });
  return rows.map((r) => r.id);
}

/** Tells everyone involved (live) that something changed, so their open pages refresh. */
async function broadcastChange(row) {
  emitTo('intern', row.intern_id, 'ojt:changed', { applicationId: row.application_id });
  emitTo('company', row.company_id, 'ojt:changed', { applicationId: row.application_id });
  for (const id of await coordinatorIds(row.school_key)) emitTo('coordinator', id, 'ojt:changed', { applicationId: row.application_id });
}

/* ------------------------------------------------------------------ completion */

async function checkCompletion(applicationId) {
  const [[row]] = await pool.query(`${PLACEMENT_SQL} AND a.id = :aid`, { aid: applicationId });
  if (!row || row.completed_at) return;
  const [[ev]] = await pool.query("SELECT COUNT(*) AS n FROM placement_documents WHERE application_id = :a AND doc_type = 'Evaluation' AND status = 'Approved'", { a: applicationId });
  if (!hoursDone(row) || !Number(ev.n)) return;

  const [claim] = await pool.query('UPDATE applications SET completed_at = NOW() WHERE id = :id AND completed_at IS NULL', { id: applicationId });
  if (!claim.affectedRows) return;
  await notify('intern', row.intern_id, 'ojt_completed', `🎉 You completed your OJT at ${row.company_name}! Your certificate is ready in My OJT.`);
  await notify('company', row.company_id, 'ojt_completed', `${row.intern_name} completed the placement for ${row.title}. The certificate is available under Interns.`);
  for (const id of await coordinatorIds(row.school_key)) await notify('coordinator', id, 'ojt_completed', `${row.intern_name} completed OJT at ${row.company_name}.`);
  await broadcastChange(row);
}

/* ------------------------------------------------------------------ lists */

router.get('/placements', async (req, res) => {
  const rows = await loadPlacements(req);
  const q = String(req.query.q || '').trim().toLowerCase();
  res.json(rows.map(shape).filter((p) => !q || p.student.name.toLowerCase().includes(q) || p.company.name.toLowerCase().includes(q)));
});

router.get('/summary', async (req, res) => {
  if (req.user.role === 'intern') return res.status(403).json({ error: 'Not allowed' });
  const rows = (await loadPlacements(req)).map(shape);
  const out = {
    placements: rows.length,
    completed: rows.filter((p) => p.completedAt).length,
    approvedHours: num(rows.reduce((t, p) => t + p.hours.approved, 0)),
    pendingEntries: rows.reduce((t, p) => t + p.hours.pendingEntries, 0),
    docsAwaiting: rows.reduce((t, p) => t + p.docs.submitted, 0),
  };
  if (req.user.role === 'coordinator') {
    const key = await coordinatorKey(req.user.id);
    out.students = Number((await pool.query('SELECT COUNT(*) AS n FROM interns WHERE school_key = :k', { k: key }))[0][0].n);
    const [needs] = await pool.query(
      `SELECT d.application_id, d.doc_type, d.uploaded_at, i.name AS student, c.name AS company
       FROM placement_documents d JOIN applications a ON a.id = d.application_id
       JOIN interns i ON i.id = a.intern_id JOIN postings p ON p.id = a.posting_id JOIN companies c ON c.id = p.company_id
       WHERE d.status = 'Submitted' AND i.school_key = :k ORDER BY d.uploaded_at ASC LIMIT 8`, { k: key });
    out.needsReview = needs.map((n) => ({ applicationId: n.application_id, docType: n.doc_type, label: DOC_TYPES[n.doc_type]?.label, uploadedAt: n.uploaded_at, student: n.student, company: n.company }));
  }
  res.json(out);
});

router.get('/placements/:id', async (req, res) => {
  const row = await loadPlacement(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Placement not found.' });
  const [hours] = await pool.query('SELECT * FROM hour_logs WHERE application_id = :a ORDER BY log_date DESC, created_at DESC', { a: row.application_id });
  const [docs] = await pool.query('SELECT * FROM placement_documents WHERE application_id = :a', { a: row.application_id });
  const reviewer = reviewerOf(row);
  const [[coord]] = await pool.query(
    "SELECT name, position FROM coordinators WHERE school_key = :k AND account_status = 'Approved' ORDER BY name LIMIT 1", { k: row.school_key });
  const [[ev]] = await pool.query("SELECT COUNT(*) AS n FROM placement_documents WHERE application_id = :a AND doc_type = 'Evaluation' AND status = 'Approved'", { a: row.application_id });

  res.json({
    ...shape(row),
    coordinator: coord || null,
    hoursLog: hours.map((h) => ({ id: h.id, date: h.log_date, hours: num(h.hours), notes: h.notes, status: h.status, reviewerNote: h.reviewer_note, reviewedAt: h.reviewed_at })),
    documents: Object.entries(DOC_TYPES).map(([type, def]) => {
      const d = docs.find((x) => x.doc_type === type);
      return {
        type, label: def.label, hint: def.hint, uploaders: def.uploaders,
        canUpload: def.uploaders.includes(req.user.role) && !row.completed_at,
        canReview: !!d && d.status === 'Submitted' && reviewer === req.user.role,
        id: d?.id || null, status: d ? d.status : 'Missing', fileName: d?.file_name || null, note: d?.reviewer_note || null,
        uploadedBy: d?.uploaded_by || null, uploadedAt: d?.uploaded_at || null, reviewedBy: d?.reviewed_by || null,
      };
    }),
    completion: {
      hoursDone: hoursDone(row), evaluationApproved: Number(ev.n) > 0,
      certificateReady: !!row.completed_at,
    },
  });
});

/* ------------------------------------------------------------------ hours */

async function validateHours(body, placement, ignoreLogId = '') {
  const date = String(body.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return { error: 'Pick the date you worked.' };
  if (date > todayStr()) return { error: "You can't log hours for a future date." };
  if (placement.start_date && date < placement.start_date) return { error: `Your placement starts on ${fmtDay(placement.start_date)} — you can't log hours before that.` };
  if (placement.end_date) {
    const limit = new Date(`${placement.end_date}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 60); // grace period to finish remaining hours
    if (date > limit.toISOString().slice(0, 10)) return { error: 'That date is long after your placement ended. Ask your company to extend the end date first.' };
  }
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 12 || Math.round(hours * 4) !== hours * 4)
    return { error: 'Hours must be between 0.25 and 12, in steps of 15 minutes (0.25).' };
  const notes = String(body.notes || '').trim().slice(0, 255);
  if (notes.length < 3) return { error: 'Add a short note about what you worked on.' };
  const [[day]] = await pool.query(
    "SELECT COALESCE(SUM(hours), 0) AS h FROM hour_logs WHERE application_id = :a AND log_date = :d AND status <> 'Rejected' AND id <> :ex",
    { a: placement.application_id, d: date, ex: ignoreLogId });
  if (Number(day.h) + hours > 12) return { error: `That would make ${num(Number(day.h) + hours)} hours on one day. The daily limit is 12.` };
  return { date, hours, notes };
}

router.post('/placements/:id/hours', async (req, res) => {
  if (req.user.role !== 'intern') return res.status(403).json({ error: 'Only the student logs their own hours.' });
  const row = await loadPlacement(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Placement not found.' });
  if (row.completed_at) return res.status(409).json({ error: 'This placement is already complete.' });
  const v = await validateHours(req.body, row);
  if (v.error) return res.status(400).json({ error: v.error });

  const [[had]] = await pool.query("SELECT COUNT(*) AS n FROM hour_logs WHERE application_id = :a AND status = 'Pending'", { a: row.application_id });
  const id = randomUUID();
  await pool.query('INSERT INTO hour_logs (id, application_id, log_date, hours, notes) VALUES (:id, :a, :d, :h, :n)',
    { id, a: row.application_id, d: v.date, h: v.hours, n: v.notes });
  // One heads-up per batch: only the first waiting entry notifies, so the company isn't spammed.
  if (!Number(had.n)) await notify('company', row.company_id, 'hours_pending', `${row.intern_name} logged hours that are waiting for your approval.`);
  await broadcastChange(row);
  res.status(201).json({ id });
});

async function ownLog(req) {
  const [[log]] = await pool.query(
    `SELECT h.*, a.intern_id, a.completed_at FROM hour_logs h JOIN applications a ON a.id = h.application_id WHERE h.id = :id`, { id: req.params.logId });
  return log && log.intern_id === req.user.id ? log : null;
}

router.patch('/hours/:logId', async (req, res) => {
  if (req.user.role !== 'intern') return res.status(403).json({ error: 'Not allowed' });
  const log = await ownLog(req);
  if (!log) return res.status(404).json({ error: 'Entry not found.' });
  if (log.status === 'Approved') return res.status(409).json({ error: 'Approved hours are locked. Ask your company if something needs fixing.' });
  const row = await loadPlacement(req, log.application_id);
  const v = await validateHours(req.body, row, log.id);
  if (v.error) return res.status(400).json({ error: v.error });
  await pool.query("UPDATE hour_logs SET log_date = :d, hours = :h, notes = :n, status = 'Pending', reviewer_note = NULL, reviewed_at = NULL WHERE id = :id",
    { d: v.date, h: v.hours, n: v.notes, id: log.id });
  await broadcastChange(row);
  res.json({ ok: true });
});

router.delete('/hours/:logId', async (req, res) => {
  if (req.user.role !== 'intern') return res.status(403).json({ error: 'Not allowed' });
  const log = await ownLog(req);
  if (!log) return res.status(404).json({ error: 'Entry not found.' });
  if (log.status === 'Approved') return res.status(409).json({ error: 'Approved hours are locked.' });
  await pool.query('DELETE FROM hour_logs WHERE id = :id', { id: log.id });
  const row = await loadPlacement(req, log.application_id);
  if (row) await broadcastChange(row);
  res.json({ ok: true });
});

// The host company approves or rejects the student's hours.
router.patch('/hours/:logId/review', async (req, res) => {
  if (req.user.role !== 'company') return res.status(403).json({ error: 'Only the host company approves hours.' });
  const { decision } = req.body;
  if (decision !== 'Approve' && decision !== 'Reject') return res.status(400).json({ error: 'decision must be Approve or Reject.' });
  const note = String(req.body.note || '').trim().slice(0, 255);
  if (decision === 'Reject' && note.length < 3) return res.status(400).json({ error: 'Tell the student briefly why these hours were not approved.' });

  const [[log]] = await pool.query('SELECT h.* FROM hour_logs h WHERE h.id = :id', { id: req.params.logId });
  const row = log && await loadPlacement(req, log.application_id);
  if (!row) return res.status(404).json({ error: 'Entry not found.' });
  const status = decision === 'Approve' ? 'Approved' : 'Rejected';
  await pool.query('UPDATE hour_logs SET status = :s, reviewer_note = :n, reviewed_at = NOW() WHERE id = :id', { s: status, n: note || null, id: log.id });

  await notify('intern', row.intern_id, 'hours_reviewed',
    decision === 'Approve'
      ? `${row.company_name} approved your ${num(log.hours)} hours for ${fmtDay(log.log_date)}.`
      : `${row.company_name} did not approve your ${num(log.hours)} hours for ${fmtDay(log.log_date)}: ${note}`);
  await broadcastChange(row);
  if (decision === 'Approve') await checkCompletion(row.application_id);
  res.json({ ok: true, status });
});

router.post('/placements/:id/hours/approve-all', async (req, res) => {
  if (req.user.role !== 'company') return res.status(403).json({ error: 'Only the host company approves hours.' });
  const row = await loadPlacement(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Placement not found.' });
  const [[sum]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h FROM hour_logs WHERE application_id = :a AND status = 'Pending'", { a: row.application_id });
  if (!Number(sum.n)) return res.json({ ok: true, approved: 0 });
  await pool.query("UPDATE hour_logs SET status = 'Approved', reviewer_note = NULL, reviewed_at = NOW() WHERE application_id = :a AND status = 'Pending'", { a: row.application_id });
  await notify('intern', row.intern_id, 'hours_reviewed', `${row.company_name} approved ${num(sum.h)} hours (${sum.n} entr${Number(sum.n) === 1 ? 'y' : 'ies'}).`);
  await broadcastChange(row);
  await checkCompletion(row.application_id);
  res.json({ ok: true, approved: Number(sum.n), hours: num(sum.h) });
});

/* ------------------------------------------------------------------ documents */

router.post('/placements/:id/documents/:type',
  async (req, res, next) => {
    // Check access BEFORE accepting a file, so strangers can't fill the disk.
    const def = DOC_TYPES[req.params.type];
    if (!def) return res.status(400).json({ error: 'Unknown document type.' });
    if (!def.uploaders.includes(req.user.role)) return res.status(403).json({ error: `Your account can't upload the ${def.label.toLowerCase()}.` });
    const row = await loadPlacement(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Placement not found.' });
    if (row.completed_at) return res.status(409).json({ error: 'This placement is already complete.' });
    req.placement = row;
    next();
  },
  (req, res, next) => handleUpload(docUpload, 'file', { exts: DOC_EXTS, maxMb: 10 }, req, res, next),
  async (req, res) => {
    const row = req.placement, type = req.params.type, def = DOC_TYPES[type];
    const reviewer = reviewerOf(row);
    // If the uploader IS the reviewer (e.g. the coordinator uploads, or the company with no coordinator), no second check is needed.
    const autoApprove = req.user.role === reviewer;

    const [[old]] = await pool.query('SELECT id, file_path FROM placement_documents WHERE application_id = :a AND doc_type = :t', { a: row.application_id, t: type });
    await pool.query(
      `INSERT INTO placement_documents (id, application_id, doc_type, file_path, file_name, status, uploaded_by, uploaded_at, reviewed_by, reviewed_at)
       VALUES (:id, :a, :t, :p, :n, :s, :by, NOW(), :rb, :ra)
       ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), file_name = VALUES(file_name), status = VALUES(status), reviewer_note = NULL,
         uploaded_by = VALUES(uploaded_by), uploaded_at = NOW(), reviewed_by = VALUES(reviewed_by), reviewed_at = VALUES(reviewed_at)`,
      { id: randomUUID(), a: row.application_id, t: type, p: req.file.path, n: req.file.cleanName,
        s: autoApprove ? 'Approved' : 'Submitted', by: req.user.role, rb: autoApprove ? req.user.role : null, ra: autoApprove ? new Date() : null });
    if (old?.file_path) require('fs').unlink(old.file_path, () => {});

    if (!autoApprove) {
      const msg = `${req.user.role === 'intern' ? row.intern_name : req.user.role === 'company' ? row.company_name : 'The school coordinator'} submitted the ${def.label.toLowerCase()} for ${row.intern_name}. It needs your review.`;
      if (reviewer === 'company') await notify('company', row.company_id, 'doc_review', msg);
      else for (const id of await coordinatorIds(row.school_key)) await notify('coordinator', id, 'doc_review', msg);
    }
    if (req.user.role !== 'intern') await notify('intern', row.intern_id, 'doc_uploaded', `The ${def.label.toLowerCase()} for your OJT was uploaded${autoApprove ? ' and approved' : ''}.`);
    await broadcastChange(row);
    if (autoApprove && type === 'Evaluation') await checkCompletion(row.application_id);
    res.status(201).json({ ok: true, status: autoApprove ? 'Approved' : 'Submitted' });
  });

async function loadDoc(req) {
  const [[doc]] = await pool.query('SELECT * FROM placement_documents WHERE id = :id', { id: req.params.docId });
  if (!doc) return {};
  return { doc, row: await loadPlacement(req, doc.application_id) };
}

router.get('/documents/:docId/file', async (req, res) => {
  const { doc, row } = await loadDoc(req);
  if (!doc || !row) return res.status(404).json({ error: 'Document not found.' });
  sendStored(res, doc.file_path, { name: doc.file_name, download: req.query.download === '1' });
});

router.patch('/documents/:docId/review', async (req, res) => {
  const { doc, row } = await loadDoc(req);
  if (!doc || !row) return res.status(404).json({ error: 'Document not found.' });
  if (reviewerOf(row) !== req.user.role) return res.status(403).json({ error: `Only the ${reviewerOf(row)} reviews this document.` });
  if (doc.status !== 'Submitted') return res.status(409).json({ error: 'This document is not waiting for review.' });
  const { decision } = req.body;
  if (decision !== 'Approve' && decision !== 'Reject') return res.status(400).json({ error: 'decision must be Approve or Reject.' });
  const note = String(req.body.note || '').trim().slice(0, 255);
  if (decision === 'Reject' && note.length < 3) return res.status(400).json({ error: 'Tell them briefly what to fix.' });

  const status = decision === 'Approve' ? 'Approved' : 'Rejected';
  await pool.query('UPDATE placement_documents SET status = :s, reviewer_note = :n, reviewed_by = :rb, reviewed_at = NOW() WHERE id = :id',
    { s: status, n: note || null, rb: req.user.role, id: doc.id });
  const label = DOC_TYPES[doc.doc_type].label.toLowerCase();
  const msg = decision === 'Approve' ? `Your ${label} was approved.` : `Your ${label} needs changes: ${note}`;
  await notify('intern', row.intern_id, 'doc_reviewed', msg);
  if (doc.uploaded_by === 'company') await notify('company', row.company_id, 'doc_reviewed', `The ${label} for ${row.intern_name} was ${status.toLowerCase()}${decision === 'Reject' ? `: ${note}` : '.'}`);
  await broadcastChange(row);
  if (decision === 'Approve' && doc.doc_type === 'Evaluation') await checkCompletion(row.application_id);
  res.json({ ok: true, status });
});

/* ------------------------------------------------------------------ certificate */

router.get('/placements/:id/certificate', async (req, res) => {
  const row = await loadPlacement(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Placement not found.' });
  if (!row.completed_at) return res.status(409).json({ error: 'The certificate unlocks once all required hours are approved and the evaluation form is approved.' });
  const [[coord]] = await pool.query("SELECT name, position FROM coordinators WHERE school_key = :k AND account_status = 'Approved' ORDER BY name LIMIT 1", { k: row.school_key });
  try {
    const pdf = await buildCertificate({
      studentName: row.intern_name, school: row.school, company: row.company_name, position: row.title, programType: row.program_type,
      hours: row.required_hours && Number(row.approved_hours) >= row.required_hours ? row.required_hours : Number(row.approved_hours),
      startDate: row.start_date ? fmtDay(row.start_date) : '', endDate: row.end_date ? fmtDay(row.end_date) : '',
      issuedOn: fmtDay(new Date(row.completed_at).toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Manila' })),
      certNo: `ITN-${new Date(row.completed_at).getFullYear()}-${row.application_id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      coordinator: coord || null,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="ITern-Certificate-${row.intern_name.replace(/[^\w]+/g, '_')}.pdf"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    });
    res.send(pdf);
  } catch (err) {
    if (err.code === 'PDF_LIB_MISSING') return res.status(501).json({ error: err.message });
    throw err;
  }
});

module.exports = router;

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { emitTo } = require('../utils/realtime');
const { getOrCreateConversation, postMessage } = require('../utils/chat');
const { missingForOffer } = require('../utils/posting');
const { requirementStatus } = require('./requirements');
const router = express.Router();

const STAGES = ['Applied', 'Waitlisted', 'Interviewing', 'Offer', 'Rejected']; // what a company can set
const HOLDS_A_SLOT = "('Applied','Waitlisted','Interviewing','Offer','Accepted')";

// Drops a line into the company <-> student chat (never lets a chat hiccup break the main action).
async function say(internId, companyId, senderType, body, kind = 'text') {
  try {
    const conversation = await getOrCreateConversation(internId, companyId);
    await postMessage({ conversation, senderType, senderId: senderType === 'company' ? companyId : internId, body, kind });
  } catch (err) { console.error('[chat] could not post message:', err.message); }
}
 
router.get('/mine', requireAuth, requireRole('intern'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, p.title, p.work_mode, p.company_id, c.name AS company_name,
       p.program_type, p.location, p.description, p.compensation_type, p.compensation_amount,
       p.compensation_period, p.benefits, p.start_date, p.end_date, p.required_hours,
       p.work_days, p.shift_start, p.shift_end, p.schedule_notes,
       iv.scheduled_at, iv.mode AS interview_mode, iv.meeting_link, iv.interviewer
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN companies c ON c.id = p.company_id
     LEFT JOIN interviews iv ON iv.id = (
       SELECT i2.id FROM interviews i2 WHERE i2.application_id = a.id
       ORDER BY i2.scheduled_at DESC LIMIT 1)
     WHERE a.intern_id = :id ORDER BY a.applied_at DESC`,
    { id: req.user.id }
  );
  // The shortlist star and notes are the company's private working data — students never see them.
  rows.forEach((r) => { delete r.company_notes; delete r.shortlisted; });
  res.json(rows);
});

router.get('/company', requireAuth, requireRole('company'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, p.title, i.id AS intern_id, i.name AS intern_name, i.school, i.program,
       iv.scheduled_at, iv.mode AS interview_mode, iv.meeting_link, iv.interviewer
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN interns i ON i.id = a.intern_id
     LEFT JOIN interviews iv ON iv.id = (
       SELECT i2.id FROM interviews i2 WHERE i2.application_id = a.id
       ORDER BY i2.scheduled_at DESC LIMIT 1)
     WHERE p.company_id = :id ORDER BY a.match_score DESC`,
    { id: req.user.id }
  );
  res.json(rows);
});
 
router.post('/', requireAuth, requireRole('intern'), async (req, res) => {
  const { postingId } = req.body;
  // Requirements first: a student can't apply until every required document is on file.
  const reqs = await requirementStatus(req.user.id);
  if (!reqs.complete) return res.status(400).json({ code: 'REQUIREMENTS_INCOMPLETE', missing: reqs.missing, error: `Submit your requirements first: ${reqs.missing.join(', ')}.` });
  const [[existing]] = await pool.query('SELECT id FROM applications WHERE intern_id = :i AND posting_id = :p', { i: req.user.id, p: postingId });
  if (existing) return res.status(409).json({ error: 'Already applied to this posting.' });
 
  const [[posting]] = await pool.query("SELECT p.capacity, p.status, p.application_deadline, c.account_status AS company_status FROM postings p JOIN companies c ON c.id = p.company_id WHERE p.id = :id", { id: postingId });
  if (!posting) return res.status(404).json({ error: 'Posting not found.' });
  if (posting.status !== 'Active' || posting.company_status !== 'Approved') return res.status(400).json({ error: 'This posting is no longer accepting applications.' });
  if (posting.application_deadline && posting.application_deadline < new Date().toISOString().slice(0, 10))
    return res.status(400).json({ error: 'The application deadline for this posting has passed.' });
  const [[{ filled }]] = await pool.query(
    `SELECT COUNT(*) AS filled FROM applications WHERE posting_id = :id AND status IN ${HOLDS_A_SLOT}`,
    { id: postingId }
  );
  const status = filled >= posting.capacity ? 'Waitlisted' : 'Applied';
 
  // The ML service is the source of truth for the score. If it is down, compute the SAME formula here
  // so the stored score is never a misleading 0.
  let matchScore = null;
  try {
    const r = await fetch(`${process.env.ML_SERVICE_URL}/score`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ internId: req.user.id, postingId }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) ({ score: matchScore } = await r.json());
  } catch { /* ML service not reachable - fall through to the local calculation */ }
  if (matchScore === null) matchScore = await localMatchScore(req.user.id, postingId);

  await pool.query(
    'INSERT INTO applications (id, intern_id, posting_id, status, match_score) VALUES (UUID(), :i, :p, :status, :score)',
    { i: req.user.id, p: postingId, status, score: matchScore }
  );
  const [[owner]] = await pool.query('SELECT p.company_id, p.title, i.name FROM postings p, interns i WHERE p.id = :p AND i.id = :i', { p: postingId, i: req.user.id });
  if (owner) {
    await notify('company', owner.company_id, 'new_applicant', `${owner.name} applied to ${owner.title}.`);
    emitTo('company', owner.company_id, 'applications:changed', { postingId });
  }
  emitTo('intern', req.user.id, 'applications:changed', { postingId });
  if (status === 'Waitlisted') {
    await notify('intern', req.user.id, 'waitlist_added', "You're on the waitlist — you'll be notified if a spot opens.");
  }
  res.status(201).json({ status });
});
 
// Same formula as ml/skill_matcher.py compute_score(): 60% coverage + 40% weighted strength; 12 if nothing overlaps.
async function localMatchScore(internId, postingId) {
  try {
    const [mine] = await pool.query(
      'SELECT s.name, isk.level FROM intern_skills isk JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = :i', { i: internId });
    let wanted;
    try {
      [wanted] = await pool.query('SELECT s.name, ps.weight AS weight FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.posting_id = :p', { p: postingId });
    } catch { // older database without a weight column
      [wanted] = await pool.query('SELECT s.name, 1 AS weight FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.posting_id = :p', { p: postingId });
    }
    if (!wanted.length) return 0;
    const have = new Map(mine.map((r) => [r.name.toLowerCase(), r.level]));
    const matched = wanted.filter((w) => have.has(w.name.toLowerCase()));
    if (!matched.length) return 12;
    const w = (x) => Number(x.weight) || 1;
    const coverage = matched.length / wanted.length;
    const totalW = matched.reduce((a, x) => a + 100 * w(x), 0);
    const strength = totalW ? matched.reduce((a, x) => a + have.get(x.name.toLowerCase()) * w(x), 0) / totalW : 0;
    return Math.round((coverage * 0.6 + strength * 0.4) * 100);
  } catch (err) { console.error('[score] local fallback failed:', err.message); return 0; }
}

// Loads an application only if it belongs to one of THIS company's postings.
async function ownedApplication(req) {
  const [[app]] = await pool.query(
    `SELECT a.*, p.title, p.company_id, p.start_date, p.end_date, p.work_days, p.shift_start, p.shift_end
     FROM applications a JOIN postings p ON p.id = a.posting_id
     WHERE a.id = :id AND p.company_id = :c`,
    { id: req.params.id, c: req.user.id }
  );
  return app || null;
}

router.patch('/:id/status', requireAuth, requireRole('company'), async (req, res) => {
  const { status } = req.body;
  if (!STAGES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STAGES.join(', ')}.` });
  const app = await ownedApplication(req);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status === status) return res.json({ ok: true });
  if (app.status === 'Accepted' || app.status === 'Declined')
    return res.status(409).json({ error: `The student already ${app.status === 'Accepted' ? 'accepted' : 'declined'} this offer, so the status is locked.` });

  // The student must be able to see the duration and schedule before they accept, so an offer needs them.
  if (status === 'Offer') {
    const missing = missingForOffer(app);
    if (missing.length) return res.status(400).json({ error: `Before making an offer, add the ${missing.join(' and ')} to this posting (Postings → Edit).` });
  }

  await pool.query('UPDATE applications SET status = :status WHERE id = :id', { status, id: app.id });
  const [[co]] = await pool.query('SELECT name FROM companies WHERE id = :id', { id: req.user.id });
  const message = status === 'Offer'
    ? `${co.name} extended you an offer for ${app.title}! Open Applications to review the details and respond.`
    : `Your application for ${app.title} is now: ${status}.`;
  await notify('intern', app.intern_id, status === 'Offer' ? 'offer_extended' : 'status_change', message);
  emitTo('intern', app.intern_id, 'applications:changed', { applicationId: app.id });

  // Chat: a system line for offers, and the company's own words (if they wrote any) for rejections.
  if (status === 'Offer') await say(app.intern_id, req.user.id, 'company', `Offer extended for ${app.title}. Review the duration, schedule and allowance in Applications, then accept or decline.`, 'system');
  const note = String(req.body.message || '').trim().slice(0, 1000);
  if (status === 'Rejected' && note) await say(app.intern_id, req.user.id, 'company', note);

  if (status === 'Rejected') await promoteNextWaitlisted(app.posting_id);
  res.json({ ok: true });
});

// The student's answer to an offer.
router.post('/:id/respond', requireAuth, requireRole('intern'), async (req, res) => {
  const decision = req.body.decision;
  if (decision !== 'Accept' && decision !== 'Decline') return res.status(400).json({ error: 'decision must be Accept or Decline.' });

  const [[app]] = await pool.query(
    `SELECT a.*, p.title, p.company_id, i.name AS intern_name
     FROM applications a JOIN postings p ON p.id = a.posting_id JOIN interns i ON i.id = a.intern_id
     WHERE a.id = :id AND a.intern_id = :i`,
    { id: req.params.id, i: req.user.id }
  );
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status === 'Accepted' || app.status === 'Declined') return res.status(409).json({ error: `You already ${app.status.toLowerCase()} this offer.` });
  if (app.status !== 'Offer') return res.status(409).json({ error: 'There is no offer to respond to on this application.' });

  const next = decision === 'Accept' ? 'Accepted' : 'Declined';
  const [r] = await pool.query(
    "UPDATE applications SET status = :s, responded_at = NOW() WHERE id = :id AND status = 'Offer'",
    { s: next, id: app.id }
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'This offer was just changed. Refresh and try again.' });

  const reason = String(req.body.reason || '').trim().slice(0, 500);
  await notify('company', app.company_id, decision === 'Accept' ? 'offer_accepted' : 'offer_declined',
    `${app.intern_name} ${decision === 'Accept' ? 'accepted' : 'declined'} your offer for ${app.title}.${decision === 'Decline' && reason ? ` Reason: ${reason}` : ''}`);
  emitTo('company', app.company_id, 'applications:changed', { applicationId: app.id });
  emitTo('intern', req.user.id, 'applications:changed', { applicationId: app.id });
  await say(req.user.id, app.company_id, 'intern',
    decision === 'Accept' ? `I accepted the offer for ${app.title}.` : `I declined the offer for ${app.title}.${reason ? ` ${reason}` : ''}`, 'system');

  if (decision === 'Decline') await promoteNextWaitlisted(app.posting_id); // frees the slot
  res.json({ ok: true, status: next });
});

// Company-only working data: shortlist star + private notes (never sent to students).
router.patch('/:id/shortlist', requireAuth, requireRole('company'), async (req, res) => {
  const app = await ownedApplication(req);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const value = req.body.shortlisted ? 1 : 0;
  await pool.query('UPDATE applications SET shortlisted = :v WHERE id = :id', { v: value, id: app.id });
  res.json({ ok: true, shortlisted: !!value });
});

router.patch('/:id/notes', requireAuth, requireRole('company'), async (req, res) => {
  const app = await ownedApplication(req);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const notes = String(req.body.notes ?? '').slice(0, 4000);
  await pool.query('UPDATE applications SET company_notes = :n WHERE id = :id', { n: notes || null, id: app.id });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole('intern'), async (req, res) => {
  const [[app]] = await pool.query('SELECT * FROM applications WHERE id = :id AND intern_id = :i', { id: req.params.id, i: req.user.id });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  await pool.query('DELETE FROM applications WHERE id = :id', { id: req.params.id });
  const [[own]] = await pool.query('SELECT company_id FROM postings WHERE id = :p', { p: app.posting_id });
  if (own) emitTo('company', own.company_id, 'applications:changed', { postingId: app.posting_id });
  await promoteNextWaitlisted(app.posting_id);
  res.json({ ok: true });
});
 
async function promoteNextWaitlisted(postingId) {
  const [[next]] = await pool.query(
    `SELECT id, intern_id FROM applications WHERE posting_id = :p AND status = 'Waitlisted'
     ORDER BY applied_at ASC LIMIT 1`,
    { p: postingId }
  );
  if (!next) return;
  await pool.query("UPDATE applications SET status = 'Applied' WHERE id = :id", { id: next.id });
  await notify('intern', next.intern_id, 'waitlist_promoted', "A spot opened up — your application moved from Waitlisted to Applied.");
  emitTo('intern', next.intern_id, 'applications:changed', { applicationId: next.id });
}
 
module.exports = router;

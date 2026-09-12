const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const router = express.Router();
 
router.get('/mine', requireAuth, requireRole('intern'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, p.title, p.work_mode, p.company_id, c.name AS company_name,
       iv.scheduled_at, iv.mode AS interview_mode, iv.meeting_link
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN companies c ON c.id = p.company_id
     LEFT JOIN interviews iv ON iv.application_id = a.id
     WHERE a.intern_id = :id ORDER BY a.applied_at DESC`,
    { id: req.user.id }
  );
  res.json(rows);
});
 
router.get('/company', requireAuth, requireRole('company'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, p.title, i.id AS intern_id, i.name AS intern_name, i.school, i.program
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN interns i ON i.id = a.intern_id
     WHERE p.company_id = :id ORDER BY a.match_score DESC`,
    { id: req.user.id }
  );
  res.json(rows);
});
 
router.post('/', requireAuth, requireRole('intern'), async (req, res) => {
  const { postingId } = req.body;
  const [[existing]] = await pool.query('SELECT id FROM applications WHERE intern_id = :i AND posting_id = :p', { i: req.user.id, p: postingId });
  if (existing) return res.status(409).json({ error: 'Already applied to this posting.' });
 
  const [[posting]] = await pool.query('SELECT capacity FROM postings WHERE id = :id', { id: postingId });
  if (!posting) return res.status(404).json({ error: 'Posting not found.' });
  const [[{ filled }]] = await pool.query(
    `SELECT COUNT(*) AS filled FROM applications WHERE posting_id = :id AND status IN ('Applied','Waitlisted','Interviewing','Offer')`,
    { id: postingId }
  );
  const status = filled >= posting.capacity ? 'Waitlisted' : 'Applied';
 
  let matchScore = 0;
  try {
    const r = await fetch(`${process.env.ML_SERVICE_URL}/score`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ internId: req.user.id, postingId }),
    });
    if (r.ok) ({ score: matchScore } = await r.json());
  } catch { /* ML service not running yet — fine, score stays 0 until Day 6 */ }
 
  await pool.query(
    'INSERT INTO applications (id, intern_id, posting_id, status, match_score) VALUES (UUID(), :i, :p, :status, :score)',
    { i: req.user.id, p: postingId, status, score: matchScore }
  );
  if (status === 'Waitlisted') {
    await notify('intern', req.user.id, 'waitlist_added', "You're on the waitlist — you'll be notified if a spot opens.");
  }
  res.status(201).json({ status });
});
 
router.patch('/:id/status', requireAuth, requireRole('company'), async (req, res) => {
  const { status } = req.body;
  const [[app]] = await pool.query('SELECT * FROM applications WHERE id = :id', { id: req.params.id });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
 
  await pool.query('UPDATE applications SET status = :status WHERE id = :id', { status, id: req.params.id });
  await notify('intern', app.intern_id, 'status_change', `Your application status changed to ${status}.`);
  if (status === 'Rejected') await promoteNextWaitlisted(app.posting_id);
  res.json({ ok: true });
});
 
router.delete('/:id', requireAuth, requireRole('intern'), async (req, res) => {
  const [[app]] = await pool.query('SELECT * FROM applications WHERE id = :id AND intern_id = :i', { id: req.params.id, i: req.user.id });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  await pool.query('DELETE FROM applications WHERE id = :id', { id: req.params.id });
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
}
 
module.exports = router;

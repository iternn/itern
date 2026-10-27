const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { broadcast } = require('../utils/realtime');
const { fromRow, validatePosting } = require('../utils/posting');
const { randomUUID } = require('crypto');
const router = express.Router();
 
router.get('/', async (req, res) => { // public — used by the student Matches page
  const [rows] = await pool.query(
    `SELECT p.*, c.name AS company_name,
       (SELECT GROUP_CONCAT(s.name) FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id
        WHERE ps.posting_id = p.id) AS skills
     FROM postings p JOIN companies c ON c.id = p.company_id
     WHERE p.status = 'Active' AND c.account_status = 'Approved' AND (p.application_deadline IS NULL OR p.application_deadline >= CURDATE())
     ORDER BY p.posted_at DESC`
  );
  res.json(rows);
});
 
router.get('/mine', requireAuth, requireRole('company'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*,
       (SELECT GROUP_CONCAT(s.name) FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id
        WHERE ps.posting_id = p.id) AS skills,
       (SELECT COUNT(*) FROM applications a WHERE a.posting_id = p.id) AS applicant_count
     FROM postings p WHERE p.company_id = :id ORDER BY p.created_at DESC`,
    { id: req.user.id }
  );
  res.json(rows);
});
 
const COLUMNS = ['title', 'work_mode', 'capacity', 'status', 'program_type', 'location', 'description',
  'compensation_type', 'compensation_amount', 'compensation_period', 'benefits', 'start_date', 'end_date',
  'required_hours', 'work_days', 'shift_start', 'shift_end', 'schedule_notes', 'application_deadline'];

router.post('/', requireAuth, requireRole('company'), async (req, res) => {
  const { row, error } = validatePosting({ ...req.body, mode: req.body.mode });
  if (error) return res.status(400).json({ error });
  if (row.status === 'Active' && req.user.accountStatus !== 'Approved') return res.status(403).json({ code: 'PENDING_APPROVAL', error: 'Your company is still waiting for admin approval, so you can save drafts but not publish yet.' });

  const id = randomUUID();
  const params = { id, c: req.user.id, postedAt: row.status === 'Active' ? new Date() : null, ...row };
  await pool.query(
    `INSERT INTO postings (id, company_id, posted_at, ${COLUMNS.join(', ')})
     VALUES (:id, :c, :postedAt, ${COLUMNS.map((c) => ':' + c).join(', ')})`,
    params
  );
  await syncSkills(id, Array.isArray(req.body.skills) ? req.body.skills : []);
  const [[posting]] = await pool.query('SELECT * FROM postings WHERE id = :id', { id });
  broadcast('postings:changed', {});
  res.status(201).json(posting);
});

router.patch('/:id', requireAuth, requireRole('company'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT * FROM postings WHERE id = :id AND company_id = :c', { id: req.params.id, c: req.user.id });
  if (!existing) return res.status(404).json({ error: 'Posting not found.' });

  // Validate the posting as it WILL look after this edit (current values + the changes).
  const merged = { ...fromRow(existing) };
  for (const key of Object.keys(req.body)) if (key !== 'skills') merged[key] = req.body[key];
  const { row, error } = validatePosting(merged);
  if (error) return res.status(400).json({ error });
  if (row.status === 'Active' && req.user.accountStatus !== 'Approved') return res.status(403).json({ code: 'PENDING_APPROVAL', error: 'Your company is still waiting for admin approval, so you can save drafts but not publish yet.' });

  const sets = COLUMNS.map((c) => `${c} = :${c}`);
  if (row.status === 'Active') sets.push('posted_at = IFNULL(posted_at, NOW())');
  await pool.query(`UPDATE postings SET ${sets.join(', ')} WHERE id = :id`, { id: req.params.id, ...row });
  if (Array.isArray(req.body.skills)) await syncSkills(req.params.id, req.body.skills);

  const [[posting]] = await pool.query('SELECT * FROM postings WHERE id = :id', { id: req.params.id });
  broadcast('postings:changed', {});
  res.json(posting);
});

router.delete('/:id', requireAuth, requireRole('company'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM postings WHERE id = :id AND company_id = :c', { id: req.params.id, c: req.user.id });
  if (!result.affectedRows) return res.status(404).json({ error: 'Posting not found.' });
  broadcast('postings:changed', {});
  res.json({ ok: true });
});
 
async function syncSkills(postingId, skillNames) {
  await pool.query('DELETE FROM posting_skills WHERE posting_id = :id', { id: postingId });
  for (const name of skillNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    await pool.query('INSERT INTO skills (name) VALUES (:name) ON DUPLICATE KEY UPDATE name = VALUES(name)', { name: trimmed });
    const [[row]] = await pool.query('SELECT id FROM skills WHERE name = :name', { name: trimmed });
    await pool.query('INSERT IGNORE INTO posting_skills (posting_id, skill_id) VALUES (:p, :s)', { p: postingId, s: row.id });
  }
}
 
module.exports = router;

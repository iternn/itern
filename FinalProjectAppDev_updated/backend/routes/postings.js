const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();
 
router.get('/', async (req, res) => { // public — used by the student Matches page
  const [rows] = await pool.query(
    `SELECT p.*, c.name AS company_name,
       (SELECT GROUP_CONCAT(s.name) FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id
        WHERE ps.posting_id = p.id) AS skills
     FROM postings p JOIN companies c ON c.id = p.company_id
     WHERE p.status = 'Active' ORDER BY p.posted_at DESC`
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
 
router.post('/', requireAuth, requireRole('company'), async (req, res) => {
  const { title, mode = 'Remote', capacity = 1, status = 'Draft', skills = [] } = req.body;
  await pool.query(
    `INSERT INTO postings (id, company_id, title, work_mode, capacity, status, posted_at)
     VALUES (UUID(), :c, :title, :mode, :capacity, :status, :postedAt)`,
    { c: req.user.id, title, mode, capacity, status, postedAt: status === 'Active' ? new Date() : null }
  );
  const [[posting]] = await pool.query('SELECT * FROM postings WHERE company_id = :c ORDER BY created_at DESC LIMIT 1', { c: req.user.id });
  await syncSkills(posting.id, skills);
  res.status(201).json(posting);
});
 
router.patch('/:id', requireAuth, requireRole('company'), async (req, res) => {
  const [[owned]] = await pool.query('SELECT id FROM postings WHERE id = :id AND company_id = :c', { id: req.params.id, c: req.user.id });
  if (!owned) return res.status(404).json({ error: 'Posting not found.' });
 
  const { title, mode, status, capacity, skills } = req.body;
  const fields = [], params = { id: req.params.id };
  if (title !== undefined) { fields.push('title = :title'); params.title = title; }
  if (mode !== undefined) { fields.push('work_mode = :mode'); params.mode = mode; }
  if (capacity !== undefined) { fields.push('capacity = :capacity'); params.capacity = capacity; }
  if (status !== undefined) {
    fields.push('status = :status'); params.status = status;
    if (status === 'Active') fields.push('posted_at = IFNULL(posted_at, NOW())');
  }
  if (fields.length) await pool.query(`UPDATE postings SET ${fields.join(', ')} WHERE id = :id`, params);
  if (Array.isArray(skills)) await syncSkills(req.params.id, skills);
 
  const [[posting]] = await pool.query('SELECT * FROM postings WHERE id = :id', { id: req.params.id });
  res.json(posting);
});
 
router.delete('/:id', requireAuth, requireRole('company'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM postings WHERE id = :id AND company_id = :c', { id: req.params.id, c: req.user.id });
  if (!result.affectedRows) return res.status(404).json({ error: 'Posting not found.' });
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

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();
 
const uploadDir = process.env.RESUME_UPLOAD_DIR || './uploads/resumes';
fs.mkdirSync(uploadDir, { recursive: true });
 
router.get('/me', requireAuth, requireRole('intern'), async (req, res) => {
  const [[intern]] = await pool.query(
    'SELECT id, name, email, school, program, career_goal, resume_path FROM interns WHERE id = :id',
    { id: req.user.id }
  );
  const [skills] = await pool.query(
    `SELECT s.name, isk.level, isk.source FROM intern_skills isk
     JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = :id`,
    { id: req.user.id }
  );
  res.json({ ...intern, skills });
});
 
router.patch('/me', requireAuth, requireRole('intern'), async (req, res) => {
  const { careerGoal, skills } = req.body;
  if (careerGoal !== undefined) {
    await pool.query('UPDATE interns SET career_goal = :careerGoal WHERE id = :id', { careerGoal, id: req.user.id });
  }
if (Array.isArray(skills)) {
    await pool.query('DELETE FROM intern_skills WHERE intern_id = :id', { id: req.user.id });
    for (const s of skills) {
      await pool.query('INSERT INTO skills (name) VALUES (:name) ON DUPLICATE KEY UPDATE name = VALUES(name)', { name: s.name });
      const [[row]] = await pool.query('SELECT id FROM skills WHERE name = :name', { name: s.name });
      await pool.query(
        'INSERT INTO intern_skills (intern_id, skill_id, level, source) VALUES (:i, :s, :l, "manual")',
        { i: req.user.id, s: row.id, l: s.level || 50 }
      );
    }
  }
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${req.user.id}_${Date.now()}.pdf`),
  }),
  limits: { fileSize: (Number(process.env.RESUME_MAX_MB) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('ONLY_PDF'));
    cb(null, true);
  },
});
 
router.post('/resume', requireAuth, requireRole('intern'), (req, res) => {
  upload.single('resume')(req, res, async (err) => {
    if (err) {
      if (err.message === 'ONLY_PDF') return res.status(415).json({ error: 'Only PDF resumes are accepted.' });
      return res.status(400).json({ error: err.message });
    }
    await pool.query('UPDATE interns SET resume_path = :p, resume_uploaded_at = NOW() WHERE id = :id',
      { p: req.file.path, id: req.user.id });

    // Hand off to the ML service to extract skills from the PDF text.
    try {
      const r = await fetch(`${process.env.ML_SERVICE_URL}/extract-skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internId: req.user.id, filePath: req.file.path }),
      });
      if (r.ok) await pool.query('UPDATE interns SET resume_parsed_at = NOW() WHERE id = :id', { id: req.user.id });
    } catch {
      // ML service not running — resume is still saved, extraction can be retried later.
    }

    res.json({ ok: true, fileName: req.file.filename });
  });
});
 
// Used by the company Applicants page (Day 5) to view a student's profile —
// never exposes the password hash.
router.get('/:id/public', requireAuth, requireRole('company'), async (req, res) => {
  const [[intern]] = await pool.query(
    'SELECT id, name, school, program, career_goal, resume_path FROM interns WHERE id = :id',
    { id: req.params.id }
  );
  if (!intern) return res.status(404).json({ error: 'Not found' });
  const [skills] = await pool.query(
    `SELECT s.name, isk.level, isk.source FROM intern_skills isk
     JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = :id`,
    { id: req.params.id }
  );
  const [testScores] = await pool.query(
    `SELECT s.name AS skill, MAX(a.score_pct) AS best_score FROM skill_test_attempts a
     JOIN skills s ON s.id = a.skill_id WHERE a.intern_id = :id GROUP BY s.name`,
    { id: req.params.id }
  );
  res.json({ ...intern, skills, testScores });
});
 
module.exports = router;

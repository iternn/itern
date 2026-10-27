const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { hasApplicationBetween } = require('../utils/chat');
const { getCatalog, canonical } = require('../utils/skillCatalog');
const { MAX_SKILLS_TOTAL, MAX_SELF_DECLARED, MAX_SELF_LEVEL, SKILL_NAME_RE } = require('../utils/requirements');
const router = express.Router();
 
const uploadDir = process.env.RESUME_UPLOAD_DIR || './uploads/resumes';
fs.mkdirSync(uploadDir, { recursive: true });
 
router.get('/me', requireAuth, requireRole('intern'), async (req, res) => {
  const [[intern]] = await pool.query(
    'SELECT id, name, email, school, program, career_goal, resume_path, resume_original_name, resume_uploaded_at FROM interns WHERE id = :id',
    { id: req.user.id }
  );
  const [skills] = await pool.query(
    `SELECT s.name, isk.level, isk.source FROM intern_skills isk
     JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = :id`,
    { id: req.user.id }
  );
  res.json({ ...intern, skills, skillLimits: { total: MAX_SKILLS_TOTAL, selfDeclared: MAX_SELF_DECLARED, selfLevel: MAX_SELF_LEVEL } });
});
 
router.get('/skill-catalog', requireAuth, requireRole('intern'), async (req, res) => {
  res.json(await getCatalog());
});

router.patch('/me', requireAuth, requireRole('intern'), async (req, res) => {
  const { careerGoal, skills } = req.body;
  if (careerGoal !== undefined) {
    await pool.query('UPDATE interns SET career_goal = :careerGoal WHERE id = :id', { careerGoal: String(careerGoal).slice(0, 160), id: req.user.id });
  }
  if (Array.isArray(skills)) {
    // What's already saved (name -> { level, source }). Skills that came from the resume / a skills test keep
    // their source and level: the student can remove them, but can't re-label them or inflate their level.
    const [saved] = await pool.query(
      `SELECT s.name, isk.level, isk.source FROM intern_skills isk JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = :id`,
      { id: req.user.id });
    const savedByName = new Map(saved.map((r) => [r.name.toLowerCase(), r]));
    const oldSelfCount = saved.filter((r) => r.source === 'manual').length;

    const catalog = await getCatalog();
    const clean = [];
    const seen = new Set();
    for (const s of skills) {
      const name = String(s?.name ?? '').trim().replace(/\s+/g, ' ');
      if (!name) continue;
      if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: `"${name.slice(0, 30)}" isn't a valid skill name. Use letters, numbers and + # . / & ( ) - only, up to 30 characters.` });
      if (seen.has(name.toLowerCase())) continue;   // no duplicates
      seen.add(name.toLowerCase());
      const existing = savedByName.get(name.toLowerCase());
      if (existing) clean.push({ name, level: existing.level, source: existing.source });
      else {
        const approved = canonical(name, catalog);
        if (!approved) return res.status(400).json({ error: `"${name}" isn't on our skills list. Pick a skill from the suggestions.` });
        clean.push({ name: approved, level: Math.min(Math.max(Number(s.level) || 35, 1), MAX_SELF_LEVEL), source: 'manual' });
      }
    }

    if (clean.length > MAX_SKILLS_TOTAL) return res.status(400).json({ error: `You can list up to ${MAX_SKILLS_TOTAL} skills. Remove a few and try again.` });
    const selfCount = clean.filter((c) => c.source === 'manual').length;
    if (selfCount > Math.max(MAX_SELF_DECLARED, oldSelfCount))
      return res.status(400).json({ error: `You can add up to ${MAX_SELF_DECLARED} skills by hand. Upload your resume or take a skills test to verify more.` });

    await pool.query('DELETE FROM intern_skills WHERE intern_id = :id', { id: req.user.id });
    for (const c of clean) {
      await pool.query('INSERT INTO skills (name) VALUES (:name) ON DUPLICATE KEY UPDATE name = name', { name: c.name });
      const [[row]] = await pool.query('SELECT id FROM skills WHERE name = :name', { name: c.name });
      await pool.query(
        'INSERT INTO intern_skills (intern_id, skill_id, level, source) VALUES (:i, :s, :l, :src) ON DUPLICATE KEY UPDATE level = VALUES(level)',
        { i: req.user.id, s: row.id, l: c.level, src: c.source }
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
  upload.single('resume')(req, res, (err) => { Promise.resolve((async () => {
    if (err) {
      if (err.message === 'ONLY_PDF') return res.status(415).json({ error: 'Only PDF resumes are accepted.' });
      return res.status(400).json({ error: err.message });
    }
    // multer reads file names as latin1; convert so names like "Résumé.pdf" survive.
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255);
    await pool.query('UPDATE interns SET resume_path = :p, resume_original_name = :n, resume_uploaded_at = NOW() WHERE id = :id',
      { p: req.file.path, n: originalName, id: req.user.id });

    // Hand off to the ML service to extract skills from the PDF text.
    try {
      const r = await fetch(`${process.env.ML_SERVICE_URL}/extract-skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internId: req.user.id, filePath: path.resolve(req.file.path) }),
      });
      if (r.ok) {
        await pool.query('UPDATE interns SET resume_parsed_at = NOW() WHERE id = :id', { id: req.user.id });
      } else {
        console.error('ML extraction failed:', r.status, await r.text());
      }
    } catch (err) {
      console.error('Could not reach ML service:', err.message);
    }

    res.json({ ok: true, fileName: originalName });
  })()).catch((e) => res.status(500).json({ error: e.message }));
  });
});
 
// Streams a stored resume PDF. The files are behind login (not the open /uploads folder),
// so the browser fetches them with its token and shows them in an in-page viewer.
function sendResume(res, resumePath, displayName, download) {
  if (!resumePath) return res.status(404).json({ error: 'No resume on file.' });
  const abs = path.resolve(resumePath);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'The resume file could not be found. Please upload it again.' });
  const safeName = (displayName || 'resume.pdf').replace(/[\r\n"]/g, '');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  res.sendFile(abs);
}

router.get('/me/resume', requireAuth, requireRole('intern'), async (req, res) => {
  const [[row]] = await pool.query('SELECT resume_path, resume_original_name FROM interns WHERE id = :id', { id: req.user.id });
  sendResume(res, row?.resume_path, row?.resume_original_name, req.query.download === '1');
});

// A company may open the resume of students who applied to one of its postings.
router.get('/:id/resume', requireAuth, requireRole('company'), async (req, res) => {
  if (!(await hasApplicationBetween(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not allowed.' });
  const [[row]] = await pool.query('SELECT resume_path, resume_original_name FROM interns WHERE id = :id', { id: req.params.id });
  sendResume(res, row?.resume_path, row?.resume_original_name, req.query.download === '1');
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

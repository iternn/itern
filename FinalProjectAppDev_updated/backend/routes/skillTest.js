const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();
 
router.get('/:skillName/questions', requireAuth, requireRole('intern'), async (req, res) => {
  const [[skill]] = await pool.query('SELECT id FROM skills WHERE name = :n', { n: req.params.skillName });
  if (!skill) return res.status(404).json({ error: 'Unknown skill' });
  const [questions] = await pool.query(
    `SELECT id, prompt, choice_a, choice_b, choice_c, choice_d FROM skill_test_questions
     WHERE skill_id = :id ORDER BY RAND() LIMIT 5`,
    { id: skill.id }
  );
  res.json({ skillId: skill.id, questions });
});
 
router.post('/submit', requireAuth, requireRole('intern'), async (req, res) => {
  const { skillId, answers } = req.body; // answers: { [questionId]: 'A'|'B'|'C'|'D' }
  const ids = Object.keys(answers);
  const [rows] = await pool.query(
    `SELECT id, correct_choice FROM skill_test_questions WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const correct = rows.filter(r => answers[r.id] === r.correct_choice).length;
  const scorePct = Math.round((correct / rows.length) * 100);
 
  await pool.query('INSERT INTO skill_test_attempts (id, intern_id, skill_id, score_pct) VALUES (UUID(), :i, :s, :p)',
    { i: req.user.id, s: skillId, p: scorePct });
  await pool.query(
    `INSERT INTO intern_skills (intern_id, skill_id, level, source) VALUES (:i, :s, :p, 'skills_test')
     ON DUPLICATE KEY UPDATE level = GREATEST(level, VALUES(level)), source = 'skills_test'`,
    { i: req.user.id, s: skillId, p: scorePct }
  );
  res.json({ scorePct, correct, total: rows.length });
});
 
module.exports = router;


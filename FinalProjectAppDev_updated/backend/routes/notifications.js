const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM notifications WHERE recipient_type = :t AND recipient_id = :id
     ORDER BY created_at DESC LIMIT 30`,
    { t: req.user.role, id: req.user.id }
  );
  res.json(rows);
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE notifications SET is_read = 1 WHERE id = :id AND recipient_type = :t AND recipient_id = :u',
    { id: req.params.id, t: req.user.role, u: req.user.id }
  );
  res.json({ ok: true });
});

module.exports = router;

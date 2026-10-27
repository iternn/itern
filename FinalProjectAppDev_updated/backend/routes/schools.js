// Public: schools that have an approved coordinator. Used to suggest consistent school names when students sign up.
const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

router.get('/', async (req, res) => {
  const [rows] = await pool.query("SELECT DISTINCT school FROM coordinators WHERE account_status = 'Approved' ORDER BY school");
  res.json(rows.map((r) => r.school));
});

module.exports = router;

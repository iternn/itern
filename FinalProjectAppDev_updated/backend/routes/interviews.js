const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const router = express.Router();
 
router.post('/', requireAuth, requireRole('company'), async (req, res) => {
  const { applicationId, scheduledAt, mode, meetingLink, interviewer } = req.body;
  const [[app]] = await pool.query('SELECT intern_id FROM applications WHERE id = :id', { id: applicationId });
  if (!app) return res.status(404).json({ error: 'Application not found.' });
 
  await pool.query(
    `INSERT INTO interviews (id, application_id, scheduled_at, mode, meeting_link, interviewer)
     VALUES (UUID(), :a, :dt, :mode, :link, :who)`,
    { a: applicationId, dt: scheduledAt, mode, link: meetingLink || null, who: interviewer || null }
  );
  await pool.query("UPDATE applications SET status = 'Interviewing' WHERE id = :id", { id: applicationId });
  await notify('intern', app.intern_id, 'interview_scheduled', `An interview has been scheduled for ${new Date(scheduledAt).toLocaleString()}.`);
  res.status(201).json({ ok: true });
});
 
module.exports = router;

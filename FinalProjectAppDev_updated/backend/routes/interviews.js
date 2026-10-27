const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { emitTo } = require('../utils/realtime');
const { getOrCreateConversation, postMessage } = require('../utils/chat');
const { fmtWhen } = require('../utils/format');
const { sendNotificationEmail } = require('../utils/mailer');
const router = express.Router();

/** "meet.google.com/abc" -> "https://meet.google.com/abc". Returns null if empty, false if not a web link. */
function normalizeLink(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname.includes('.')) return false;
    return url.toString();
  } catch { return false; }
}

// Schedule (or reschedule) the interview for an application.
router.post('/', requireAuth, requireRole('company'), async (req, res) => {
  const { applicationId, mode = 'Video call', interviewer } = req.body;

  // The browser sends an ISO timestamp, so the time means the same thing wherever the server runs.
  const when = new Date(req.body.scheduledAt);
  if (!req.body.scheduledAt || Number.isNaN(when.getTime())) {
    return res.status(400).json({ error: 'Pick a valid date and time for the interview.' });
  }

  const [[app]] = await pool.query(
    `SELECT a.id, a.intern_id, p.title, p.company_id, co.name AS company_name
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN companies co ON co.id = p.company_id
     WHERE a.id = :id`,
    { id: applicationId }
  );
  // Also stops one company from scheduling interviews on another company's applicants.
  if (!app || app.company_id !== req.user.id) return res.status(404).json({ error: 'Application not found.' });

  let link = normalizeLink(req.body.meetingLink);
  if (link === false) return res.status(400).json({ error: "That meeting link doesn't look right. Paste the full link, e.g. https://meet.google.com/abc-defg-hij" });
  if (mode === 'Video call' && !link) return res.status(400).json({ error: 'Add a meeting link so the student can join the call.' });
  if (mode !== 'Video call') link = null;

  // One interview per application: scheduling again simply replaces the old one.
  await pool.query('DELETE FROM interviews WHERE application_id = :a', { a: applicationId });
  // If the interview is already less than 24h (or 1h) away, those reminders would be pointless — mark them done.
  const msAway = when.getTime() - Date.now();
  await pool.query(
    `INSERT INTO interviews (id, application_id, scheduled_at, mode, meeting_link, interviewer, reminder_24h_sent_at, reminder_1h_sent_at)
     VALUES (UUID(), :a, :dt, :mode, :link, :who, :r24, :r1)`,
    { a: applicationId, dt: when, mode, link, who: String(interviewer || '').trim() || null,
      r24: msAway < 24 * 3600 * 1000 ? new Date() : null, r1: msAway < 3600 * 1000 ? new Date() : null }
  );
  await pool.query("UPDATE applications SET status = 'Interviewing' WHERE id = :id", { id: applicationId });

  const niceDate = fmtWhen(when);
  await notify('intern', app.intern_id, 'interview_scheduled',
    `${app.company_name} scheduled your interview for ${app.title} on ${niceDate}.`);
  emitTo('intern', app.intern_id, 'applications:changed', { applicationId });
  emitTo('company', req.user.id, 'applications:changed', { applicationId });

  // Email the student too (unless they switched email notifications off) — they may not be logged in.
  try {
    const [[who]] = await pool.query('SELECT name, email, email_notifications AS pref FROM interns WHERE id = :id', { id: app.intern_id });
    if (who && who.pref !== 0) {
      await sendNotificationEmail(who.email, `Interview scheduled: ${app.title}`,
        `Hi ${who.name},\n\n${app.company_name} scheduled your interview for ${app.title}.\n\nWhen: ${niceDate}\nFormat: ${mode}` +
        `${interviewer ? `\nInterviewer: ${String(interviewer).trim()}` : ''}${link ? `\nJoin: ${link}` : ''}\n\nYou can also find this under Applications and Messages in ITern.`);
    }
  } catch (err) { console.error('[mail] interview email failed:', err.message); }

  // Drop the details into the chat too, so the student has the time and link in one place.
  try {
    const conversation = await getOrCreateConversation(app.intern_id, req.user.id);
    await postMessage({
      conversation, senderType: 'company', senderId: req.user.id, kind: 'interview',
      body: `Interview scheduled for ${app.title}`,
      meta: {
        applicationId, title: app.title, scheduledAt: when.toISOString(), mode,
        link, interviewer: String(interviewer || '').trim() || null,
      },
    });
  } catch (err) {
    console.error('Could not post the interview into the chat:', err.message);
  }

  res.status(201).json({ ok: true, meetingLink: link });
});

// Interviews that haven't finished yet (started up to an hour ago, or in the future) — feeds both dashboards.
router.get('/upcoming', requireAuth, async (req, res) => {
  const isCompany = req.user.role === 'company';
  const [rows] = await pool.query(
    `SELECT iv.id, iv.scheduled_at, iv.mode, iv.meeting_link, iv.interviewer, a.id AS application_id,
       p.title, p.company_id, c.name AS company_name, i.id AS intern_id, i.name AS intern_name
     FROM interviews iv
     JOIN applications a ON a.id = iv.application_id
     JOIN postings p ON p.id = a.posting_id
     JOIN companies c ON c.id = p.company_id
     JOIN interns i ON i.id = a.intern_id
     WHERE ${isCompany ? 'p.company_id' : 'a.intern_id'} = :id
       AND iv.scheduled_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
     ORDER BY iv.scheduled_at ASC LIMIT 20`,
    { id: req.user.id }
  );
  res.json(rows);
});

module.exports = router;

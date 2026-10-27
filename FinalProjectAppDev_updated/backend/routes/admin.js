// Admin console: approve new companies / school coordinators, suspend or remove fake accounts.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { tableOf, clearStatusCache, deleteAccount } = require('../utils/accounts');
const { notify } = require('../utils/notify');
const { emitTo } = require('../utils/realtime');
const { sendNotificationEmail } = require('../utils/mailer');
const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const MANAGED = ['company', 'coordinator', 'intern'];
const STATUSES = ['Approved', 'Rejected', 'Suspended'];
const count = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);

router.get('/stats', async (req, res) => {
  const byStatus = async (table) => {
    const [rows] = await pool.query(`SELECT account_status AS s, COUNT(*) AS n FROM ${table} GROUP BY account_status`);
    return Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
  };
  res.json({
    companies: await byStatus('companies'),
    coordinators: await byStatus('coordinators'),
    interns: await byStatus('interns'),
    postings: await count("SELECT COUNT(*) AS n FROM postings WHERE status = 'Active'"),
    placements: await count("SELECT COUNT(*) AS n FROM applications WHERE status = 'Accepted'"),
    completed: await count('SELECT COUNT(*) AS n FROM applications WHERE completed_at IS NOT NULL'),
  });
});

router.get('/accounts', async (req, res) => {
  const role = req.query.role;
  if (!MANAGED.includes(role)) return res.status(400).json({ error: 'role must be company, coordinator or intern.' });
  const params = {};
  const where = [];
  if (STATUSES.concat('Pending').includes(req.query.status)) { where.push('x.account_status = :status'); params.status = req.query.status; }
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push(`(x.name LIKE :q OR x.email LIKE :q${role === 'company' ? '' : ' OR x.school LIKE :q'})`);
    params.q = `%${q}%`;
  }
  const extra = {
    company: '(SELECT COUNT(*) FROM postings p WHERE p.company_id = x.id) AS postings',
    coordinator: '(SELECT COUNT(*) FROM interns i WHERE i.school_key = x.school_key) AS students',
    intern: '(SELECT COUNT(*) FROM applications a WHERE a.intern_id = x.id) AS applications',
  }[role];
  const [rows] = await pool.query(
    `SELECT x.*, ${extra} FROM ${tableOf(role)} x ${where.length ? 'WHERE ' + where.join(' AND ') : ''} LIMIT 500`, params);
  rows.forEach((r) => { delete r.password_hash; });
  // newest first when we have a sign-up date, otherwise alphabetical
  rows.sort((a, b) => (b.created_at && a.created_at ? new Date(b.created_at) - new Date(a.created_at) : String(a.name).localeCompare(b.name)));
  res.json(rows);
});

const MESSAGES = {
  Approved: { company: 'Your company account has been approved. You can now publish postings that students can see.',
              coordinator: 'Your school coordinator account has been approved. You can now see your students\' OJT progress.',
              intern: 'Your account has been reinstated.' },
  Rejected: { all: 'Your registration was not approved.' },
  Suspended: { all: 'Your account has been suspended.' },
};

router.patch('/accounts/:role/:id/status', async (req, res) => {
  const { role, id } = req.params;
  const { status } = req.body;
  if (!MANAGED.includes(role)) return res.status(400).json({ error: 'Unknown account type.' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'status must be Approved, Rejected or Suspended.' });
  const note = String(req.body.note || '').trim().slice(0, 255) || null;

  const [[user]] = await pool.query(`SELECT id, name, email, email_notifications FROM ${tableOf(role)} WHERE id = :id`, { id });
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  await pool.query(`UPDATE ${tableOf(role)} SET account_status = :status, status_note = :note WHERE id = :id`, { status, note: status === 'Approved' ? null : note, id });
  clearStatusCache(role, id);

  const base = (MESSAGES[status][role] || MESSAGES[status].all);
  const message = `${base}${status !== 'Approved' && note ? ` Reason: ${note}` : ''}`;
  try { await notify(role, id, 'account_status', message); } catch { /* the decision itself already succeeded */ }
  emitTo(role, id, 'account:status', { status });
  sendNotificationEmail(user.email, `ITern account update: ${status}`, `Hi ${user.name},\n\n${message}`).catch(() => {});
  res.json({ ok: true, status });
});

// Removes a (fake / abusive) account and everything attached to it.
router.delete('/accounts/:role/:id', async (req, res) => {
  const { role, id } = req.params;
  if (!MANAGED.includes(role)) return res.status(400).json({ error: 'Unknown account type.' });
  const [[user]] = await pool.query(`SELECT id FROM ${tableOf(role)} WHERE id = :id`, { id });
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  try { await deleteAccount(role, id); }
  catch (err) { console.error('[admin] delete failed:', err.message); return res.status(500).json({ error: "Couldn't delete that account. Nothing was changed." }); }
  res.json({ ok: true });
});

module.exports = router;

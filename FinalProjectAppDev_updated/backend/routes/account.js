// Account settings for both portals: display name, password, email (re-verified by code), delete account.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendOtpEmail } = require('../utils/mailer');
const { issueOtp, checkOtp } = require('../utils/otp');
const { tableOf, emailTaken, deleteAccount } = require('../utils/accounts');
const { schoolKey } = require('../utils/schoolkey');
const router = express.Router();
router.use(requireAuth);

// Anything that checks a password or sends a code is rate-limited (a stolen token shouldn't allow guessing).
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many attempts. Try again in a few minutes.' } });
const emailLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: Number(process.env.OTP_RATE_LIMIT_MAX) || 5, message: { error: 'Too many code requests. Try again shortly.' } });

const table = (req) => tableOf(req.user.role);
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;

async function loadUser(req) {
  const [[user]] = await pool.query(`SELECT * FROM ${table(req)} WHERE id = :id`, { id: req.user.id });
  return user || null;
}
const publicUser = (user, role) => { const { password_hash, ...rest } = user; return { ...rest, role }; };
const signToken = (u) => jwt.sign({ id: u.id, role: u.role, email: u.email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

async function passwordMatches(req, password) {
  const user = await loadUser(req);
  return !!user && typeof password === 'string' && await bcrypt.compare(password, user.password_hash);
}

router.get('/', async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json(publicUser(user, req.user.role));
});

router.patch('/', async (req, res) => {
  const role = req.user.role;
  const sets = [], params = { id: req.user.id };

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 120);
    if (name.length < 2) return res.status(400).json({ error: 'Enter your name (at least 2 characters).' });
    sets.push('name = :name'); params.name = name;
  }
  // The school is what links a student to their school coordinator, so it's editable here.
  if ((role === 'intern' || role === 'coordinator') && req.body.school !== undefined) {
    const school = String(req.body.school).trim().slice(0, 160);
    if (school.length < 2) return res.status(400).json({ error: 'Enter your school.' });
    sets.push('school = :school', 'school_key = :schoolKey'); params.school = school; params.schoolKey = schoolKey(school);
  }
  if (role === 'intern' && req.body.program !== undefined) { sets.push('program = :program'); params.program = String(req.body.program).trim().slice(0, 160) || null; }
  if (role === 'coordinator' && req.body.position !== undefined) { sets.push('position = :position'); params.position = String(req.body.position).trim().slice(0, 120) || null; }
  if (role !== 'admin' && req.body.emailNotifications !== undefined) { sets.push('email_notifications = :en'); params.en = req.body.emailNotifications ? 1 : 0; }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  await pool.query(`UPDATE ${table(req)} SET ${sets.join(', ')} WHERE id = :id`, params);
  res.json(publicUser(await loadUser(req), role));
});

router.post('/password', sensitiveLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'Your new password must be 8 to 72 characters.' });
  if (!(await passwordMatches(req, currentPassword))) return res.status(400).json({ error: 'Your current password is incorrect.' });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'Choose a password different from your current one.' });
  await pool.query(`UPDATE ${table(req)} SET password_hash = :h WHERE id = :id`, { h: await bcrypt.hash(newPassword, 12), id: req.user.id });
  res.json({ ok: true });
});

// Step 1: send a code to the NEW address.
router.post('/email/request', emailLimiter, async (req, res) => {
  const newEmail = normEmail(req.body.newEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const user = await loadUser(req);
  if (newEmail === user.email) return res.status(400).json({ error: 'That is already your email address.' });
  if (await emailTaken(newEmail)) return res.status(409).json({ error: 'That email is already used by another account.' });
  const { code, ttlMinutes } = await issueOtp(newEmail, 'email_change');
  try { await sendOtpEmail(newEmail, code, ttlMinutes, 'email_change'); }
  catch (err) { console.error('[mail] email-change send failed:', err.message); return res.status(502).json({ error: 'Could not send the email. Check the address and try again.' }); }
  res.json({ sent: true });
});

// Step 2: code + current password -> the email changes, and a fresh token is issued.
router.post('/email/confirm', sensitiveLimiter, async (req, res) => {
  const newEmail = normEmail(req.body.newEmail);
  if (!(await passwordMatches(req, req.body.password))) return res.status(400).json({ error: 'Your password is incorrect.' });
  const result = await checkOtp(newEmail, 'email_change', req.body.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (await emailTaken(newEmail)) return res.status(409).json({ error: 'That email is already used by another account.' });
  await pool.query(`UPDATE ${table(req)} SET email = :e WHERE id = :id`, { e: newEmail, id: req.user.id });
  const user = publicUser(await loadUser(req), req.user.role);
  res.json({ user, token: signToken(user) });
});

// Permanently deletes the account and everything that belongs to it (needs the password).
router.delete('/', sensitiveLimiter, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be deleted here.' });
  if (!(await passwordMatches(req, req.body.password))) return res.status(400).json({ error: 'Your password is incorrect.' });
  try { await deleteAccount(req.user.role, req.user.id); }
  catch (err) {
    console.error('[account] delete failed:', err.message);
    return res.status(500).json({ error: "We couldn't delete your account. Nothing was changed — please try again." });
  }
  res.json({ ok: true });
});

module.exports = router;

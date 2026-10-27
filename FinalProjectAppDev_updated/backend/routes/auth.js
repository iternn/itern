const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { sendOtpEmail } = require('../utils/mailer');
const { issueOtp, checkOtp } = require('../utils/otp');
const pool = require('../db/pool');
const { emailTaken, tableOf } = require('../utils/accounts');
const { schoolKey } = require('../utils/schoolkey');
const { notify } = require('../utils/notify');
 
const router = express.Router();
 
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.OTP_RATE_LIMIT_MAX) || 5,
  message: { error: 'Too many code requests. Try again shortly.' },
});
 
const normEmail = (e) => String(e || '').trim().toLowerCase();

// Proof-of-verification handed to the browser after a correct OTP; registration requires it.
function signVerifyToken(email) {
  return jwt.sign({ email, purpose: 'register' }, process.env.JWT_SECRET, { expiresIn: '30m' });
}
function checkVerifyToken(token, email) {
  try {
    const p = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    return p.purpose === 'register' && p.email === email;
  } catch { return false; }
}
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Lets every admin know (bell + live pop-up) that something needs their attention.
async function notifyAdmins(message) {
  try {
    const [admins] = await pool.query('SELECT id FROM admins');
    for (const a of admins) await notify('admin', a.id, 'approval_needed', message);
  } catch (err) { console.error('[admin] could not notify admins:', err.message); }
}

router.post('/otp/request', otpLimiter, async (req, res) => {
  const email = normEmail(req.body.email);
  const purpose = req.body.purpose || 'register';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  if (purpose === 'register') {
    if (await emailTaken(email)) return res.status(409).json({ error: 'Email already registered. Try logging in.' });
  }

  const { code, ttlMinutes } = await issueOtp(email, purpose);

  try {
    await sendOtpEmail(email, code, ttlMinutes, purpose);
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return res.status(502).json({ error: 'Could not send the email. Check the address and try again.' });
  }
  res.json({ sent: true });
});

router.post('/otp/verify', async (req, res) => {
  const email = normEmail(req.body.email);
  const { code, purpose = 'register' } = req.body;
  const result = await checkOtp(email, purpose, code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, verificationToken: signVerifyToken(email) });
});

router.post('/register/intern', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!checkVerifyToken(req.body.verificationToken, email))
    return res.status(403).json({ error: 'Email not verified. Please verify your email first.' });
  const { name, password, school, program } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password are required' });
 
  if (await emailTaken(email)) return res.status(409).json({ error: 'Email already registered.' });
 
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO interns (id, name, email, password_hash, school, school_key, program, email_verified_at)
     VALUES (UUID(), :name, :email, :passwordHash, :school, :schoolKey, :program, NOW())`,
    { name, email, passwordHash, school: school || null, schoolKey: schoolKey(school), program: program || null }
  );
  const [[user]] = await pool.query('SELECT id, name, email, school, program FROM interns WHERE email = :email', { email });
  const safeUser = { ...user, role: 'intern' };
  res.status(201).json({ user: safeUser, token: signToken(safeUser) });
});
 
router.post('/register/company', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!checkVerifyToken(req.body.verificationToken, email))
    return res.status(403).json({ error: 'Email not verified. Please verify your email first.' });
  const { name, password, industry } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password are required' });
 
  if (await emailTaken(email)) return res.status(409).json({ error: 'Email already registered.' });
 
  const passwordHash = await bcrypt.hash(password, 12);
  // New companies wait for an admin's approval before their postings become visible to students.
  await pool.query(
    `INSERT INTO companies (id, name, email, password_hash, industry, email_verified_at, account_status)
     VALUES (UUID(), :name, :email, :passwordHash, :industry, NOW(), 'Pending')`,
    { name, email, passwordHash, industry: industry || null }
  );
  const [[user]] = await pool.query('SELECT id, name, email, industry, account_status FROM companies WHERE email = :email', { email });
  await notifyAdmins(`New company waiting for approval: ${user.name}.`);
  const safeUser = { ...user, role: 'company' };
  res.status(201).json({ user: safeUser, token: signToken(safeUser) });
});

router.post('/register/coordinator', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!checkVerifyToken(req.body.verificationToken, email))
    return res.status(403).json({ error: 'Email not verified. Please verify your email first.' });
  const { name, password, school, position } = req.body;
  if (!name || !email || !password || !String(school || '').trim())
    return res.status(400).json({ error: 'Name, email, password and school are required.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Your password must be 8 to 72 characters.' });
  if (await emailTaken(email)) return res.status(409).json({ error: 'Email already registered.' });

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO coordinators (id, name, email, password_hash, school, school_key, position, email_verified_at, account_status)
     VALUES (UUID(), :name, :email, :passwordHash, :school, :schoolKey, :position, NOW(), 'Pending')`,
    { name: String(name).trim(), email, passwordHash, school: String(school).trim(), schoolKey: schoolKey(school), position: position ? String(position).trim() : null }
  );
  const [[row]] = await pool.query('SELECT * FROM coordinators WHERE email = :email', { email });
  delete row.password_hash;
  await notifyAdmins(`New school coordinator waiting for approval: ${row.name} (${row.school}).`);
  const safeUser = { ...row, role: 'coordinator' };
  res.status(201).json({ user: safeUser, token: signToken(safeUser) });
});
 
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const email = normEmail(req.body.email);
  const role = ['company', 'coordinator', 'admin'].includes(req.body.role) ? req.body.role : 'intern';
  const [[user]] = await pool.query(`SELECT * FROM ${tableOf(role)} WHERE email = :email`, { email });
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
 
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  if (user.account_status === 'Rejected')
    return res.status(403).json({ code: 'ACCOUNT_BLOCKED', error: `Your registration was not approved.${user.status_note ? ` Reason: ${user.status_note}` : ''} Contact the ITern admin if you think this is a mistake.` });
  if (user.account_status === 'Suspended')
    return res.status(403).json({ code: 'ACCOUNT_BLOCKED', error: `Your account has been suspended.${user.status_note ? ` Reason: ${user.status_note}` : ''} Contact the ITern admin.` });
 
  delete user.password_hash;
  const safeUser = { ...user, role };
  res.json({ user: safeUser, token: signToken(safeUser) });
});
 
// ---------- Forgot password ----------
const tableFor = (role) => tableOf(['company', 'coordinator', 'admin'].includes(role) ? role : 'intern');
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;

// Always answers the same way, so this can't be used to discover which emails have accounts.
router.post('/password/forgot', otpLimiter, async (req, res) => {
  const email = normEmail(req.body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const [[user]] = await pool.query(`SELECT id FROM ${tableFor(req.body.role)} WHERE email = :email`, { email });
  if (user) {
    try {
      const { code, ttlMinutes } = await issueOtp(email, 'reset');
      await sendOtpEmail(email, code, ttlMinutes, 'reset');
    } catch (err) { console.error('[mail] reset email failed:', err.message); }
  }
  res.json({ sent: true });
});

router.post('/password/reset', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!validPassword(req.body.newPassword)) return res.status(400).json({ error: 'Your new password must be 8 to 72 characters.' });
  const result = await checkOtp(email, 'reset', req.body.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const hash = await bcrypt.hash(req.body.newPassword, 12);
  const [r] = await pool.query(`UPDATE ${tableFor(req.body.role)} SET password_hash = :hash WHERE email = :email`, { hash, email });
  if (!r.affectedRows) return res.status(400).json({ error: 'Could not reset the password for that account.' });
  res.json({ ok: true });
});

module.exports = router;

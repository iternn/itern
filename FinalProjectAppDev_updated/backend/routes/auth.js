const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const pool = require('../db/pool');
 
const router = express.Router();
 
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { error: 'Too many code requests. Try again shortly.' },
});
 
const transporter = process.env.EMAIL_HOST
  ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT),
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;
 
function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

router.post('/otp/request', otpLimiter, async (req, res) => {
  const { email, purpose = 'register' } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
 
  const code = sixDigitCode();
  const codeHash = await bcrypt.hash(code, 10);
  const ttlMinutes = Number(process.env.OTP_TTL_MINUTES || 5);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
 
  await pool.query(
    'INSERT INTO otp_codes (email, code_hash, purpose, expires_at) VALUES (:email, :codeHash, :purpose, :expiresAt)',
    { email, codeHash, purpose, expiresAt }
  );
 
  if (transporter) {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your ITern verification code',
      text: `Your code is ${code}. It expires in ${ttlMinutes} minutes.`,
    });
  } else {
    console.log(`[dev] OTP for ${email} (${purpose}): ${code}`);
  }
res.json({ sent: true });
});
 
router.post('/otp/verify', async (req, res) => {
  const { email, code, purpose = 'register' } = req.body;
  const [rows] = await pool.query(
    `SELECT * FROM otp_codes WHERE email = :email AND purpose = :purpose AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    { email, purpose }
  );
  const rec = rows[0];
  if (!rec) return res.status(400).json({ error: 'No code requested for this email.' });
  if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired.' });
 
  const ok = await bcrypt.compare(String(code), rec.code_hash);
  if (!ok) return res.status(400).json({ error: 'Incorrect code.' });
 
  await pool.query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = :id', { id: rec.id });
  res.json({ ok: true });
});
router.post('/register/intern', async (req, res) => {
  const { name, email, password, school, program } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password are required' });
 
  const [existing] = await pool.query('SELECT id FROM interns WHERE email = :email', { email });
  if (existing.length) return res.status(409).json({ error: 'Email already registered.' });
 
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO interns (id, name, email, password_hash, school, program, email_verified_at)
     VALUES (UUID(), :name, :email, :passwordHash, :school, :program, NOW())`,
    { name, email, passwordHash, school: school || null, program: program || null }
  );
  const [[user]] = await pool.query('SELECT id, name, email, school, program FROM interns WHERE email = :email', { email });
  const safeUser = { ...user, role: 'intern' };
  res.status(201).json({ user: safeUser, token: signToken(safeUser) });
});
 
router.post('/register/company', async (req, res) => {
  const { name, email, password, industry } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, password are required' });
 
  const [existing] = await pool.query('SELECT id FROM companies WHERE email = :email', { email });
  if (existing.length) return res.status(409).json({ error: 'Email already registered.' });
 
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO companies (id, name, email, password_hash, industry, email_verified_at)
     VALUES (UUID(), :name, :email, :passwordHash, :industry, NOW())`,
    { name, email, passwordHash, industry: industry || null }
  );
  const [[user]] = await pool.query('SELECT id, name, email, industry FROM companies WHERE email = :email', { email });
  const safeUser = { ...user, role: 'company' };
  res.status(201).json({ user: safeUser, token: signToken(safeUser) });
});
 
router.post('/login', async (req, res) => {
  const { role, email, password } = req.body;
  const table = role === 'company' ? 'companies' : 'interns';
  const [[user]] = await pool.query(`SELECT * FROM ${table} WHERE email = :email`, { email });
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
 
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
 
  delete user.password_hash;
  const safeUser = { ...user, role: role === 'company' ? 'company' : 'intern' };
  res.json({ user: safeUser, token: signToken(safeUser) });
});
 
module.exports = router;

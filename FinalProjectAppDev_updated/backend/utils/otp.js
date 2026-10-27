// One-time codes (email verification, password reset, email change). Codes are stored hashed,
// expire after OTP_TTL_MINUTES, and are limited to 5 wrong guesses each.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const MAX_ATTEMPTS = 5;
const attempts = new Map(); // `${email}:${otpId}` -> wrong guesses (resets on restart / new code)

const ttlMinutes = () => Number(process.env.OTP_TTL_MINUTES || 5);

/** Creates a new code (invalidating older ones for the same email + purpose). Returns the plain code. */
async function issueOtp(email, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + ttlMinutes() * 60 * 1000);
  await pool.query('UPDATE otp_codes SET consumed_at = NOW() WHERE email = :email AND purpose = :purpose AND consumed_at IS NULL', { email, purpose });
  await pool.query(
    'INSERT INTO otp_codes (email, code_hash, purpose, expires_at) VALUES (:email, :codeHash, :purpose, :expiresAt)',
    { email, codeHash, purpose, expiresAt }
  );
  return { code, ttlMinutes: ttlMinutes() };
}

/** Checks a code. On success it is consumed. Returns { ok: true } or { ok: false, status, error }. */
async function checkOtp(email, purpose, code) {
  const [rows] = await pool.query(
    `SELECT * FROM otp_codes WHERE email = :email AND purpose = :purpose AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    { email, purpose }
  );
  const rec = rows[0];
  if (!rec) return { ok: false, status: 400, error: 'No active code. Request a new one.' };
  if (new Date(rec.expires_at) < new Date()) return { ok: false, status: 400, error: 'Code expired. Request a new one.' };

  const key = `${email}:${rec.id}`;
  if ((attempts.get(key) || 0) >= MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many wrong attempts. Request a new code.' };
  if (!(await bcrypt.compare(String(code || ''), rec.code_hash))) {
    attempts.set(key, (attempts.get(key) || 0) + 1);
    return { ok: false, status: 400, error: 'Incorrect code.' };
  }
  attempts.delete(key);
  await pool.query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = :id', { id: rec.id });
  return { ok: true };
}

module.exports = { issueOtp, checkOtp };

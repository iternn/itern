// Creates the first admin from .env (ADMIN_EMAIL / ADMIN_PASSWORD) the first time the server starts.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { emailTaken } = require('./accounts');

async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM admins');

  if (!email || !password) {
    if (!Number(n)) console.log('[admin] No admin account yet. Add ADMIN_EMAIL and ADMIN_PASSWORD to backend/.env and restart to create one.');
    return;
  }
  const [[existing]] = await pool.query('SELECT id FROM admins WHERE email = :email', { email });
  if (existing) return;                       // already created — never overwrites a changed password
  if (Number(n) && !process.env.ADMIN_ADD) return; // an admin already exists; set ADMIN_ADD=1 to add another
  if (password.length < 8) return console.error('[admin] ADMIN_PASSWORD must be at least 8 characters — admin not created.');
  if (await emailTaken(email)) return console.error(`[admin] ${email} is already used by another account — admin not created.`);

  await pool.query(
    'INSERT INTO admins (id, name, email, password_hash) VALUES (UUID(), :name, :email, :hash)',
    { name: process.env.ADMIN_NAME || 'ITern Admin', email, hash: await bcrypt.hash(password, 12) }
  );
  console.log(`[admin] Admin account created for ${email}. Log in at frontend/admin/login.html`);
}

module.exports = { ensureAdmin };

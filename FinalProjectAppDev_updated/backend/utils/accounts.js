// Shared account helpers for the four kinds of login: student (intern), company, school coordinator, admin.
const fs = require('fs');
const pool = require('../db/pool');

const TABLES = { intern: 'interns', company: 'companies', coordinator: 'coordinators', admin: 'admins' };
const ROLES = Object.keys(TABLES);
const tableOf = (role) => TABLES[role] || null;

/** True if any account of any kind already uses this email. */
async function emailTaken(email, exceptRole = null, exceptId = null) {
  for (const [role, table] of Object.entries(TABLES)) {
    const [[row]] = await pool.query(`SELECT id FROM ${table} WHERE email = :email`, { email });
    if (row && !(role === exceptRole && row.id === exceptId)) return true;
  }
  return false;
}

// account_status: Pending (awaiting admin) | Approved | Rejected | Suspended. Cached briefly so that
// checking it on every request stays cheap, while an admin's decision still takes effect within seconds.
const cache = new Map();
const TTL_MS = 10 * 1000;
const cacheKey = (role, id) => `${role}:${id}`;
const clearStatusCache = (role, id) => cache.delete(cacheKey(role, id));

/** Returns the status, or null when the account no longer exists. */
async function accountStatus(role, id) {
  const table = tableOf(role);
  if (!table) return null;
  const hit = cache.get(cacheKey(role, id));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;
  const sql = role === 'admin'
    ? "SELECT 'Approved' AS s FROM admins WHERE id = :id"
    : `SELECT account_status AS s FROM ${table} WHERE id = :id`;
  const [[row]] = await pool.query(sql, { id });
  const status = row ? (row.s || 'Approved') : null;
  cache.set(cacheKey(role, id), { status, at: Date.now() });
  return status;
}

/**
 * Permanently deletes an account and everything that belongs to it (used by "delete my account" and by admins).
 * Everything happens in one transaction, so a failure leaves the data untouched. Uploaded files are removed
 * afterwards. Throws on failure.
 */
async function deleteAccount(role, id) {
  const table = tableOf(role);
  const [[user]] = await pool.query(`SELECT * FROM ${table} WHERE id = :id`, { id });
  if (!user) return;

  const files = [];
  const conn = await pool.getConnection();
  const run = async (sql, optional = false) => {
    try { await conn.query(sql, { id }); }
    catch (err) { if (!(optional && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR'))) throw err; }
  };
  const collect = async (sql, col) => {
    try { const [rows] = await conn.query(sql, { id }); rows.forEach((r) => r[col] && files.push(r[col])); } catch { /* table may not exist yet */ }
  };

  try {
    await conn.beginTransaction();
    if (role === 'company' || role === 'intern') {
      const apps = role === 'company'
        ? '(SELECT a.id FROM applications a JOIN postings p ON p.id = a.posting_id WHERE p.company_id = :id)'
        : '(SELECT id FROM applications WHERE intern_id = :id)';
      const convs = `(SELECT id FROM conversations WHERE ${role === 'company' ? 'company_id' : 'intern_id'} = :id)`;
      await collect(`SELECT file_path AS f FROM placement_documents WHERE application_id IN ${apps}`, 'f');
      await collect(`SELECT attachment_path AS f FROM messages WHERE conversation_id IN ${convs}`, 'f');
      await run(`DELETE FROM hour_logs WHERE application_id IN ${apps}`, true);
      await run(`DELETE FROM placement_documents WHERE application_id IN ${apps}`, true);
      await run(`DELETE FROM interviews WHERE application_id IN ${apps}`);
      if (role === 'company') {
        await run('DELETE FROM applications WHERE posting_id IN (SELECT id FROM postings WHERE company_id = :id)');
        await run('DELETE FROM posting_skills WHERE posting_id IN (SELECT id FROM postings WHERE company_id = :id)');
        await run('DELETE FROM postings WHERE company_id = :id');
        files.push(user.profile_photo_path);
      } else {
        await run('DELETE FROM applications WHERE intern_id = :id');
        await run('DELETE FROM intern_skills WHERE intern_id = :id', true);
        await run('DELETE FROM skill_test_attempts WHERE intern_id = :id', true);
        files.push(user.resume_path);
      }
      await run(`DELETE FROM messages WHERE conversation_id IN ${convs}`, true);
      await run(`DELETE FROM conversations WHERE ${role === 'company' ? 'company_id' : 'intern_id'} = :id`, true);
    }
    await conn.query('DELETE FROM notifications WHERE recipient_type = :t AND recipient_id = :id', { t: role, id });
    await conn.query('DELETE FROM otp_codes WHERE email = :e', { e: user.email });
    await conn.query(`DELETE FROM ${table} WHERE id = :id`, { id });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }

  clearStatusCache(role, id);
  files.filter(Boolean).forEach((f) => fs.unlink(f, () => {})); // best-effort file cleanup
}

module.exports = { TABLES, ROLES, tableOf, emailTaken, accountStatus, clearStatusCache, deleteAccount };

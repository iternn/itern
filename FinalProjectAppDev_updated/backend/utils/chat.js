const pool = require('../db/pool');
const { emitTo } = require('./realtime');

const MAX_BODY = 2000;

/** Turns a DB row into the JSON the browser receives. */
function shapeMessage(row) {
  let meta = null;
  if (row.meta) { try { meta = JSON.parse(row.meta); } catch { meta = null; } }
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    body: row.body,
    kind: row.kind,
    meta,
    createdAt: row.created_at,
    readAt: row.read_at,
    attachment: row.attachment_path
      ? { name: row.attachment_name, type: row.attachment_type, size: row.attachment_size }
      : null,
  };
}

/** A company and an intern may only talk once the intern has applied to one of that company's postings. */
async function hasApplicationBetween(internId, companyId) {
  const [rows] = await pool.query(
    `SELECT 1 FROM applications a JOIN postings p ON p.id = a.posting_id
     WHERE a.intern_id = :i AND p.company_id = :c LIMIT 1`,
    { i: internId, c: companyId }
  );
  return rows.length > 0;
}

async function findConversation(internId, companyId) {
  const [[row]] = await pool.query(
    'SELECT * FROM conversations WHERE intern_id = :i AND company_id = :c',
    { i: internId, c: companyId }
  );
  return row || null;
}

async function getOrCreateConversation(internId, companyId) {
  const existing = await findConversation(internId, companyId);
  if (existing) return existing;
  // INSERT IGNORE + re-read: two people opening the chat at the same moment can't create duplicates.
  await pool.query(
    'INSERT IGNORE INTO conversations (id, intern_id, company_id) VALUES (UUID(), :i, :c)',
    { i: internId, c: companyId }
  );
  return findConversation(internId, companyId);
}

/**
 * Stores a message, bumps the conversation, and pushes it live to the *other* person.
 * (The sender's own browser gets the saved message back in the HTTP response.)
 */
async function postMessage({ conversation, senderType, senderId, body, kind = 'text', meta = null, attachment = null }) {
  const text = String(body ?? '').trim().slice(0, MAX_BODY);
  const [result] = await pool.query(
    `INSERT INTO messages (conversation_id, sender_type, sender_id, body, kind, meta, attachment_path, attachment_name, attachment_type, attachment_size)
     VALUES (:conv, :st, :sid, :body, :kind, :meta, :ap, :an, :at, :asz)`,
    { conv: conversation.id, st: senderType, sid: senderId, body: text, kind: attachment ? 'file' : kind, meta: meta ? JSON.stringify(meta) : null,
      ap: attachment?.path || null, an: attachment?.name || null, at: attachment?.type || null, asz: attachment?.size ?? null }
  );
  await pool.query(
    'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP(3) WHERE id = :id',
    { id: conversation.id }
  );
  const [[row]] = await pool.query('SELECT * FROM messages WHERE id = :id', { id: result.insertId });
  const message = shapeMessage(row);

  const recipientType = senderType === 'intern' ? 'company' : 'intern';
  const recipientId = senderType === 'intern' ? conversation.company_id : conversation.intern_id;
  const [[sender]] = await pool.query(
    senderType === 'intern'
      ? 'SELECT name FROM interns WHERE id = :id'
      : 'SELECT name FROM companies WHERE id = :id',
    { id: senderId }
  );
  emitTo(recipientType, recipientId, 'message:new', {
    conversationId: conversation.id,
    senderName: sender?.name || 'Someone',
    kind: attachment ? 'file' : kind,
    preview: attachment ? `📎 ${attachment.name}` : kind === 'interview' ? 'Interview scheduled' : text.slice(0, 120),
    message,
  });
  return message;
}

module.exports = { MAX_BODY, shapeMessage, hasApplicationBetween, findConversation, getOrCreateConversation, postMessage };

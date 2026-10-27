const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { emitTo } = require('../utils/realtime');
const {
  MAX_BODY, shapeMessage, hasApplicationBetween, findConversation, getOrCreateConversation, postMessage,
} = require('../utils/chat');
const { makeUpload, handleUpload, sendStored, extOf, TYPES } = require('../utils/files');
const router = express.Router();

const CHAT_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'doc', 'docx', 'txt'];
const chatUpload = makeUpload({ dir: process.env.CHAT_UPLOAD_DIR || './uploads/chat', exts: CHAT_EXTS, maxMb: 10 });

// Both portals use these routes; the JWT role ('intern' | 'company') decides which side you are.
router.use(requireAuth, (req, res, next) => {
  if (req.user.role !== 'intern' && req.user.role !== 'company') return res.status(403).json({ error: 'Not allowed' });
  next();
});

const mineColumn = (role) => (role === 'intern' ? 'intern_id' : 'company_id');

async function ownConversation(req, id) {
  const [[conv]] = await pool.query('SELECT * FROM conversations WHERE id = :id', { id });
  if (!conv) return null;
  return conv[mineColumn(req.user.role)] === req.user.id ? conv : null;
}

/** Conversation list: other person, latest message, unread count. */
router.get('/conversations', async (req, res) => {
  const col = mineColumn(req.user.role);
  const [rows] = await pool.query(
    `SELECT c.id, c.last_message_at, c.intern_id, c.company_id,
       i.name AS intern_name, i.school, i.program,
       co.name AS company_name, co.industry, co.profile_photo_path AS company_photo,
       (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT m.kind FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
       (SELECT m.sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_type <> :role AND m.read_at IS NULL) AS unread
     FROM conversations c
     JOIN interns i ON i.id = c.intern_id
     JOIN companies co ON co.id = c.company_id
     WHERE c.${col} = :id AND c.last_message_at IS NOT NULL
     ORDER BY c.last_message_at DESC`,
    { id: req.user.id, role: req.user.role }
  );
  res.json(rows.map((r) => ({
    id: r.id,
    lastMessageAt: r.last_message_at,
    unread: Number(r.unread),
    lastMessage: { body: r.last_body, kind: r.last_kind, senderType: r.last_sender },
    other: req.user.role === 'company'
      ? { id: r.intern_id, name: r.intern_name, subtitle: [r.program, r.school].filter(Boolean).join(' · '), photo: null }
      : { id: r.company_id, name: r.company_name, subtitle: r.industry || '', photo: r.company_photo },
  })));
});

/** Everyone this user is allowed to start a chat with (i.e. there's an application between you). */
router.get('/contacts', async (req, res) => {
  if (req.user.role === 'company') {
    const [rows] = await pool.query(
      `SELECT i.id, i.name, i.school, i.program, c.id AS conversation_id,
         GROUP_CONCAT(DISTINCT p.title ORDER BY p.title SEPARATOR ' · ') AS positions
       FROM applications a
       JOIN postings p ON p.id = a.posting_id
       JOIN interns i ON i.id = a.intern_id
       LEFT JOIN conversations c ON c.intern_id = i.id AND c.company_id = :id
       WHERE p.company_id = :id
       GROUP BY i.id, i.name, i.school, i.program, c.id
       ORDER BY i.name`,
      { id: req.user.id }
    );
    return res.json(rows.map((r) => ({
      id: r.id, name: r.name, subtitle: [r.program, r.school].filter(Boolean).join(' · '),
      photo: null, positions: r.positions || '', conversationId: r.conversation_id,
    })));
  }
  const [rows] = await pool.query(
    `SELECT co.id, co.name, co.industry, co.profile_photo_path AS photo, c.id AS conversation_id,
       GROUP_CONCAT(DISTINCT p.title ORDER BY p.title SEPARATOR ' · ') AS positions
     FROM applications a
     JOIN postings p ON p.id = a.posting_id
     JOIN companies co ON co.id = p.company_id
     LEFT JOIN conversations c ON c.company_id = co.id AND c.intern_id = :id
     WHERE a.intern_id = :id
     GROUP BY co.id, co.name, co.industry, co.profile_photo_path, c.id
     ORDER BY co.name`,
    { id: req.user.id }
  );
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, subtitle: r.industry || '', photo: r.photo,
    positions: r.positions || '', conversationId: r.conversation_id,
  })));
});

/**
 * Messages of one conversation. `?after=<id>` returns only newer ones (used for live updates).
 * Opening a conversation also marks the other person's messages as read.
 */
router.get('/conversations/:id/messages', async (req, res) => {
  const conv = await ownConversation(req, req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const after = Number(req.query.after) || 0;
  const [rows] = after
    ? await pool.query(
        'SELECT * FROM messages WHERE conversation_id = :c AND id > :after ORDER BY id ASC LIMIT 200',
        { c: conv.id, after })
    : await pool.query(
        `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = :c ORDER BY id DESC LIMIT 200) t ORDER BY id ASC`,
        { c: conv.id });

  const [marked] = await pool.query(
    `UPDATE messages SET read_at = CURRENT_TIMESTAMP(3)
     WHERE conversation_id = :c AND sender_type <> :role AND read_at IS NULL`,
    { c: conv.id, role: req.user.role }
  );
  if (marked.affectedRows) {
    const otherType = req.user.role === 'intern' ? 'company' : 'intern';
    const otherId = req.user.role === 'intern' ? conv.company_id : conv.intern_id;
    emitTo(otherType, otherId, 'message:read', { conversationId: conv.id });
  }

  // Highest message *I* sent that the other person has already opened -> drives the "Seen" label.
  const [[seen]] = await pool.query(
    `SELECT MAX(id) AS upto FROM messages WHERE conversation_id = :c AND sender_type = :role AND read_at IS NOT NULL`,
    { c: conv.id, role: req.user.role }
  );
  res.json({ messages: rows.map(shapeMessage), otherReadUpTo: seen?.upto ? Number(seen.upto) : 0 });
});

/** Finds (or, for a first message, creates) the conversation a send request is aimed at. */
async function resolveConversation(req) {
  const isIntern = req.user.role === 'intern';
  if (req.body.conversationId) {
    const conversation = await ownConversation(req, req.body.conversationId);
    return conversation ? { conversation } : { status: 404, error: 'Conversation not found.' };
  }
  if (!req.body.toId) return { status: 400, error: 'conversationId or toId is required.' };
  const internId = isIntern ? req.user.id : req.body.toId;
  const companyId = isIntern ? req.body.toId : req.user.id;
  let conversation = await findConversation(internId, companyId);
  if (!conversation) {
    if (!(await hasApplicationBetween(internId, companyId))) {
      return { status: 403, error: isIntern
        ? 'You can message a company once you have applied to one of its postings.'
        : 'You can message a student once they have applied to one of your postings.' };
    }
    conversation = await getOrCreateConversation(internId, companyId);
  }
  return { conversation };
}

/** Send a text message — into an existing conversation (`conversationId`) or to a new person (`toId`). */
router.post('/', async (req, res) => {
  const body = String(req.body.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  if (body.length > MAX_BODY) return res.status(400).json({ error: `Messages can be at most ${MAX_BODY} characters.` });
  const found = await resolveConversation(req);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const message = await postMessage({ conversation: found.conversation, senderType: req.user.role, senderId: req.user.id, body });
  res.status(201).json({ conversationId: found.conversation.id, message });
});

/** Send a file (PDF, image, Word, text) with an optional caption. */
router.post('/file', (req, res, next) => handleUpload(chatUpload, 'file', { exts: CHAT_EXTS, maxMb: 10 }, req, res, next), async (req, res) => {
  const discard = () => require('fs').unlink(req.file.path, () => {});
  const caption = String(req.body.body ?? '').trim().slice(0, MAX_BODY);
  const found = await resolveConversation(req);
  if (found.error) { discard(); return res.status(found.status).json({ error: found.error }); }
  const ext = extOf(req.file.filename);
  const message = await postMessage({
    conversation: found.conversation, senderType: req.user.role, senderId: req.user.id, body: caption,
    attachment: { path: req.file.path, name: req.file.cleanName, type: TYPES[ext], size: req.file.size },
  });
  res.status(201).json({ conversationId: found.conversation.id, message });
});

/** Download / view a chat attachment (only the two people in the conversation). */
router.get('/files/:messageId', async (req, res) => {
  const [[m]] = await pool.query(
    `SELECT m.attachment_path, m.attachment_name, c.intern_id, c.company_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = :id`,
    { id: req.params.messageId });
  const mine = m && (req.user.role === 'intern' ? m.intern_id === req.user.id : m.company_id === req.user.id);
  if (!mine || !m.attachment_path) return res.status(404).json({ error: 'File not found.' });
  sendStored(res, m.attachment_path, { name: m.attachment_name, download: req.query.download === '1' });
});

/** "…is typing" — a live-only signal, never stored. */
router.post('/typing', async (req, res) => {
  const conv = await ownConversation(req, req.body.conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const [[me]] = await pool.query(`SELECT name FROM ${req.user.role === 'intern' ? 'interns' : 'companies'} WHERE id = :id`, { id: req.user.id });
  emitTo(req.user.role === 'intern' ? 'company' : 'intern', req.user.role === 'intern' ? conv.company_id : conv.intern_id,
    'message:typing', { conversationId: conv.id, name: me?.name || 'Someone' });
  res.json({ ok: true });
});

router.get('/unread-count', async (req, res) => {
  const col = mineColumn(req.user.role);
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.${col} = :id AND m.sender_type <> :role AND m.read_at IS NULL`,
    { id: req.user.id, role: req.user.role }
  );
  res.json({ count: Number(row.n) });
});

module.exports = router;

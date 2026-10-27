const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { hasApplicationBetween } = require('../utils/chat');
const { REQUIRED_DOCS, DOC_KEYS } = require('../utils/requirements');
const router = express.Router();

const uploadDir = process.env.REQUIREMENTS_UPLOAD_DIR || './uploads/requirements';
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };

/** What a student still has to submit before applying. Used by the API and by POST /applications. */
async function requirementStatus(internId) {
  const [docs] = await pool.query(
    'SELECT doc_type, file_name, uploaded_at FROM student_documents WHERE intern_id = :i', { i: internId });
  const [[intern]] = await pool.query('SELECT resume_path, resume_original_name FROM interns WHERE id = :i', { i: internId });
  const byType = new Map(docs.map((d) => [d.doc_type, d]));
  const items = [
    { key: 'resume', label: 'Resume', hint: 'Upload it on your Profile page.', onProfile: true,
      done: !!intern?.resume_path, fileName: intern?.resume_original_name || null },
    ...REQUIRED_DOCS.map((d) => ({
      ...d, done: byType.has(d.key), fileName: byType.get(d.key)?.file_name || null,
      uploadedAt: byType.get(d.key)?.uploaded_at || null,
    })),
  ];
  return { items, complete: items.every((i) => i.done), missing: items.filter((i) => !i.done).map((i) => i.label) };
}

router.get('/mine', requireAuth, requireRole('intern'), async (req, res) => {
  res.json(await requirementStatus(req.user.id));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${req.user.id}_${req.params.type}_${Date.now()}${ALLOWED[file.mimetype] || '.pdf'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!DOC_KEYS.includes(req.params.type)) return cb(new Error('UNKNOWN_TYPE'));
    if (!ALLOWED[file.mimetype]) return cb(new Error('BAD_FILE'));
    cb(null, true);
  },
});

router.post('/:type', requireAuth, requireRole('intern'), (req, res) => {
  upload.single('file')(req, res, (err) => {
    Promise.resolve((async () => {
      if (err) {
        if (err.message === 'UNKNOWN_TYPE') return res.status(404).json({ error: 'Unknown requirement.' });
        if (err.message === 'BAD_FILE') return res.status(415).json({ error: 'Upload a PDF, JPG or PNG file.' });
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is over 5MB.' });
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255);
      const [[old]] = await pool.query('SELECT id, file_path FROM student_documents WHERE intern_id = :i AND doc_type = :t',
        { i: req.user.id, t: req.params.type });
      if (old) {
        await pool.query('UPDATE student_documents SET file_path = :p, file_name = :n, uploaded_at = NOW() WHERE id = :id',
          { p: req.file.path, n: name, id: old.id });
        fs.unlink(path.resolve(old.file_path), () => {});
      } else {
        await pool.query('INSERT INTO student_documents (id, intern_id, doc_type, file_path, file_name) VALUES (:id, :i, :t, :p, :n)',
          { id: randomUUID(), i: req.user.id, t: req.params.type, p: req.file.path, n: name });
      }
      res.json(await requirementStatus(req.user.id));
    })()).catch((e) => res.status(500).json({ error: e.message }));
  });
});

router.delete('/:type', requireAuth, requireRole('intern'), async (req, res) => {
  const [[old]] = await pool.query('SELECT id, file_path FROM student_documents WHERE intern_id = :i AND doc_type = :t',
    { i: req.user.id, t: req.params.type });
  if (old) {
    await pool.query('DELETE FROM student_documents WHERE id = :id', { id: old.id });
    fs.unlink(path.resolve(old.file_path), () => {});
  }
  res.json(await requirementStatus(req.user.id));
});

function sendDoc(res, row) {
  if (!row) return res.status(404).json({ error: 'No file on record.' });
  const abs = path.resolve(row.file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'The file could not be found. Please upload it again.' });
  res.set({
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(row.file_name).replace(/[\r\n"]/g, ''))}`,
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  res.sendFile(abs);
}

// The student opens their own file...
router.get('/:type/file', requireAuth, requireRole('intern'), async (req, res) => {
  const [[row]] = await pool.query('SELECT file_path, file_name FROM student_documents WHERE intern_id = :i AND doc_type = :t',
    { i: req.user.id, t: req.params.type });
  sendDoc(res, row);
});

// ...and a company may open the files of students who applied to it.
router.get('/intern/:internId', requireAuth, requireRole('company'), async (req, res) => {
  if (!(await hasApplicationBetween(req.params.internId, req.user.id))) return res.status(403).json({ error: 'Not allowed.' });
  res.json(await requirementStatus(req.params.internId));
});

router.get('/intern/:internId/:type/file', requireAuth, requireRole('company'), async (req, res) => {
  if (!(await hasApplicationBetween(req.params.internId, req.user.id))) return res.status(403).json({ error: 'Not allowed.' });
  const [[row]] = await pool.query('SELECT file_path, file_name FROM student_documents WHERE intern_id = :i AND doc_type = :t',
    { i: req.params.internId, t: req.params.type });
  sendDoc(res, row);
});

module.exports = router;
module.exports.requirementStatus = requirementStatus;

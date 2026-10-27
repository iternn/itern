// Safe uploads shared by OJT documents and chat attachments:
//  - only whitelisted extensions, stored under a random name (never the user's file name)
//  - the file's first bytes must match its extension (a renamed .exe is not a PDF)
//  - files are served only through login-protected routes, with a content type WE choose
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain',
};
const INLINE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']); // shown in the browser; everything else is a download

const extOf = (name) => path.extname(String(name || '')).slice(1).toLowerCase();

function makeUpload({ dir, exts, maxMb = 10 }) {
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${extOf(file.originalname)}`),
    }),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => (exts.includes(extOf(file.originalname)) ? cb(null, true) : cb(new Error('BAD_TYPE'))),
  });
}

function sniffOk(filePath, ext) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024);
  const n = fs.readSync(fd, buf, 0, 1024, 0);
  fs.closeSync(fd);
  const head = buf.subarray(0, n);
  const starts = (...bytes) => bytes.every((b, i) => head[i] === b);
  switch (ext) {
    case 'pdf': return starts(0x25, 0x50, 0x44, 0x46);
    case 'png': return starts(0x89, 0x50, 0x4e, 0x47);
    case 'jpg': case 'jpeg': return starts(0xff, 0xd8, 0xff);
    case 'webp': return head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
    case 'docx': return starts(0x50, 0x4b, 0x03, 0x04);
    case 'doc': return starts(0xd0, 0xcf, 0x11, 0xe0);
    case 'txt': return !head.includes(0);
    default: return false;
  }
}

/** Runs multer then validates the real content. On any problem it deletes the file and answers 4xx. */
function handleUpload(upload, field, { exts, maxMb }, req, res, next) {
  upload.single(field)(req, res, (err) => {
    if (err) {
      if (err.message === 'BAD_TYPE') return res.status(415).json({ error: `Allowed file types: ${exts.join(', ').toUpperCase()}.` });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `That file is too large (${maxMb} MB max).` });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Please choose a file to upload.' });
    const ext = extOf(req.file.filename);
    if (!sniffOk(req.file.path, ext)) {
      fs.unlink(req.file.path, () => {});
      return res.status(415).json({ error: `That doesn't look like a real ${ext.toUpperCase()} file.` });
    }
    // multer decodes names as latin1 — restore UTF-8 so "Résumé.pdf" survives
    try { req.file.cleanName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255); }
    catch { req.file.cleanName = req.file.originalname.slice(0, 255); }
    next();
  });
}

/** Streams a stored file back with a type we trust (never the one the uploader claimed). */
function sendStored(res, filePath, { name, download = false }) {
  const abs = path.resolve(filePath || '');
  if (!filePath || !fs.existsSync(abs)) return res.status(404).json({ error: 'The file could not be found.' });
  const ext = extOf(abs);
  const inline = INLINE.has(ext) && !download;
  res.set({
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent((name || `file.${ext}`).replace(/[\r\n"]/g, ''))}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  res.sendFile(abs);
}

module.exports = { TYPES, extOf, makeUpload, handleUpload, sendStored };

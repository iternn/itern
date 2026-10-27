const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const photoDir = process.env.PHOTO_UPLOAD_DIR || './uploads/photos';
fs.mkdirSync(photoDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: photoDir,
    // Spaces / odd characters in the original name would make the image URL fragile.
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]+/g, '_')}`),
  }),
  fileFilter: (req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) return cb(new Error('BAD_TYPE'));
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.get('/me', requireAuth, requireRole('company'), async (req, res) => {
  const [[company]] = await pool.query(
    'SELECT id, name, email, industry, about, profile_photo_path FROM companies WHERE id = :id',
    { id: req.user.id }
  );
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  res.json(company);
});

router.patch('/me', requireAuth, requireRole('company'), async (req, res) => {
  const about = req.body.about ?? '';
  const industry = req.body.industry ?? '';
  await pool.query('UPDATE companies SET about = :about, industry = :industry WHERE id = :id', { about, industry, id: req.user.id });
  res.json({ ok: true });
});

// Single profile picture — replaces whatever was there before (not a gallery).
router.post('/photo', requireAuth, requireRole('company'), (req, res) => {
  upload.single('photo')(req, res, (err) => { Promise.resolve((async () => {
    if (err) {
      if (err.message === 'BAD_TYPE') return res.status(415).json({ error: 'Please choose a PNG, JPG, or WEBP image.' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That image is too large (8 MB max).' });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Please choose an image to upload.' });

    const [[existing]] = await pool.query('SELECT profile_photo_path FROM companies WHERE id = :id', { id: req.user.id });
    const cleanPath = req.file.path.replace(/^\.[\\/]/, '').replace(/\\/g, '/');

    await pool.query('UPDATE companies SET profile_photo_path = :p WHERE id = :id', { p: cleanPath, id: req.user.id });

    // Best-effort cleanup of the old file so uploads/photos doesn't grow forever.
    if (existing?.profile_photo_path) {
      fs.unlink(existing.profile_photo_path, () => {});
    }
    res.status(201).json({ ok: true, path: cleanPath });
  })()).catch((e) => res.status(500).json({ error: e.message }));
  });
});

router.delete('/photo', requireAuth, requireRole('company'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT profile_photo_path FROM companies WHERE id = :id', { id: req.user.id });
  await pool.query('UPDATE companies SET profile_photo_path = NULL WHERE id = :id', { id: req.user.id });
  if (existing?.profile_photo_path) fs.unlink(existing.profile_photo_path, () => {});
  res.json({ ok: true });
});

router.get('/:id/public', async (req, res) => {
  const [[company]] = await pool.query(
    'SELECT id, name, industry, about, profile_photo_path FROM companies WHERE id = :id',
    { id: req.params.id }
  );
  if (!company) return res.status(404).json({ error: 'Not found' });
  res.json(company);
});

module.exports = router;

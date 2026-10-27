const express = require('express');
const jwt = require('jsonwebtoken');
const { addClient } = require('../utils/realtime');
const { accountStatus } = require('../utils/accounts');
const router = express.Router();

// EventSource can't send an Authorization header, so the JWT comes in the query string.
router.get('/', async (req, res) => {
  let user;
  try { user = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  const status = await accountStatus(user.role, user.id);
  if (!status || status === 'Rejected' || status === 'Suspended') return res.status(401).json({ error: 'Invalid token: account unavailable.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');
  addClient(user.role, user.id, res);
});

module.exports = router;

const jwt = require('jsonwebtoken');
const { accountStatus } = require('../utils/accounts');

// Verifies the login token AND that the account still exists and hasn't been rejected / suspended by an admin
// (so an admin's decision takes effect immediately, not when the token expires a week later).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  const status = await accountStatus(user.role, user.id);
  if (status === null) return res.status(401).json({ error: 'Invalid token: this account no longer exists.' });
  if (status === 'Rejected' || status === 'Suspended') {
    return res.status(403).json({
      code: 'ACCOUNT_BLOCKED',
      error: status === 'Suspended' ? 'Your account has been suspended. Contact the ITern admin.' : 'Your registration was not approved.',
    });
  }
  req.user = { ...user, accountStatus: status };
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: `${role} account required` });
    next();
  };
}

// For features that need the admin's go-ahead first (publishing postings, seeing student data...).
function requireApproved(req, res, next) {
  if (req.user?.accountStatus !== 'Approved') {
    return res.status(403).json({ code: 'PENDING_APPROVAL', error: 'Your account is still waiting for approval by the ITern admin.' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireApproved };

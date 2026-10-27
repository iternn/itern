require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const internRoutes = require('./routes/interns');
const skillsTestRoutes = require('./routes/skillTest'); 
const postingRoutes = require('./routes/postings');
const applicationRoutes = require('./routes/applications');
const companyRoutes = require('./routes/companies');
const interviewRoutes = require('./routes/interviews');
const notificationRoutes = require('./routes/notifications');
const eventRoutes = require('./routes/events');
const messageRoutes = require('./routes/messages');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const ojtRoutes = require('./routes/ojt');
const schoolRoutes = require('./routes/schools');
const requirementRoutes = require('./routes/requirements');
const { ensureAdmin } = require('./utils/admin');
const ensureSchema = require('./db/ensureSchema');
const { startReminders } = require('./utils/reminders');
 
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());
// Only profile photos are public. Resumes, OJT documents and chat files are private: they are served through
// login-protected routes that check who is asking.
app.use('/uploads/photos', express.static('uploads/photos'));
 
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/interns', internRoutes);
app.use('/api/skills-test', skillsTestRoutes);
app.use('/api/postings', postingRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/events', eventRoutes); // real-time stream (SSE)
app.use('/api/messages', messageRoutes); // company <-> intern chat
app.use('/api/account', accountRoutes); // name / password / email / delete account
app.use('/api/admin', adminRoutes); // approvals + account management
app.use('/api/ojt', ojtRoutes); // OJT hours, documents, certificate
app.use('/api/schools', schoolRoutes); // public list of schools with a coordinator
app.use('/api/requirements', requirementRoutes); // documents students must submit before applying
 
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
 
const PORT = process.env.PORT || 4000;
// Bring the database up to date first (adds any missing columns / tables), then accept requests.
ensureSchema()
  .then(() => { console.log('[db] schema is up to date'); return ensureAdmin(); })
  .catch((err) => console.error('[db] schema check FAILED — some features may error:', err.message))
  .finally(() => app.listen(PORT, () => {
    console.log(`ITern API listening on :${PORT}`);
    startReminders(); // interview reminders (24h + 1h before)
  }));

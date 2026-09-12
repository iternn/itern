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
 
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());
app.use('/uploads', express.static('uploads')); // serves resumes + company photos
 
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/interns', internRoutes);
app.use('/api/skills-test', skillsTestRoutes);
app.use('/api/postings', postingRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/interviews', interviewRoutes);
 
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
 
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`ITern API listening on :${PORT}`));

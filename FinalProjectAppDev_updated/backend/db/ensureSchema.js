// Runs once every time the backend starts. It makes sure the database has every
// column / table the code expects, so nobody has to remember to run a migration
// .sql file by hand (a missing migration was what broke the Company Profile page:
// "Unknown column 'profile_photo_path'").
//
// Everything here is idempotent — safe to run on every start, and it never drops
// or rewrites existing data.
const pool = require('./pool');
const { schoolKey } = require('../utils/schoolkey');

async function tableExists(table) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t LIMIT 1',
    { t: table }
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c LIMIT 1`,
    { t: table, c: column }
  );
  return rows.length > 0;
}

async function ensureColumn(table, column, ddl) {
  // If the base table itself is missing, leave it alone so the real problem surfaces clearly.
  if (!(await tableExists(table))) return;
  if (await columnExists(table, column)) return;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
  console.log(`[db] added column ${table}.${column}`);
}

// New tables copy the charset/collation of interns.id so joins between them never
// fail with "Illegal mix of collations", whatever MySQL version / defaults you have.
async function idColumnType() {
  try {
    const [[row]] = await pool.query(
      `SELECT CHARACTER_SET_NAME AS cs, COLLATION_NAME AS co FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'interns' AND COLUMN_NAME = 'id'`
    );
    if (row?.cs && row?.co) return `CHAR(36) CHARACTER SET ${row.cs} COLLATE ${row.co}`;
  } catch { /* fall through to the default */ }
  return 'CHAR(36)';
}

// Some text columns may have been created as an ENUM (a fixed list of allowed words) or as a short VARCHAR.
// New features add new words ('Accepted', 'reset', 'offer_extended', ...), which such a column would reject
// ("Data truncated for column ..."). This converts them to a roomy VARCHAR; existing values are kept as-is.
async function widenColumn(table, column, minLength) {
  if (!(await tableExists(table))) return;
  const [[col]] = await pool.query(
    `SELECT DATA_TYPE AS type, COLUMN_TYPE AS ctype, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c`,
    { t: table, c: column }
  );
  if (!col) return;
  const isEnum = /^enum$/i.test(col.type);
  const tooShort = /^varchar$/i.test(col.type) && Number(col.len) < minLength;
  if (!isEnum && !tooShort) return;
  const dflt = col.dflt == null ? '' : `DEFAULT '${String(col.dflt).replace(/^'|'$/g, '').replace(/'/g, "''")}'`;
  await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` VARCHAR(${Math.max(minLength, Number(col.len) || 0)}) ${col.nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${dflt}`);
  console.log(`[db] ${table}.${column} widened to VARCHAR (was ${col.ctype})`);
}

// Gives students who registered before school matching existed a normalised school key.
async function backfillSchoolKeys() {
  if (!(await tableExists('interns')) || !(await columnExists('interns', 'school_key'))) return;
  const [rows] = await pool.query('SELECT id, school FROM interns WHERE school_key IS NULL AND school IS NOT NULL');
  for (const r of rows) await pool.query('UPDATE interns SET school_key = :k WHERE id = :id', { k: schoolKey(r.school), id: r.id });
  if (rows.length) console.log(`[db] school keys filled in for ${rows.length} students`);
}

// Table-level charset/collation copied from `interns`, so text columns we add (school_key ...) compare cleanly
// with the existing ones whatever your MySQL defaults are.
async function tableOptions() {
  try {
    const [[row]] = await pool.query("SELECT TABLE_COLLATION AS co FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'interns'");
    if (row?.co) return `DEFAULT CHARSET=${row.co.split('_')[0]} COLLATE=${row.co}`;
  } catch { /* use the database default */ }
  return '';
}

async function ensureSchema() {
  // --- Company profile picture (was migration_2026-09.sql) ---
  await ensureColumn('companies', 'profile_photo_path', 'VARCHAR(255) NULL');

  // --- Resume: remember the original file name so the profile can show it ---
  await ensureColumn('interns', 'resume_original_name', 'VARCHAR(255) NULL');
  await ensureColumn('interns', 'resume_uploaded_at', 'DATETIME NULL');

  // --- Posting details: program type, pay, location, duration & schedule, deadline ---
  await ensureColumn('postings', 'program_type', 'VARCHAR(20) NULL');            // 'OJT' | 'Internship'
  await ensureColumn('postings', 'compensation_type', 'VARCHAR(20) NULL');       // 'Unpaid' | 'Allowance' | 'Paid'
  await ensureColumn('postings', 'compensation_amount', 'DECIMAL(10,2) NULL');
  await ensureColumn('postings', 'compensation_period', 'VARCHAR(10) NULL');     // 'day' | 'week' | 'month'
  await ensureColumn('postings', 'benefits', 'VARCHAR(255) NULL');
  await ensureColumn('postings', 'location', 'VARCHAR(160) NULL');
  await ensureColumn('postings', 'description', 'TEXT NULL');
  await ensureColumn('postings', 'start_date', 'DATE NULL');
  await ensureColumn('postings', 'end_date', 'DATE NULL');
  await ensureColumn('postings', 'required_hours', 'INT NULL');
  await ensureColumn('postings', 'work_days', 'VARCHAR(40) NULL');               // 'Mon,Tue,Wed'
  await ensureColumn('postings', 'shift_start', 'VARCHAR(5) NULL');              // '09:00'
  await ensureColumn('postings', 'shift_end', 'VARCHAR(5) NULL');                // '17:00'
  await ensureColumn('postings', 'schedule_notes', 'VARCHAR(255) NULL');
  await ensureColumn('postings', 'application_deadline', 'DATE NULL');

  // --- Applications: offer response, shortlist, private company notes ---
  await ensureColumn('applications', 'shortlisted', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('applications', 'company_notes', 'TEXT NULL');
  await ensureColumn('applications', 'responded_at', 'DATETIME NULL');
  await widenColumn('applications', 'status', 20);   // + Accepted / Declined
  await widenColumn('otp_codes', 'purpose', 20);     // + reset / email_change
  await widenColumn('notifications', 'type', 40);    // + offer_extended / offer_accepted / interview_reminder ...

  // --- Interview reminders (so each reminder is only sent once) ---
  await ensureColumn('interviews', 'reminder_24h_sent_at', 'DATETIME NULL');
  await ensureColumn('interviews', 'reminder_1h_sent_at', 'DATETIME NULL');

  // --- Account approval (admin), school matching and email preferences ---
  // Existing accounts default to 'Approved' so nobody is locked out; NEW company / coordinator sign-ups are
  // inserted as 'Pending' by the registration routes.
  for (const table of ['interns', 'companies']) {
    await ensureColumn(table, 'account_status', "VARCHAR(12) NOT NULL DEFAULT 'Approved'");
    await ensureColumn(table, 'status_note', 'VARCHAR(255) NULL');
    await ensureColumn(table, 'email_notifications', 'TINYINT(1) NOT NULL DEFAULT 1');
  }
  await ensureColumn('interns', 'school_key', 'VARCHAR(160) NULL');
  await widenColumn('notifications', 'recipient_type', 20);   // + coordinator / admin
  await backfillSchoolKeys();

  // --- OJT completion ---
  await ensureColumn('applications', 'completed_at', 'DATETIME NULL');

  // --- Chat: file attachments + "emailed about this message" marker ---
  await ensureColumn('messages', 'attachment_path', 'VARCHAR(255) NULL');
  await ensureColumn('messages', 'attachment_name', 'VARCHAR(255) NULL');
  await ensureColumn('messages', 'attachment_type', 'VARCHAR(100) NULL');
  await ensureColumn('messages', 'attachment_size', 'INT NULL');
  await ensureColumn('messages', 'emailed_at', 'DATETIME(3) NULL');

  // --- Messaging between companies and student interns ---
  const idType = await idColumnType();
  const opts = await tableOptions();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id ${idType} NOT NULL PRIMARY KEY,
      intern_id ${idType} NOT NULL,
      company_id ${idType} NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_message_at DATETIME(3) NULL,
      UNIQUE KEY uq_conversation_pair (intern_id, company_id),
      KEY idx_conversation_company (company_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      conversation_id ${idType} NOT NULL,
      sender_type VARCHAR(10) NOT NULL,
      sender_id ${idType} NOT NULL,
      body TEXT NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'text',
      meta TEXT NULL,
      read_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_messages_conversation (conversation_id, id)
    )`);
  // (on a brand-new database the messages table only exists from here on)
  await ensureColumn('messages', 'attachment_path', 'VARCHAR(255) NULL');
  await ensureColumn('messages', 'attachment_name', 'VARCHAR(255) NULL');
  await ensureColumn('messages', 'attachment_type', 'VARCHAR(100) NULL');
  await ensureColumn('messages', 'attachment_size', 'INT NULL');
  await ensureColumn('messages', 'emailed_at', 'DATETIME(3) NULL');

  // --- The two extra kinds of login ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id ${idType} NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(190) NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_email (email)
    ) ${opts}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coordinators (
      id ${idType} NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(190) NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      school VARCHAR(160) NOT NULL,
      school_key VARCHAR(160) NULL,
      position VARCHAR(120) NULL,
      email_verified_at DATETIME NULL,
      account_status VARCHAR(12) NOT NULL DEFAULT 'Pending',
      status_note VARCHAR(255) NULL,
      email_notifications TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_coordinator_email (email),
      KEY idx_coordinator_school (school_key)
    ) ${opts}`);

  // --- OJT: daily hours + the document checklist ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hour_logs (
      id ${idType} NOT NULL PRIMARY KEY,
      application_id ${idType} NOT NULL,
      log_date DATE NOT NULL,
      hours DECIMAL(4,2) NOT NULL,
      notes VARCHAR(255) NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'Pending',
      reviewer_note VARCHAR(255) NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_hours_application (application_id, log_date)
    ) ${opts}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS placement_documents (
      id ${idType} NOT NULL PRIMARY KEY,
      application_id ${idType} NOT NULL,
      doc_type VARCHAR(20) NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'Submitted',
      reviewer_note VARCHAR(255) NULL,
      uploaded_by VARCHAR(12) NOT NULL,
      uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by VARCHAR(12) NULL,
      reviewed_at DATETIME NULL,
      UNIQUE KEY uq_placement_doc (application_id, doc_type)
    ) ${opts}`);
  // --- Application requirements: documents a student keeps on file and reuses for every application ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_documents (
      id ${idType} NOT NULL PRIMARY KEY,
      intern_id ${idType} NOT NULL,
      doc_type VARCHAR(30) NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_student_doc (intern_id, doc_type)
    ) ${opts}`);
}

module.exports = ensureSchema;

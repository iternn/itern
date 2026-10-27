// Interview reminders: one heads-up ~24 hours before and one ~1 hour before, to BOTH the student and the
// company — as an in-app notification (bell + pop-up) and, when Gmail is configured, as an email.
const pool = require('../db/pool');
const { notify } = require('./notify');
const { sendNotificationEmail } = require('./mailer');
const { fmtWhen } = require('./format');

const WINDOWS = [
  { column: 'reminder_24h_sent_at', hours: 24, lead: 'tomorrow' },
  { column: 'reminder_1h_sent_at', hours: 1, lead: 'in about an hour' },
];

async function sendFor(row, lead) {
  const when = fmtWhen(row.scheduled_at);
  const link = row.meeting_link ? `\nJoin: ${row.meeting_link}` : '';
  const toStudent = `Reminder: your interview with ${row.company_name} for ${row.title} is ${lead} (${when}).`;
  const toCompany = `Reminder: your interview with ${row.intern_name} for ${row.title} is ${lead} (${when}).`;
  await notify('intern', row.intern_id, 'interview_reminder', toStudent);
  await notify('company', row.company_id, 'interview_reminder', toCompany);
  for (const [email, text, pref] of [[row.intern_email, toStudent, row.intern_pref], [row.company_email, toCompany, row.company_pref]]) {
    if (pref === 0) continue; // they turned email notifications off in Settings
    try { await sendNotificationEmail(email, 'Interview reminder', `${text}${link}`); }
    catch (err) { console.error('[reminders] email failed:', err.message); }
  }
}

/** Looks for interviews entering a reminder window. Safe to call as often as you like. */
async function runReminders() {
  for (const w of WINDOWS) {
    const [rows] = await pool.query(
      `SELECT iv.id, iv.scheduled_at, iv.meeting_link, p.title, p.company_id, c.name AS company_name, c.email AS company_email,
         i.id AS intern_id, i.name AS intern_name, i.email AS intern_email,
         i.email_notifications AS intern_pref, c.email_notifications AS company_pref
       FROM interviews iv
       JOIN applications a ON a.id = iv.application_id
       JOIN postings p ON p.id = a.posting_id
       JOIN companies c ON c.id = p.company_id
       JOIN interns i ON i.id = a.intern_id
       WHERE iv.${w.column} IS NULL AND iv.scheduled_at > NOW()
         AND iv.scheduled_at <= DATE_ADD(NOW(), INTERVAL ${w.hours} HOUR)`
    );
    for (const row of rows) {
      // Claim it first so two overlapping runs can never send the same reminder twice.
      const [claim] = await pool.query(`UPDATE interviews SET ${w.column} = NOW() WHERE id = :id AND ${w.column} IS NULL`, { id: row.id });
      if (!claim.affectedRows) continue;
      try { await sendFor(row, w.lead); } catch (err) { console.error('[reminders] failed:', err.message); }
    }
  }
}

/**
 * "You have a new message" emails. Only for messages still unread after 5 minutes (so nobody gets emailed about a
 * chat they're actively reading), at most one email per conversation every 30 minutes.
 */
async function runMessageEmails() {
  const [groups] = await pool.query(
    `SELECT m.conversation_id, m.sender_type, COUNT(*) AS n, MAX(m.id) AS last_id, c.intern_id, c.company_id
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.read_at IS NULL AND m.emailed_at IS NULL AND m.kind IN ('text', 'file')
       AND m.created_at <= DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
     GROUP BY m.conversation_id, m.sender_type, c.intern_id, c.company_id`
  );
  for (const g of groups) {
    const [[recent]] = await pool.query(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = :c AND emailed_at > DATE_SUB(NOW(3), INTERVAL 30 MINUTE)', { c: g.conversation_id });
    if (Number(recent.n)) continue;                       // emailed about this chat recently — wait

    const toIntern = g.sender_type === 'company';
    const [[to]] = await pool.query(`SELECT name, email, email_notifications AS pref FROM ${toIntern ? 'interns' : 'companies'} WHERE id = :id`, { id: toIntern ? g.intern_id : g.company_id });
    const [[from]] = await pool.query(`SELECT name FROM ${toIntern ? 'companies' : 'interns'} WHERE id = :id`, { id: toIntern ? g.company_id : g.intern_id });
    const [[last]] = await pool.query('SELECT body, attachment_name FROM messages WHERE id = :id', { id: g.last_id });

    // claim first, so overlapping runs can't send twice
    const [claim] = await pool.query(
      "UPDATE messages SET emailed_at = NOW(3) WHERE conversation_id = :c AND sender_type = :s AND read_at IS NULL AND emailed_at IS NULL AND kind IN ('text', 'file')",
      { c: g.conversation_id, s: g.sender_type });
    if (!claim.affectedRows || !to || to.pref === 0) continue;
    const preview = (last.body || `📎 ${last.attachment_name}`).slice(0, 200);
    try {
      await sendNotificationEmail(to.email, `${from?.name || 'Someone'} sent you a message on ITern`,
        `Hi ${to.name},\n\n${from?.name || 'Someone'} sent you ${Number(g.n) === 1 ? 'a message' : `${g.n} messages`} on ITern:\n\n"${preview}"\n\nLog in to ITern and open Messages to reply.`);
    } catch (err) { console.error('[mail] message email failed:', err.message); }
  }
}

function startReminders() {
  const tick = () => {
    runReminders().catch((err) => console.error('[reminders]', err.message));
    runMessageEmails().catch((err) => console.error('[message emails]', err.message));
  };
  tick();
  return setInterval(tick, 60 * 1000);
}

module.exports = { runReminders, runMessageEmails, startReminders };

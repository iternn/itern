const nodemailer = require('nodemailer');

// Real Gmail delivery. Needs a Gmail *App Password* (not your normal password):
// Google Account -> Security -> 2-Step Verification (turn on) -> App passwords.
const enabled = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

const transporter = enabled
  ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.EMAIL_PORT || 465),
      secure: Number(process.env.EMAIL_PORT || 465) === 465, // 465 = SSL, 587 = STARTTLS
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

if (transporter) {
  transporter.verify()
    .then(() => console.log(`[mail] Gmail SMTP ready (sending as ${process.env.EMAIL_USER})`))
    .catch((err) => console.error('[mail] Gmail SMTP login FAILED:', err.message,
      '\n       Check EMAIL_USER / EMAIL_PASS (must be a Gmail App Password, no spaces).'));
} else {
  console.warn('[mail] EMAIL_USER / EMAIL_PASS not set — OTP codes will only print in this terminal.');
}

const OTP_WORDING = {
  register: { subject: 'is your ITern verification code', intro: 'Use this code to verify your email:' },
  reset: { subject: 'is your ITern password reset code', intro: 'Use this code to reset your ITern password:' },
  email_change: { subject: 'is your code to confirm your new ITern email', intro: 'Use this code to confirm your new email address:' },
};

async function sendOtpEmail(to, code, ttlMinutes, purpose = 'register') {
  const wording = OTP_WORDING[purpose] || OTP_WORDING.register;
  if (!transporter) {
    console.log(`[dev] OTP (${purpose}) for ${to}: ${code}`);
    return { dev: true };
  }
  await transporter.sendMail({
    from: `"ITern" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${code} ${wording.subject}`,
    text: `${wording.intro} ${code}.\nIt expires in ${ttlMinutes} minutes. If you didn't request it, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
      <h2 style="margin:0 0 8px;color:#5b3fd6">ITern</h2>
      <p style="color:#444">${wording.intro}</p>
      <div style="font-size:32px;letter-spacing:8px;font-weight:700;text-align:center;padding:16px;background:#f5f2ff;border-radius:8px">${code}</div>
      <p style="color:#888;font-size:12px">Expires in ${ttlMinutes} minutes. If you didn't request this, you can ignore this email.</p></div>`,
  });
  return { dev: false };
}

// Plain notification email (interview reminders). Without Gmail configured it just logs to the terminal.
async function sendNotificationEmail(to, subject, text) {
  if (!transporter) { console.log(`[dev] email to ${to}: ${subject}`); return { dev: true }; }
  await transporter.sendMail({
    from: `"ITern" <${process.env.EMAIL_USER}>`, to, subject, text,
    html: `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
      <h2 style="margin:0 0 8px;color:#5b3fd6">ITern</h2><p style="color:#444;white-space:pre-line">${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p></div>`,
  });
  return { dev: false };
}

module.exports = { sendOtpEmail, sendNotificationEmail, mailEnabled: enabled };

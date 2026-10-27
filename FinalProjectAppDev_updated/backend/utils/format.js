// Date/time wording used in notifications and emails. Defaults to Philippine time so every
// message says the same thing no matter where the server happens to run (override with APP_TIMEZONE).
const TZ = process.env.APP_TIMEZONE || 'Asia/Manila';

const fmtWhen = (d) => new Date(d).toLocaleString('en-PH', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });

/** Today's date as YYYY-MM-DD in the app's timezone (used to stop people logging hours in the future). */
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

module.exports = { TZ, fmtWhen, fmtDay, todayStr };

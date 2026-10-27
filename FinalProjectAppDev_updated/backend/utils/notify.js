const pool = require('../db/pool');
const { emitTo } = require('./realtime');

async function notify(recipientType, recipientId, type, message) {
  await pool.query(
    `INSERT INTO notifications (id, recipient_type, recipient_id, type, message)
     VALUES (UUID(), :t, :id, :type, :message)`,
    { t: recipientType, id: recipientId, type, message }
  );
  // recipientType is 'intern' or 'company' — same values used as the JWT role.
  emitTo(recipientType, recipientId, 'notification', { type, message });
}

module.exports = { notify };

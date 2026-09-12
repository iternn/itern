const pool = require('../db/pool');
 
async function notify(recipientType, recipientId, type, message) {
  await pool.query(
    `INSERT INTO notifications (id, recipient_type, recipient_id, type, message)
     VALUES (UUID(), :t, :id, :type, :message)`,
    { t: recipientType, id: recipientId, type, message }
  );
}
 
module.exports = { notify };

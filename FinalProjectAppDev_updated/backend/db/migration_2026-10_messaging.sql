-- OPTIONAL: the backend now runs this automatically on startup (backend/db/ensureSchema.js),
-- so you normally do NOT need to run this file. Kept for reference / manual setups.

-- Company profile picture (was the cause of "Unknown column 'profile_photo_path'")
-- ALTER TABLE companies ADD COLUMN profile_photo_path VARCHAR(255) NULL;
-- Resume display name
-- ALTER TABLE interns ADD COLUMN resume_original_name VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  intern_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME(3) NULL,
  UNIQUE KEY uq_conversation_pair (intern_id, company_id),
  KEY idx_conversation_company (company_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  sender_type VARCHAR(10) NOT NULL,
  sender_id CHAR(36) NOT NULL,
  body TEXT NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'text',
  meta TEXT NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_messages_conversation (conversation_id, id)
);

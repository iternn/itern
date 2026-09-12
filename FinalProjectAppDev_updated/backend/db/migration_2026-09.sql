-- Run this once in MySQL Workbench (or `mysql -u itern_app -p itern < migration_2026-09.sql`)
-- before restarting the backend. This is the only schema change these fixes need.

USE itern;

ALTER TABLE companies
  ADD COLUMN profile_photo_path VARCHAR(255) NULL AFTER about;

-- Optional cleanup: the old multi-photo gallery is no longer used by the
-- frontend (replaced by the single profile_photo_path above). Safe to leave
-- company_photos in place if you want the data, or drop it once you've
-- confirmed the new profile picture flow works:
--
-- DROP TABLE IF EXISTS company_photos;

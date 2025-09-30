-- Add expires_at column to banners table
ALTER TABLE banners
ADD COLUMN expires_at DATETIME DEFAULT NULL COMMENT 'When the banner expires. NULL means no expiration';

-- Update existing banners to have no expiration
UPDATE banners SET expires_at = NULL;
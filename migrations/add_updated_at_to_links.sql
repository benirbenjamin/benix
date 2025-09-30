-- Add updated_at column to links table
-- This simpler syntax should work with most MySQL/MariaDB versions
-- If the column already exists, you'll get an error but it's safe to ignore

ALTER TABLE links ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
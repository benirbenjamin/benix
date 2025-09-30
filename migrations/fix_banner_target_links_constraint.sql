-- Drop the existing foreign key constraint
ALTER TABLE banner_target_links
DROP FOREIGN KEY fk_banner_target_banner;

-- Add the foreign key constraint with the correct table name
ALTER TABLE banner_target_links
ADD CONSTRAINT fk_banner_target_banner
FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE;
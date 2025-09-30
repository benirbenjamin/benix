-- Add targeting columns to banners table
ALTER TABLE banners
ADD COLUMN IF NOT EXISTS target_type ENUM('all', 'specific', 'popular') DEFAULT 'all',
ADD COLUMN IF NOT EXISTS min_clicks INT DEFAULT 0;

-- Create banner target links table if it doesn't exist
CREATE TABLE IF NOT EXISTS banner_target_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  banner_id INT NOT NULL,
  link_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_banner_link (banner_id, link_id),
  FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE,
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);
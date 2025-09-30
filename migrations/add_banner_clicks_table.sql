-- Banner clicks tracking table
CREATE TABLE IF NOT EXISTS banner_clicks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  banner_id INT UNSIGNED NOT NULL,
  page_link_id VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  clicked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY banner_id (banner_id),
  KEY clicked_at (clicked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
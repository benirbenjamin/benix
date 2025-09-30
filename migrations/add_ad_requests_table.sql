-- Create ad_requests table
CREATE TABLE IF NOT EXISTS ad_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    banner_id BIGINT UNSIGNED NOT NULL,
    publisher_id BIGINT UNSIGNED NOT NULL,
    slot_id VARCHAR(50) NOT NULL,
    ip VARCHAR(45) NOT NULL,
    user_agent TEXT,
    referer TEXT,
    url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_banner_id (banner_id),
    KEY idx_publisher_id (publisher_id),
    KEY idx_created_at (created_at),
    CONSTRAINT fk_ad_requests_banner FOREIGN KEY (banner_id) REFERENCES banners (id) ON DELETE CASCADE,
    CONSTRAINT fk_ad_requests_publisher FOREIGN KEY (publisher_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Migration: Add product sharing functionality tables

-- Table for shared products (similar to shared_links but for products)
CREATE TABLE IF NOT EXISTS shared_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    user_id INT NOT NULL,
    share_code VARCHAR(10) NOT NULL UNIQUE,
    clicks INT DEFAULT 0,
    earnings DECIMAL(10, 4) DEFAULT 0.0000,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_share_code (share_code),
    INDEX idx_product_user (product_id, user_id),
    UNIQUE KEY unique_product_user (product_id, user_id)
);

-- Table for tracking clicks on shared products
CREATE TABLE IF NOT EXISTS product_clicks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shared_product_id INT NOT NULL,
    ip_address VARCHAR(45),
    device_info TEXT,
    referrer VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shared_product_id) REFERENCES shared_products(id) ON DELETE CASCADE,
    INDEX idx_shared_product (shared_product_id),
    INDEX idx_created_at (created_at)
);

-- Add ref_code column to orders table to track referrals
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ref_code VARCHAR(10) DEFAULT NULL;
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_ref_code (ref_code);

-- Update products table to ensure it has commission_rate if not exists
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5, 2) DEFAULT 5.00;

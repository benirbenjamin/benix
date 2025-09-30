-- Migration: Add Unilevel Commission System with Paid Activation
-- Created: July 22, 2025

-- Add activation and commission settings to config table
INSERT IGNORE INTO config (key_name, value, description) VALUES 
('activation_fee_rwf', '3000', 'User activation fee in Rwandan Francs'),
('level1_commission_rwf', '1500', 'Level 1 commission amount in Rwandan Francs'),
('level2_commission_rwf', '500', 'Level 2 commission amount in Rwandan Francs'),
('enable_paid_activation', 'true', 'Enable paid activation for new users'),
('flutterwave_webhook_hash', '', 'Flutterwave webhook secret hash for verification');

-- Add user status and activation fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS status ENUM('pending', 'active', 'suspended', 'banned') DEFAULT 'pending';
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_fee_paid DECIMAL(10,4) DEFAULT 0.0000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_fee_currency VARCHAR(5) DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer_id INT DEFAULT NULL;

-- Add foreign key for referrer relationship
ALTER TABLE users ADD INDEX IF NOT EXISTS idx_referrer (referrer_id);

-- Create commission levels table for unilevel structure
CREATE TABLE IF NOT EXISTS commission_levels (
  id INT AUTO_INCREMENT PRIMARY KEY,
  level_number INT NOT NULL,
  commission_amount_rwf DECIMAL(10,2) NOT NULL,
  commission_amount_usd DECIMAL(10,4) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_level (level_number)
);

-- Insert default commission levels
INSERT IGNORE INTO commission_levels (level_number, commission_amount_rwf, commission_amount_usd) VALUES 
(1, 1500.00, 1.5000),
(2, 500.00, 0.5000);

-- Create activation payments table
CREATE TABLE IF NOT EXISTS activation_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  transaction_id VARCHAR(255) NOT NULL,
  payment_method VARCHAR(50) NOT NULL,
  amount_paid DECIMAL(10,4) NOT NULL,
  currency VARCHAR(5) NOT NULL,
  usd_amount DECIMAL(10,4) NOT NULL,
  exchange_rate DECIMAL(10,6) NOT NULL,
  status ENUM('pending', 'successful', 'failed', 'cancelled') DEFAULT 'pending',
  payment_data JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_transaction (transaction_id),
  INDEX idx_user_status (user_id, status)
);

-- Create unilevel commissions table
CREATE TABLE IF NOT EXISTS unilevel_commissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  referrer_id INT NOT NULL,
  referred_user_id INT NOT NULL,
  level_number INT NOT NULL,
  commission_amount_rwf DECIMAL(10,2) NOT NULL,
  commission_amount_usd DECIMAL(10,4) NOT NULL,
  exchange_rate DECIMAL(10,6) NOT NULL,
  status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
  activation_payment_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (activation_payment_id) REFERENCES activation_payments(id) ON DELETE CASCADE,
  INDEX idx_referrer_level (referrer_id, level_number),
  INDEX idx_referred_user (referred_user_id),
  INDEX idx_activation_payment (activation_payment_id)
);

-- Update existing users to be active (grandfathered)
UPDATE users SET status = 'active', activated_at = created_at WHERE status IS NULL OR status = 'pending';

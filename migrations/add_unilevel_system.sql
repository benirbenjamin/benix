-- Migration: Add Unilevel Commission System
-- This migration adds the necessary tables and columns for the unilevel commission system

-- Add activation_fee_rwf and activation_fee_usd to config table if not exists
INSERT IGNORE INTO config (key_name, value, description) VALUES 
('activation_fee_rwf', '3000', 'Activation fee in Rwandan Francs'),
('activation_fee_usd', '3.00', 'Activation fee in USD (auto-converted from RWF)'),
('level1_commission_rwf', '1500', 'Level 1 commission in Rwandan Francs'),
('level1_commission_usd', '1.50', 'Level 1 commission in USD (auto-converted from RWF)'),
('level2_commission_rwf', '500', 'Level 2 commission in Rwandan Francs'),
('level2_commission_usd', '0.50', 'Level 2 commission in USD (auto-converted from RWF)'),
('max_commission_levels', '2', 'Maximum number of commission levels'),
('commission_system_enabled', 'true', 'Whether the commission system is enabled');

-- Add activation status and payment tracking to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS is_activated BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS activation_paid_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS referrer_id INT NULL,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
ADD FOREIGN KEY IF NOT EXISTS fk_users_referrer (referrer_id) REFERENCES users(id);

-- Create payments table for tracking activation payments
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  transaction_id VARCHAR(255) UNIQUE NOT NULL,
  flutterwave_tx_ref VARCHAR(255) UNIQUE NOT NULL,
  amount_rwf DECIMAL(10,2) NOT NULL,
  amount_usd DECIMAL(10,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'RWF',
  status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
  payment_type ENUM('activation', 'commission', 'other') DEFAULT 'activation',
  payment_method VARCHAR(50),
  gateway_response JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_payment_type (payment_type),
  INDEX idx_transaction_id (transaction_id)
) ENGINE=InnoDB;

-- Create commissions table for tracking unilevel commissions
CREATE TABLE IF NOT EXISTS commissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  referrer_id INT NOT NULL,
  referred_user_id INT NOT NULL,
  level INT NOT NULL,
  amount_rwf DECIMAL(10,2) NOT NULL,
  amount_usd DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
  payment_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_referrer_id (referrer_id),
  INDEX idx_referred_user_id (referred_user_id),
  INDEX idx_level (level),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- Create currency_rates table for storing exchange rates
CREATE TABLE IF NOT EXISTS currency_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  from_currency VARCHAR(10) NOT NULL,
  to_currency VARCHAR(10) NOT NULL,
  rate DECIMAL(15,8) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_currency_pair (from_currency, to_currency),
  INDEX idx_currencies (from_currency, to_currency)
) ENGINE=InnoDB;

-- Insert initial exchange rate for RWF to USD (will be updated by API)
INSERT INTO currency_rates (from_currency, to_currency, rate) VALUES 
('RWF', 'USD', 0.001) 
ON DUPLICATE KEY UPDATE rate = VALUES(rate);

-- Create migrations table to track applied migrations
CREATE TABLE IF NOT EXISTS migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  migration_name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_migration_name (migration_name)
) ENGINE=InnoDB;

-- Mark this migration as applied
INSERT IGNORE INTO migrations (migration_name) VALUES ('add_unilevel_system');

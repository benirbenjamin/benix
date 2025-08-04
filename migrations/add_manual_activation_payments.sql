-- Add manual activation payments table and update activation_payments table

-- Add payment_type column to activation_payments table
ALTER TABLE activation_payments 
ADD COLUMN payment_type ENUM('automatic', 'manual') DEFAULT 'automatic' AFTER payment_method;

-- Create manual_activation_payments table for manual payment submissions
CREATE TABLE IF NOT EXISTS manual_activation_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount_original DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(20),
  account_number VARCHAR(100),
  payment_screenshot_url VARCHAR(500),
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  admin_notes TEXT,
  whatsapp_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- Update activation_payments to include manual payments
ALTER TABLE activation_payments 
MODIFY COLUMN flutterwave_tx_ref VARCHAR(255) NULL,
ADD COLUMN manual_payment_id INT NULL,
ADD FOREIGN KEY (manual_payment_id) REFERENCES manual_activation_payments(id) ON DELETE SET NULL;

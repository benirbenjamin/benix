-- Add activation settings table
CREATE TABLE IF NOT EXISTS activation_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    is_activation_required BOOLEAN DEFAULT TRUE,
    min_shared_links INT DEFAULT 100,
    min_login_days INT DEFAULT 2,
    min_clicks_before_withdraw INT DEFAULT 500,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Insert default settings
INSERT INTO activation_settings 
(is_activation_required, min_shared_links, min_login_days, min_clicks_before_withdraw)
VALUES 
(TRUE, 100, 2, 500);

-- Add activation status to users table
ALTER TABLE users 
ADD COLUMN activation_status ENUM('pending', 'active', 'suspended') DEFAULT 'pending',
ADD COLUMN last_withdraw_clicks INT DEFAULT 0,
ADD COLUMN weekly_login_days INT DEFAULT 0,
ADD COLUMN total_shared_links INT DEFAULT 0,
ADD COLUMN last_login_week INT DEFAULT NULL;
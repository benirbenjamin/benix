// Simple Database Initialization Service
class DatabaseInitService {
  constructor(pool) {
    this.pool = pool;
  }

  async initializeDatabase() {
    try {
      console.log('🔄 Initializing database...');
      
      // Create/update users table with new fields
      await this.initializeUsersTable();
      
      // Create system settings table
      await this.initializeSettingsTable();
      
      // Create commissions table
      await this.initializeCommissionsTable();
      
      // Create payments table
      await this.initializePaymentsTable();
      
      // Create user referrals table
      await this.initializeReferralsTable();
      
      // Initialize manual activation payments
      await this.initializeManualActivationPayments();

      // Initialize activation settings
      await this.initializeActivationSettings();

      // Initialize banner tables
      await this.initializeBannerTables();
      
      // Insert default settings
      await this.insertDefaultSettings();
      
      console.log('✅ Database initialization completed successfully');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
  }

  async initializeUsersTable() {
    try {
      // First, check if users table exists and get its structure
      const [tables] = await this.pool.query("SHOW TABLES LIKE 'users'");
      
      if (tables.length === 0) {
        // Create users table from scratch
        await this.pool.query(`
          CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            activation_status ENUM('pending', 'active', 'suspended') DEFAULT 'pending',
            last_withdraw_clicks INT DEFAULT 0,
            weekly_login_days INT DEFAULT 0,
            total_shared_links INT DEFAULT 0,
            last_login_week INT DEFAULT NULL,
            password VARCHAR(255) NOT NULL,
            phone VARCHAR(20),
            role ENUM('user', 'merchant', 'admin') DEFAULT 'user',
            status ENUM('pending', 'active', 'suspended') DEFAULT 'pending',
            activation_paid BOOLEAN DEFAULT FALSE,
            referrer_id INT,
            referral_code VARCHAR(20) UNIQUE,
            wallet_balance DECIMAL(15, 2) DEFAULT 0.00,
            total_earnings DECIMAL(15, 2) DEFAULT 0.00,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            activated_at TIMESTAMP NULL,
            FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_referrer (referrer_id),
            INDEX idx_referral_code (referral_code),
            INDEX idx_status (status),
            INDEX idx_email (email)
          ) ENGINE=InnoDB
        `);
        console.log('✅ Created users table');
      } else {
        // Add new columns if they don't exist
        await this.addColumnIfNotExists('users', 'activation_paid', 'BOOLEAN DEFAULT FALSE');
        await this.addColumnIfNotExists('users', 'referrer_id', 'INT');
        await this.addColumnIfNotExists('users', 'referral_code', 'VARCHAR(20) UNIQUE');
        await this.addColumnIfNotExists('users', 'wallet_balance', 'DECIMAL(15, 2) DEFAULT 0.00');
        await this.addColumnIfNotExists('users', 'total_earnings', 'DECIMAL(15, 2) DEFAULT 0.00');
        await this.addColumnIfNotExists('users', 'activated_at', 'TIMESTAMP NULL');
        
        // Update status enum if needed
        await this.updateStatusEnum();
        
        // Add foreign key if not exists
        await this.addForeignKeyIfNotExists();
        
        console.log('✅ Updated users table structure');
      }

      // Generate referral codes for existing users who don't have them
      await this.generateMissingReferralCodes();
      
    } catch (error) {
      console.error('Error initializing users table:', error);
      throw error;
    }
  }

  async initializeSettingsTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(100) UNIQUE NOT NULL,
          setting_value TEXT,
          setting_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_setting_key (setting_key)
        ) ENGINE=InnoDB
      `);
      console.log('✅ System settings table ready');
    } catch (error) {
      console.error('Error creating system_settings table:', error);
      throw error;
    }
  }

  async initializeCommissionsTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS commissions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          referrer_id INT NOT NULL,
          referred_user_id INT NOT NULL,
          level INT NOT NULL,
          amount_usd DECIMAL(15, 2) NOT NULL,
          amount_rwf DECIMAL(15, 2) NOT NULL,
          commission_type ENUM('activation', 'purchase', 'referral') DEFAULT 'activation',
          status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
          payment_reference VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_user_id (user_id),
          INDEX idx_referrer_id (referrer_id),
          INDEX idx_level (level),
          INDEX idx_status (status),
          INDEX idx_commission_type (commission_type)
        ) ENGINE=InnoDB
      `);
      console.log('✅ Commissions table ready');
    } catch (error) {
      console.error('Error creating commissions table:', error);
      throw error;
    }
  }

  async initializePaymentsTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS activation_payments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          amount_usd DECIMAL(15, 2) NOT NULL,
          amount_original DECIMAL(15, 2) NOT NULL,
          currency VARCHAR(10) NOT NULL,
          payment_method VARCHAR(50),
          payment_type ENUM('automatic', 'manual') DEFAULT 'automatic',
          flutterwave_tx_ref VARCHAR(255) UNIQUE,
          flutterwave_tx_id VARCHAR(255),
          manual_payment_id INT NULL,
          payment_status ENUM('pending', 'successful', 'failed', 'cancelled') DEFAULT 'pending',
          payment_response JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_user_id (user_id),
          INDEX idx_tx_ref (flutterwave_tx_ref),
          INDEX idx_status (payment_status)
        ) ENGINE=InnoDB
      `);
      
      // Add new columns if they don't exist (for existing tables)
      await this.addColumnIfNotExists('activation_payments', 'payment_type', 'ENUM(\'automatic\', \'manual\') DEFAULT \'automatic\' AFTER payment_method');
      await this.addColumnIfNotExists('activation_payments', 'manual_payment_id', 'INT NULL');
      
      // Modify flutterwave_tx_ref to allow NULL values for manual payments
      await this.pool.query(`
        ALTER TABLE activation_payments 
        MODIFY COLUMN flutterwave_tx_ref VARCHAR(255) NULL
      `);
      
      console.log('✅ Activation payments table ready');
    } catch (error) {
      console.error('Error creating activation_payments table:', error);
      throw error;
    }
  }

  async initializeManualActivationPayments() {
    try {
      await this.pool.query(`
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
        ) ENGINE=InnoDB
      `);
      
      // Add foreign key constraint for manual_payment_id in activation_payments
      await this.addForeignKeyIfNotExistsManualPayment();
      
      console.log('✅ Manual activation payments table ready');
    } catch (error) {
      console.error('Error creating manual_activation_payments table:', error);
      throw error;
    }
  }

  async initializeReferralsTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_referrals (
          id INT AUTO_INCREMENT PRIMARY KEY,
          referrer_id INT NOT NULL,
          referred_id INT NOT NULL,
          referral_code VARCHAR(20) NOT NULL,
          status ENUM('pending', 'activated', 'expired') DEFAULT 'pending',
          commission_paid BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          activated_at TIMESTAMP NULL,
          FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_referral (referrer_id, referred_id),
          INDEX idx_referrer (referrer_id),
          INDEX idx_referred (referred_id),
          INDEX idx_code (referral_code),
          INDEX idx_status (status)
        ) ENGINE=InnoDB
      `);
      console.log('✅ User referrals table ready');
    } catch (error) {
      console.error('Error creating user_referrals table:', error);
      throw error;
    }
  }

  async insertDefaultSettings() {
    try {
      const defaultSettings = [
        {
          key: 'activation_fee_rwf',
          value: '3000',
          type: 'number',
          description: 'User activation fee in Rwandan Francs'
        },
        {
          key: 'level1_commission_rwf',
          value: '1500',
          type: 'number',
          description: 'Level 1 commission in Rwandan Francs'
        },
        {
          key: 'level2_commission_rwf',
          value: '500',
          type: 'number',
          description: 'Level 2 commission in Rwandan Francs'
        },
        {
          key: 'max_commission_levels',
          value: '2',
          type: 'number',
          description: 'Maximum number of commission levels'
        },
        {
          key: 'supported_currencies',
          value: JSON.stringify(['RWF', 'USD', 'UGX', 'KES', 'EUR', 'GBP']),
          type: 'json',
          description: 'List of supported payment currencies'
        },
        {
          key: 'auto_activate_existing_users',
          value: 'true',
          type: 'boolean',
          description: 'Automatically activate existing users without payment'
        },
        {
          key: 'manual_payment_accounts',
          value: JSON.stringify({
            'RWF': {
              bankName: 'Bank of Kigali',
              accountName: 'BenixSpace Rwanda',
              accountNumber: '000-123-456789',
              mobileNumber: '+250783987223',
              instructions: 'Send payment to the account above and upload screenshot'
            },
            'USD': {
              bankName: 'Bank of Kigali',
              accountName: 'BenixSpace Rwanda',
              accountNumber: '000-USD-123456',
              mobileNumber: '+250783987223',
              instructions: 'Send payment to the USD account above and upload screenshot'
            }
          }),
          type: 'json',
          description: 'Manual payment account details for different currencies'
        },
        {
          key: 'admin_whatsapp_number',
          value: '+250783987223',
          type: 'string',
          description: 'Admin WhatsApp number for manual payment notifications'
        }
      ];

      for (const setting of defaultSettings) {
        await this.pool.query(`
          INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
          VALUES (?, ?, ?, ?)
        `, [setting.key, setting.value, setting.type, setting.description]);
      }

      console.log('✅ Default settings inserted');
    } catch (error) {
      console.error('Error inserting default settings:', error);
      throw error;
    }
  }

  // Helper method to add column if it doesn't exist
  async addColumnIfNotExists(tableName, columnName, columnDefinition) {
    try {
      const [columns] = await this.pool.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ? 
        AND COLUMN_NAME = ?
      `, [tableName, columnName]);

      if (columns.length === 0) {
        await this.pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
        console.log(`✅ Added column ${columnName} to ${tableName}`);
      }
    } catch (error) {
      console.error(`Error adding column ${columnName} to ${tableName}:`, error);
    }
  }

  // Update status enum to include 'pending'
  async updateStatusEnum() {
    try {
      await this.pool.query(`
        ALTER TABLE users MODIFY COLUMN status 
        ENUM('pending', 'active', 'suspended') DEFAULT 'pending'
      `);
    } catch (error) {
      // Ignore error if enum is already correct
      console.log('Status enum already up to date');
    }
  }

  // Add foreign key for referrer_id if not exists
  async addForeignKeyIfNotExists() {
    try {
      const [constraints] = await this.pool.query(`
        SELECT CONSTRAINT_NAME 
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'referrer_id' 
        AND REFERENCED_TABLE_NAME IS NOT NULL
      `);

      if (constraints.length === 0) {
        await this.pool.query(`
          ALTER TABLE users 
          ADD CONSTRAINT fk_users_referrer 
          FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE SET NULL
        `);
        console.log('✅ Added foreign key constraint for referrer_id');
      }
    } catch (error) {
      console.log('Foreign key constraint already exists or cannot be added');
    }
  }

  // Add foreign key for manual_payment_id if not exists
  async addForeignKeyIfNotExistsManualPayment() {
    try {
      const [constraints] = await this.pool.query(`
        SELECT CONSTRAINT_NAME 
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'activation_payments' 
        AND COLUMN_NAME = 'manual_payment_id' 
        AND REFERENCED_TABLE_NAME IS NOT NULL
      `);

      if (constraints.length === 0) {
        await this.pool.query(`
          ALTER TABLE activation_payments 
          ADD CONSTRAINT fk_activation_payments_manual 
          FOREIGN KEY (manual_payment_id) REFERENCES manual_activation_payments(id) ON DELETE SET NULL
        `);
        console.log('✅ Added foreign key constraint for manual_payment_id');
      }
    } catch (error) {
      console.log('Manual payment foreign key constraint already exists or cannot be added');
    }
  }

  // Generate referral codes for existing users
  async generateMissingReferralCodes() {
    try {
      const [users] = await this.pool.query(`
        SELECT id FROM users WHERE referral_code IS NULL OR referral_code = ''
      `);

      for (const user of users) {
        const referralCode = this.generateReferralCode();
        await this.pool.query(`
          UPDATE users SET referral_code = ? WHERE id = ?
        `, [referralCode, user.id]);
      }

      if (users.length > 0) {
        console.log(`✅ Generated referral codes for ${users.length} users`);
      }
    } catch (error) {
      console.error('Error generating referral codes:', error);
    }
  }

  // Initialize activation settings table and defaults
  async initializeActivationSettings() {
    try {
      // Create activation settings table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS activation_settings (
          id INT PRIMARY KEY AUTO_INCREMENT,
          is_activation_required BOOLEAN DEFAULT TRUE,
          min_shared_links INT DEFAULT 0,
          min_login_days INT DEFAULT 0,
          min_clicks_before_withdraw INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      // Check if there are any existing settings
      const [settings] = await this.pool.query('SELECT * FROM activation_settings LIMIT 1');
      
      // Only insert default settings if none exist
      if (settings.length === 0) {
        await this.pool.query(`
          INSERT INTO activation_settings 
          (is_activation_required, min_shared_links, min_login_days, min_clicks_before_withdraw)
          VALUES 
          (TRUE, 0, 0, 0)
        `);
      }

      console.log('✅ Activation settings table initialized');
    } catch (error) {
      console.error('Error initializing activation settings:', error);
      throw error;
    }
  }

  // Activate existing users automatically (one-time migration)
  async activateExistingUsers() {
    try {
      // Check if migration has already been run
      const [migrationCheck] = await this.pool.query(`
        SELECT setting_value FROM system_settings 
        WHERE setting_key = 'existing_users_activated'
      `);

      if (migrationCheck.length === 0) {
        // First time running this migration - only activate users who already have 'active' status
        const [result] = await this.pool.query(`
          UPDATE users 
          SET activation_paid = TRUE, 
              activated_at = CURRENT_TIMESTAMP
          WHERE status = 'active' 
          AND activation_paid = FALSE
        `);

        // Set status to 'pending' for all users who don't have 'active' status
        await this.pool.query(`
          UPDATE users 
          SET status = 'pending'
          WHERE status != 'active'
        `);

        // Set flag to prevent this from running again
        await this.pool.query(`
          INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
          VALUES ('existing_users_activated', 'true', 'boolean', 'Flag to indicate existing users have been auto-activated')
        `);

        console.log(`Auto-activated ${result.affectedRows} users with active status (one-time migration)`);
      } else {
        console.log('Existing users already activated, skipping migration');
      }

      if (result.affectedRows > 0) {
        console.log(`✅ Activated ${result.affectedRows} existing users`);
      }
    } catch (error) {
      console.error('Error activating existing users:', error);
    }
  }

  // Helper method to generate referral code
  generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Run the complete initialization
  async run() {
    try {
      await this.initializeDatabase();
      
      // Check if we should auto-activate existing users
      const [setting] = await this.pool.query(`
        SELECT setting_value FROM system_settings 
        WHERE setting_key = 'auto_activate_existing_users'
      `);
      
      if (setting.length > 0 && setting[0].setting_value === 'true') {
        await this.activateExistingUsers();
      }
      
    } catch (error) {
      console.error('Database initialization failed:', error);
      throw error;
    }
  }
}

module.exports = DatabaseInitService;

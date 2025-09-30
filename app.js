// Affiliate Link & Product Sharing Platform - Server (app.js)
// A single-file Node.js application using MySQL database

// Import required modules
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const flash = require('connect-flash');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const nodemailer = require('nodemailer');
const MySQLStore = require('express-mysql-session')(session);
const indexRoutes = require('./routes/index');
const productRoutes = require('./routes/productRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const adRoutes = require('./routes/adRoutes');

// Import new services
const CurrencyService = require('./services/currencyService');
const CommissionService = require('./services/commissionService');
const FlutterwaveService = require('./services/flutterwaveService');
const EmailService = require('./services/emailService');
const NotificationService = require('./services/notificationService');
const ActivationService = require('./services/activationService');
const BannerService = require('./services/bannerService');
const ReportScheduler = require('./services/reportScheduler');




// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG and GIF files are allowed'));
    }
    cb(null, true);
  }
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;


// Set absolute paths for views and public directories
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// Configure middleware

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Add database pool and user data to request
app.use(async (req, res, next) => {
  // Make pool available to all routes
  req.pool = pool;
  
  if (req.session && req.session.userId) {
    try {
      const [users] = await pool.query(
        'SELECT id, username, email, role FROM users WHERE id = ?',
        [req.session.userId]
      );
      if (users.length > 0) {
        req.user = users[0];
        console.log('User data added to request:', req.user);
      }
    } catch (err) {
      console.error('Error fetching user data:', err);
    }
  }
  next();
});
// Create MySQL session store
const sessionTimeoutHours = parseInt(process.env.SESSION_TIMEOUT_HOURS) || 1;
const sessionTimeoutMs = sessionTimeoutHours * 60 * 60 * 1000;

const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'benix',
  clearExpired: true,
  checkExpirationInterval: 900000, // Clean up expired sessions every 15 minutes
  expiration: sessionTimeoutMs, // Session expires after configured hours
  createDatabaseTable: true
});

// Configure sessions with MySQL store
app.use(session({
  key: 'benix_session',
  secret: process.env.SESSION_SECRET || 'affiliate-platform-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Change to true in production with HTTPS
    maxAge: sessionTimeoutMs, // Configured session timeout
    httpOnly: true
  }
}));

// Enable flash messages
app.use(flash());

// Session activity middleware - extends session on user activity
app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    // Reset the session maxAge on each request (rolling session)
    req.session.cookie.maxAge = sessionTimeoutMs;
    console.log('Session found for user:', req.session.userId, 'username:', req.session.username, 'on path:', req.path);
  } else {
    console.log('No session found for path:', req.path, 'session exists:', !!req.session);
  }
  next();
});

// Cart count middleware
app.use(async (req, res, next) => {
  if (req.session.userId) {
    try {
      const [cartCount] = await pool.query(
        'SELECT COUNT(*) as count FROM cart_items WHERE user_id = ?',
        [req.session.userId]
      );
      res.locals.cartCount = cartCount[0].count;
    } catch (err) {
      console.error('Error fetching cart count:', err);
      res.locals.cartCount = 0;
    }
  }
  next();
});

// User middleware - makes user available in all templates
app.use(async (req, res, next) => {
  if (req.session.userId) {
    try {
      const [users] = await pool.query(
        'SELECT * FROM users WHERE id = ?',
        [req.session.userId]
      );
      if (users.length > 0) {
        res.locals.user = users[0];
      }
    } catch (err) {
      console.error('Error fetching user for global middleware:', err);
    }
  }
  next();
});

// Set EJS as the view engine
app.set('view engine', 'ejs');

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'benix',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize services that require database access
const bannerService = new BannerService(pool);
app.set('bannerService', bannerService);

// Initialize banner system after pool is ready
(async () => {
  try {
    await bannerService.initializeBannerSystem();
    console.log('✅ Banner system initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize banner system:', error);
  }
})();

// Migrate banners from ad_banners to banners if needed
async function migrateBanners() {
  try {
    // Check if ad_banners table exists
    const [tables] = await pool.query("SHOW TABLES LIKE 'ad_banners'");
    if (tables.length > 0) {
      console.log('🔄 Checking for banners to migrate...');
      
      // Get all banners from ad_banners
      const [oldBanners] = await pool.query('SELECT * FROM ad_banners');
      
      // Insert each banner into the new banners table
      for (const banner of oldBanners) {
        await pool.query(`
          INSERT IGNORE INTO banners 
          (id, title, image_url, target_url, merchant_id, status, is_active, display_order, 
           target_type, min_clicks, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
          updated_at = VALUES(updated_at)
        `, [
          banner.id,
          banner.title || 'Untitled Banner',
          banner.image_url,
          banner.target_url,
          banner.merchant_id,
          banner.status || 'pending',
          Boolean(banner.is_active),
          banner.display_order || 0,
          banner.target_type || 'all',
          banner.min_clicks || 0,
          banner.created_at,
          banner.updated_at || new Date()
        ]);
      }
      
      console.log(`✅ Migrated ${oldBanners.length} banners successfully`);
    }
  } catch (err) {
    console.error('❌ Banner migration error:', err);
  }
}

// Run banner migration on startup
migrateBanners().catch(console.error);

// Function to fix banner table foreign key constraints
async function fixBannerConstraints() {
  try {
    console.log('🔄 Checking and fixing banner table constraints...');

    // First, get all foreign key constraints on banner_target_links
    const [constraints] = await pool.query(`
      SELECT 
        CONSTRAINT_NAME,
        REFERENCED_TABLE_NAME
      FROM information_schema.KEY_COLUMN_USAGE 
      WHERE TABLE_NAME = 'banner_target_links' 
      AND REFERENCED_TABLE_NAME IN ('banners', 'ad_banners')
      AND CONSTRAINT_NAME != 'PRIMARY'
      AND TABLE_SCHEMA = DATABASE()
    `);

    console.log('Found constraints:', constraints);

    // Drop all existing foreign key constraints
    for (const constraint of constraints) {
      try {
        await pool.query(`
          ALTER TABLE banner_target_links
          DROP FOREIGN KEY \`${constraint.CONSTRAINT_NAME}\`
        `);
        console.log(`Dropped constraint: ${constraint.CONSTRAINT_NAME}`);
      } catch (err) {
        // If we can't drop it, just log and continue
        console.log(`Note: Could not drop constraint ${constraint.CONSTRAINT_NAME}:`, err.message);
      }
    }

    // Add the new constraint to reference the banners table
    try {
      await pool.query(`
        ALTER TABLE banner_target_links
        ADD CONSTRAINT fk_banner_target_banner
        FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE
      `);
      console.log('✅ Added new foreign key constraint successfully');
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log('Note: Foreign key constraint already exists');
      } else {
        throw err;
      }
    }

    console.log('✅ Banner table constraints check completed');
  } catch (error) {
    console.error('❌ Error fixing banner constraints:', error);
    // Log more details about the error
    console.error('Error details:', {
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage
    });
  }
}

// Run the fix before initializing services
fixBannerConstraints().catch(console.error);

// Initialize services
const currencyService = new CurrencyService(pool);
const emailService = new EmailService(pool);

// Initialize notification service with email service
const notificationService = new NotificationService(pool, emailService);

const commissionService = new CommissionService(pool, currencyService, notificationService);
const flutterwaveService = new FlutterwaveService();
const reportScheduler = new ReportScheduler(notificationService);
const activationService = new ActivationService(pool);

// Verify email service is working
emailService.transporter?.verify().then(() => {
    console.log('Email service is ready');
}).catch(err => {
    console.error('Email service configuration error:', err);
});

// Wire up notification service to commission service
commissionService.setNotificationService(notificationService);

// Make services available to routes
app.locals.pool = pool;
app.locals.currencyService = currencyService;
app.locals.commissionService = commissionService;
app.locals.flutterwaveService = flutterwaveService;
app.locals.emailService = emailService;
app.locals.notificationService = notificationService;
app.locals.reportScheduler = reportScheduler;
app.locals.activationService = activationService;

// Make notification service globally available for commission service
global.notificationService = notificationService;

// Configure email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  // Add debug option for troubleshooting (remove in production)
  debug: true,
  // Use a fallback if the SMTP server fails
  fallback: true
});

// Testing the transporter connection
transporter.verify(function(error, success) {
  if (error) {
    console.error('SMTP connection error:', error);
    console.log('Email functionality will be disabled. Please check your SMTP settings.');
  } else {
    console.log('SMTP server is ready to send emails');
  }
});

// Helper function to send email with improved error handling
async function sendEmail(to, subject, html) {
  // Skip sending if credentials aren't set
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('Email not sent: Missing SMTP credentials in environment variables');
    console.log('Would have sent email to:', to);
    console.log('Subject:', subject);
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"BenixSpace" <noreply@benixspace.com>',
      to,
      subject,
      html
    });
    console.log('Email sent successfully:', info.messageId);
    return true;
  } catch (err) {
    console.error('Email sending error:', err);
    // Log what we would have sent for debugging purposes
    console.log('Failed to send email to:', to);
    console.log('Subject:', subject);
    return false;
  }
}

// Helper function to send email
async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"BenixSpace" <noreply@benixspace.com>',
      to,
      subject,
      html
    });
  } catch (err) {
    console.error('Email sending error:', err);
  }
}

// Helper function to send withdrawal notification
async function sendWithdrawalNotification(user, transaction, status) {
  const statusText = {
    completed: 'processed and sent',
    failed: 'cancelled',
    rejected: 'rejected'
  }[status];

  const emailHtml = `
    <h2>Withdrawal Update</h2>
    <p>Hello ${user.username},</p>
    <p>Your withdrawal request for $${transaction.amount} has been ${statusText}.</p>
    ${(status === 'failed' || status === 'rejected') ? '<p>The amount has been returned to your wallet.</p>' : ''}
    ${transaction.notes ? `<p>Notes: ${transaction.notes}</p>` : ''}
    ${transaction.details ? `<p>Details: ${transaction.details}</p>` : ''}
    <p>If you have any questions, please contact support.</p>
    <br>
    <p>Best regards,<br>BenixSpace Team</p>
  `;

  await sendEmail(
    user.email,
    `Withdrawal ${status === 'completed' ? 'Processed' : 'Update'}`,
    emailHtml
  );
}

// Migration function for validated_view column
async function runValidatedViewMigration(connection) {
  try {
    // Check if validated_view column exists in clicks table
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'clicks' 
      AND COLUMN_NAME = 'validated_view'
    `);
    
    if (columns.length === 0) {
      console.log('🔄 Running validated_view migration...');
      
      // Add validated_view column to clicks table
      await connection.query(`
        ALTER TABLE clicks ADD COLUMN validated_view BOOLEAN DEFAULT FALSE
      `);
      
      // Update existing clicks to mark them as validated (for backward compatibility)
      await connection.query(`
        UPDATE clicks SET validated_view = TRUE WHERE is_counted = TRUE
      `);
      
      console.log('✅ validated_view migration completed successfully');
    } else {
      console.log('📋 validated_view column already exists, skipping migration');
    }
  } catch (error) {
    console.error('❌ Error running validated_view migration:', error);
    // Don't throw error to prevent app startup failure
  }
}

// Initialize the database tables if they don't exist
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    // Create config table with adjusted key length and row format
    await connection.query(`
      CREATE TABLE IF NOT EXISTS config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        key_name VARCHAR(191) NOT NULL UNIQUE,
        value TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ROW_FORMAT=DYNAMIC
    `);

    // Run migration for validated_view column
    await runValidatedViewMigration(connection);

    // Add product type and song fields to products table
    try {
      // Check if product_type column exists
      const [typeColumns] = await connection.query(`
        SHOW COLUMNS FROM products LIKE 'product_type'
      `);
      
      if (typeColumns.length === 0) {
        await connection.query(`
          ALTER TABLE products 
          ADD COLUMN product_type ENUM('product', 'song') DEFAULT 'product' AFTER name
        `);
        console.log('Added product_type column to products table');
      }

      // Add song-specific fields
      const songFields = [
        'audio_file VARCHAR(500)',
        'lyrics TEXT',
        'genre VARCHAR(100)',
        'style ENUM("secular", "gospel") DEFAULT "secular"',
        'duration INT', // duration in seconds
        'preview_start INT DEFAULT 0', // start time for 35-second preview
        'cover_image VARCHAR(500)', // auto-generated cover
        'is_sold BOOLEAN DEFAULT FALSE',
        'buyer_id INT',
        'sold_at TIMESTAMP NULL'
      ];

      for (const field of songFields) {
        const fieldName = field.split(' ')[0];
        const [fieldColumns] = await connection.query(`
          SHOW COLUMNS FROM products LIKE '${fieldName}'
        `);
        
        if (fieldColumns.length === 0) {
          await connection.query(`
            ALTER TABLE products ADD COLUMN ${field}
          `);
          console.log(`Added ${fieldName} column to products table`);
        }
      }

    } catch (err) {
      console.error('Error adding song fields to products table:', err);
    }



    // Create users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(100) NOT NULL,
        role ENUM('admin', 'merchant', 'user') DEFAULT 'user',
        wallet DECIMAL(10,2) DEFAULT 0,
        balance DECIMAL(10,4) DEFAULT 0.0000,
        earnings DECIMAL(10,2) DEFAULT 0,
        has_lifetime_commission BOOLEAN DEFAULT FALSE,
        business_name VARCHAR(100),
        business_description TEXT,
        is_verified BOOLEAN DEFAULT FALSE,
        amount_to_pay DECIMAL(10,2) DEFAULT 0,
        paid_balance DECIMAL(10,2) DEFAULT 0,
        account_name VARCHAR(150),
        account_number VARCHAR(150),
        bank_code VARCHAR(50),
        phone_number VARCHAR(20),
        notes TEXT,
        last_login_date DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add last_login_date column to users table if it doesn't exist
    try {
  await connection.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS country VARCHAR(100) AFTER bank_code,
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20) AFTER country,
    ADD COLUMN IF NOT EXISTS last_login_date DATETIME
  `);
} catch (err) {
  // For databases that don't support IF NOT EXISTS in ALTER TABLE
  try {
    // Check if country column exists
    const [countryColumns] = await connection.query(`
      SHOW COLUMNS FROM users LIKE 'country'
    `);
    
    if (countryColumns.length === 0) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN country VARCHAR(100) AFTER bank_code
      `);
      console.log('Added country column');
    }
    
    // Check if phone_number column exists
    const [phoneColumns] = await connection.query(`
      SHOW COLUMNS FROM users LIKE 'phone_number'
    `);
    
    if (phoneColumns.length === 0) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN phone_number VARCHAR(20) AFTER country
      `);
      console.log('Added phone_number column');
    }
    
    // Check if last_login_date column exists
    const [loginDateColumns] = await connection.query(`
      SHOW COLUMNS FROM users LIKE 'last_login_date'
    `);
    
    if (loginDateColumns.length === 0) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN last_login_date DATETIME
      `);
      console.log('Added last_login_date column');
    }
  } catch (checkErr) {
    console.error('Error checking/adding columns:', checkErr);
  }
}
   
    // Check if we need to rename merchant_balance to amount_to_pay
    try {
      const [columns] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'merchant_balance'
      `);
      
      if (columns.length > 0) {
        // Rename merchant_balance to amount_to_pay
        await connection.query(`
          ALTER TABLE users 
          CHANGE merchant_balance amount_to_pay DECIMAL(10,2) DEFAULT 0
        `);
        
        console.log('Renamed merchant_balance to amount_to_pay');
      }
      
      // Add paid_balance column if it doesn't exist
      const [paidBalanceColumn] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'paid_balance'
      `);
      
      if (paidBalanceColumn.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN paid_balance DECIMAL(10,2) DEFAULT 0 AFTER amount_to_pay
        `);
        
        console.log('Added paid_balance column');
      }
    } catch (err) {
      console.error('Error updating users table schema:', err);
    }
    // Create referrals table if it doesn't exist
await connection.query(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    referrer_id INT NOT NULL,
    referred_id INT NOT NULL,
    commission_paid DECIMAL(10,4) DEFAULT 0.0200,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id),
    FOREIGN KEY (referred_id) REFERENCES users(id)
  )
`);
    // Create links table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        description TEXT,
        merchant_id INT NOT NULL,
        type ENUM('product', 'link', 'youtube') NOT NULL,
        url TEXT NOT NULL,
        image_url TEXT,
        price DECIMAL(10,2),
        category VARCHAR(150),
        click_target INT NOT NULL,
        cost_per_click DECIMAL(10,2) NOT NULL,
        clicks_count INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (merchant_id) REFERENCES users(id)
      )
    `);

    // Create banner tables (after users and links tables exist)
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ad_banners (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          image_url VARCHAR(500) NOT NULL,
          click_url VARCHAR(500) NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          target_type ENUM('all', 'specific', 'popular') DEFAULT 'all',
          min_clicks INT DEFAULT 0,
          created_by INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      console.log('✅ Created ad_banners table');
    } catch (err) {
      console.error('Error creating ad_banners table:', err);
    }

    // Create banner target links table (for specific targeting)
    try {
      // First check the data types of the referenced columns
      const [bannersSchema] = await connection.query(`
        SHOW COLUMNS FROM ad_banners WHERE Field = 'id'
      `);
      const [linksSchema] = await connection.query(`
        SHOW COLUMNS FROM links WHERE Field = 'id'
      `);
      
      console.log('ad_banners.id type:', bannersSchema[0]?.Type);
      console.log('links.id type:', linksSchema[0]?.Type);
      
      await connection.query(`
        CREATE TABLE IF NOT EXISTS banner_target_links (
          id INT AUTO_INCREMENT PRIMARY KEY,
          banner_id INT NOT NULL,
          link_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (banner_id) REFERENCES ad_banners(id) ON DELETE CASCADE,
          FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE,
          UNIQUE KEY unique_banner_link (banner_id, link_id)
        )
      `);
      console.log('✅ Created banner_target_links table');
    } catch (err) {
      console.error('Error creating banner_target_links table:', err);
      // If foreign key constraint fails, create without foreign keys first
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS banner_target_links (
            id INT AUTO_INCREMENT PRIMARY KEY,
            banner_id INT NOT NULL,
            link_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_banner_link (banner_id, link_id)
          )
        `);
        console.log('✅ Created banner_target_links table without foreign keys');
        
        // Try to add foreign keys separately with better error handling
        try {
          await connection.query(`
            ALTER TABLE banner_target_links 
            ADD CONSTRAINT fk_banner_target_banner 
            FOREIGN KEY (banner_id) REFERENCES ad_banners(id) ON DELETE CASCADE
          `);
          console.log('✅ Added banner_id foreign key to banner_target_links');
        } catch (fkErr) {
          console.error('Could not add banner_id foreign key:', fkErr.message);
          console.error('This might be due to existing data or data type mismatch');
        }
        
        try {
          await connection.query(`
            ALTER TABLE banner_target_links 
            ADD CONSTRAINT fk_banner_target_link 
            FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
          `);
          console.log('✅ Added link_id foreign key to banner_target_links');
        } catch (fkErr) {
          console.error('Could not add link_id foreign key:', fkErr.message);
          console.error('This might be due to existing data or data type mismatch');
        }
      } catch (createErr) {
        console.error('Could not create banner_target_links table at all:', createErr);
      }
    }

    // Create banner analytics table
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS banner_analytics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          banner_id INT NOT NULL,
          link_id INT,
          event_type ENUM('impression', 'click') NOT NULL,
          user_id INT,
          ip_address VARCHAR(45),
          user_agent TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (banner_id) REFERENCES ad_banners(id) ON DELETE CASCADE,
          FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_banner_event (banner_id, event_type),
          INDEX idx_created_at (created_at)
        )
      `);
      console.log('✅ Created banner_analytics table');
    } catch (err) {
      console.error('Error creating banner_analytics table:', err);
      // Create without foreign keys if needed
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS banner_analytics (
            id INT AUTO_INCREMENT PRIMARY KEY,
            banner_id INT NOT NULL,
            link_id INT,
            event_type ENUM('impression', 'click') NOT NULL,
            user_id INT,
            ip_address VARCHAR(45),
            user_agent TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_banner_event (banner_id, event_type),
            INDEX idx_created_at (created_at)
          )
        `);
        console.log('✅ Created banner_analytics table without foreign keys');
        
        // Try to add foreign keys one by one to see which one fails
        try {
          await connection.query(`
            ALTER TABLE banner_analytics 
            ADD CONSTRAINT fk_banner_analytics_banner 
            FOREIGN KEY (banner_id) REFERENCES ad_banners(id) ON DELETE CASCADE
          `);
          console.log('✅ Added banner_id foreign key to banner_analytics');
        } catch (fkErr) {
          console.error('Could not add banner_id foreign key to banner_analytics:', fkErr.message);
        }
        
        try {
          await connection.query(`
            ALTER TABLE banner_analytics 
            ADD CONSTRAINT fk_banner_analytics_link 
            FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE SET NULL
          `);
          console.log('✅ Added link_id foreign key to banner_analytics');
        } catch (fkErr) {
          console.error('Could not add link_id foreign key to banner_analytics:', fkErr.message);
        }
        
        try {
          await connection.query(`
            ALTER TABLE banner_analytics 
            ADD CONSTRAINT fk_banner_analytics_user 
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          `);
          console.log('✅ Added user_id foreign key to banner_analytics');
        } catch (fkErr) {
          console.error('Could not add user_id foreign key to banner_analytics:', fkErr.message);
        }
      } catch (createErr) {
        console.error('Could not create banner_analytics table at all:', createErr);
      }
    }

// Update precision for existing columns if the table already exists
try {
  // Check which columns exist before modifying them
  const [columns] = await connection.query(`
    SHOW COLUMNS FROM users
  `);
  
  const columnNames = columns.map(col => col.Field);
  const columnsToUpdate = [];
  
  if (columnNames.includes('wallet')) {
    columnsToUpdate.push('MODIFY wallet DECIMAL(10,4) DEFAULT 0.0000');
  }
  if (columnNames.includes('balance')) {
    columnsToUpdate.push('MODIFY balance DECIMAL(10,4) DEFAULT 0.0000');
  }
  if (columnNames.includes('earnings')) {
    columnsToUpdate.push('MODIFY earnings DECIMAL(10,4) DEFAULT 0.0000');
  }
  if (columnNames.includes('amount_to_pay')) {
    columnsToUpdate.push('MODIFY amount_to_pay DECIMAL(10,4) DEFAULT 0.0000');
  }
  if (columnNames.includes('paid_balance')) {
    columnsToUpdate.push('MODIFY paid_balance DECIMAL(10,4) DEFAULT 0.0000');
  }
  
  if (columnsToUpdate.length > 0) {
    await connection.query(`
      ALTER TABLE users 
      ${columnsToUpdate.join(',\n      ')}
    `);
    console.log('✅ Updated users decimal precision for existing columns');
  }
} catch (err) {
  console.error('Error updating users decimal precision:', err);
}
  // Create transactions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('deposit', 'withdrawal', 'commission', 'payment', 'upgrade') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status ENUM('pending', 'completed', 'failed', 'rejected') DEFAULT 'pending',
        reference VARCHAR(150),
        details TEXT,
        notes TEXT,
        gateway VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

try {
  await connection.query(`
    ALTER TABLE transactions 
    MODIFY amount DECIMAL(10,4) NOT NULL
  `);
} catch (err) {
  console.error('Error updating transactions decimal precision:', err);
}

// Update transactions table to include 'bonus' type
try {
  // First check if 'bonus' type already exists
  const [columns] = await connection.query(`
    SHOW COLUMNS FROM transactions WHERE Field = 'type'
  `);
  
  if (columns.length > 0) {
    const typeColumn = columns[0];
    const currentEnum = typeColumn.Type;
    
    // Check if 'bonus' is already in the enum
    if (!currentEnum.includes('bonus')) {
      console.log('Adding bonus type to transactions table...');
      await connection.query(`
        ALTER TABLE transactions 
        MODIFY type ENUM('deposit', 'withdrawal', 'commission', 'payment', 'upgrade', 'bonus') NOT NULL
      `);
      console.log('✅ Updated transactions table to include bonus type');
    } else {
      console.log('✅ Transactions table already includes bonus type');
    }
  }
} catch (err) {
  console.error('Error updating transactions type enum:', err);
  // Try to recreate the table if it's corrupted
  try {
    console.log('Attempting to fix transactions table...');
    await connection.query(`DROP TABLE IF EXISTS transactions`);
    await connection.query(`
      CREATE TABLE transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('deposit', 'withdrawal', 'commission', 'payment', 'upgrade', 'bonus') NOT NULL,
        amount DECIMAL(10,4) NOT NULL,
        status ENUM('pending', 'completed', 'failed', 'rejected') DEFAULT 'pending',
        reference VARCHAR(150),
        details TEXT,
        notes TEXT,
        gateway VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    console.log('✅ Recreated transactions table with bonus type');
  } catch (recreateErr) {
    console.error('Error recreating transactions table:', recreateErr);
  }
}

// Create blog_posts table
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      merchant_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      content LONGTEXT NOT NULL,
      excerpt TEXT,
      featured_image VARCHAR(500),
      meta_title VARCHAR(60),
      meta_description VARCHAR(160),
      meta_keywords VARCHAR(255),
      cpc DECIMAL(10,4) NOT NULL DEFAULT 0.0100,
      is_active BOOLEAN DEFAULT true,
      view_count INT DEFAULT 0,
      click_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (merchant_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_slug (slug),
      INDEX idx_merchant (merchant_id),
      INDEX idx_active (is_active),
      INDEX idx_created (created_at)
    )
  `);
  console.log('✅ Blog posts table created');
} catch (err) {
  console.error('Error creating blog_posts table:', err);
}

// Create blog_post_shares table
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS blog_post_shares (
      id INT AUTO_INCREMENT PRIMARY KEY,
      blog_post_id INT NOT NULL,
      user_id INT NOT NULL,
      unique_code VARCHAR(50) UNIQUE NOT NULL,
      clicks_count INT DEFAULT 0,
      earnings DECIMAL(10,4) DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_code (unique_code),
      INDEX idx_user_post (user_id, blog_post_id),
      INDEX idx_active (is_active)
    )
  `);
  console.log('✅ Blog post shares table created');
} catch (err) {
  console.error('Error creating blog_post_shares table:', err);
}

// Create blog_post_views table for tracking views with IP restrictions
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS blog_post_views (
      id INT AUTO_INCREMENT PRIMARY KEY,
      blog_post_id INT NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      user_agent TEXT,
      referrer VARCHAR(500),
      viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
      INDEX idx_post_id (blog_post_id),
      INDEX idx_ip_time (ip_address, viewed_at),
      UNIQUE KEY unique_ip_post_time (blog_post_id, ip_address, viewed_at)
    )
  `);
  console.log('✅ Blog post views table created');
} catch (err) {
  console.error('Error creating blog_post_views table:', err);
}

// Create blog_post_clicks table
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS blog_post_clicks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      blog_post_share_id INT NULL,
      blog_post_id INT NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      referrer VARCHAR(500),
      clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      validated_view BOOLEAN DEFAULT false,
      read_time_seconds INT DEFAULT 0,
      commission_paid BOOLEAN DEFAULT false,
      FOREIGN KEY (blog_post_share_id) REFERENCES blog_post_shares(id) ON DELETE CASCADE,
      FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
      INDEX idx_share_id (blog_post_share_id),
      INDEX idx_post_id (blog_post_id),
      INDEX idx_ip_date (ip_address, created_at),
      INDEX idx_validated (validated_view),
      INDEX idx_commission (commission_paid)
    )
  `);
  
  // Add blog_post_id column if it doesn't exist (for existing installations)
  try {
    // Check if columns exist first, then add them
    const [columns] = await connection.query(`
      SHOW COLUMNS FROM blog_post_clicks LIKE 'commission_paid'
    `);
    
    if (columns.length === 0) {
      console.log('Adding commission_paid column to blog_post_clicks table...');
      await connection.query(`
        ALTER TABLE blog_post_clicks 
        ADD COLUMN commission_paid BOOLEAN DEFAULT FALSE
      `);
      console.log('✅ Added commission_paid column');
    }

    const [blogPostIdColumns] = await connection.query(`
      SHOW COLUMNS FROM blog_post_clicks LIKE 'blog_post_id'
    `);
    
    if (blogPostIdColumns.length === 0) {
      console.log('Adding blog_post_id column to blog_post_clicks table...');
      await connection.query(`
        ALTER TABLE blog_post_clicks 
        ADD COLUMN blog_post_id INT NULL AFTER blog_post_share_id
      `);
      console.log('✅ Added blog_post_id column');
    }

    const [createdAtColumns] = await connection.query(`
      SHOW COLUMNS FROM blog_post_clicks LIKE 'created_at'
    `);
    
    if (createdAtColumns.length === 0) {
      console.log('Adding created_at column to blog_post_clicks table...');
      await connection.query(`
        ALTER TABLE blog_post_clicks 
        ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER clicked_at
      `);
      console.log('✅ Added created_at column');
    }

    // Add read_time_seconds column if it doesn't exist
    const [readTimeColumns] = await connection.query(`
      SHOW COLUMNS FROM blog_post_clicks LIKE 'read_time_seconds'
    `);
    
    if (readTimeColumns.length === 0) {
      console.log('Adding read_time_seconds column to blog_post_clicks table...');
      await connection.query(`
        ALTER TABLE blog_post_clicks 
        ADD COLUMN read_time_seconds INT DEFAULT 0
      `);
      console.log('✅ Added read_time_seconds column');
    }

    // Add validated_view column if it doesn't exist
    const [validatedViewColumns] = await connection.query(`
      SHOW COLUMNS FROM blog_post_clicks LIKE 'validated_view'
    `);
    
    if (validatedViewColumns.length === 0) {
      console.log('Adding validated_view column to blog_post_clicks table...');
      await connection.query(`
        ALTER TABLE blog_post_clicks 
        ADD COLUMN validated_view BOOLEAN DEFAULT FALSE
      `);
      console.log('✅ Added validated_view column');
    }

    // Make blog_post_share_id nullable for direct views
    await connection.query(`
      ALTER TABLE blog_post_clicks 
      MODIFY COLUMN blog_post_share_id INT NULL
    `);
    console.log('✅ Made blog_post_share_id nullable');
    
  } catch (alterErr) {
    console.error('Error adding columns to blog_post_clicks table:', alterErr);
  }
  
  console.log('✅ Blog post clicks table created/updated');
} catch (err) {
  console.error('Error creating blog_post_clicks table:', err);
}

// Ensure blog_posts statistics columns exist and have proper default values
try {
  // Check if columns exist and add them if missing
  await connection.query(`
    ALTER TABLE blog_posts 
    ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS click_count INT DEFAULT 0
  `);
  
  // Update existing NULL values to 0
  await connection.query(`
    UPDATE blog_posts 
    SET view_count = 0 WHERE view_count IS NULL
  `);
  
  await connection.query(`
    UPDATE blog_posts 
    SET click_count = 0 WHERE click_count IS NULL
  `);
  
  console.log('✅ Blog posts statistics columns updated');
} catch (err) {
  console.log('Note: Blog posts statistics columns already exist or update not needed');
}

// Create banners table
  try {
    // Create banners table with nullable merchant_id
    await connection.query(`
      CREATE TABLE IF NOT EXISTS banners (
      id INT AUTO_INCREMENT PRIMARY KEY,
      merchant_id INT,
      title VARCHAR(255) NOT NULL,
      image_url VARCHAR(500) NOT NULL,
      target_url VARCHAR(500) NOT NULL,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      is_active BOOLEAN DEFAULT false,
      admin_notes TEXT,
      display_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (merchant_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_merchant (merchant_id),
      INDEX idx_status (status),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB
  `);
  console.log('✅ Banners table created');
  
  // Ensure merchant_id is nullable (in case table already existed)
  await connection.query(`
    ALTER TABLE banners MODIFY COLUMN merchant_id INT NULL
  `);
  console.log('✅ Ensured merchant_id is nullable');  // Add targeting columns to banners table if they don't exist
  try {
    await connection.query(`
      ALTER TABLE banners
      ADD COLUMN IF NOT EXISTS target_type ENUM('all', 'specific', 'popular') DEFAULT 'all',
      ADD COLUMN IF NOT EXISTS min_clicks INT DEFAULT 0
    `);
    console.log('✅ Banner targeting columns added');
  } catch (err) {
    console.log('Note: Banner targeting columns already exist or update not needed');
  }

  // Create banner target links table
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS banner_target_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        banner_id INT NOT NULL,
        link_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_banner_link (banner_id, link_id),
        FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE,
        FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ Banner target links table created');
  } catch (err) {
    console.error('Error creating banner target links table:', err);
  }

} catch (err) {
  console.error('Error creating banners table:', err);
}

// Create banner_clicks table
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS banner_clicks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      banner_id INT NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      user_agent TEXT,
      referrer VARCHAR(500),
      country VARCHAR(100),
      city VARCHAR(100),
      clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE,
      INDEX idx_banner (banner_id),
      INDEX idx_location (country, city),
      INDEX idx_time (clicked_at)
    )
  `);
  console.log('✅ Banner clicks table created');
} catch (err) {
  console.error('Error creating banner_clicks table:', err);
}

// Create banner_views table
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS banner_views (
      id INT AUTO_INCREMENT PRIMARY KEY,
      banner_id INT NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      user_agent TEXT,
      country VARCHAR(100),
      city VARCHAR(100),
      viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (banner_id) REFERENCES banners(id) ON DELETE CASCADE,
      INDEX idx_banner (banner_id),
      INDEX idx_location (country, city),
      INDEX idx_time (viewed_at)
    )
  `);
  console.log('✅ Banner views table created');
} catch (err) {
  console.error('Error creating banner_views table:', err);
}

// Update transactions table to include 'rejected' status if not already present
try {
  await connection.query(`
    ALTER TABLE transactions 
    MODIFY status ENUM('pending', 'completed', 'failed', 'rejected') DEFAULT 'pending'
  `);
  console.log('Updated transactions status enum to include rejected');
} catch (err) {
  console.error('Error updating transactions status enum:', err);
}

try {
  await connection.query(`
    ALTER TABLE links 
    MODIFY cost_per_click DECIMAL(10,4) NOT NULL
  `);
} catch (err) {
  console.error('Error updating links decimal precision:', err);
}
 // Create orders table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
        shipping_address TEXT NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);


try {
  const [columns] = await connection.query(`
    SHOW COLUMNS FROM users LIKE 'referral_id'
  `);
  
  if (columns.length === 0) {
    await connection.query(`
      ALTER TABLE users 
      ADD COLUMN referral_id VARCHAR(50) UNIQUE
    `);
    
    // Generate referral IDs for existing users
    const [users] = await connection.query('SELECT id FROM users');
    for (const user of users) {
      const referralId = uuidv4().substring(0, 8);
      await connection.query('UPDATE users SET referral_id = ? WHERE id = ?', [referralId, user.id]);
    }
  }
} catch (err) {
  console.error('Error adding referral_id column:', err);
}

    // Add new columns for unilevel commission system
    try {
      // Add activation_paid column to users table
      const [activationColumns] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'activation_paid'
      `);
      
      if (activationColumns.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN activation_paid BOOLEAN DEFAULT FALSE AFTER is_verified
        `);
        console.log('Added activation_paid column');
      }

      // Add referrer_id column to users table (for tracking who referred this user)
      const [referrerColumns] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'referrer_id'
      `);
      
      if (referrerColumns.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN referrer_id INT AFTER referral_id,
          ADD INDEX idx_referrer_id (referrer_id)
        `);
        console.log('Added referrer_id column');
      }

      // Add activated_at column to users table
      const [activatedAtColumns] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'activated_at'
      `);
      
      if (activatedAtColumns.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN activated_at TIMESTAMP NULL AFTER last_login_date
        `);
        console.log('Added activated_at column');
      }

      // Add status column for pending users (modify role enum)
      const [statusColumns] = await connection.query(`
        SHOW COLUMNS FROM users LIKE 'status'
      `);
      
      if (statusColumns.length === 0) {
        await connection.query(`
          ALTER TABLE users 
          ADD COLUMN status ENUM('pending', 'active', 'suspended') DEFAULT 'pending' AFTER role
        `);
        console.log('Added status column');
      }

    } catch (err) {
      console.error('Error adding unilevel system columns:', err);
    }

    // Create system_settings table for admin configuration
    await connection.query(`
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

    // Create commissions table for tracking unilevel commissions
    await connection.query(`
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

    // Create activation_payments table for tracking activation payments
    await connection.query(`
      CREATE TABLE IF NOT EXISTS activation_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount_usd DECIMAL(15, 2) NOT NULL,
        amount_original DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        payment_method VARCHAR(50),
        payment_type ENUM('automatic', 'manual') DEFAULT 'automatic',
        flutterwave_tx_ref VARCHAR(255),
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

    // Add payment_type column to activation_payments if it doesn't exist
    try {
      const [paymentTypeColumns] = await connection.query(`
        SHOW COLUMNS FROM activation_payments LIKE 'payment_type'
      `);
      
      if (paymentTypeColumns.length === 0) {
        await connection.query(`
          ALTER TABLE activation_payments 
          ADD COLUMN payment_type ENUM('automatic', 'manual') DEFAULT 'automatic' AFTER payment_method
        `);
        console.log('Added payment_type column to activation_payments');
      }
    } catch (err) {
      console.error('Error adding payment_type column:', err);
    }

    // Add manual_payment_id column to activation_payments if it doesn't exist
    try {
      const [manualPaymentIdColumns] = await connection.query(`
        SHOW COLUMNS FROM activation_payments LIKE 'manual_payment_id'
      `);
      
      if (manualPaymentIdColumns.length === 0) {
        await connection.query(`
          ALTER TABLE activation_payments 
          ADD COLUMN manual_payment_id INT NULL AFTER flutterwave_tx_id
        `);
        console.log('Added manual_payment_id column to activation_payments');
      }
    } catch (err) {
      console.error('Error adding manual_payment_id column:', err);
    }

    // Modify flutterwave_tx_ref to allow NULL values for manual payments
    try {
      await connection.query(`
        ALTER TABLE activation_payments 
        MODIFY COLUMN flutterwave_tx_ref VARCHAR(255) NULL
      `);
    } catch (err) {
      console.error('Error modifying flutterwave_tx_ref column:', err);
    }

    // Create manual_activation_payments table for manual payment submissions
    await connection.query(`
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
    try {
      // Check if foreign key constraint already exists
      const [constraints] = await connection.query(`
        SELECT CONSTRAINT_NAME 
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'activation_payments' 
        AND COLUMN_NAME = 'manual_payment_id'
        AND REFERENCED_TABLE_NAME = 'manual_activation_payments'
      `);
      
      if (constraints.length === 0) {
        await connection.query(`
          ALTER TABLE activation_payments 
          ADD CONSTRAINT fk_manual_payment 
          FOREIGN KEY (manual_payment_id) REFERENCES manual_activation_payments(id) ON DELETE SET NULL
        `);
        console.log('Added foreign key constraint for manual_payment_id');
      }
    } catch (err) {
      console.error('Error adding foreign key constraint for manual_payment_id:', err);
    }

    // Create user_referrals table for detailed referral tracking
    await connection.query(`
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

    // Migrate data from old referrals table to user_referrals table (one-time migration)
    try {
      // Check if migration has already been done successfully
      const [migrationCheck] = await connection.query(`
        SELECT setting_value FROM system_settings 
        WHERE setting_key = 'referrals_migrated_v2'
      `);

      if (!migrationCheck.length || migrationCheck[0].setting_value !== 'true') {
        console.log('Starting referrals migration from old table to new table...');

        // Check if old referrals table exists and has data
        const [oldReferrals] = await connection.query(`
          SELECT 
            r.referrer_id,
            r.referred_id,
            r.commission_paid,
            r.created_at,
            CONCAT('REF_', r.id) as referral_code
          FROM referrals r
          WHERE NOT EXISTS (
            SELECT 1 FROM user_referrals ur 
            WHERE ur.referrer_id = r.referrer_id 
            AND ur.referred_id = r.referred_id
          )
        `);

        if (oldReferrals.length > 0) {
          console.log(`Found ${oldReferrals.length} referrals to migrate...`);

          let successCount = 0;
          for (const referral of oldReferrals) {
            try {
              // Check if referred user is activated
              const [userStatus] = await connection.query(`
                SELECT status FROM users WHERE id = ?
              `, [referral.referred_id]);

              const status = (userStatus.length > 0 && userStatus[0].status === 'active') ? 'activated' : 'pending';
              const commissionPaid = referral.commission_paid > 0;
              const activatedAt = status === 'activated' ? referral.created_at : null;

              // Insert into user_referrals table
              await connection.query(`
                INSERT INTO user_referrals 
                (referrer_id, referred_id, referral_code, status, commission_paid, created_at, activated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                status = VALUES(status),
                commission_paid = VALUES(commission_paid),
                activated_at = VALUES(activated_at)
              `, [
                referral.referrer_id,
                referral.referred_id,
                referral.referral_code,
                status,
                commissionPaid,
                referral.created_at,
                activatedAt
              ]);

              // If commission was paid in old table, create commission record
              if (commissionPaid && referral.commission_paid > 0) {
                // Convert USD to RWF (assuming old commissions were in USD)
                const commissionRWF = referral.commission_paid * 1300; // Approximate conversion

                await connection.query(`
                  INSERT IGNORE INTO commissions 
                  (user_id, referrer_id, referred_user_id, level, amount_rwf, amount_usd, commission_type, status, created_at)
                  VALUES (?, ?, ?, 1, ?, ?, 'activation', 'paid', ?)
                `, [
                  referral.referrer_id,
                  referral.referrer_id,
                  referral.referred_id,
                  commissionRWF,
                  referral.commission_paid,
                  referral.created_at
                ]);
              }

              successCount++;
            } catch (err) {
              console.error(`Error migrating referral ${referral.referrer_id} -> ${referral.referred_id}:`, err.message);
            }
          }

          console.log(`Successfully migrated ${successCount} out of ${oldReferrals.length} referrals to new system`);
        } else {
          console.log('No referrals found to migrate from old table');
        }

        // Mark migration as completed with new version flag
        await connection.query(`
          INSERT INTO system_settings (setting_key, setting_value, setting_type, description)
          VALUES ('referrals_migrated_v2', 'true', 'boolean', 'Flag to indicate referrals have been migrated from old table (v2)')
          ON DUPLICATE KEY UPDATE setting_value = 'true'
        `);

        console.log('Referrals migration completed successfully');
      }
    } catch (err) {
      console.error('Error during referrals migration:', err);
      // Don't stop the app from starting if migration fails
    }

    // Insert default settings for unilevel system
    const unilevelSettings = [
      ['activation_fee_rwf', '3000', 'number', 'User activation fee in Rwandan Francs'],
      ['level1_commission_rwf', '1500', 'number', 'Level 1 commission in Rwandan Francs'],
      ['level2_commission_rwf', '500', 'number', 'Level 2 commission in Rwandan Francs'],
      ['max_commission_levels', '2', 'number', 'Maximum number of commission levels'],
      ['supported_currencies', '["RWF", "USD", "UGX", "KES", "EUR", "GBP"]', 'json', 'List of supported payment currencies'],
      ['auto_activate_existing_users', 'true', 'boolean', 'Automatically activate existing users without payment']
    ];

    for (const [key, value, type, description] of unilevelSettings) {
      await connection.query(`
        INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description)
        VALUES (?, ?, ?, ?)
      `, [key, value, type, description]);
    }

    // Auto-activate existing users (users created before this system was implemented)
    // Only run this once by checking if there's a flag in system_settings
    const [migrationCheck] = await connection.query(`
      SELECT setting_value FROM system_settings 
      WHERE setting_key = 'existing_users_activated'
    `);

    if (migrationCheck.length === 0) {
      // First time running this migration - only activate users who already have 'active' status
      // This ensures that only users who were already considered active get auto-activated
      await connection.query(`
        UPDATE users 
        SET activation_paid = TRUE, 
            activated_at = CURRENT_TIMESTAMP
        WHERE status = 'active' 
        AND activation_paid = FALSE
      `);

      // Set status to 'pending' for all users who don't have 'active' status
      await connection.query(`
        UPDATE users 
        SET status = 'pending'
        WHERE status != 'active'
      `);

      // Set flag to prevent this from running again
      await connection.query(`
        INSERT INTO system_settings (setting_key, setting_value, setting_type, description)
        VALUES ('existing_users_activated', 'true', 'boolean', 'Flag to indicate existing users have been auto-activated')
      `);

      console.log('Auto-activated users with active status (one-time migration)');
    }

    // Create currency_rates table for exchange rate caching
    await connection.query(`
      CREATE TABLE IF NOT EXISTS currency_rates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        from_currency VARCHAR(10) NOT NULL,
        to_currency VARCHAR(10) NOT NULL,
        rate DECIMAL(15, 6) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_currency_pair (from_currency, to_currency),
        INDEX idx_currencies (from_currency, to_currency),
        INDEX idx_updated (updated_at)
      ) ENGINE=InnoDB
    `);

    // Insert initial exchange rates (these will be updated by the API)
    const initialRates = [
      ['RWF', 'USD', 0.00069],  // Updated to more accurate rate
      ['USD', 'RWF', 1449.28],  // Inverse of 0.00069
      ['RWF', 'UGX', 2.5],
      ['RWF', 'KES', 0.1],
      ['USD', 'UGX', 3700],
      ['USD', 'KES', 130],
      ['USD', 'EUR', 0.85],
      ['USD', 'GBP', 0.75]
    ];

    for (const [fromCurrency, toCurrency, rate] of initialRates) {
      await connection.query(`
        INSERT IGNORE INTO currency_rates (from_currency, to_currency, rate)
        VALUES (?, ?, ?)
      `, [fromCurrency, toCurrency, rate]);
    }
 

    // Create shared_links table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS shared_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        link_id INT NOT NULL,
        user_id INT NOT NULL,
        share_code VARCHAR(150) NOT NULL UNIQUE,
        clicks INT DEFAULT 0,
        earnings DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (link_id) REFERENCES links(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
// Also update other tables with monetary values
try {
  await connection.query(`
    ALTER TABLE shared_links 
    MODIFY earnings DECIMAL(10,4) DEFAULT 0.0000
  `);
} catch (err) {
  console.error('Error updating shared_links decimal precision:', err);
}

    // Create clicks table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shared_link_id INT NOT NULL,
        ip_address VARCHAR(50),
        device_info TEXT,
        referrer TEXT,
        is_counted BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (shared_link_id) REFERENCES shared_links(id)
      )
    `);

   
    // Create products table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        merchant_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        image_url TEXT,
        category VARCHAR(150),
        commission_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (merchant_id) REFERENCES users(id)
      )
    `);

    // Create cart table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);

   
    // Create order items table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        commission_earned DECIMAL(10,2) NOT NULL,
        referrer_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (referrer_id) REFERENCES users(id)
      )
    `);
try {
  await connection.query(`
    ALTER TABLE order_items 
    MODIFY commission_earned DECIMAL(10,4) NOT NULL
  `);
} catch (err) {
  console.error('Error updating order_items decimal precision:', err);
}
    // Insert default config values
    const configValues = [
      ['commission_rate', '5', 'Default commission percentage for users (deprecated - use user_commission_percentage)'],
      ['admin_commission_rate', '10', 'Admin commission percentage from product sales'],
      ['user_commission_percentage', '30', 'User commission as percentage of admin commission (e.g., 30% of admin commission)'],
      ['cost_per_click', '0.0030', 'Default cost per click for merchants'],
      ['lifetime_commission_fee', '8', 'Fee for lifetime commission upgrade'],
      ['merchant_monthly_fee', '10', 'Monthly subscription fee for merchants'],
      ['min_payout', '6', 'Minimum amount required for payout'],
      ['min_deposit', '1', 'Minimum deposit amount for merchants'],
      ['payout_cycle', '30', 'Number of days between automatic payouts'],
      ['enable_youtube_embedding', 'true', 'Whether to allow YouTube video embedding'],
      ['umvapay_public_key', '', 'Umva Pay public key'],
      ['umvapay_secret_key', '', 'Umva Pay secret key for transaction verification'],
      ['umvapay_mode', 'test', 'Umva Pay mode (test/live)'],
      ['umvapay_site_logo', '', 'Umva Pay site logo URL'],
      ['manual_payment_instructions', 'Please transfer the amount to our account and upload a screenshot/receipt as proof of payment.', 'Instructions for manual payment processing'],
      ['manual_payment_bank_name', '', 'Bank name for manual payments'],
      ['manual_payment_account_name', '', 'Account name for manual payments'],
      ['manual_payment_account_number', '', 'Account number for manual payments'],
      ['manual_payment_swift_code', '', 'SWIFT/BIC code for international transfers (optional)'],
      ['manual_payment_enabled', 'true', 'Enable manual payment option for activations'],
      ['admin_whatsapp_number', '250783987223', 'Admin WhatsApp number for manual payment notifications'],
      ['song_admin_commission_rate', '40', 'Admin commission percentage from song sales (e.g., 40% of song price)'],
      ['song_user_commission_percentage', '40', 'User commission as percentage of admin commission from songs (e.g., 40% of admin commission)']
    ];

    for (const [key, value, description] of configValues) {
      await connection.query(
        'INSERT IGNORE INTO config (key_name, value, description) VALUES (?, ?, ?)',
        [key, value, description]
      );
    }

    // Create admin user if doesn't exist
    const adminExists = await connection.query(
      'SELECT COUNT(*) as count FROM users WHERE role = ?', 
      ['admin']
    );
    
    if (adminExists[0][0].count === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await connection.query(
        'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
        ['admin', 'admin@example.com', hashedPassword, 'admin']
      );
    }

    // Create shared_products table for product sharing functionality
    await connection.query(`
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
      )
    `);

    // Create product_clicks table for tracking clicks on shared products
    await connection.query(`
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
      )
    `);

    // Create shared_songs table for song sharing functionality
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS shared_songs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          song_id INT NOT NULL,
          user_id INT NOT NULL,
          share_code VARCHAR(10) NOT NULL UNIQUE,
          clicks INT DEFAULT 0,
          purchases INT DEFAULT 0,
          earnings DECIMAL(10, 4) DEFAULT 0.0000,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (song_id) REFERENCES products(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_share_code (share_code),
          INDEX idx_song_user (song_id, user_id),
          UNIQUE KEY unique_song_user (song_id, user_id)
        )
      `);
      console.log('✅ Created shared_songs table');
    } catch (err) {
      console.error('Error creating shared_songs table:', err);
      // Create without foreign keys if needed
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS shared_songs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            song_id INT NOT NULL,
            user_id INT NOT NULL,
            share_code VARCHAR(10) NOT NULL UNIQUE,
            clicks INT DEFAULT 0,
            purchases INT DEFAULT 0,
            earnings DECIMAL(10, 4) DEFAULT 0.0000,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_share_code (share_code),
            INDEX idx_song_user (song_id, user_id),
            UNIQUE KEY unique_song_user (song_id, user_id)
          )
        `);
        console.log('✅ Created shared_songs table without foreign keys');
      } catch (createErr) {
        console.error('Could not create shared_songs table at all:', createErr);
      }
    }

    // Create song_clicks table for tracking clicks on shared songs
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS song_clicks (
          id INT AUTO_INCREMENT PRIMARY KEY,
          shared_song_id INT NOT NULL,
          ip_address VARCHAR(45),
          device_info TEXT,
          referrer VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shared_song_id) REFERENCES shared_songs(id) ON DELETE CASCADE,
          INDEX idx_shared_song (shared_song_id),
          INDEX idx_created_at (created_at)
        )
      `);
      console.log('✅ Created song_clicks table');
    } catch (err) {
      console.error('Error creating song_clicks table:', err);
      // Create without foreign keys if needed
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS song_clicks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            shared_song_id INT NOT NULL,
            ip_address VARCHAR(45),
            device_info TEXT,
            referrer VARCHAR(500),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_shared_song (shared_song_id),
            INDEX idx_created_at (created_at)
          )
        `);
        console.log('✅ Created song_clicks table without foreign keys');
      } catch (createErr) {
        console.error('Could not create song_clicks table at all:', createErr);
      }
    }

    // Add ref_code column to orders table if it doesn't exist
    try {
      await connection.query(`
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS ref_code VARCHAR(10) DEFAULT NULL
      `);
      await connection.query(`
        ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_ref_code (ref_code)
      `);
    } catch (err) {
      // For databases that don't support IF NOT EXISTS in ALTER TABLE
      try {
        const [refCodeColumns] = await connection.query(`
          SHOW COLUMNS FROM orders LIKE 'ref_code'
        `);
        
        if (refCodeColumns.length === 0) {
          await connection.query(`
            ALTER TABLE orders ADD COLUMN ref_code VARCHAR(10) DEFAULT NULL
          `);
          await connection.query(`
            ALTER TABLE orders ADD INDEX idx_ref_code (ref_code)
          `);
        }
      } catch (alterErr) {
        console.error('Error adding ref_code column to orders:', alterErr);
      }
    }

    // Update products table to ensure it has commission_rate column
    try {
      await connection.query(`
        ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5, 2) DEFAULT 5.00
      `);
    } catch (err) {
      // For databases that don't support IF NOT EXISTS in ALTER TABLE
      try {
        const [commissionColumns] = await connection.query(`
          SHOW COLUMNS FROM products LIKE 'commission_rate'
        `);
        
        if (commissionColumns.length === 0) {
          await connection.query(`
            ALTER TABLE products ADD COLUMN commission_rate DECIMAL(5, 2) DEFAULT 5.00
          `);
        }
      } catch (alterErr) {
        console.error('Error adding commission_rate column to products:', alterErr);
      }
    }

    // ===== EMAIL AND NOTIFICATION SYSTEM TABLES =====
    console.log('🔄 Creating email and notification system tables...');
    
    // Create email_logs table
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS email_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          status ENUM('sent', 'failed', 'queued', 'system') NOT NULL,
          event_type VARCHAR(100) NOT NULL,
          details JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_status (status),
          INDEX idx_event_type (event_type),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB
      `);
      console.log('✅ Email logs table created');
    } catch (err) {
      console.error('Error creating email_logs table:', err);
    }

    // Create notifications table
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NULL,
          type ENUM('info', 'success', 'warning', 'error', 'critical') DEFAULT 'info',
          category ENUM('info', 'commission', 'payment', 'system', 'user_action', 'admin_alert', 'report') DEFAULT 'info',
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          action_url VARCHAR(500) NULL,
          is_read BOOLEAN DEFAULT FALSE,
          email_sent BOOLEAN DEFAULT FALSE,
          priority TINYINT DEFAULT 1,
          expires_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          read_at TIMESTAMP NULL,
          INDEX idx_user_id (user_id),
          INDEX idx_type (type),
          INDEX idx_category (category),
          INDEX idx_is_read (is_read),
          INDEX idx_created_at (created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('✅ Notifications table created');
    } catch (err) {
      console.error('Error creating notifications table:', err);
    }

    // Create notification_preferences table
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS notification_preferences (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          email_notifications BOOLEAN DEFAULT TRUE,
          commission_alerts BOOLEAN DEFAULT TRUE,
          payment_alerts BOOLEAN DEFAULT TRUE,
          system_alerts BOOLEAN DEFAULT TRUE,
          daily_reports BOOLEAN DEFAULT TRUE,
          weekly_reports BOOLEAN DEFAULT TRUE,
          monthly_reports BOOLEAN DEFAULT TRUE,
          marketing_emails BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_user_preferences (user_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('✅ Notification preferences table created');
    } catch (err) {
      console.error('Error creating notification_preferences table:', err);
    }

    // Create report_schedules table
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS report_schedules (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NULL,
          report_type ENUM('daily', 'weekly', 'monthly') NOT NULL,
          target_type ENUM('user', 'admin', 'all_users') NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          last_sent TIMESTAMP NULL,
          next_scheduled TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_id (user_id),
          INDEX idx_report_type (report_type),
          INDEX idx_target_type (target_type),
          INDEX idx_next_scheduled (next_scheduled),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('✅ Report schedules table created');
    } catch (err) {
      console.error('Error creating report_schedules table:', err);
    }

    // Add default notification preferences for existing users
    try {
      await connection.query(`
        INSERT IGNORE INTO notification_preferences (user_id)
        SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM notification_preferences)
      `);
      console.log('✅ Default notification preferences added for existing users');
    } catch (err) {
      console.error('Error adding default notification preferences:', err);
    }

    console.log('✅ Email and notification system tables initialized successfully');
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    connection.release();
  }
}

// Helper functions
async function getConfig(key) {
  const [rows] = await pool.query('SELECT value FROM config WHERE key_name = ?', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

async function updateConfig(key, value) {
  await pool.query('UPDATE config SET value = ? WHERE key_name = ?', [value, key]);
}

// Function to process admin commissions when order is completed
async function processAdminCommissions(orderId) {
  try {
    // Get all order items for this order
    const [orderItems] = await pool.query(`
      SELECT oi.*, p.price, p.name as product_name, o.user_id
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [orderId]);

    let totalAdminCommission = 0;

    for (const item of orderItems) {
      // Get admin commission rate from config
      const adminCommissionRate = await getConfig('admin_commission_rate') || 10; // Default 10%
      
      // Calculate admin commission (admin commission rate % of product price * quantity)
      const adminCommission = parseFloat((parseFloat(item.price) * parseFloat(adminCommissionRate) / 100 * item.quantity).toFixed(4));
      totalAdminCommission += adminCommission;
    }

    if (totalAdminCommission > 0) {
      // Record admin commission in transactions (to admin user if exists, or system)
      const [adminUsers] = await pool.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      const adminUserId = adminUsers.length > 0 ? adminUsers[0].id : null;

      if (adminUserId) {
        // Update admin earnings and wallet
        await pool.query(`
          UPDATE users 
          SET earnings = COALESCE(earnings, 0) + ?, 
              wallet = COALESCE(wallet, 0) + ? 
          WHERE id = ?
        `, [totalAdminCommission, totalAdminCommission, adminUserId]);

        // Record transaction
        await pool.query(`
          INSERT INTO transactions (user_id, type, amount, status, details, created_at)
          VALUES (?, 'admin_commission', ?, 'completed', ?, NOW())
        `, [
          adminUserId,
          totalAdminCommission,
          `Admin commission for Order #${orderId}`
        ]);

        console.log(`Processed admin commission of $${totalAdminCommission.toFixed(4)} for Order #${orderId}`);
      }
    }
  } catch (err) {
    console.error('Error processing admin commissions:', err);
  }
}

// Function to process product commissions when order is completed
async function processProductCommissions(orderId) {
  try {
    // Get all order items for this order with referral information
    const [orderItems] = await pool.query(`
      SELECT oi.*, o.ref_code, p.price, p.name as product_name
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ? AND o.ref_code IS NOT NULL
    `, [orderId]);

    for (const item of orderItems) {
      if (item.ref_code) {
        // Find the shared product record
        const [sharedProducts] = await pool.query(`
          SELECT sp.*, u.username
          FROM shared_products sp
          JOIN users u ON sp.user_id = u.id
          WHERE sp.share_code = ?
        `, [item.ref_code]);

        if (sharedProducts.length > 0) {
          const sharedProduct = sharedProducts[0];
          
          // Get admin commission rate and user commission percentage from config
          const adminCommissionRate = await getConfig('admin_commission_rate') || 10; // Default 10%
          const userCommissionPercentage = await getConfig('user_commission_percentage') || 30; // Default 30% of admin commission
          
          // Calculate admin commission (admin commission rate % of product price * quantity)
          const adminCommission = parseFloat((parseFloat(item.price) * parseFloat(adminCommissionRate) / 100 * item.quantity).toFixed(4));
          
          // Calculate user commission (user commission percentage % of admin commission)
          const userCommission = parseFloat((adminCommission * parseFloat(userCommissionPercentage) / 100).toFixed(4));
          
          // Update user earnings and wallet with user commission
          await pool.query(`
            UPDATE users 
            SET earnings = COALESCE(earnings, 0) + ?, 
                wallet = COALESCE(wallet, 0) + ? 
            WHERE id = ?
          `, [userCommission, userCommission, sharedProduct.user_id]);
          
          // Update shared product earnings with user commission
          await pool.query(`
            UPDATE shared_products 
            SET earnings = COALESCE(earnings, 0) + ? 
            WHERE id = ?
          `, [userCommission, sharedProduct.id]);
          
          // Record transaction with detailed information
          await pool.query(`
            INSERT INTO transactions (user_id, type, amount, status, details, created_at)
            VALUES (?, 'commission', ?, 'completed', ?, NOW())
          `, [
            sharedProduct.user_id,
            userCommission,
            `Product commission for "${item.product_name}" (Order #${orderId}) - User gets ${userCommissionPercentage}% of admin commission ($${adminCommission.toFixed(4)})`
          ]);
          
          console.log(`Processed commission: Admin gets $${adminCommission.toFixed(4)} (${adminCommissionRate}%), User ${sharedProduct.username} gets $${userCommission.toFixed(4)} (${userCommissionPercentage}% of admin commission) on product "${item.product_name}"`);
        }
      }
    }
  } catch (err) {
    console.error('Error processing product commissions:', err);
  }
}

// Function to process admin commissions when order is completed
async function processAdminCommissions(orderId) {
  try {
    // Get all order items for this order
    const [orderItems] = await pool.query(`
      SELECT oi.*, p.price, p.name as product_name, o.user_id
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [orderId]);

    let totalAdminCommission = 0;

    for (const item of orderItems) {
      // Get admin commission rate from config
      const adminCommissionRate = await getConfig('admin_commission_rate') || 10; // Default 10%
      
      // Calculate admin commission (admin commission rate % of product price * quantity)
      const adminCommission = parseFloat((parseFloat(item.price) * parseFloat(adminCommissionRate) / 100 * item.quantity).toFixed(4));
      totalAdminCommission += adminCommission;
    }

    if (totalAdminCommission > 0) {
      // Record admin commission in transactions (to admin user if exists, or system)
      const [adminUsers] = await pool.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      const adminUserId = adminUsers.length > 0 ? adminUsers[0].id : null;

      if (adminUserId) {
        // Update admin earnings and wallet
        await pool.query(`
          UPDATE users 
          SET earnings = COALESCE(earnings, 0) + ?, 
              wallet = COALESCE(wallet, 0) + ? 
          WHERE id = ?
        `, [totalAdminCommission, totalAdminCommission, adminUserId]);

        // Record transaction
        await pool.query(`
          INSERT INTO transactions (user_id, type, amount, status, details, created_at)
          VALUES (?, 'admin_commission', ?, 'completed', ?, NOW())
        `, [
          adminUserId,
          totalAdminCommission,
          `Admin commission for Order #${orderId}`
        ]);

        console.log(`Processed admin commission of $${totalAdminCommission.toFixed(4)} for Order #${orderId}`);
      }
    }
  } catch (err) {
    console.error('Error processing admin commissions:', err);
  }
}

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  
  // Store the original URL in session for redirect after login
  // Only store if it's a GET request and not already a login/register page
  if (req.method === 'GET' && !req.path.includes('/login') && !req.path.includes('/register') && !req.path.includes('/auth')) {
    req.session.redirectTo = req.originalUrl;
  }
  
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.role === 'admin') {
    return next();
  }
  res.status(403).render('error', { message: 'Access denied. Admin privileges required.' });
}

function isMerchant(req, res, next) {
  if (req.session.role === 'merchant' || req.session.role === 'admin') {
    return next();
  }
  res.status(403).render('error', { message: 'Access denied. Merchant privileges required.' });
}

// Activation middleware - checks if user is logged in AND activated (only for regular users)
async function isActivated(req, res, next) {
  if (!req.session.userId) {
    // Store the original URL in session for redirect after login
    if (req.method === 'GET' && !req.path.includes('/login') && !req.path.includes('/register') && !req.path.includes('/auth')) {
      req.session.redirectTo = req.originalUrl;
    }
    return res.redirect('/login');
  }

  try {
    const [users] = await pool.query(
      'SELECT status, activation_paid, role FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length === 0) {
      return res.status(403).render('error', { message: 'User not found' });
    }

    const user = users[0];
    
    // Skip activation check for merchants and admins
    if (user.role === 'merchant' || user.role === 'admin') {
      return next();
    }
    
    // If activation is not required, allow access
    if (process.env.REQUIRE_ACTIVATION !== 'true') {
      return next();
    }
    
    // Check if regular user is activated (except for activation page itself)
    if (user.status !== 'active' || !user.activation_paid) {
      // Allow access to activation-related pages
      const allowedPaths = [
        '/user/activate',
        '/user/activate/payment',
        '/user/activate/callback'
      ];
      
      if (!allowedPaths.includes(req.path)) {
        return res.redirect('/user/activate?error=Please activate your account to access this page');
      }
    }

    next();
  } catch (error) {
    console.error('Activation middleware error:', error);
    res.status(500).render('error', { message: 'Server error' });
  }
}

// =============== ROUTES ===============

// Home route
// app.get('/', async (req, res) => {
//   try {
//     // Initialize all required variables
//     let links = [];
//     let products = [];
//     let merchants = [];
//     let testimonials = [];
//     let stats = {
//       userCount: 0,
//       totalLinks: 0,
//       clickCount: 0,
//       totalEarnings: 0
//     };try {      // Fetch active links with smart engagement-based ranking
//       const [activeLinks] = await pool.query(`
//         SELECT l.*, 
//                u.username as merchant_name,
//                u.business_name,
//                COUNT(DISTINCT sl.id) as total_shares,
//                COALESCE(SUM(sl.clicks), 0) as total_clicks,
//                COALESCE(SUM(sl.earnings), 0) as total_earnings,
//                (
//                  COALESCE(SUM(sl.clicks), 0) / 
//                  GREATEST(DATEDIFF(NOW(), l.created_at), 1) + 
//                  (COUNT(DISTINCT sl.id) * 2) +
//                  (CASE 
//                    WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 50
//                    WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 20
//                    ELSE 0
//                  END)
//                ) as engagement_score
//         FROM links l
//         JOIN users u ON l.merchant_id = u.id  
//         LEFT JOIN shared_links sl ON l.id = sl.link_id        WHERE l.is_active = true
//         GROUP BY l.id, u.username, u.business_name
//         ORDER BY 
//           engagement_score DESC,
//           CASE 
//             WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 3
//             WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 2 
//             WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1
//             ELSE 0
//           END DESC,
//           total_clicks DESC,
//           l.created_at DESC
//        LIMIT 100
//       `);
//       links = activeLinks;

//       // Fetch products with popularity ranking
//       const [activeProducts] = await pool.query(`
//         SELECT p.*, u.username as merchant_name 
//         FROM products p
//         JOIN users u ON p.merchant_id = u.id
//         WHERE p.is_active = true
//         ORDER BY p.created_at DESC
//       `);
//       products = activeProducts;

//       // Fetch merchants
//       const [activeMerchants] = await pool.query(`
//         SELECT u.*, COUNT(p.id) as product_count
//         FROM users u 
//         LEFT JOIN products p ON u.id = p.merchant_id
//         WHERE u.role = 'merchant'
//         GROUP BY u.id
//         ORDER BY product_count DESC
//         LIMIT 3
//       `);
//       merchants = activeMerchants;

//       // Get stats
//       const [[userCount]] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role != "admin"');
//       const [[linkCount]] = await pool.query('SELECT COUNT(*) as count FROM links WHERE is_active = true');
//       const [[clickCount]] = await pool.query('SELECT COALESCE(SUM(clicks), 0) as count FROM shared_links');
//       const [[earningsSum]] = await pool.query('SELECT COALESCE(SUM(earnings), 0) as total FROM users');

//       stats = {
//         userCount: userCount.count || 0,
//         totalLinks: linkCount.count || 0,
//         clickCount: clickCount.count || 0,
//         totalEarnings: parseFloat(earningsSum.total || 0).toFixed(4)
//       };

//     } catch (dbErr) {
//       console.error('Database error:', dbErr);
//     }

//     // Render with all required variables
//     return res.render('index', {
//       user: req.session.userId ? {
//         id: req.session.userId,
//         username: req.session.username,
//         role: req.session.role
//       } : null,
//       links: links,
//       products: products,
//       stats: stats,
//       merchants: merchants,
//       testimonials: testimonials,
//       error: null,
//       success: null
//     });

//   } catch (err) {
//     console.error('Homepage error:', err);
//     return res.render('index', {
//       user: null,
//       links: [],
//       products: [],
//       stats: {
//         userCount: 0,
//         totalLinks: 0,
//         clickCount: 0,
//         totalEarnings: 0
//       },
//       merchants: [],
//       testimonials: [],
//       error: 'An error occurred',
//       success: null
//     });  }
// });
// Update the home route to fetch links correctly - DISABLED (using routes/index.js instead)
/*
app.get('/', async (req, res) => {
  try {
    // Get search parameter
    const search = req.query.search || '';
    const searchTerm = search.trim();
    
    // Initialize all required variables
    let links = [];
    let products = [];
    let merchants = [];
    let stats = {
      userCount: 0,
      totalLinks: 0,
      clickCount: 0,
      totalEarnings: 0
    };
    
    try {
      // Build the links query with optional search
      let linksQuery = `
        SELECT l.*, 
               u.username as merchant_name,
               u.business_name,
               COUNT(DISTINCT sl.id) as total_shares,
               COUNT(DISTINCT c.id) as total_clicks,
               COALESCE(SUM(sl.earnings), 0) as total_earnings,
               (
                 COUNT(DISTINCT c.id) / 
                 GREATEST(DATEDIFF(NOW(), l.created_at), 1) + 
                 (COUNT(DISTINCT sl.id) * 2) +
                 (CASE 
                   WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 50
                   WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 20
                   ELSE 0
                 END)
               ) as engagement_score
        FROM links l
        JOIN users u ON l.merchant_id = u.id  
        LEFT JOIN shared_links sl ON l.id = sl.link_id
        LEFT JOIN clicks c ON sl.id = c.shared_link_id
        WHERE l.is_active = true
      `;
      
      let queryParams = [];
      
      // Add search filter if search term exists
      if (searchTerm) {
        linksQuery += ` AND (
          l.title LIKE ? OR 
          l.description LIKE ? OR 
          l.category LIKE ? OR 
          u.username LIKE ? OR 
          u.business_name LIKE ?
        )`;
        const searchPattern = `%${searchTerm}%`;
        queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
      }
      
      linksQuery += `
        GROUP BY l.id, u.username, u.business_name
        ORDER BY 
          engagement_score DESC,
          CASE 
            WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 3
            WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 2 
            WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1
            ELSE 0
          END DESC,
          total_clicks DESC,
          l.created_at DESC
       LIMIT 14
      `;
      
      // Fetch active links with search
      const [activeLinks] = await pool.query(linksQuery, queryParams);
      links = activeLinks;

      // Fetch products with popularity ranking (limited to 14)
      const [activeProducts] = await pool.query(`
        SELECT p.*, u.username as merchant_name 
        FROM products p
        JOIN users u ON p.merchant_id = u.id
        WHERE p.is_active = true
        ORDER BY p.created_at DESC
        LIMIT 14
      `);
      products = activeProducts;

      // Fetch merchants
      const [activeMerchants] = await pool.query(`
        SELECT u.*, COUNT(p.id) as product_count
        FROM users u 
        LEFT JOIN products p ON u.id = p.merchant_id
        WHERE u.role = 'merchant'
        GROUP BY u.id
        ORDER BY product_count DESC
        LIMIT 3
      `);
      merchants = activeMerchants;      // Get accurate stats
      const [[userCount]] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role != "admin"');
      const [[linkCount]] = await pool.query('SELECT COUNT(*) as count FROM links WHERE is_active = 1');
      const [[clickCount]] = await pool.query('SELECT COUNT(*) as count FROM clicks');
      
      const [[earningsSum]] = await pool.query('SELECT COALESCE(SUM(earnings), 0) as total FROM users');      stats = {
        userCount: userCount.count || 0,
        totalLinks: linkCount.count || 0,
        clickCount: clickCount.count || 0,
        totalEarnings: parseFloat(earningsSum.total || 0).toFixed(4)
      };

    } catch (dbErr) {
      console.error('Database error:', dbErr);
    }

    // Render with all required variables
    return res.render('index', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      links: links,
      products: products,
      stats: stats,
      merchants: merchants,
      error: null,
      success: null,
      page: 'home',
      searchTerm: searchTerm
    });

  } catch (err) {
    console.error('Homepage error:', err);
    return res.render('index', {
      user: null,
      links: [],
      products: [],
      stats: {
        userCount: 0,
        totalLinks: 0,
        clickCount: 0,
        totalEarnings: 0
      },
      merchants: [],
      error: 'An error occurred',
      success: null,
      page: 'home',
      searchTerm: ''
    });
  }
});
*/

// Merchant profile page route
app.get('/merchants/:username', async (req, res) => {
  try {
    const username = req.params.username;
    
    // Get merchant info
    const [merchants] = await pool.query(`
      SELECT u.*, COUNT(l.id) as total_links, COUNT(p.id) as total_products
      FROM users u
      LEFT JOIN links l ON u.id = l.merchant_id AND l.is_active = 1
      LEFT JOIN products p ON u.id = p.merchant_id AND p.is_active = 1
      WHERE u.username = ? AND u.role = 'merchant'
      GROUP BY u.id
    `, [username]);
    
    if (merchants.length === 0) {
      return res.status(404).render('error', {
        message: 'Merchant not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const merchant = merchants[0];
    
    // Get merchant's links
    const [links] = await pool.query(`
      SELECT l.*, 
             COUNT(DISTINCT sl.id) as total_shares,
             COUNT(DISTINCT c.id) as total_clicks,
             COALESCE(SUM(sl.earnings), 0) as total_earnings
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      LEFT JOIN clicks c ON sl.id = c.shared_link_id
      WHERE l.merchant_id = ? AND l.is_active = 1
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [merchant.id]);
    
    // Get merchant's products
    const [products] = await pool.query(`
      SELECT * FROM products 
      WHERE merchant_id = ? AND is_active = 1
      ORDER BY created_at DESC
    `, [merchant.id]);
    
    res.render('merchant-profile', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      merchant: merchant,
      links: links,
      products: products,
      page: 'merchant-profile'
    });
  } catch (error) {
    console.error('Merchant profile error:', error);
    res.status(500).render('error', {
      message: 'Error loading merchant profile',
      error: { status: 500, stack: '' }
    });
  }
});
// Update the home route to fetch links correctly

// API routes for homepage load more functionality
app.get('/api/links/load-more', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 14;
    const search = req.query.search || '';
    const searchTerm = search.trim();
    
    let linksQuery = `
      SELECT l.*, 
             u.username as merchant_name,
             u.business_name,
             COUNT(DISTINCT sl.id) as total_shares,
             COUNT(DISTINCT c.id) as total_clicks,
             COALESCE(SUM(sl.earnings), 0) as total_earnings,
             (
               COUNT(DISTINCT c.id) / 
               GREATEST(DATEDIFF(NOW(), l.created_at), 1) + 
               (COUNT(DISTINCT sl.id) * 2) +
               (CASE 
                 WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 50
                 WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 20
                 ELSE 0
               END)
             ) as engagement_score
      FROM links l
      JOIN users u ON l.merchant_id = u.id  
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      LEFT JOIN clicks c ON sl.id = c.shared_link_id
      WHERE l.is_active = true
    `;
    
    let queryParams = [];
    
    if (searchTerm) {
      linksQuery += ` AND (
        l.title LIKE ? OR 
        l.description LIKE ? OR 
        l.category LIKE ? OR 
        u.username LIKE ? OR 
        u.business_name LIKE ?
      )`;
      const searchPattern = `%${searchTerm}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    linksQuery += `
      GROUP BY l.id, u.username, u.business_name
      ORDER BY 
        engagement_score DESC,
        CASE 
          WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 3
          WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 2 
          WHEN l.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1
          ELSE 0
        END DESC,
        total_clicks DESC,
        l.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    queryParams.push(limit, offset);
    
    const [links] = await pool.query(linksQuery, queryParams);
    
    res.json({
      success: true,
      data: links,
      hasMore: links.length === limit
    });
  } catch (error) {
    console.error('Load more links error:', error);
    res.status(500).json({
      success: false,
      message: 'Error loading more links'
    });
  }
});

app.get('/api/products/load-more', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 14;
    const search = req.query.search || '';
    const category = req.query.category || '';
    const min_price = req.query.min_price ? parseFloat(req.query.min_price) : null;
    const max_price = req.query.max_price ? parseFloat(req.query.max_price) : null;
    
    let productsQuery = `
      SELECT p.*, u.username as merchant_name 
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.is_active = true
    `;
    
    let queryParams = [];
    
    if (search.trim()) {
      productsQuery += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      const searchPattern = `%${search.trim()}%`;
      queryParams.push(searchPattern, searchPattern);
    }
    
    if (category && category !== 'all') {
      productsQuery += ` AND p.category = ?`;
      queryParams.push(category);
    }
    
    if (min_price !== null && !isNaN(min_price)) {
      productsQuery += ` AND p.price >= ?`;
      queryParams.push(min_price);
    }
    
    if (max_price !== null && !isNaN(max_price)) {
      productsQuery += ` AND p.price <= ?`;
      queryParams.push(max_price);
    }
    
    productsQuery += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    const [products] = await pool.query(productsQuery, queryParams);
    
    res.json({
      success: true,
      data: products,
      hasMore: products.length === limit
    });
  } catch (error) {
    console.error('Load more products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error loading more products'
    });
  }
});

// API route for time ago helper
app.get('/api/time-ago/:timestamp', (req, res) => {
  try {
    const timestamp = new Date(req.params.timestamp);
    const now = new Date();
    const diff = now - timestamp;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);
    
    let timeAgo;
    if (years > 0) {
      timeAgo = `${years} year${years > 1 ? 's' : ''} ago`;
    } else if (months > 0) {
      timeAgo = `${months} month${months > 1 ? 's' : ''} ago`;
    } else if (weeks > 0) {
      timeAgo = `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else if (days > 0) {
      timeAgo = `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      timeAgo = `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      timeAgo = `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
      timeAgo = 'Just now';
    }
    
    res.json({ timeAgo });
  } catch (error) {
    res.json({ timeAgo: 'Unknown' });
  }
});

// About Us page route
app.get('/about', (req, res) => {
  res.render('about', {
    title: 'About Us | BenixSpace',
    user: req.session.user || null,
    page: 'about'
  });
});

// Privacy Policy page route
app.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', {
    title: 'Privacy Policy | BenixSpace',
    user: req.session.user || null
  });
});

// Terms & Conditions page route
app.get('/terms', (req, res) => {
  res.render('terms', {
    title: 'Terms & Conditions | BenixSpace',
    user: req.session.user || null
  });
});

// Shop redirect route
app.get('/shop', (req, res) => {
  res.redirect('/user/products');
});

// Products route
app.get('/user/products', async (req, res) => {
  try {
    // Extract and sanitize query parameters
    const category = req.query.category || null;
    const search = req.query.search || null;
    const sort = req.query.sort || 'newest'; // Default to newest products first
    const min_price = req.query.min_price ? parseFloat(req.query.min_price) : null;
    const max_price = req.query.max_price ? parseFloat(req.query.max_price) : null;
    
    // Build query with filters
    let query = `
      SELECT p.*, u.username as merchant_name 
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.is_active = true
    `;
    let queryParams = [];
    
    // Add category filter
    if (category && category !== 'all' && category.trim() !== '') {
      query += ` AND p.category = ?`;
      queryParams.push(category);
    }
    
    // Add search filter
    if (search && search.trim() !== '') {
      query += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      queryParams.push(`%${search}%`, `%${search}%`);
    }
    
    // Add price range filter
    if (min_price !== null && !isNaN(min_price) && min_price >= 0) {
      query += ` AND p.price >= ?`;
      queryParams.push(min_price);
    }
    
    if (max_price !== null && !isNaN(max_price) && max_price >= 0) {
      query += ` AND p.price <= ?`;
      queryParams.push(max_price);
    }
    
    // Add sorting
    switch (sort) {
      case 'newest':
      default:
        query += ` ORDER BY p.created_at DESC`; // Default: Newest products first
        break;
      case 'price_low':
        query += ` ORDER BY p.price ASC`;
        break;
      case 'price_high':
        query += ` ORDER BY p.price DESC`;
        break;
      case 'name':
        query += ` ORDER BY p.name ASC`;
        break;
    }
    
    const [products] = await pool.query(query, queryParams);

    // Get all unique categories
    const [categories] = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
    const categoryList = categories.map(c => c.category);

    // Get cart count if user is logged in
    let cartCount = 0;
    if (req.session.userId) {
      const [cartItems] = await pool.query('SELECT COUNT(*) as count FROM cart_items WHERE user_id = ?', [req.session.userId]);
      cartCount = cartItems[0].count;
    }

    // Ensure filters object is always defined
    const filters = {
      category: category || '',
      search: search || '',
      sort: sort || 'newest', // Default to newest
      min_price: min_price || '',
      max_price: max_price || ''
    };

    res.render('user/products', { 
      products,
      categories: categoryList,
      cartCount,
      filters,
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      page: 'shop'
    });
  } catch (err) {
    console.error('Products page error:', err);
    
    // Fallback: render with empty filters to prevent crashes
    try {
      // Get basic data for fallback
      const [products] = await pool.query(`
        SELECT p.*, u.username as merchant_name 
        FROM products p
        JOIN users u ON p.merchant_id = u.id
        WHERE p.is_active = true
        ORDER BY p.created_at DESC
      `);

      const [categories] = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
      const categoryList = categories.map(c => c.category);

      let cartCount = 0;
      if (req.session.userId) {
        const [cartItems] = await pool.query('SELECT COUNT(*) as count FROM cart_items WHERE user_id = ?', [req.session.userId]);
        cartCount = cartItems[0].count;
      }

      res.render('user/products', { 
        products,
        categories: categoryList,
        cartCount,
        filters: {
          category: '',
          search: '',
          sort: 'newest', // Reverted to newest default
          min_price: '',
          max_price: ''
        }, // Properly defined empty filters object
        user: req.session.userId ? {
          id: req.session.userId,
          username: req.session.username,
          role: req.session.role
        } : null,
        page: 'shop',
        error: 'Some filters may not be working properly.'
      });
    } catch (fallbackErr) {
      console.error('Products fallback error:', fallbackErr);
      res.status(500).render('error', { message: 'Server error. Please try again later.' });
    }
  }
});
// Auth routes
// Authentication routes

// Auth routes
app.get('/login', (req, res) => {
  if (req.session.userId) {
    // If user is already logged in, redirect to intended destination or dashboard
    const redirectTo = req.query.redirect || req.session.redirectTo || '/dashboard';
    delete req.session.redirectTo; // Clean up
    return res.redirect(redirectTo);
  }
  
  // Store manual redirect parameter if provided
  if (req.query.redirect) {
    req.session.redirectTo = req.query.redirect;
  }
  
  res.render('auth', { page: 'login', error: null, referralCode: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user by email
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.render('auth', { page: 'login', error: 'Invalid email or password', referralCode: null });
    }
    
    const user = users[0];
    
    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.render('auth', { page: 'login', error: 'Invalid email or password', referralCode: null });
    }
    
    // Set session data
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    
    // Update activation tracking for login
    const activationService = req.app.locals.activationService;
    await activationService.updateUserActivationProgress(user.id);
    
    console.log('Login successful, setting session data:', { 
      userId: user.id, 
      username: user.username, 
      role: user.role 
    });

    // Save session to ensure it's persisted
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
      } else {
        console.log('Session saved successfully');
      }
    });

    // Check for daily login bonus eligibility
    let loginBonusAwarded = false;
    let loginBonusMessage = null;
    const dailyLoginBonus = parseFloat(process.env.DAILY_LOGIN_BONUS || 0.08);
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0]; // Get YYYY-MM-DD format
    
    console.log('Daily login bonus check:', {
      dailyLoginBonus,
      todayDate,
      lastLoginDate: user.last_login_date
    });
    
    if (user.last_login_date) {
      const lastLoginDate = new Date(user.last_login_date).toISOString().split('T')[0];
      
      // If last login was not today, award the daily bonus
      if (lastLoginDate !== todayDate && dailyLoginBonus > 0) {
        try {
          console.log('Awarding login bonus of', dailyLoginBonus, 'to user', user.id);
          console.log('User wallet before bonus:', user.wallet);
          
          // Start a transaction to ensure both operations succeed or fail together
          await pool.query('START TRANSACTION');
          
          try {
            // Update both wallet and earnings with login bonus
            const updateResult = await pool.query(
              `UPDATE users SET wallet = wallet + ?, earnings = earnings + ?, last_login_date = NOW() WHERE id = ?`, 
              [dailyLoginBonus, dailyLoginBonus, user.id]
            );
            console.log('Wallet and earnings update result:', updateResult[0]);
            
            if (updateResult[0].affectedRows === 0) {
              throw new Error('No rows updated - user might not exist');
            }
            
            // Record the transaction - try bonus first, fallback to commission if bonus type doesn't exist
            let transactionResult;
            try {
              transactionResult = await pool.query(`
                INSERT INTO transactions (user_id, type, amount, status, details, created_at)
                VALUES (?, 'bonus', ?, 'completed', 'Daily login bonus', NOW())
              `, [user.id, dailyLoginBonus]);
              console.log('Transaction insert result (bonus):', transactionResult[0]);
            } catch (transactionError) {
              console.log('Bonus type not available, trying commission type...');
              transactionResult = await pool.query(`
                INSERT INTO transactions (user_id, type, amount, status, details, created_at)
                VALUES (?, 'commission', ?, 'completed', 'Daily login bonus', NOW())
              `, [user.id, dailyLoginBonus]);
              console.log('Transaction insert result (commission):', transactionResult[0]);
            }
            
            if (transactionResult[0].affectedRows === 0) {
              throw new Error('Transaction record not inserted');
            }
            
            // Commit the transaction
            await pool.query('COMMIT');
            
            // Verify the wallet was updated
            const [updatedUser] = await pool.query('SELECT wallet FROM users WHERE id = ?', [user.id]);
            console.log('User wallet after bonus:', updatedUser[0].wallet);
            
            loginBonusAwarded = true;
            loginBonusMessage = `Congratulations! You received $${dailyLoginBonus.toFixed(2)} daily login bonus! Login again tomorrow for another bonus.`;
            console.log('Login bonus awarded successfully');
          } catch (transactionError) {
            // Rollback on error
            await pool.query('ROLLBACK');
            console.error('Database transaction error, rolled back:', transactionError);
            throw transactionError;
          }
        } catch (bonusError) {
          console.error('Error awarding login bonus:', bonusError);
          // Update login date even if bonus fails
          await pool.query(
            `UPDATE users SET last_login_date = NOW() WHERE id = ?`, 
            [user.id]
          );
        }
      } else if (lastLoginDate === todayDate) {
        // User already logged in today
        loginBonusMessage = `You've already received today's login bonus! Come back tomorrow to get $${dailyLoginBonus.toFixed(2)} login bonus.`;
        await pool.query(
          `UPDATE users SET last_login_date = NOW() WHERE id = ?`, 
          [user.id]
        );
      } else {
        // Update last login date without bonus
        await pool.query(
          `UPDATE users SET last_login_date = NOW() WHERE id = ?`, 
          [user.id]
        );
      }
    } else {
      // First time login, award bonus and set login date
      if (dailyLoginBonus > 0) {
        try {
          console.log('First time login - awarding bonus of', dailyLoginBonus, 'to user', user.id);
          console.log('User wallet before first bonus:', user.wallet);
          
          // Start a transaction to ensure both operations succeed or fail together
          await pool.query('START TRANSACTION');
          
          try {
            const updateResult = await pool.query(
              `UPDATE users SET wallet = wallet + ?, earnings = earnings + ?, last_login_date = NOW() WHERE id = ?`, 
              [dailyLoginBonus, dailyLoginBonus, user.id]
            );
            console.log('First time wallet and earnings update result:', updateResult[0]);
            
            if (updateResult[0].affectedRows === 0) {
              throw new Error('No rows updated - user might not exist');
            }
            
            // Record the transaction - try bonus first, fallback to commission if bonus type doesn't exist
            let transactionResult;
            try {
              transactionResult = await pool.query(`
                INSERT INTO transactions (user_id, type, amount, status, details, created_at)
                VALUES (?, 'bonus', ?, 'completed', 'Daily login bonus', NOW())
              `, [user.id, dailyLoginBonus]);
              console.log('First time transaction insert result (bonus):', transactionResult[0]);
            } catch (transactionError) {
              console.log('Bonus type not available for first time, trying commission type...');
              transactionResult = await pool.query(`
                INSERT INTO transactions (user_id, type, amount, status, details, created_at)
                VALUES (?, 'commission', ?, 'completed', 'Daily login bonus', NOW())
              `, [user.id, dailyLoginBonus]);
              console.log('First time transaction insert result (commission):', transactionResult[0]);
            }
            
            if (transactionResult[0].affectedRows === 0) {
              throw new Error('Transaction record not inserted');
            }
            
            // Commit the transaction
            await pool.query('COMMIT');
            
            // Verify the wallet was updated
            const [updatedUser] = await pool.query('SELECT wallet FROM users WHERE id = ?', [user.id]);
            console.log('User wallet after first bonus:', updatedUser[0].wallet);
            
            loginBonusAwarded = true;
            loginBonusMessage = `Welcome! You received $${dailyLoginBonus.toFixed(2)} daily login bonus! Login again tomorrow for another bonus.`;
            console.log('First time login bonus awarded successfully');
          } catch (transactionError) {
            // Rollback on error
            await pool.query('ROLLBACK');
            console.error('First time bonus transaction error, rolled back:', transactionError);
            throw transactionError;
          }
        } catch (bonusError) {
          console.error('Error awarding first time login bonus:', bonusError);
          // Update login date even if bonus fails
          await pool.query(
            `UPDATE users SET last_login_date = NOW() WHERE id = ?`, 
            [user.id]
          );
        }
      } else {
        await pool.query(
          `UPDATE users SET last_login_date = NOW() WHERE id = ?`, 
          [user.id]
        );
      }
    }
    
    // Set the login bonus message in session
    if (loginBonusMessage) {
      req.session.loginBonusMessage = loginBonusMessage;
    }
    
    // Send security notification for login
    if (notificationService) {
      await notificationService.notifySecurityEvent(user.id, {
        eventType: 'login',
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown'
      });
    }
    
    // Check if user needs activation (for new unilevel system)
    if (user.status === 'pending' && !user.activation_paid) {
      return res.redirect('/user/activate?info=Please activate your account to access all features');
    }
    
    // Save session before redirecting to ensure login bonus message is persisted
    req.session.save((sessionErr) => {
      if (sessionErr) {
        console.error('Session save error before redirect:', sessionErr);
      }
      
      // Redirect to intended destination or dashboard
      const redirectTo = req.session.redirectTo || '/dashboard';
      delete req.session.redirectTo; // Clean up the redirect URL
      
      return res.redirect(redirectTo);
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.render('auth', { page: 'login', error: 'Server error. Please try again.', referralCode: null });
  }
});

// Test session endpoint
app.get('/test-session', (req, res) => {
  res.json({
    session: {
      userId: req.session.userId,
      username: req.session.username,
      role: req.session.role,
      loginBonusMessage: req.session.loginBonusMessage
    },
    sessionId: req.sessionID
  });
});

// Test bonus endpoint
app.get('/test-bonus/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const dailyLoginBonus = parseFloat(process.env.DAILY_LOGIN_BONUS || 0.08);
    
    // Check user before bonus
    const [usersBefore] = await pool.query('SELECT wallet, last_login_date FROM users WHERE id = ?', [userId]);
    if (usersBefore.length === 0) {
      return res.json({ error: 'User not found' });
    }
    
    const userBefore = usersBefore[0];
    
    // Check transactions table structure
    const [columns] = await pool.query('SHOW COLUMNS FROM transactions WHERE Field = "type"');
    const typeColumn = columns[0];
    
    // Award test bonus
    await pool.query('UPDATE users SET wallet = wallet + ? WHERE id = ?', [dailyLoginBonus, userId]);
    
    // Insert test transaction - try bonus first, fallback to commission
    let transactionResult;
    try {
      transactionResult = await pool.query(`
        INSERT INTO transactions (user_id, type, amount, status, details, created_at)
        VALUES (?, 'bonus', ?, 'completed', 'Test login bonus', NOW())
      `, [userId, dailyLoginBonus]);
    } catch (transactionError) {
      console.log('Using commission type for test transaction');
      transactionResult = await pool.query(`
        INSERT INTO transactions (user_id, type, amount, status, details, created_at)
        VALUES (?, 'commission', ?, 'completed', 'Test login bonus', NOW())
      `, [userId, dailyLoginBonus]);
    }
    
    // Check user after bonus
    const [usersAfter] = await pool.query('SELECT wallet FROM users WHERE id = ?', [userId]);
    
    // Get recent transactions
    const [recentTransactions] = await pool.query(`
      SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    `, [userId]);
    
    res.json({
      userBefore: userBefore,
      userAfter: usersAfter[0],
      bonusAmount: dailyLoginBonus,
      transactionsTableType: typeColumn,
      recentTransactions: recentTransactions,
      success: true
    });
  } catch (error) {
    res.json({ error: error.message, stack: error.stack });
  }
});

// Fix database endpoint
app.get('/fix-db', async (req, res) => {
  try {
    const results = [];
    
    // Check current transactions table structure
    const [currentColumns] = await pool.query('SHOW COLUMNS FROM transactions WHERE Field = "type"');
    results.push({ step: 'Current type column', data: currentColumns[0] });
    
    // Try to add bonus type
    try {
      await pool.query(`
        ALTER TABLE transactions 
        MODIFY type ENUM('deposit', 'withdrawal', 'commission', 'payment', 'upgrade', 'bonus') NOT NULL
      `);
      results.push({ step: 'Added bonus type', success: true });
    } catch (alterError) {
      results.push({ step: 'Add bonus type failed', error: alterError.message });
      
      // Try alternative approach - recreate table
      try {
        // First backup existing data
        const [existingTransactions] = await pool.query('SELECT * FROM transactions');
        results.push({ step: 'Backed up transactions', count: existingTransactions.length });
        
        // Drop and recreate table
        await pool.query('DROP TABLE transactions');
        await pool.query(`
          CREATE TABLE transactions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            type ENUM('deposit', 'withdrawal', 'commission', 'payment', 'upgrade', 'bonus') NOT NULL,
            amount DECIMAL(10,4) NOT NULL,
            status ENUM('pending', 'completed', 'failed', 'rejected') DEFAULT 'pending',
            reference VARCHAR(150),
            details TEXT,
            notes TEXT,
            gateway VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
          )
        `);
        results.push({ step: 'Recreated transactions table', success: true });
        
        // Restore data
        for (const transaction of existingTransactions) {
          await pool.query(`
            INSERT INTO transactions (id, user_id, type, amount, status, reference, details, notes, gateway, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            transaction.id, transaction.user_id, transaction.type, transaction.amount,
            transaction.status, transaction.reference, transaction.details, 
            transaction.notes, transaction.gateway, transaction.created_at, transaction.updated_at
          ]);
        }
        results.push({ step: 'Restored transactions data', count: existingTransactions.length });
        
      } catch (recreateError) {
        results.push({ step: 'Recreation failed', error: recreateError.message });
      }
    }
    
    // Check final structure
    const [finalColumns] = await pool.query('SHOW COLUMNS FROM transactions WHERE Field = "type"');
    results.push({ step: 'Final type column', data: finalColumns[0] });
    
    res.json({ results });
  } catch (error) {
    res.json({ error: error.message, stack: error.stack });
  }
});

// Debug database endpoint
app.get('/debug-db', async (req, res) => {
  try {
    // Check transactions table structure
    const [transactionsColumns] = await pool.query('SHOW COLUMNS FROM transactions');
    
    // Check if there are any transactions
    const [transactionsCount] = await pool.query('SELECT COUNT(*) as count FROM transactions');
    
    // Check recent transactions
    const [recentTransactions] = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10');
    
    // Check users table structure
    const [usersColumns] = await pool.query('SHOW COLUMNS FROM users WHERE Field IN ("wallet", "last_login_date")');
    
    res.json({
      transactionsTable: {
        columns: transactionsColumns,
        count: transactionsCount[0].count,
        recent: recentTransactions
      },
      usersColumns: usersColumns,
      envBonus: process.env.DAILY_LOGIN_BONUS
    });
  } catch (error) {
    res.json({ error: error.message, stack: error.stack });
  }
});

// Dashboard route
// Dashboard route
app.get('/dashboard', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    console.log('Dashboard accessed by user:', userId);
    console.log('Login bonus message in session:', req.session.loginBonusMessage);
    
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (!users || users.length === 0) {
      console.error('User not found for ID:', userId);
      return res.status(403).render('error', { 
        message: 'User not found',
        error: { status: 403, stack: '' }
      });
    }
    
    const user = users[0];
    console.log('User found:', { id: user.id, username: user.username, wallet: user.wallet });
    
    // Initialize stats object based on user role
    let stats = {};
    
    if (user.role === 'admin') {
      // Admin dashboard data
      const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
      const [merchantCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role = ?', ['merchant']);
      const [linkCount] = await pool.query('SELECT COUNT(*) as count FROM links');
      const [clickCount] = await pool.query('SELECT COUNT(*) as count FROM clicks');
      
      // Get recent transactions
      const [recentTransactions] = await pool.query(`
        SELECT t.*, u.username 
        FROM transactions t 
        JOIN users u ON t.user_id = u.id 
        ORDER BY t.created_at DESC 
        LIMIT 10
      `);
      
      stats = {
        userCount: userCount[0].count,
        merchantCount: merchantCount[0].count,
        linkCount: linkCount[0].count,
        clickCount: clickCount[0].count,
        recentTransactions: recentTransactions
      };
    } 
    else if (user.role === 'merchant') {
      // Merchant dashboard data
      const [links] = await pool.query('SELECT * FROM links WHERE merchant_id = ?', [userId]);
      const [totalClicks] = await pool.query(`
        SELECT COUNT(*) as count FROM clicks c
        JOIN shared_links sl ON c.shared_link_id = sl.id
        JOIN links l ON sl.link_id = l.id
        WHERE l.merchant_id = ?
      `, [userId]);
      
      stats = {
        linkCount: links.length,
        totalClicks: totalClicks[0].count,
        amountToPay: parseFloat(user.amount_to_pay || 0).toFixed(4),
        paidBalance: parseFloat(user.paid_balance || 0).toFixed(4),
        links: links
      };
    } 
    else {
      // Regular user dashboard data
      const [sharedLinks] = await pool.query(`
        SELECT sl.*, l.title, l.type, l.url, l.image_url 
        FROM shared_links sl
        JOIN links l ON sl.link_id = l.id
        WHERE sl.user_id = ?
      `, [userId]);
      
      const [totalClicks] = await pool.query(`
        SELECT COUNT(*) as count FROM clicks c
        JOIN shared_links sl ON c.shared_link_id = sl.id
        WHERE sl.user_id = ?
      `, [userId]);
      
      stats = {
        sharedLinkCount: sharedLinks.length,
        totalClicks: totalClicks[0].count,
        totalEarnings: user.earnings,
        sharedLinks: sharedLinks
      };
      
      // Fetch available links to share
      const [availableLinks] = await pool.query(`
        SELECT l.*, u.username as merchant_name, u.business_name
        FROM links l
        JOIN users u ON l.merchant_id = u.id
        WHERE l.is_active = true
        ORDER BY l.created_at DESC
        LIMIT 20
      `);
      
      stats.availableLinks = availableLinks;
    }
    
    // Get cart count for the cart badge in navbar
    const [cartCount] = await pool.query(
      'SELECT COUNT(*) as count FROM cart_items WHERE user_id = ?',
      [user.id]
    );
    
    // Get leaderboard data for all dashboard types
    const [topPerformers] = await pool.query(`
      SELECT u.id, u.username, u.wallet, u.earnings,
             COALESCE(referrals.referral_count, 0) as referral_count,
             COALESCE(links.total_shared_links, 0) as total_shared_links,
             COALESCE(orders.total_orders, 0) as total_orders,
             (COALESCE(u.wallet, 0) + COALESCE(u.earnings, 0) + COALESCE(referrals.referral_count, 0) * 5 + COALESCE(links.total_shared_links, 0) * 2) as performance_score
      FROM users u
      LEFT JOIN (
        SELECT referrer_id, COUNT(*) as referral_count
        FROM users 
        WHERE referrer_id IS NOT NULL
        GROUP BY referrer_id
      ) referrals ON u.id = referrals.referrer_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_shared_links
        FROM shared_links
        GROUP BY user_id
      ) links ON u.id = links.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_orders
        FROM orders
        WHERE status = 'completed'
        GROUP BY user_id
      ) orders ON u.id = orders.user_id
      WHERE u.role != 'admin'
      ORDER BY performance_score DESC
      LIMIT 5
    `);
    
    // Render dashboard with all required data
    console.log('Rendering dashboard with login bonus message:', req.session.loginBonusMessage);
    res.render('dashboard', {
      user: user,
      stats: stats,
      cartCount: cartCount[0].count || 0,
      topPerformers: topPerformers,
      page: 'dashboard',
      loginBonusMessage: req.session.loginBonusMessage || null,
      dailyLoginBonus: parseFloat(process.env.DAILY_LOGIN_BONUS || 0.08)
    });
    
    // Clear the login bonus message after displaying it
    console.log('Clearing login bonus message from session');
    delete req.session.loginBonusMessage;
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});
// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  
  // Store the original URL in session for redirect after login
  // Only store if it's a GET request and not already a login/register page
  if (req.method === 'GET' && !req.path.includes('/login') && !req.path.includes('/register') && !req.path.includes('/auth')) {
    req.session.redirectTo = req.originalUrl;
  }
  
  res.redirect('/login');
}

// app.post('/profile/update', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const {
//       username,
//       email,
//       current_password,
//       new_password,
//       business_name,
//       business_description,
//       account_name,
//       account_number,
//       bank_code
//     } = req.body;

//     // Check if username or email already exists
//     const [existingUsers] = await pool.query(
//       'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?',
//       [username, email, userId]
//     );

//     if (existingUsers.length > 0) {
//       const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//       return res.render('user/profile', {
//         user: user[0],
//         error: 'Username or email already in use'
//       });
//     }

//     // Update basic info
//     await pool.query(`
//       UPDATE users 
//       SET username = ?, 
//           email = ?,
//           business_name = ?,
//           business_description = ?,
//           account_name = ?,
//           account_number = ?,
//           bank_code = ?
//       WHERE id = ?
//     `, [
//       username,
//       email,
//       business_name || null,
//       business_description || null,
//       account_name,
//       account_number,




//       bank_code,
//       userId
//     ]);

//     // Update password if provided
//     if (current_password && new_password) {
//       const [user] = await pool.query('SELECT password FROM users WHERE id = ?', [userId]);
//       const passwordMatch = await bcrypt.compare(current_password, user[0].password);

//       if (!passwordMatch) {
//         return res.render('user/profile', {
//           user: { ...req.body, id: userId },
//           error: 'Current password is incorrect'
//         });
//       }

//       const hashedPassword = await bcrypt.hash(new_password, 10);
//       await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
//     }

//     // Get updated user data
//     const [updatedUser] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
//     res.render('user/profile', {
//       user: updatedUser[0],
//       success: 'Profile updated successfully'
//     });
//   } catch (err) {
//     console.error('Profile update error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

// Import uuid library at the top of your file (if not already imported)

// Add referral_id column to users table during database initialization
// This should be in your database initialization code


// Modified registration GET route to handle referral codes
// Add this GET route before your POST route
// app.get('/profile', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
    
//     // Get user data with all fields
//     const [users] = await pool.query(`
//       SELECT id, username, email, role, country, phone_number,
//              business_name, business_description, account_name,
//              account_number, bank_code, created_at, has_lifetime_commission
//       FROM users 
//       WHERE id = ?
//     `, [userId]);

//     if (users.length === 0) {
//       return res.status(404).render('error', { message: 'User not found' });
//     }
//       const user = users[0];
//     console.log('Retrieved user data:', user);
//       // Parse the phone number to separate country code and number
//     let phoneDetails = { countryCode: '+1', number: '' };
//     if (user.phone_number) {
//       console.log('Processing phone number:', user.phone_number);
//       // Try different phone number formats
//       let match = user.phone_number.match(/^(\+\d{1,3}|\d{1,3})(\d+)$/);
//       if (match) {
//         phoneDetails.countryCode = match[1].startsWith('+') ? match[1] : '+' + match[1];
//         phoneDetails.number = match[2];
//       } else {
//         // If format is completely different, try to extract numbers
//         const numbers = user.phone_number.replace(/[^\d]/g, '');
//         if (numbers.length > 3) {
//           // Assume first 1-3 digits are country code
//           const countryCode = numbers.slice(0, Math.min(3, numbers.length - 4));
//           phoneDetails.countryCode = '+' + countryCode;
//           phoneDetails.number = numbers.slice(countryCode.length);
//         } else {
//           // If all else fails, treat entire number as local number
//           phoneDetails.number = numbers;
//         }
//       }
//       console.log('Parsed phone details:', phoneDetails);
//     }

//     // Get stats based on user role
//     const stats = {
//       totalLinks: 0,
//       totalClicks: 0,
//       totalEarnings: 0
//     };
    
//     if (user.role === 'merchant') {
//       // Get merchant stats
//       const [linkCountResults] = await pool.query('SELECT COUNT(*) as count FROM links WHERE merchant_id = ?', [userId]);
//       stats.totalLinks = linkCountResults[0].count || 0;
      
//       const [clickResults] = await pool.query(`
//         SELECT COALESCE(SUM(sl.clicks), 0) as totalClicks
//         FROM links l
//         LEFT JOIN shared_links sl ON l.id = sl.link_id
//         WHERE l.merchant_id = ?
//       `, [userId]);
      
//       stats.totalClicks = clickResults[0].totalClicks || 0;
//     } else {
//       // Regular user stats
//       const [linkCountResults] = await pool.query('SELECT COUNT(*) as count FROM shared_links WHERE user_id = ?', [userId]);
//       stats.totalLinks = linkCountResults[0].count || 0;
      
//       const [clickResults] = await pool.query('SELECT COALESCE(SUM(clicks), 0) as totalClicks FROM shared_links WHERE user_id = ?', [userId]);
//       stats.totalClicks = clickResults[0].totalClicks || 0;
      
//       stats.totalEarnings = parseFloat(user.earnings || 0);
//     }
    
//     res.render('user/profile', { 
//       user,
//       stats,
//       phoneDetails,
//       success: req.query.success,
//       error: req.query.error
//     });
//   } catch (err) {
//     console.error('Profile page error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });
// app.post('/profile/update', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const {
//       username,
//       email,
//       current_password,
//       new_password,
//       business_name,
//       business_description,
//       account_name,
//       account_number,
//       bank_code,
//       country,
//       phone,
//       dialCode
//     } = req.body;

//     // Debug log the received form data
//     console.log('Form data received:', {
//       country,
//       phone,
//       dialCode
//     });

//     // Check if username or email already exists
//     const [existingUsers] = await pool.query(
//       'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?',
//       [username, email, userId]
//     );

//     if (existingUsers.length > 0) {
//       const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//       return res.render('user/profile', {
//         user: user[0],
//         error: 'Username or email already in use'
//       });
//     }    // Format phone number with country code if both values exist    let phone_number = null;
//     if (phone || dialCode) {
//       // Ensure we have both values
//       if (!phone || !dialCode) {
//         const [user] = await pool.query(`
//           SELECT id, username, email, role, country, phone_number,
//                  business_name, business_description, account_name,
//                  account_number, bank_code, created_at, has_lifetime_commission 
//           FROM users WHERE id = ?`, [userId]);
//         return res.render('user/profile', {
//           user: user[0],
//           error: 'Please provide both phone number and select a country',
//           stats: { totalLinks: 0, totalClicks: 0, totalEarnings: 0 },
//           phoneDetails: { countryCode: dialCode || '+1', number: phone || '' }
//         });
//       }
      
//       // Clean up the phone number and dial code
//       const cleanPhone = phone.replace(/[^\d]/g, '');
//       const cleanDialCode = dialCode.replace(/[^\d]/g, '').replace(/^([^+])/, '+$1');
      
//       // Validate phone number format
//       if (cleanPhone.length < 6 || cleanPhone.length > 15) {
//         const [user] = await pool.query(`
//           SELECT id, username, email, role, country, phone_number,
//                  business_name, business_description, account_name,
//                  account_number, bank_code, created_at, has_lifetime_commission 
//           FROM users WHERE id = ?`, [userId]);
//         return res.render('user/profile', {
//           user: user[0],
//           error: 'Please enter a valid phone number (6-15 digits)',
//           stats: { totalLinks: 0, totalClicks: 0, totalEarnings: 0 },
//           phoneDetails: { countryCode: cleanDialCode, number: cleanPhone }
//         });
//       }
      
//       console.log('Setting phone number with:', { cleanDialCode, cleanPhone });
//       phone_number = `${cleanDialCode}${cleanPhone}`;
//       console.log('Final phone_number:', phone_number);
//     }

//     console.log('Formatted phone number:', phone_number);

//     // Update basic info
//     await pool.query(`
//       UPDATE users 
//       SET username = ?, 
//           email = ?,
//           business_name = ?,
//           business_description = ?,
//           account_name = ?,
//           account_number = ?,
//           bank_code = ?,
//           country = ?,
//           phone_number = ?
//       WHERE id = ?
//     `, [
//       username,
//       email,
//       business_name || null,
//       business_description || null,
//       account_name,
//       account_number,
//       bank_code,
//       country,
//       phone_number,
//       userId
//     ]);

//     // Update password if provided
//     if (current_password && new_password) {
//       const [user] = await pool.query('SELECT password FROM users WHERE id = ?', [userId]);
//       const passwordMatch = await bcrypt.compare(current_password, user[0].password);

//       if (!passwordMatch) {
//         return res.render('user/profile', {
//           user: { ...req.body, id: userId },
//           error: 'Current password is incorrect'
//         });
//       }

//       const hashedPassword = await bcrypt.hash(new_password, 10);
//       await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
//     }

//     // Get updated user data
//     const [updatedUser] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
//     console.log('Updated user data:', {
//       country: updatedUser[0].country,
//       phone_number: updatedUser[0].phone_number
//     });

//     res.render('user/profile', {
//       user: updatedUser[0],
//       success: 'Profile updated successfully'
//     });
//   } catch (err) {
//     console.error('Profile update error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

app.post('/register', async (req, res) => {
  try {
    const { 
      username, 
      email, 
      password, 
      confirmPassword, 
      role, 
      business_name, 
      business_description, 
      referral_code,
      country,
      phone,
      full_phone // Get the full phone number with country code
    } = req.body;
    
    // Basic validation
    if (password !== confirmPassword) {
      return res.render('auth', { 
        page: 'register', 
        error: 'Passwords do not match',
        referralCode: referral_code 
      });
    }

    // Get activation settings
    const activationService = req.app.locals.activationService;
    const settings = await activationService.getActivationSettings();
    
    // Validate role
    if (!['user', 'merchant'].includes(role)) {
      return res.render('auth', { 
        page: 'register', 
        error: 'Invalid role selected',
        referralCode: referral_code 
      });
    }
    
    // Additional validation for merchants
    if (role === 'merchant' && (!business_name || !business_description)) {
      return res.render('auth', { 
        page: 'register', 
        error: 'Business name and description are required for merchants',
        referralCode: referral_code 
      });
    }
    
    // Validate phone number
    if (!phone) {
      return res.render('auth', { 
        page: 'register', 
        error: 'Phone number is required',
        referralCode: referral_code 
      });
    }
    
    // Get the country code from the selected country
    const countryCode = country;
      // Use the full phone number from the hidden field or build it from components
    const phone_number = full_phone || phone;
    
    // Check if username or email already exists
    const [existingUsers] = await pool.query(
      'SELECT username, email FROM users WHERE username = ? OR email = ?', 
      [username, email]
    );
    
    if (existingUsers.length > 0) {
      const error = existingUsers[0].email === email ? 
        'Email address already in use' : 
        'Username already in use';
      return res.render('auth', { 
        page: 'register', 
        error,
        referralCode: referral_code,
        formData: { ...req.body, password: '', confirmPassword: '' } // Pass back form data but clear passwords
      });
    }
    
    // Create user with referral ID and pending status for new unilevel system
    const hashedPassword = await bcrypt.hash(password, 10);
    const referralId = uuidv4().substring(0, 8);
    
    // Find referrer if referral code provided
    let referrerId = null;
    if (referral_code) {
      const [referrers] = await pool.query(
        'SELECT id FROM users WHERE referral_id = ?',
        [referral_code]
      );
      if (referrers.length > 0) {
        referrerId = referrers[0].id;
      }
    }
    
    const [result] = await pool.query(
      `INSERT INTO users (
        username, email, password, role, business_name, business_description, 
        referral_id, country, phone_number, referrer_id, status, activation_paid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE)`,
      [username, email, hashedPassword, role, business_name || null, business_description || null, 
       referralId, countryCode, phone_number, referrerId]
    );
    
    // Create referral record if there's a referrer
    if (referrerId) {
      await pool.query(
        `INSERT INTO user_referrals (referrer_id, referred_id, referral_code, status) 
         VALUES (?, ?, ?, 'pending')`,
        [referrerId, result.insertId, referral_code]
      );
    }
    
    // Set session
    req.session.userId = result.insertId;
    req.session.username = username;
    req.session.role = role;
    
    // Send notification about registration
    if (notificationService) {
      await notificationService.notifyUserRegistered(result.insertId, {
        username,
        email,
        hasReferrer: !!referrerId
      });
    }
    
    // Redirect based on REQUIRE_ACTIVATION environment variable
    if (process.env.REQUIRE_ACTIVATION === 'true') {
      res.redirect('/user/activate?success=Registration successful! Please activate your account to access all features.');
    } else {
      // Set user as active and activated by default
      await pool.query('UPDATE users SET status = ?, activation_paid = ? WHERE id = ?', ['active', true, result.insertId]);
      res.redirect('/dashboard?success=Registration successful! Welcome to your dashboard.');
    }
  } catch (err) {
    console.error('Registration error:', err);
    res.render('auth', { 
      page: 'register', 
      error: 'Server error. Please try again.',
      referralCode: req.body.referral_code 
    });
  }
});

app.get('/register', (req, res) => {
  try {
    // If user is already logged in, redirect to intended destination or dashboard
    if (req.session.userId) {
      const redirectTo = req.session.redirectTo || '/dashboard';
      delete req.session.redirectTo; // Clean up
      return res.redirect(redirectTo);
    }
    
    const referralCode = req.query.ref || '';
    return res.render('auth', { 
      page: 'register', 
      error: null,
      referralCode: referralCode 
    });
  } catch (err) {
    console.error('Failed to load register page:', err);
    return res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});



app.get('/api/countries', (req, res) => {
  const countries = [
    { name: "Afghanistan", code: "AF", dial_code: "+93" },
    { name: "Albania", code: "AL", dial_code: "+355" },
    { name: "Algeria", code: "DZ", dial_code: "+213" },
    { name: "Andorra", code: "AD", dial_code: "+376" },
    { name: "Angola", code: "AO", dial_code: "+244" },
    { name: "Anguilla", code: "AI", dial_code: "+1264" },
    { name: "Antigua and Barbuda", code: "AG", dial_code: "+1268" },
    { name: "Argentina", code: "AR", dial_code: "+54" },
    { name: "Armenia", code: "AM", dial_code: "+374" },
    { name: "Aruba", code: "AW", dial_code: "+297" },
    { name: "Australia", code: "AU", dial_code: "+61" },
    { name: "Austria", code: "AT", dial_code: "+43" },
    { name: "Azerbaijan", code: "AZ", dial_code: "+994" },
    { name: "Bahamas", code: "BS", dial_code: "+1242" },
    { name: "Bahrain", code: "BH", dial_code: "+973" },
    { name: "Bangladesh", code: "BD", dial_code: "+880" },
    { name: "Barbados", code: "BB", dial_code: "+1246" },
    { name: "Belarus", code: "BY", dial_code: "+375" },
    { name: "Belgium", code: "BE", dial_code: "+32" },
    { name: "Belize", code: "BZ", dial_code: "+501" },
    { name: "Benin", code: "BJ", dial_code: "+229" },
    { name: "Bermuda", code: "BM", dial_code: "+1441" },
    { name: "Bhutan", code: "BT", dial_code: "+975" },
    { name: "Bolivia", code: "BO", dial_code: "+591" },
    { name: "Bosnia and Herzegovina", code: "BA", dial_code: "+387" },
    { name: "Botswana", code: "BW", dial_code: "+267" },
    { name: "Brazil", code: "BR", dial_code: "+55" },
    { name: "Brunei Darussalam", code: "BN", dial_code: "+673" },
    { name: "Bulgaria", code: "BG", dial_code: "+359" },
    { name: "Burkina Faso", code: "BF", dial_code: "+226" },
    { name: "Burundi", code: "BI", dial_code: "+257" },
    { name: "Cambodia", code: "KH", dial_code: "+855" },
    { name: "Cameroon", code: "CM", dial_code: "+237" },
    { name: "Canada", code: "CA", dial_code: "+1" },
    { name: "Cape Verde", code: "CV", dial_code: "+238" },
    { name: "Cayman Islands", code: "KY", dial_code: "+1345" },
    { name: "Central African Republic", code: "CF", dial_code: "+236" },
    { name: "Chad", code: "TD", dial_code: "+235" },
    { name: "Chile", code: "CL", dial_code: "+56" },
    { name: "China", code: "CN", dial_code: "+86" },
    { name: "Colombia", code: "CO", dial_code: "+57" },
    { name: "Comoros", code: "KM", dial_code: "+269" },
    { name: "Congo", code: "CG", dial_code: "+242" },
    { name: "Congo, The Democratic Republic of the", code: "CD", dial_code: "+243" },
    { name: "Cook Islands", code: "CK", dial_code: "+682" },
    { name: "Costa Rica", code: "CR", dial_code: "+506" },
    { name: "Cote d'Ivoire", code: "CI", dial_code: "+225" },
    { name: "Croatia", code: "HR", dial_code: "+385" },
    { name: "Cuba", code: "CU", dial_code: "+53" },
    { name: "Cyprus", code: "CY", dial_code: "+357" },
    { name: "Czech Republic", code: "CZ", dial_code: "+420" },
    { name: "Denmark", code: "DK", dial_code: "+45" },
    { name: "Djibouti", code: "DJ", dial_code: "+253" },
    { name: "Dominica", code: "DM", dial_code: "+1767" },
    { name: "Dominican Republic", code: "DO", dial_code: "+1849" },
    { name: "Ecuador", code: "EC", dial_code: "+593" },
    { name: "Egypt", code: "EG", dial_code: "+20" },
    { name: "El Salvador", code: "SV", dial_code: "+503" },
    { name: "Equatorial Guinea", code: "GQ", dial_code: "+240" },
    { name: "Eritrea", code: "ER", dial_code: "+291" },
    { name: "Estonia", code: "EE", dial_code: "+372" },
    { name: "Ethiopia", code: "ET", dial_code: "+251" },
    { name: "Falkland Islands (Malvinas)", code: "FK", dial_code: "+500" },
    { name: "Faroe Islands", code: "FO", dial_code: "+298" },
    { name: "Fiji", code: "FJ", dial_code: "+679" },
    { name: "Finland", code: "FI", dial_code: "+358" },
    { name: "France", code: "FR", dial_code: "+33" },
    { name: "French Guiana", code: "GF", dial_code: "+594" },
    { name: "French Polynesia", code: "PF", dial_code: "+689" },
    { name: "Gabon", code: "GA", dial_code: "+241" },
    { name: "Gambia", code: "GM", dial_code: "+220" },
    { name: "Georgia", code: "GE", dial_code: "+995" },
    { name: "Germany", code: "DE", dial_code: "+49" },
    { name: "Ghana", code: "GH", dial_code: "+233" },
    { name: "Gibraltar", code: "GI", dial_code: "+350" },
    { name: "Greece", code: "GR", dial_code: "+30" },
    { name: "Greenland", code: "GL", dial_code: "+299" },
    { name: "Grenada", code: "GD", dial_code: "+1473" },
    { name: "Guadeloupe", code: "GP", dial_code: "+590" },
    { name: "Guam", code: "GU", dial_code: "+1671" },
    { name: "Guatemala", code: "GT", dial_code: "+502" },
   
    { name: "Nauru", code: "NR", dial_code: "+674" },
    { name: "Nepal", code: "NP", dial_code: "+977" },
    { name: "Netherlands", code: "NL", dial_code: "+31" },
    { name: "Netherlands Antilles", code: "AN", dial_code: "+599" },
    { name: "New Caledonia", code: "NC", dial_code: "+687" },
    { name: "New Zealand", code: "NZ", dial_code: "+64" },
    { name: "Nicaragua", code: "NI", dial_code: "+505" },
    { name: "Niger", code: "NE", dial_code: "+227" },
    { name: "Nigeria", code: "NG", dial_code: "+234" },
    { name: "Niue", code: "NU", dial_code: "+683" },
    { name: "Norfolk Island", code: "NF", dial_code: "+672" },
    { name: "Northern Mariana Islands", code: "MP", dial_code: "+1670" },
    { name: "Norway", code: "NO", dial_code: "+47" },
    { name: "Oman", code: "OM", dial_code: "+968" },
    { name: "Pakistan", code: "PK", dial_code: "+92" },
    { name: "Palau", code: "PW", dial_code: "+680" },
    { name: "Palestinian Territory, Occupied", code: "PS", dial_code: "+970" },
    { name: "Panama", code: "PA", dial_code: "+507" },
    { name: "Papua New Guinea", code: "PG", dial_code: "+675" },
    { name: "Paraguay", code: "PY", dial_code: "+595" },
    { name: "Peru", code: "PE", dial_code: "+51" },
    { name: "Philippines", code: "PH", dial_code: "+63" },
    { name: "Pitcairn", code: "PN", dial_code: "+64" },
    { name: "Poland", code: "PL", dial_code: "+48" },
    { name: "Portugal", code: "PT", dial_code: "+351" },
    { name: "Puerto Rico", code: "PR", dial_code: "+1939" },
    { name: "Qatar", code: "QA", dial_code: "+974" },
    { name: "Reunion", code: "RE", dial_code: "+262" },
    { name: "Romania", code: "RO", dial_code: "+40" },
    { name: "Russian Federation", code: "RU", dial_code: "+7" },
    { name: "Rwanda", code: "RW", dial_code: "+250" },
    { name: "Saint Kitts and Nevis", code: "KN", dial_code: "+1869" },
    { name: "Saint Lucia", code: "LC", dial_code: "+1758" },
    { name: "Saint Pierre and Miquelon", code: "PM", dial_code: "+508" },
    { name: "Saint Vincent and the Grenadines", code: "VC", dial_code: "+1784" },
    { name: "Samoa", code: "WS", dial_code: "+685" },
    { name: "San Marino", code: "SM", dial_code: "+378" },
    { name: "Sao Tome and Principe", code: "ST", dial_code: "+239" },
    { name: "Saudi Arabia", code: "SA", dial_code: "+966" },
    { name: "Senegal", code: "SN", dial_code: "+221" },
    { name: "Serbia", code: "RS", dial_code: "+381" },
    { name: "Seychelles", code: "SC", dial_code: "+248" },
    { name: "Sierra Leone", code: "SL", dial_code: "+232" },
    { name: "Singapore", code: "SG", dial_code: "+65" },
    { name: "Slovakia", code: "SK", dial_code: "+421" },
    { name: "Slovenia", code: "SI", dial_code: "+386" },
    { name: "Solomon Islands", code: "SB", dial_code: "+677" },
    { name: "Somalia", code: "SO", dial_code: "+252" },
    { name: "South Africa", code: "ZA", dial_code: "+27" },
    { name: "South Georgia and the South Sandwich Islands", code: "GS", dial_code: "+500" },
    { name: "Spain", code: "ES", dial_code: "+34" },
    { name: "Sri Lanka", code: "LK", dial_code: "+94" },
    { name: "Sudan", code: "SD", dial_code: "+249" },
    { name: "Suriname", code: "SR", dial_code: "+597" },
    { name: "Svalbard and Jan Mayen", code: "SJ", dial_code: "+47" },
    { name: "Swaziland", code: "SZ", dial_code: "+268" },
    { name: "Sweden", code: "SE", dial_code: "+46" },
    { name: "Switzerland", code: "CH", dial_code: "+41" },
    { name: "Syrian Arab Republic", code: "SY", dial_code: "+963" },
    { name: "Taiwan", code: "TW", dial_code: "+886" },
    { name: "Tajikistan", code: "TJ", dial_code: "+992" },
    { name: "Tanzania, United Republic of", code: "TZ", dial_code: "+255" },
    { name: "Thailand", code: "TH", dial_code: "+66" },
    { name: "Timor-Leste", code: "TL", dial_code: "+670" },
    { name: "Togo", code: "TG", dial_code: "+228" },
    { name: "Tokelau", code: "TK", dial_code: "+690" },
    { name: "Tonga", code: "TO", dial_code: "+676" },
    { name: "Trinidad and Tobago", code: "TT", dial_code: "+1868" },
    { name: "Tunisia", code: "TN", dial_code: "+216" },
    { name: "Turkey", code: "TR", dial_code: "+90" },
    { name: "Turkmenistan", code: "TM", dial_code: "+993" },
    { name: "Turks and Caicos Islands", code: "TC", dial_code: "+1649" },
    { name: "Tuvalu", code: "TV", dial_code: "+688" },
    { name: "Uganda", code: "UG", dial_code: "+256" },
    { name: "Ukraine", code: "UA", dial_code: "+380" },
    { name: "United Arab Emirates", code: "AE", dial_code: "+971" },
    { name: "United Kingdom", code: "GB", dial_code: "+44" },
    { name: "United States", code: "US", dial_code: "+1" },
    { name: "Uruguay", code: "UY", dial_code: "+598" },
    { name: "Uzbekistan", code: "UZ", dial_code: "+998" },
    { name: "Vanuatu", code: "VU", dial_code: "+678" },
    { name: "Venezuela", code: "VE", dial_code: "+58" },
    { name: "Viet Nam", code: "VN", dial_code: "+84" },
    { name: "Virgin Islands, British", code: "VG", dial_code: "+1284" },
    { name: "Virgin Islands, U.S.", code: "VI", dial_code: "+1340" },
    { name: "Wallis and Futuna", code: "WF", dial_code: "+681" },
    { name: "Western Sahara", code: "EH", dial_code: "+212" },
    { name: "Yemen", code: "YE", dial_code: "+967" },
    { name: "Zambia", code: "ZM", dial_code: "+260" },
    { name: "Zimbabwe", code: "ZW", dial_code: "+263" }
  ];
  
  res.json(countries);
});



// Route to show user's referral stats and link
app.get('/referrals', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get user data including referral_id
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).render('error', { message: 'User not found' });
    }
    
    const user = users[0];
    
    // Get Level 1 referrals (direct referrals)
    const [level1Referrals] = await pool.query(`
      SELECT 
        u.id,
        u.username, 
        u.email, 
        u.status,
        u.activation_paid,
        u.activated_at,
        u.created_at,
        c.amount_rwf as commission_earned,
        c.amount_usd as commission_earned_usd,
        c.created_at as commission_date
      FROM users u
      LEFT JOIN commissions c ON c.referred_user_id = u.id AND c.user_id = ? AND c.level = 1
      WHERE u.referrer_id = ?
      ORDER BY u.created_at DESC
    `, [userId, userId]);
    
    // Get Level 2 referrals (referrals of your referrals)
    const [level2Referrals] = await pool.query(`
      SELECT 
        u.id,
        u.username, 
        u.email, 
        u.status,
        u.activation_paid,
        u.activated_at,
        u.created_at,
        u.referrer_id,
        ref_user.username as referrer_username,
        c.amount_rwf as commission_earned,
        c.amount_usd as commission_earned_usd,
        c.created_at as commission_date
      FROM users u
      JOIN users ref_user ON u.referrer_id = ref_user.id
      LEFT JOIN commissions c ON c.referred_user_id = u.id AND c.user_id = ? AND c.level = 2
      WHERE ref_user.referrer_id = ?
      ORDER BY u.created_at DESC
    `, [userId, userId]);
    
    // Get total referral stats
    const [referralStats] = await pool.query(`
      SELECT 
        COUNT(CASE WHEN c.level = 1 THEN 1 END) as level1_count,
        COUNT(CASE WHEN c.level = 2 THEN 1 END) as level2_count,
        COALESCE(SUM(CASE WHEN c.level = 1 THEN c.amount_rwf END), 0) as level1_earnings_rwf,
        COALESCE(SUM(CASE WHEN c.level = 2 THEN c.amount_rwf END), 0) as level2_earnings_rwf,
        COALESCE(SUM(c.amount_usd), 0) as total_earnings_usd
      FROM commissions c
      WHERE c.user_id = ? AND c.commission_type = 'activation'
    `, [userId]);
    
    const stats = referralStats[0];
    
    // Combine Level 1 and Level 2 for total counts (including non-activated)
    const totalLevel1 = level1Referrals.length;
    const totalLevel2 = level2Referrals.length;
    
    res.render('user/referrals', {
      user: user,
      referralStats: {
        totalReferrals: totalLevel1 + totalLevel2,
        level1Count: totalLevel1,
        level2Count: totalLevel2,
        level1Earnings: stats.level1_earnings_rwf || 0,
        level2Earnings: stats.level2_earnings_rwf || 0,
        totalEarnings: stats.total_earnings_usd || 0,
        referralLink: `${req.protocol}://${req.get('host')}/register?ref=${user.referral_id}`,
        level1Referrals: level1Referrals,
        level2Referrals: level2Referrals
      }
    });
  } catch (err) {
    console.error('Referrals page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});



// Wallet route
app.get('/wallet', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];

    // Get minimum payout amount from config
    const minPayout = await getConfig('min_payout');
    
    // Get manual payment instructions
    const manualInstructions = await getConfig('manual_payment_instructions');

    // Get user's transactions
    const [transactions] = await pool.query(`
      SELECT * FROM transactions 
      WHERE user_id = ? AND (type = 'commission' OR type = 'withdrawal')
      ORDER BY created_at DESC
    `, [userId]);

    // Get activation status and progress
    const activationService = req.app.locals.activationService;
    const activationProgress = await activationService.getActivationProgress(userId);
    const canWithdraw = activationProgress.status === 'active' || !activationProgress.isActivationRequired;

    res.render('user/wallet', { 
      user,
      transactions,
      minPayout: parseFloat(minPayout),
      manualInstructions: manualInstructions || 'Please transfer the amount to our account and upload a screenshot/receipt as proof of payment.',
      activationProgress,
      canWithdraw
    });
  } catch (err) {
    console.error('Wallet page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});



// Merchant link management routes
// Fix for the "no links showing" issue in the merchant links route
app.get('/merchant/links', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get all links for this merchant with COALESCE to handle NULLs
    const [links] = await pool.query(`
      SELECT l.*, 
             COUNT(DISTINCT sl.id) as share_count,
             COUNT(DISTINCT c.id) as total_clicks
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      LEFT JOIN clicks c ON sl.id = c.shared_link_id
      WHERE l.merchant_id = ?
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [userId]);
    
    console.log('Merchant links found:', links.length);
    
    res.render('merchant/links', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      links: links,
      success: req.query.success,
      error: req.query.error,
      page: 'links'
    });
  } catch (err) {
    console.error('Merchant links error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Fix for the "Failed to create link" issue
app.post('/merchant/links/create', isAuthenticated, isMerchant, upload.single('image'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const {
      title,
      description,
      type,
      url,
      category,
      click_target,
      cost_per_click,
      price
    } = req.body;
    
    // Validate required fields
    if (!title || !type || !url || !click_target) {
      return res.redirect('/merchant/links/create?error=Missing required fields');
    }
    
    // Get the file path if an image was uploaded
    let imageUrl = null;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }
    
    // Ensure cost_per_click is a valid number
    let linkCostPerClick;
    if (!cost_per_click || isNaN(parseFloat(cost_per_click))) {
      // If not provided or invalid, get default from config
      linkCostPerClick = await getConfig('cost_per_click');
    } else {
      linkCostPerClick = cost_per_click;
    }
    
    // Convert to float to ensure it's a valid number
    const costPerClickValue = parseFloat(linkCostPerClick);
    
    // Insert the new link
    await pool.query(`
      INSERT INTO links (
        title, 
        description, 
        merchant_id, 
        type, 
        url, 
        image_url, 
        category,
        price, 
        click_target, 
        cost_per_click,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true)
    `, [
      title,
      description || null,
      userId,
      type,
      url,
      imageUrl,
      category || null,
      price || null,
      parseInt(click_target),
      costPerClickValue // This will now always be a valid number
    ]);
    
    res.redirect('/merchant/links?success=Link created successfully');
  } catch (err) {
    console.error('Link creation error:', err);
    res.redirect('/merchant/links/create?error=Failed to create link. Please try again.');
  }
});

app.get('/merchant/links/create', isAuthenticated, isMerchant, async (req, res) => {
  try {
    // Get cost per click from config
    const costPerClick = await getConfig('cost_per_click');
    
    res.render('merchant/link-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: null, // null means new link
      costPerClick: parseFloat(costPerClick),
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Link form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

app.post('/merchant/links/create', isAuthenticated, isMerchant, upload.single('image'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const {
      title,
      description,
      type,
      url,
      category,
      click_target,
      cost_per_click,
      price // Include price field
    } = req.body;
    
    // Validate required fields
    if (!title || !type || !url || !click_target) {
      return res.redirect('/merchant/links/create?error=Missing required fields');
    }
    
    // Get the file path if an image was uploaded
    let imageUrl = null;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }
    
    // Insert the new link
    await pool.query(`
      INSERT INTO links (
        title, 
        description, 
        merchant_id, 
        type, 
        url, 
        image_url, 
        category,
        price, 
        click_target, 
        cost_per_click,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true)
    `, [
      title,
      description || null,
      userId,
      type,
      url,
      imageUrl,
      category || null,
      price || null,
      parseFloat(click_target),
      parseFloat(cost_per_click)
    ]);
    
    res.redirect('/merchant/links?success=Link created successfully');
  } catch (err) {
    console.error('Link creation error:', err);
    res.redirect('/merchant/links/create?error=Failed to create link. Please try again.');
  }
});
app.get('/merchant/links/:id/edit', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Get link details, ensuring it belongs to this merchant
    const [links] = await pool.query(`
      SELECT * FROM links
      WHERE id = ? AND merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to edit it.' });
    }
    
    // Get cost per click from config
    const costPerClick = await getConfig('cost_per_click');
    
    res.render('merchant/link-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: links[0],
      costPerClick: parseFloat(costPerClick),
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Edit link form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

app.post('/merchant/links/:id/edit', isAuthenticated, isMerchant, upload.single('image'), async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    const {
      title,
      description,
      type,
      url,
      category,
      click_target,
      cost_per_click,
      is_active
    } = req.body;
    
    // Verify link belongs to this merchant
    const [links] = await pool.query(`
      SELECT l.*
      FROM links l
      WHERE l.id = ? AND l.merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to edit it.' });
    }
    
    // Get the file path if a new image was uploaded
    let imageUrl = links[0].image_url;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
      
      // Delete old image if it exists
      if (links[0].image_url) {
        const oldImagePath = path.join(__dirname, 'public', links[0].image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
    }
    
    // Update the link
    await pool.query(`
      UPDATE links
      SET title = ?,
          description = ?,
          type = ?,
          url = ?,
          image_url = ?,
          category = ?,
          click_target = ?,
          cost_per_click = ?,
          is_active = ?
      WHERE id = ? AND merchant_id = ?
    `, [
      title,
      description,
      type,
      url,
      imageUrl,
      category,
      click_target,
      cost_per_click,
      is_active ? 1 : 0,
      linkId,
      userId
    ]);
    
    res.redirect(`/merchant/links?success=Link updated successfully`);
  } catch (err) {
    console.error('Link update error:', err);
    res.redirect(`/merchant/links/${req.params.id}/edit?error=Failed to update link. Please try again.`);
  }
});

// Route to view a specific merchant link
app.get('/merchant/links/:id', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Get link details, ensuring it belongs to this merchant
    const [links] = await pool.query(`
      SELECT l.*
      FROM links l
      WHERE l.id = ? AND l.merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to view it.' });
    }
    
    const link = links[0];
    
    // Get analytics data for this link with corrected queries
    const [analytics] = await pool.query(`
      SELECT 
        COUNT(DISTINCT sl.id) as total_shares,
        SUM(sl.clicks) as total_clicks,
        COALESCE(SUM(sl.earnings), 0) as total_earnings
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      WHERE l.id = ?
      GROUP BY l.id
    `, [linkId]);
    
    // If no analytics records were found, initialize with zeros
    const analyticsData = analytics.length > 0 ? analytics[0] : { 
      total_shares: 0, 
      total_clicks: 0, 
      total_earnings: 0 
    };
    
    // Get users who shared this link with correct click count calculation
    const [shares] = await pool.query(`
      SELECT 
        sl.*, 
        u.username, 
        sl.clicks as click_count,
        COALESCE(sl.earnings, 0) as user_earnings
      FROM shared_links sl
      JOIN users u ON sl.user_id = u.id
      WHERE sl.link_id = ?
      ORDER BY sl.clicks DESC
    `, [linkId]);
    
    res.render('merchant/link-details', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: link,
      analytics: analyticsData,
      shares: shares,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant link details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Route for handling shared links with shortcodes
// app.get('/l/:code', async (req, res) => {
//   try {
//     const shareCode = req.params.code;
    
//     // Find the shared link with this code
//     const [sharedLinks] = await pool.query(`
//       SELECT sl.*, l.url, l.title, l.description, l.type, l.merchant_id, l.image_url, l.price
//       FROM shared_links sl
//       JOIN links l ON sl.link_id = l.id
//       WHERE sl.share_code = ?
//     `, [shareCode]);
    
//     if (sharedLinks.length === 0) {
//       return res.status(404).render('error', { message: 'Link not found or it may have been removed.' });
//     }
    
//     const sharedLink = sharedLinks[0];
    
//     // Record the click
//     const ip = req.ip || req.connection.remoteAddress;
//     const userAgent = req.headers['user-agent'];
//     const referrer = req.headers.referer || req.headers.referrer || '';
    
//     // Insert click record
//     const [clickResult] = await pool.query(`
//       INSERT INTO clicks (shared_link_id, ip_address, device_info, referrer, is_counted)
//       VALUES (?, ?, ?, ?, true)
//     `, [sharedLink.id, ip, userAgent, referrer]);
    
//     // Update click count in shared_links table
//     await pool.query(`
//       UPDATE shared_links SET clicks = clicks + 1 WHERE id = ?
//     `, [sharedLink.id]);
    
//     // Update total clicks in links table
//     await pool.query(`
//       UPDATE links SET clicks_count = clicks_count + 1 WHERE id = ?
//     `, [sharedLink.link_id]);
    
//     // Calculate and add commission for the sharer
//     const [links] = await pool.query('SELECT * FROM links WHERE id = ?', [sharedLink.link_id]);
//     const link = links[0];
    
//     // Calculate and add commission for the sharer
// const costPerClick = parseFloat(link.cost_per_click) || 0.0050;
// const commissionRate = await getConfig('commission_rate');
// const commission = parseFloat((costPerClick * (parseFloat(commissionRate) / 100)).toFixed(4));

// // Update earnings in shared_links
// await pool.query(`
//   UPDATE shared_links SET earnings = earnings + ? WHERE id = ?
// `, [commission, sharedLink.id]);

// // Update user earnings
// await pool.query(`
//   UPDATE users SET earnings = COALESCE(earnings, 0) + ?, wallet = COALESCE(wallet, 0) + ? WHERE id = ?
// `, [commission, commission, sharedLink.user_id]); 
//     // Record transaction
//     await pool.query(`
//       INSERT INTO transactions (user_id, type, amount, status, details)
//       VALUES (?, 'commission', ?, 'completed', ?)
//     `, [
//       sharedLink.user_id,
//       commission,
//       `Commission for click on ${link.title}`
//     ]);
    
//     // Increment merchant's amount to pay
//     await pool.query(`
//       UPDATE users SET amount_to_pay = COALESCE(amount_to_pay, 0) + ? WHERE id = ?
//     `, [costPerClick, link.merchant_id]);
    
//     // Redirect to the destination URL
//     if (sharedLink.type === 'product') {
//       return res.redirect(`/products/${sharedLink.link_id}?ref=${sharedLink.share_code}`);
//     } else {
//       return res.redirect(sharedLink.url);
//     }
//   } catch (err) {
//     console.error('Shared link error:', err);
//     return res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });
// Route for handling shared links with shortcodes
app.get('/l/:code', async (req, res) => {
  try {
    const shareCode = req.params.code;
    
    // Find the shared link with this code
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, l.url, l.title, l.description, l.type, l.merchant_id, l.image_url, l.price,
             u.business_name as merchant_name, u.username
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON sl.user_id = u.id
      WHERE sl.share_code = ?
    `, [shareCode]);
    
    if (sharedLinks.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or it may have been removed.' });
    }
    
    const sharedLink = sharedLinks[0];
    
    // For regular links (not YouTube), redirect directly to destination
    if (sharedLink.type !== 'youtube') {
      // Record the click first
      const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || '127.0.0.1';
      const userAgent = req.headers['user-agent'];
      const referrer = req.headers.referer || req.headers.referrer || '';
      
      console.log(`Regular link click from IP: ${ip} for shared link: ${sharedLink.id}`);
      
      // Check if this IP has clicked this shared link recently (within 10 minutes)
      const [recentClicks] = await pool.query(`
        SELECT created_at FROM clicks 
        WHERE shared_link_id = ? AND ip_address = ?
        ORDER BY created_at DESC LIMIT 1
      `, [sharedLink.id, ip]);
      
      // Determine if we should count this click
      let countClick = true;
      
      if (recentClicks.length > 0) {
        const lastClickTime = new Date(recentClicks[0].created_at);
        const currentTime = new Date();
        const minutesDifference = (currentTime - lastClickTime) / (1000 * 60);
        
        console.log(`Last click was ${minutesDifference.toFixed(2)} minutes ago`);
        
        // Only count clicks from the same IP if more than 10 minutes have passed
        countClick = minutesDifference >= 10;
      }
      
      console.log(`Click will be counted: ${countClick}`);
      
      // Insert click record
      await pool.query(`
        INSERT INTO clicks (shared_link_id, ip_address, device_info, referrer, is_counted, validated_view)
        VALUES (?, ?, ?, ?, ?, true)
      `, [sharedLink.id, ip, userAgent, referrer, countClick]);
      
      console.log(`Click record inserted for shared link: ${sharedLink.id}`);
      
      // Only update stats and pay commission if we're counting this click
      if (countClick) {
        console.log(`Updating stats and paying commission for shared link: ${sharedLink.id}`);
        
        // Update click count in shared_links table
        await pool.query(`
          UPDATE shared_links SET clicks = clicks + 1 WHERE id = ?
        `, [sharedLink.id]);
        
        // Update total clicks in links table
        await pool.query(`
          UPDATE links SET clicks_count = clicks_count + 1 WHERE id = ?
        `, [sharedLink.link_id]);
        
        // Calculate and add commission for the sharer
        const [links] = await pool.query('SELECT * FROM links WHERE id = ?', [sharedLink.link_id]);
        const link = links[0];
        
        const costPerClick = parseFloat(link.cost_per_click) || 0.0050;
        const commissionRate = await getConfig('commission_rate');
        const commission = parseFloat((costPerClick * (parseFloat(commissionRate) / 100)).toFixed(4));
        
        // Update earnings in shared_links
        await pool.query(`
          UPDATE shared_links SET earnings = earnings + ? WHERE id = ?
        `, [commission, sharedLink.id]);
        
        // Update user earnings
        await pool.query(`
          UPDATE users SET earnings = COALESCE(earnings, 0) + ?, wallet = COALESCE(wallet, 0) + ? WHERE id = ?
        `, [commission, commission, sharedLink.user_id]);
        
        // Record transaction
        await pool.query(`
          INSERT INTO transactions (user_id, type, amount, status, details)
          VALUES (?, 'commission', ?, 'completed', ?)
        `, [
          sharedLink.user_id,
          commission,
          `Commission for direct click on ${link.title}`
        ]);
        
        // Increment merchant's amount to pay
        await pool.query(`
          UPDATE users SET amount_to_pay = COALESCE(amount_to_pay, 0) + ? WHERE id = ?
        `, [costPerClick, link.merchant_id]);
        
        // Send click notification
        if (notificationService) {
          try {
            await notificationService.notifyLinkActivity(sharedLink.user_id, {
              action: 'new_click',
              linkTitle: sharedLink.title || `Link #${sharedLink.link_id}`,
              earnings: `${commission} USD`
            });
          } catch (notificationError) {
            console.error('Click notification error:', notificationError);
          }
        }
      }
      
      // Redirect directly to the destination URL for regular links
      return res.redirect(sharedLink.url);
    }
    
    // For YouTube links, show the viewer page with additional content for better AdSense performance
    try {
      // Get featured and recent blog posts for additional content
      const [blogPosts] = await pool.query(`
        (
          -- Featured posts (high engagement)
          SELECT 
            bp.id, bp.title, bp.excerpt, bp.featured_image, bp.slug,
            bp.created_at,
            u.username, u.business_name,
            COALESCE(bp.view_count, 0) as view_count
          FROM blog_posts bp
          JOIN users u ON bp.merchant_id = u.id
          WHERE bp.is_active = true
          AND bp.view_count > 100
          ORDER BY bp.view_count DESC
          LIMIT 3
        )
        UNION ALL
        (
          -- Recent posts
          SELECT 
            bp.id, bp.title, bp.excerpt, bp.featured_image, bp.slug,
            bp.created_at,
            u.username, u.business_name,
            COALESCE(bp.view_count, 0) as view_count
          FROM blog_posts bp
          JOIN users u ON bp.merchant_id = u.id
          WHERE bp.is_active = true
          ORDER BY bp.created_at DESC
          LIMIT 3
        )
        UNION ALL
        (
          -- Random posts (since we don't have categories yet)
          SELECT 
            bp.id, bp.title, bp.excerpt, bp.featured_image, bp.slug,
            bp.created_at,
            u.username, u.business_name,
            COALESCE(bp.view_count, 0) as view_count
          FROM blog_posts bp
          JOIN users u ON bp.merchant_id = u.id
          WHERE bp.is_active = true
          ORDER BY RAND()
          LIMIT 3
        )
      `);

      // Get random products for additional content
      const [randomProducts] = await pool.query(`
        SELECT 
          p.id, p.name, p.description, p.image_url, p.price,
          u.username, u.business_name as merchant_name
        FROM products p
        JOIN users u ON p.merchant_id = u.id
        WHERE p.is_active = true
        ORDER BY RAND()
        LIMIT 4
      `);

      // Get related links (same type or from same merchant)
      const [relatedLinks] = await pool.query(`
        SELECT 
          l.id, l.title, l.description, l.image_url, l.type,
          u.username, u.business_name as merchant_name
        FROM links l
        JOIN users u ON l.merchant_id = u.id
        WHERE l.is_active = true 
          AND l.id != ?
          AND (l.type = ? OR l.merchant_id = ?)
        ORDER BY RAND()
        LIMIT 3
      `, [sharedLink.link_id, sharedLink.type, sharedLink.merchant_id]);

      // Get active banners with smart selection algorithm
      console.log('Fetching banners for link viewer...');
      const [banners] = await pool.query(
        'SELECT ' +
        '  b.id,' +
        '  b.image_url as banner_image,' +
        '  b.target_url,' +
        '  b.title,' +
        '  b.target_type,' +
        '  COUNT(DISTINCT bv.id) as impressions,' +
        '  COUNT(DISTINCT bc.id) as clicks,' +
        '  COUNT(DISTINCT CASE WHEN DATE(bv.viewed_at) = CURDATE() THEN bv.id END) as today_impressions,' +
        '  COUNT(DISTINCT CASE WHEN DATE(bc.clicked_at) = CURDATE() THEN bc.id END) as today_clicks,' +
        '  b.display_order,' +
        '  b.created_at ' +
        'FROM banners b ' +
        'LEFT JOIN banner_views bv ON b.id = bv.banner_id ' +
        'LEFT JOIN banner_clicks bc ON b.id = bc.banner_id ' +
        'WHERE b.status = "approved" ' +
        'AND b.is_active = true ' +
        'GROUP BY b.id ' +
        'ORDER BY ' +
        '  b.display_order DESC,' +
        '  b.created_at DESC,' +
        '  (COUNT(DISTINCT bc.id) / GREATEST(COUNT(DISTINCT bv.id), 1)) DESC,' +
        '  RAND() ' +
        'LIMIT 5'
      );
      console.log('Found', banners.length, 'banners for link viewer');

      return res.render('link-viewer', { 
        sharedLink: sharedLink,
        title: sharedLink.title + ' - BenixSpace',
        blogPosts: blogPosts || [],
        randomProducts: randomProducts || [],
        relatedLinks: relatedLinks || [],
        adBanners: banners || []
      });
    } catch (contentError) {
      console.error('Error loading additional content for link viewer:', contentError);
      // Fallback to basic render if additional content fails
      return res.render('link-viewer', { 
        sharedLink: sharedLink,
        title: sharedLink.title + ' - BenixSpace',
        blogPosts: [],
        randomProducts: [],
        relatedLinks: [],
        adBanners: []
      });
    }
  } catch (err) {
    console.error('Shared link error:', err);
    return res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});
// API endpoint for counting clicks after 30-second wait
app.post('/api/count-click/:code', async (req, res) => {
  try {
    const shareCode = req.params.code;
    
    // Find the shared link with this code
    const query = 'SELECT sl.*, l.url, l.title, l.description, l.type, ' +
      'l.merchant_id, l.image_url, l.price ' +
      'FROM shared_links sl ' +
      'JOIN links l ON sl.link_id = l.id ' +
      'WHERE sl.share_code = ?';
    const [sharedLinks] = await pool.query(query, [shareCode]);
    
    if (sharedLinks.length === 0) {
      return res.status(404).json({ success: false, message: 'Link not found' });
    }
    
    const sharedLink = sharedLinks[0];
    
    // Record the click
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers.referer || req.headers.referrer || '';
    
    // Check if this IP has clicked this shared link recently (within 10 minutes)
    const [recentClicks] = await pool.query(
      'SELECT created_at FROM clicks ' +
      'WHERE shared_link_id = ? AND ip_address = ? ' +
      'ORDER BY created_at DESC LIMIT 1',
      [sharedLink.id, ip]);
    
    // Determine if we should count this click
    let countClick = true;
    
    if (recentClicks.length > 0) {
      const lastClickTime = new Date(recentClicks[0].created_at);
      const currentTime = new Date();
      const minutesDifference = (currentTime - lastClickTime) / (1000 * 60);
      
      // Only count clicks from the same IP if more than 10 minutes have passed
      countClick = minutesDifference >= 10;
    }
    
    // Insert click record with 30-second validation
    await pool.query(`
      INSERT INTO clicks (shared_link_id, ip_address, device_info, referrer, is_counted, validated_view)
      VALUES (?, ?, ?, ?, ?, true)
    `, [sharedLink.id, ip, userAgent, referrer, countClick]);
    
    // Only update stats and pay commission if we're counting this click
    if (countClick) {
      // Get the current link status and click count
      const [links] = await pool.query('SELECT * FROM links WHERE id = ?', [sharedLink.link_id]);
      const link = links[0];

      // Check if link is active and hasn't reached its target
      if (!link.is_active || (link.click_target && link.clicks_count >= link.click_target)) {
        console.log(`Link ${link.id} is inactive or has reached its target (${link.clicks_count}/${link.click_target})`);
        return res.redirect(sharedLink.url);
      }

      // Update click count in shared_links table
      await pool.query(`
        UPDATE shared_links SET clicks = clicks + 1 WHERE id = ?
      `, [sharedLink.id]);
      
      // Update total clicks in links table
      await pool.query(`
        UPDATE links SET clicks_count = clicks_count + 1 WHERE id = ?
      `, [sharedLink.link_id]);
      
      const costPerClick = parseFloat(link.cost_per_click) || 0.0050;
      const commissionRate = await getConfig('commission_rate');
      const commission = parseFloat((costPerClick * (parseFloat(commissionRate) / 100)).toFixed(4));
      
      // Update earnings in shared_links
      await pool.query(`
        UPDATE shared_links SET earnings = earnings + ? WHERE id = ?
      `, [commission, sharedLink.id]);
      
      // Update user earnings
      await pool.query(`
        UPDATE users SET earnings = COALESCE(earnings, 0) + ?, wallet = COALESCE(wallet, 0) + ? WHERE id = ?
      `, [commission, commission, sharedLink.user_id]);
      
      // Get updated click count and check for milestones/target
      const [updatedLink] = await pool.query('SELECT clicks_count, title, click_target FROM links WHERE id = ?', [sharedLink.link_id]);
      const totalClicks = updatedLink[0].clicks_count;
      const linkTitle = updatedLink[0].title;
      const clickTarget = updatedLink[0].click_target;
      
      // Send click notification and check milestones
      if (notificationService) {
        try {
          // Send new click notification
          await notificationService.notifyLinkActivity(sharedLink.user_id, {
            action: 'new_click',
            linkTitle: linkTitle || `Link #${sharedLink.link_id}`,
            earnings: `${commission} USD`
          });
          
          // Check for milestone notifications (every 100 clicks)
          if (totalClicks % 100 === 0 && totalClicks > 0) {
            await notificationService.notifyLinkActivity(sharedLink.user_id, {
              action: 'milestone_reached',
              linkTitle: linkTitle || `Link #${sharedLink.link_id}`,
              clicks: totalClicks
            });
          }

          // Check if target is reached and deactivate link
          if (clickTarget && totalClicks >= clickTarget) {
            // Deactivate the link
            await pool.query('UPDATE links SET is_active = false WHERE id = ?', [sharedLink.link_id]);
            
            // Notify merchant that link has been deactivated
            await notificationService.notifyLinkActivity(link.merchant_id, {
              action: 'target_reached',
              linkTitle: linkTitle || `Link #${sharedLink.link_id}`,
              clicks: totalClicks
            });
          }
        } catch (notificationError) {
          console.error('Click notification error:', notificationError);
        }
      }
      
      // Record transaction
      await pool.query(`
        INSERT INTO transactions (user_id, type, amount, status, details)
        VALUES (?, 'commission', ?, 'completed', ?)
      `, [
        sharedLink.user_id,
        commission,
        `Commission for validated 30-second view on ${link.title}`
      ]);
      
      // Increment merchant's amount to pay
      await pool.query(`
        UPDATE users SET amount_to_pay = COALESCE(amount_to_pay, 0) + ? WHERE id = ?
      `, [costPerClick, link.merchant_id]);
      
      return res.json({ 
        success: true, 
        message: 'Click counted successfully',
        commission: commission,
        totalEarnings: commission
      });
    } else {
      return res.json({ 
        success: true, 
        message: 'View recorded but not counted (duplicate within 10 minutes)',
        commission: 0,
        totalEarnings: 0
      });
    }
    
  } catch (err) {
    console.error('Click counting error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API endpoint for getting banners for a specific link
app.get('/api/banners/:shareCode', async (req, res) => {
  try {
    const shareCode = req.params.shareCode;
    
    // Get the shared link info
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, l.clicks_count, l.id as actual_link_id
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      WHERE sl.share_code = ?
    `, [shareCode]);
    
    if (sharedLinks.length === 0) {
      return res.status(404).json([]);
    }
    
    const sharedLink = sharedLinks[0];
    
    // Get active banners based on targeting
    const query = `
      WITH banner_stats AS (
        SELECT 
          b.id,
          COUNT(DISTINCT bv.id) as view_count,
          COUNT(DISTINCT bc.id) as click_count
        FROM banners b
        LEFT JOIN banner_views bv ON b.id = bv.banner_id
        LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
        GROUP BY b.id
      )
      SELECT DISTINCT 
        b.id, 
        b.title, 
        b.image_url, 
        b.target_url as click_url,
        b.target_type,
        COALESCE(bs.view_count, 0) as impressions,
        COALESCE(bs.click_count, 0) as clicks
      FROM banners b
      LEFT JOIN banner_stats bs ON b.id = bs.id
      WHERE b.status = 'approved'
      AND b.is_active = true
      AND (
        b.target_type = 'all'
        OR (b.target_type = 'popular' AND ? >= b.min_clicks)
        OR (b.target_type = 'specific' AND EXISTS (
          SELECT 1 FROM banner_target_links btl 
          WHERE btl.banner_id = b.id AND btl.link_id = ?
        ))
      )
      ORDER BY 
        b.display_order DESC,
        b.created_at DESC
      LIMIT 5
    `;
    
    console.log('Fetching banners for shared link with code:', shareCode);
    const [banners] = await pool.query(query, [sharedLink.clicks_count, sharedLink.actual_link_id]);
    
    res.json(banners);
  } catch (err) {
    console.error('Banner API error:', err);
    res.status(500).json([]);
  }
});

// API endpoint for getting banners for blog posts
app.get('/api/blog-banners', async (req, res) => {
  try {
    // Get active banners for blog pages
    const [banners] = await pool.query(`
      SELECT id, title, image_url, click_url
      FROM ad_banners 
      WHERE is_active = true 
      AND (target_type = 'all' OR target_type = 'popular')
      ORDER BY created_at DESC 
      LIMIT 4
    `);
    
    res.json(banners);
  } catch (err) {
    console.error('Blog banner API error:', err);
    res.status(500).json([]);
  }
});

// API endpoint for tracking banner analytics
app.post('/api/banner-analytics', async (req, res) => {
  try {
    const { banner_id, link_id, event_type } = req.body;
    
    if (!banner_id || !event_type || !['impression', 'click'].includes(event_type)) {
      return res.status(400).json({ success: false, message: 'Invalid parameters' });
    }
    
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    const userId = req.session.userId || null;
    
    // For impressions, check if we've already tracked this recently to avoid spam
    if (event_type === 'impression') {
      const [recentImpression] = await pool.query(`
        SELECT created_at FROM banner_analytics
        WHERE banner_id = ? AND link_id = ? AND ip_address = ? AND event_type = 'impression'
        AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      `, [banner_id, link_id, ip]);
      
      // Don't track if same IP viewed this banner on this link within 1 hour
      if (recentImpression.length > 0) {
        return res.json({ success: true, message: 'Already tracked' });
      }
    }
    
    // Record the analytics event
    await pool.query(`
      INSERT INTO banner_analytics (banner_id, link_id, event_type, user_id, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [banner_id, link_id, event_type, userId, ip, userAgent]);
    
    res.json({ success: true, message: 'Event tracked successfully' });
  } catch (err) {
    console.error('Banner analytics error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// User Routes (must be before indexRoutes to avoid /user/:username conflict)
app.use('/', userRoutes);

// Blog Post Routes
// Blog post creation form (merchant only)
app.get('/blog/create', isAuthenticated, async (req, res) => {
  try {
    const user = await getUserById(req.session.userId);
    if (user.role !== 'merchant' && user.role !== 'admin') {
      return res.status(403).render('error', { message: 'Only merchants can create blog posts' });
    }
    
    res.render('blog/create', { 
      user: user,
      page: 'blog-create',
      req: req
    });
  } catch (err) {
    console.error('Blog create page error:', err);
    res.status(500).render('error', { message: 'Server error' });
  }
});

// Image upload API for blog editor
app.post('/api/upload-image', isAuthenticated, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Validate image file
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid image format. Please use JPEG, PNG, or GIF files only.' });
    }

    // Check file size (5MB limit)
    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image file is too large. Please use an image smaller than 5MB.' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    
    res.json({ 
      success: true, 
      url: imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ 
      error: 'Failed to upload image. Please try again.' 
    });
  }
});

// Blog post creation handler
app.post('/blog/create', isAuthenticated, upload.single('featured_image'), async (req, res) => {
  try {
    const user = await getUserById(req.session.userId);
    if (user.role !== 'merchant' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only merchants and admins can create blog posts. Please contact support if you need merchant access.' });
    }

    const {
      title,
      content,
      excerpt,
      meta_title,
      meta_description,
      meta_keywords,
      cpc
    } = req.body;

    // Validation
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: 'Title is required and cannot be empty.' });
    }

    if (title.trim().length < 3) {
      return res.status(400).json({ error: 'Title must be at least 3 characters long.' });
    }

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required and cannot be empty.' });
    }

    if (content.trim().length < 50) {
      return res.status(400).json({ error: 'Content must be at least 50 characters long.' });
    }

    // Generate SEO-friendly slug
    const slug = generateSlug(title);
    
    // Check if slug already exists
    const [existingPosts] = await pool.query('SELECT id FROM blog_posts WHERE slug = ?', [slug]);
    if (existingPosts.length > 0) {
      return res.status(400).json({ error: `A blog post with similar title already exists. Please use a different title.` });
    }
    
    // Handle featured image
    let featuredImage = null;
    if (req.file) {
      // Validate image file
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Invalid image format. Please use JPEG, PNG, or GIF files only.' });
      }
      
      // Check file size (5MB limit)
      if (req.file.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image file is too large. Please use an image smaller than 5MB.' });
      }
      
      featuredImage = `/uploads/${req.file.filename}`;
    }

    // Validate CPC
    const cpcValue = parseFloat(cpc) || 0.01;
    if (cpcValue < 0.001 || cpcValue > 10) {
      return res.status(400).json({ error: 'CPC must be between $0.001 and $10.00.' });
    }

    // Insert blog post
    const [result] = await pool.query(`
      INSERT INTO blog_posts (
        merchant_id, title, slug, content, excerpt, featured_image,
        meta_title, meta_description, meta_keywords, cpc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user.id, title.trim(), slug, content.trim(), excerpt ? excerpt.trim() : '', featuredImage,
      meta_title ? meta_title.trim() : title.trim(), 
      meta_description ? meta_description.trim() : (excerpt ? excerpt.trim() : ''), 
      meta_keywords ? meta_keywords.trim() : '', 
      cpcValue
    ]);

    res.json({ 
      success: true, 
      message: 'Blog post created successfully!',
      postId: result.insertId,
      slug: slug
    });
  } catch (err) {
    console.error('Blog post creation error:', err);
    
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'A blog post with this title already exists. Please choose a different title.' });
    } else if (err.code === 'ER_DATA_TOO_LONG') {
      return res.status(400).json({ error: 'One of the fields is too long. Please reduce the content length and try again.' });
    } else if (err.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ error: 'Required field is missing. Please fill in all required fields.' });
    } else if (err.code === 'ENOENT') {
      return res.status(500).json({ error: 'File upload failed. Please try uploading the image again.' });
    } else {
      return res.status(500).json({ 
        error: `Database error: ${err.message}. Please try again or contact support if the problem persists.` 
      });
    }
  }
});

// Blog post listing page
app.get('/blog', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;

    // Debug user session
    console.log('Blog list - Session userId:', req.session.userId);
    let user = null;
    if (req.session.userId) {
      try {
        user = await getUserById(req.session.userId);
        console.log('Blog list - User found:', user ? user.username : 'null');
      } catch (err) {
        console.error('Error getting user by ID:', err);
      }
    }

    // Get blog posts with merchant info and proper statistics
    const [posts] = await pool.query(`
      SELECT 
        bp.*, 
        u.username, 
        u.business_name,
        COALESCE(bp.view_count, 0) as view_count,
        COALESCE(bp.click_count, 0) as click_count,
        COUNT(DISTINCT bps.user_id) as share_count
      FROM blog_posts bp
      JOIN users u ON bp.merchant_id = u.id
      LEFT JOIN blog_post_shares bps ON bp.id = bps.blog_post_id
      WHERE bp.is_active = true
      GROUP BY bp.id, bp.title, bp.content, bp.featured_image, bp.slug, bp.view_count, bp.click_count, bp.cpc, bp.merchant_id, bp.is_active, bp.created_at, bp.updated_at, u.username, u.business_name
      ORDER BY bp.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Get total count for pagination
    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total FROM blog_posts WHERE is_active = true
    `);

    const totalPosts = countResult[0].total;
    const totalPages = Math.ceil(totalPosts / limit);

    // Get active banners for advertising spaces
    const [banners] = await pool.query(`
      SELECT * FROM banners 
      WHERE status = 'approved' AND is_active = true 
      ORDER BY display_order DESC, created_at DESC
      LIMIT 3
    `);

    // Get unique categories/tags from existing posts (since you don't have category column)
    const [categoryStats] = await pool.query(`
      SELECT 
        SUBSTRING_INDEX(SUBSTRING_INDEX(bp.content, '#', -1), ' ', 1) as tag,
        COUNT(*) as count
      FROM blog_posts bp 
      WHERE bp.is_active = true 
        AND bp.content LIKE '%#%'
      GROUP BY tag
      HAVING tag != ''
      ORDER BY count DESC
      LIMIT 10
    `);

    res.render('blog/list', {
      user: user,
      posts: posts,
      currentPage: page,
      totalPages: totalPages,
      userCommissionPercentage: await getConfig('user_commission_percentage') || 30,
      page: 'blog',
      banners: banners || [],
      categories: categoryStats || [],
      totalPosts: totalPosts,
      query: req.query,
      currentFilter: req.query.filter || null
    });
  } catch (err) {
    console.error('Blog listing error:', err);
    res.status(500).render('error', { message: 'Server error' });
  }
});

// Blog post sharing (create affiliate link)
app.post('/blog/share/:postId', isAuthenticated, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    console.log('Blog share request:', { postId, userId });

    // Check if post exists
    const [posts] = await pool.query('SELECT * FROM blog_posts WHERE id = ? AND is_active = true', [postId]);
    console.log('Posts found:', posts.length);
    
    if (posts.length === 0) {
      console.log('Post not found:', postId);
      return res.status(404).json({ error: 'Blog post not found' });
    }

    // Check if user already has a share for this post
    const [existingShares] = await pool.query(
      'SELECT * FROM blog_post_shares WHERE blog_post_id = ? AND user_id = ?',
      [postId, userId]
    );

    console.log('Existing shares found:', existingShares.length);

    let shareData;
    if (existingShares.length > 0) {
      shareData = existingShares[0];
      console.log('Using existing share:', shareData);
    } else {
      // Create new share
      const uniqueCode = generateUniqueCode();
      console.log('Generated unique code:', uniqueCode);
      
      const [result] = await pool.query(`
        INSERT INTO blog_post_shares (blog_post_id, user_id, unique_code)
        VALUES (?, ?, ?)
      `, [postId, userId, uniqueCode]);

      console.log('Insert result:', result);

      shareData = {
        id: result.insertId,
        unique_code: uniqueCode,
        clicks_count: 0,
        earnings: 0
      };
    }

    const shareUrl = `${req.protocol}://${req.get('host')}/blog/${posts[0].slug}?ref=${shareData.unique_code}`;
    console.log('Generated share URL:', shareUrl);

    res.json({
      success: true,
      shareUrl: shareUrl,
      shareData: shareData
    });
  } catch (err) {
    console.error('Blog share error details:', err);
    res.status(500).json({ error: 'Failed to create share link: ' + err.message });
  }
});

// Validate blog post read time and award commission
app.post('/api/blog/validate-read', async (req, res) => {
  try {
    const { clickId } = req.body;
    
    if (!clickId || !req.session.pendingClickId || req.session.pendingClickId != clickId) {
      return res.status(400).json({ error: 'Invalid or expired click ID' });
    }

    // Get the click record
    const [clicks] = await pool.query(`
      SELECT bc.*, bps.user_id, bps.blog_post_id 
      FROM blog_post_clicks bc
      LEFT JOIN blog_post_shares bps ON bc.blog_post_share_id = bps.id
      WHERE bc.id = ? AND bc.commission_paid = false
    `, [clickId]);

    if (clicks.length === 0) {
      return res.status(404).json({ error: 'Click record not found or already processed' });
    }

    const click = clicks[0];
    
    // Check if 20 seconds have passed since the click
    const clickTime = new Date(click.created_at);
    const currentTime = new Date();
    const timeDiff = (currentTime - clickTime) / 1000; // in seconds

    if (timeDiff < 20) {
      return res.status(400).json({ error: 'Minimum read time not reached' });
    }

    // If this is a shared post (has blog_post_share_id), award commission
    if (click.blog_post_share_id && click.user_id) {
      // Check if this user has earned from a click in the last 10 minutes (anti-spam)
      const [recentEarnings] = await pool.query(`
        SELECT id FROM blog_post_clicks 
        WHERE blog_post_share_id IN (
          SELECT id FROM blog_post_shares WHERE user_id = ?
        ) 
        AND commission_paid = true 
        AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
      `, [click.user_id]);

      if (recentEarnings.length > 0) {
        return res.status(429).json({ error: 'Recent earning detected, please wait before next valid click' });
      }

      // Calculate earnings
      const userCommissionPercentage = await getConfig('user_commission_percentage') || 30;
      const earnings = (req.session.postCpc * userCommissionPercentage) / 100;
      
      // Update click record
      await pool.query(`
        UPDATE blog_post_clicks 
        SET validated_view = true, commission_paid = true, read_time_seconds = ?
        WHERE id = ?
      `, [Math.floor(timeDiff), clickId]);

      // Update share earnings and click count
      await pool.query(`
        UPDATE blog_post_shares 
        SET clicks_count = clicks_count + 1, earnings = earnings + ?
        WHERE id = ?
      `, [earnings, click.blog_post_share_id]);

      // Update user earnings
      await pool.query(
        'UPDATE users SET earnings = earnings + ? WHERE id = ?',
        [earnings, click.user_id]
      );

      // Update post click count
      await pool.query(
        'UPDATE blog_posts SET click_count = click_count + 1 WHERE id = ?',
        [click.blog_post_id]
      );

      // Record transaction
      await pool.query(`
        INSERT INTO transactions (user_id, amount, type, details, status)
        VALUES (?, ?, 'commission', ?, 'completed')
      `, [
        click.user_id, 
        earnings, 
        `Blog share commission for 20+ seconds read time`
      ]);

      // Clear session data
      delete req.session.pendingClickId;
      delete req.session.shareId;
      delete req.session.postCpc;

      res.json({ 
        success: true, 
        earnings: earnings,
        readTime: Math.floor(timeDiff)
      });
    } else {
      // Just mark as validated view for regular posts
      await pool.query(`
        UPDATE blog_post_clicks 
        SET validated_view = true, read_time_seconds = ?
        WHERE id = ?
      `, [Math.floor(timeDiff), clickId]);

      res.json({ 
        success: true, 
        validated: true,
        readTime: Math.floor(timeDiff)
      });
    }

  } catch (err) {
    console.error('Blog read validation error:', err);
    res.status(500).json({ error: 'Failed to validate read time' });
  }
});

// Blog post click tracking
app.get('/blog/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { ref } = req.query;

    // Debug user session
    console.log('Blog view - Session userId:', req.session.userId);
    let user = null;
    if (req.session.userId) {
      try {
        user = await getUserById(req.session.userId);
        console.log('Blog view - User found:', user ? user.username : 'null');
      } catch (err) {
        console.error('Error getting user by ID:', err);
      }
    }

    // Get blog post with actual statistics
    const [posts] = await pool.query(`
      SELECT 
        bp.*, 
        u.username, 
        u.business_name,
        COALESCE(bp.view_count, 0) as view_count,
        COALESCE(bp.click_count, 0) as click_count,
        (SELECT COUNT(DISTINCT user_id) FROM blog_post_shares WHERE blog_post_id = bp.id) as share_count
      FROM blog_posts bp
      JOIN users u ON bp.merchant_id = u.id
      WHERE bp.slug = ? AND bp.is_active = true
    `, [slug]);

    if (posts.length === 0) {
      return res.status(404).render('error', { message: 'Blog post not found' });
    }

    const post = posts[0];

    // Get user IP
    const userIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    
    // Check if this IP has viewed this post in the last 10 minutes (to prevent spam)
    const [recentViews] = await pool.query(`
      SELECT id FROM blog_post_clicks 
      WHERE blog_post_id = ? AND ip_address = ? 
      AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    `, [post.id, userIP]);

    let shouldCountView = recentViews.length === 0; // Only count if no recent view from this IP

    // Handle affiliate tracking
    if (ref) {
      const [shares] = await pool.query(
        'SELECT * FROM blog_post_shares WHERE unique_code = ? AND blog_post_id = ?',
        [ref, post.id]
      );

      if (shares.length > 0) {
        const share = shares[0];
        
        // Record the initial click (this will be used for time tracking later)
        const [clickResult] = await pool.query(`
          INSERT INTO blog_post_clicks (blog_post_share_id, blog_post_id, ip_address, user_agent, referrer, created_at)
          VALUES (?, ?, ?, ?, ?, NOW())
        `, [
          share.id,
          post.id,
          userIP,
          req.get('User-Agent') || '',
          req.get('Referrer') || ''
        ]);

        // Only count view if IP hasn't viewed recently
        if (shouldCountView) {
          // Update post view count
          await pool.query('UPDATE blog_posts SET view_count = view_count + 1 WHERE id = ?', [post.id]);
        }

        // Store click ID for later earnings tracking (after 20 seconds)
        req.session.pendingClickId = clickResult.insertId;
        req.session.shareId = share.id;
        req.session.postCpc = post.cpc;
      }
    } else if (shouldCountView) {
      // Regular view, increment view count only if IP hasn't viewed recently
      await pool.query('UPDATE blog_posts SET view_count = view_count + 1 WHERE id = ?', [post.id]);
      
      // Record the view for IP tracking
      await pool.query(`
        INSERT INTO blog_post_clicks (blog_post_id, ip_address, user_agent, referrer, created_at)
        VALUES (?, ?, ?, ?, NOW())
      `, [
        post.id,
        userIP,
        req.get('User-Agent') || '',
        req.get('Referrer') || ''
      ]);
    }

    // Get related posts (same merchant or recent posts)
    const [relatedPosts] = await pool.query(`
      (SELECT bp.id, bp.title, bp.slug, bp.featured_image, bp.created_at, u.username, u.business_name
       FROM blog_posts bp
       JOIN users u ON bp.merchant_id = u.id
       WHERE bp.is_active = true 
         AND bp.id != ? 
         AND bp.merchant_id = ?
       ORDER BY bp.created_at DESC
       LIMIT 3)
      UNION
      (SELECT bp.id, bp.title, bp.slug, bp.featured_image, bp.created_at, u.username, u.business_name
       FROM blog_posts bp
       JOIN users u ON bp.merchant_id = u.id
       WHERE bp.is_active = true 
         AND bp.id != ?
         AND bp.merchant_id != ?
       ORDER BY bp.created_at DESC
       LIMIT 3)
      LIMIT 3
    `, [post.id, post.merchant_id, post.id, post.merchant_id]);

    res.render('blog/view', {
      user: user,
      post: post,
      relatedPosts: relatedPosts,
      userCommissionPercentage: await getConfig('user_commission_percentage') || 30,
      pendingClickId: req.session.pendingClickId || null,
      shareId: req.session.shareId || null,
      page: 'blog-view'
    });
  } catch (err) {
    console.error('Blog view error:', err);
    res.status(500).render('error', { message: 'Server error' });
  }
});

// Helper functions
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-');
}

function generateUniqueCode() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

async function getUserById(userId) {
  console.log('getUserById called with:', userId);
  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  console.log('getUserById result:', users.length > 0 ? users[0].username : 'no user found');
  return users[0];
}

// Middleware to inject banners into pages
app.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      // First get some stats to help debug banner visibility
      const [[stats]] = await pool.query(`
        SELECT 
          COUNT(*) as total_banners,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_banners,
          SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END) as active_banners,
          SUM(CASE WHEN status = 'approved' AND is_active = true THEN 1 ELSE 0 END) as visible_banners
        FROM banners
      `);
      console.log('Banner stats:', stats);

      const [banners] = await pool.query(`
        SELECT 
          b.id,
          b.title,
          b.image_url,
          b.target_url,
          b.status,
          b.is_active,
          b.display_order,
          b.target_type,
          u.username as merchant_name,
          u.business_name as merchant_business
        FROM banners b
        LEFT JOIN users u ON b.merchant_id = u.id
        WHERE b.status = 'approved' 
        AND b.is_active = true 
        AND (b.merchant_id IS NULL OR u.status = 'active')
        ORDER BY b.display_order DESC, b.created_at DESC
      `);
      
      console.log('Found', banners.length, 'active banners');
      res.locals.banners = banners;
    } catch (err) {
      console.error('Error fetching banners:', err);
      res.locals.banners = [];
    }
  }
  next();
});

// Index Routes (Homepage)
app.use('/api/ads', adRoutes);
app.use('/', indexRoutes);

//Product Routes
app.use('/', productRoutes);

// Admin Routes
app.use('/', adminRoutes);

// Banner Routes
app.use('/', bannerRoutes);

// API endpoint for tracking banner analytics
app.post('/api/banner/track', async (req, res) => {
  try {
    const { bannerId, eventType, linkId } = req.body;
    const userId = req.session?.userId || null;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || '';

    // Validate event type
    if (!['impression', 'click'].includes(eventType)) {
      return res.status(400).json({ success: false, message: 'Invalid event type' });
    }

    // Record the event
    await pool.query(`
      INSERT INTO banner_analytics (banner_id, link_id, event_type, user_id, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [bannerId, linkId || null, eventType, userId, ip, userAgent]);

    res.json({ success: true, message: 'Event tracked successfully' });
  } catch (err) {
    console.error('Banner tracking error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API endpoint for banner click handling
app.post('/api/banner/click', async (req, res) => {
  try {
    const { bannerId, targetUrl, linkId } = req.body;
    const userId = req.session?.userId || null;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || '';

    // Track the click
    await pool.query(`
      INSERT INTO banner_analytics (banner_id, link_id, event_type, user_id, ip_address, user_agent)
      VALUES (?, ?, 'click', ?, ?, ?)
    `, [bannerId, linkId || null, userId, ip, userAgent]);

    // Return the target URL for redirect
    res.json({ success: true, targetUrl: targetUrl });
  } catch (err) {
    console.error('Banner click tracking error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Cart route
app.get('/cart', async (req, res) => {
  try {
    // If user is not logged in, redirect to login
    if (!req.session.userId) {
      return res.redirect('/login?redirect=/cart');
    }

    const userId = req.session.userId;
    
    // Get cart items with product details
    const [cartItems] = await pool.query(`
      SELECT ci.*, p.name, p.price, p.image_url, p.merchant_id, p.stock,
             u.username as merchant_name, u.business_name
      FROM cart_items ci
      JOIN products p ON ci.product_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE ci.user_id = ?
    `, [userId]);
    
    // Calculate totals
    let subtotal = 0;
    let totalItems = 0;
    
    cartItems.forEach(item => {
      item.total = item.quantity * item.price;
      subtotal += item.total;
      totalItems += item.quantity;
    });
    
    // Get user data
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    res.render('user/cart', {
      user: users[0],
      cartItems: cartItems,
      subtotal: subtotal,
      totalItems: totalItems,
      success: req.query.success,
      error: req.query.error,
      page: 'cart'
    });
  } catch (err) {
    console.error('Cart page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// API to add product to cart
app.post('/api/cart/add', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { productId, quantity } = req.body;
    
    // Validate product exists
    const [products] = await pool.query('SELECT * FROM products WHERE id = ? AND is_active = true', [productId]);
    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or unavailable'
      });
    }
    
    // Check if product is already in cart
    const [existingItems] = await pool.query(
      'SELECT * FROM cart_items WHERE user_id = ? AND product_id = ?',
      [userId, productId]
    );
    
    if (existingItems.length > 0) {
      // Update quantity
      await pool.query(
        'UPDATE cart_items SET quantity = quantity + ? WHERE user_id = ? AND product_id = ?',
        [parseInt(quantity) || 1, userId, productId]
      );
    } else {
      // Add new item to cart
      await pool.query(
        'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)',
        [userId, productId, parseInt(quantity) || 1]
      );
    }
    
    res.json({
      success: true,
      message: 'Product added to cart'
    });
  } catch (err) {
    console.error('Add to cart error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }

});
// User orders page
// app.get('/user/orders', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
    
//     // Get user's orders with summary information
//     const [orders] = await pool.query(`
//       SELECT o.*, 
//              COUNT(oi.id) as item_count
//       FROM orders o
//       LEFT JOIN order_items oi ON o.id = oi.order_id
//       WHERE o.user_id = ?
//       GROUP BY o.id
//       ORDER BY o.created_at DESC
//     `, [userId]);
    
//     res.render('user/orders', {
//       user: {
//         id: req.session.userId,
//         username: req.session.username,
//         role: req.session.role
//       },
//       orders: orders
//     });
//   } catch (err) {
//     console.error('User orders error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

// Order details
// app.get('/user/orders/:id', isAuthenticated, async (req, res) => {
//   try {
//     const orderId = req.params.id;
//     const userId = req.session.userId;
    
//     // Get order details
//     const [orders] = await pool.query(`
//       SELECT * FROM orders
//       WHERE id = ? AND user_id = ?
//     `, [orderId, userId]);
    
//     if (orders.length === 0) {
//       return res.status(404).render('error', { message: 'Order not found.' });
//     }
    
//     // Get order items
//     const [orderItems] = await pool.query(`
//       SELECT oi.*, p.name, p.image_url
//       FROM order_items oi
//       JOIN products p ON oi.product_id = p.id
//       WHERE oi.order_id = ?
//     `, [orderId]);
    
//     res.render('user/order-details', {
//       user: {
//         id: req.session.userId,
//         username: req.session.username,
//         role: req.session.role
//       },
//       order: orders[0],
//       items: orderItems
//     });
//   } catch (err) {
//     console.error('Order details error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });
// Order details
// app.get('/user/orders/:id', isAuthenticated, async (req, res) => {
//   try {
//     const orderId = req.params.id;
//     const userId = req.session.userId;
    
//     // Get order details
//     const [orders] = await pool.query(`
//       SELECT * FROM orders
//       WHERE id = ? AND user_id = ?
//     `, [orderId, userId]);
    
//     if (orders.length === 0) {
//       return res.status(404).render('error', { message: 'Order not found.' });
//     }
    
//     // Get order items
//     const [orderItems] = await pool.query(`
//       SELECT oi.*, p.name, p.image_url, u.username as merchant_name
//       FROM order_items oi
//       JOIN products p ON oi.product_id = p.id
//       JOIN users u ON p.merchant_id = u.id
//       WHERE oi.order_id = ?
//     `, [orderId]);
    
//     // Get payment information from config
//     const bankName = await getConfig('manual_payment_bank_name');
//     const accountName = await getConfig('manual_payment_account_name');
//     const accountNumber = await getConfig('manual_payment_account_number');
//     const swiftCode = await getConfig('manual_payment_swift_code');
    
//     const paymentInfo = {
//       bankName: bankName || 'Bank of Africa',
//       accountName: accountName || 'BenixSpace Ltd',
//       accountNumber: accountNumber || '00012345678',
//       swiftCode: swiftCode || null
//     };
    
//     res.render('user/order-details', {
//       user: {
//         id: req.session.userId,
//         username: req.session.username,
//         role: req.session.role
//       },
//       order: orders[0],
//       items: orderItems,
//       paymentInfo: paymentInfo
//     });
//   } catch (err) {
//     console.error('Order details error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });
// // API to update cart item quantity
// app.post('/api/cart/update', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const { cartItemId, quantity } = req.body;
    
//     if (parseInt(quantity) <= 0) {
//       // Remove item if quantity is 0 or negative
//       await pool.query(
//         'DELETE FROM cart_items WHERE id = ? AND user_id = ?',
//         [cartItemId, userId]
//       );
//     } else {
//       // Update quantity
//       await pool.query(
//         'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?',
//         [parseInt(quantity), cartItemId, userId]
//       );
//     }
    
//     res.json({
//       success: true,
//       message: 'Cart updated successfully'
//     });
//   } catch (err) {
//     console.error('Update cart error:', err);
//     res.status(500).json({
//       success: false,
//       message: 'Server error. Please try again later.'
//     });
//   }
// });

// // API to remove item from cart
// app.post('/api/cart/remove', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const { cartItemId } = req.body;
    
//     await pool.query(
//       'DELETE FROM cart_items WHERE id = ? AND user_id = ?',
//       [cartItemId, userId]
//     );
    
//     res.json({
//       success: true,
//       message: 'Item removed from cart'
//     });
//   } catch (err) {
//     console.error('Remove from cart error:', err);
//     res.status(500).json({
//       success: false,
//       message: 'Server error. Please try again later.'
//     });
//   }
// });

// API to update cart item quantity
app.post('/api/cart/update', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { productId, quantity } = req.body;
    
    // Find the cart item
    const [cartItems] = await pool.query(
      'SELECT id FROM cart_items WHERE user_id = ? AND product_id = ?',
      [userId, productId]
    );
    
    if (cartItems.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cart item not found'
      });
    }
    
    if (parseInt(quantity) <= 0) {
      // Remove item if quantity is 0 or negative
      await pool.query(
        'DELETE FROM cart_items WHERE user_id = ? AND product_id = ?',
        [userId, productId]
      );
    } else {
      // Update quantity
      await pool.query(
        'UPDATE cart_items SET quantity = ? WHERE user_id = ? AND product_id = ?',
        [parseInt(quantity), userId, productId]
      );
    }
    
    res.json({
      success: true,
      message: 'Cart updated successfully'
    });
  } catch (err) {
    console.error('Update cart error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});


// API route to create an order
app.post('/api/orders/create', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { shippingAddress, phoneNumber, refCode } = req.body;
    
    // Validate input
    if (!shippingAddress || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Shipping address and phone number are required'
      });
    }
    
    // Get cart items
    const [cartItems] = await pool.query(`
      SELECT ci.*, p.name, p.price, p.merchant_id, p.commission_rate
      FROM cart_items ci
      JOIN products p ON ci.product_id = p.id
      WHERE ci.user_id = ?
    `, [userId]);
    
    if (cartItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Your cart is empty'
      });
    }
    
    // Calculate total amount
    let totalAmount = 0;
    cartItems.forEach(item => {
      totalAmount += item.price * item.quantity;
    });
    
    // Create new order with optional ref_code
    const [orderResult] = await pool.query(`
      INSERT INTO orders (user_id, total_amount, status, shipping_address, phone_number, ref_code)
      VALUES (?, ?, 'pending', ?, ?, ?)
    `, [userId, totalAmount, shippingAddress, phoneNumber, refCode || null]);
    
    const orderId = orderResult.insertId;
    
    // Add all items to order_items
    for (const item of cartItems) {
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, quantity, price, commission_earned)
        VALUES (?, ?, ?, ?, ?)
      `, [
        orderId, 
        item.product_id, 
        item.quantity, 
        item.price,
        0
      ]);
    }
    
    // Clear the cart
    await pool.query('DELETE FROM cart_items WHERE user_id = ?', [userId]);
    
    // Send order notification
    if (notificationService) {
      // Collect product names for notification
      const productNames = cartItems.map(item => item.name).join(', ');
      
      await notificationService.notifyOrderPlaced(userId, {
        orderId: orderId,
        totalAmount: totalAmount + ' RWF',
        items: productNames
      });
    }
    
    res.json({
      success: true,
      message: 'Order created successfully',
      orderId: orderId
    });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// API to get cart count
app.get('/api/cart/count', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const [result] = await pool.query(
      'SELECT COUNT(*) as count FROM cart_items WHERE user_id = ?',
      [userId]
    );
    
    res.json({
      success: true,
      count: result[0].count
    });
  } catch (err) {
    console.error('Get cart count error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// API to remove item from cart
app.post('/api/cart/remove', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { productId } = req.body;
    
    // Remove item from cart
    await pool.query(
      'DELETE FROM cart_items WHERE user_id = ? AND product_id = ?',
      [userId, productId]
    );
    
    res.json({
      success: true,
      message: 'Item removed from cart'
    });
  } catch (err) {
    console.error('Remove from cart error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});


//   try {
//     const userId = req.session.userId;
//     const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//     const user = users[0];

//     // Initialize default stats
//     const stats = {
//       totalLinks: 0,
//       totalClicks: 0,
//       totalEarnings: parseFloat(user.earnings || 0)
//     };

//     if (user.role === 'merchant') {
//       const [linkCount] = await pool.query('SELECT COUNT(*) as count FROM links WHERE merchant_id = ?', [userId]);
//       const [clickCount] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         JOIN links l ON sl.link_id = l.id
//         WHERE l.merchant_id = ?
//       `, [userId]);

//       stats.totalLinks = linkCount[0].count;
//       stats.totalClicks = clickCount[0].count;
//     } else {
//       const [linkCount] = await pool.query('SELECT COUNT(*) as count FROM shared_links WHERE user_id = ?', [userId]);
//       const [clickCount] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         WHERE sl.user_id = ?
//       `, [userId]);

//       stats.totalLinks = linkCount[0].count;
//       stats.totalClicks = clickCount[0].count;
//     }

//     return res.render('user/profile', { 
//       user, 
//       stats,
//       success: req.query.success,
//       error: req.query.error 
//     });
//   } catch (err) {
//     console.error('Profile page error:', err);
//     return res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

// Add merchant orders route
app.get('/merchant/orders', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const merchantId = req.session.userId;
    
    // Get orders that include products from this merchant
    const [orders] = await pool.query(`
      SELECT DISTINCT o.*, u.username as customer_name,
             COUNT(oi.id) as item_count,
             SUM(CASE WHEN p.merchant_id = ? THEN oi.quantity ELSE 0 END) as merchant_items,
             SUM(CASE WHEN p.merchant_id = ? THEN (oi.price * oi.quantity) ELSE 0 END) as merchant_total
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      JOIN users u ON o.user_id = u.id
      WHERE p.merchant_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [merchantId, merchantId, merchantId]);
    
    res.render('merchant/orders', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      orders: orders,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant orders error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Add merchant order details route
app.get('/merchant/orders/:id', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const orderId = req.params.id;
    const merchantId = req.session.userId;
    
    // Get order details
    const [orders] = await pool.query(`
      SELECT o.*, u.username as customer_name, u.email as customer_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `, [orderId]);
    
    if (orders.length === 0) {
      return res.status(404).render('error', { message: 'Order not found.' });
    }
    
    // Get order items for this merchant only
    const [orderItems] = await pool.query(`
      SELECT oi.*, p.name, p.image_url, p.merchant_id
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ? AND p.merchant_id = ?
    `, [orderId, merchantId]);
    
    // If no items found for this merchant, they shouldn't access this order
    if (orderItems.length === 0) {
      return res.status(403).render('error', { message: 'You do not have permission to view this order.' });
    }
    
    // Calculate merchant's total for this order
    let merchantTotal = 0;
    orderItems.forEach(item => {
      merchantTotal += item.price * item.quantity;
    });
    
    res.render('merchant/order-details', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      order: orders[0],
      items: orderItems,
      merchantTotal: merchantTotal,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant order details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Add route to update order item status (for merchant's items only)
app.post('/merchant/orders/:id/update-status', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const orderId = req.params.id;
    const merchantId = req.session.userId;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['processing', 'shipped', 'delivered'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }
    
    // Verify merchant has items in this order
    const [orderItems] = await pool.query(`
      SELECT oi.id
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ? AND p.merchant_id = ?
    `, [orderId, merchantId]);
    
    if (orderItems.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this order'
      });
    }
    
    // Update order status
    await pool.query(`
      UPDATE orders
      SET status = ?
      WHERE id = ?
    `, [status, orderId]);
    
    // If order is marked as delivered, process commissions for shared products and admin
    if (status === 'delivered') {
      await processAdminCommissions(orderId);
      await processProductCommissions(orderId);
    }
    
    return res.json({
      success: true,
      message: `Order status updated to ${status}`
    });
  } catch (err) {
    console.error('Update order status error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});
// Merchant product management routes
app.get('/merchant-user/products', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const merchantId = req.session.userId;
    
    // Get all products for this merchant
    const [products] = await pool.query(`
      SELECT p.*, 
             COUNT(DISTINCT oi.id) as order_count,
             COALESCE(SUM(oi.quantity), 0) as total_sold
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      WHERE p.merchant_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `, [merchantId]);
    
    console.log('Merchant products found:', products.length);
    
    res.render('merchant/products', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      products: products,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant products error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Form to create a new product
// Form to create a new product
// Create a new product - Updated to use image URL instead of file upload
app.post('/merchant-user/products/create', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const merchantId = req.session.userId;
    const {
      name,
      description,
      price,
      stock,
      category,
      commission_rate,
      image_url // This now comes directly from the form
    } = req.body;
    
    // Validate required fields
    if (!name || !price || !stock) {
      return res.redirect('/merchant-user/products/create?error=Name, price, and stock are required fields');
    }
    
    // Insert the new product with image URL directly
    await pool.query(`
      INSERT INTO products (
        merchant_id,
        name, 
        description, 
        price, 
        stock,
        image_url, 
        category,
        commission_rate,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, true)
    `, [
      merchantId,
      name,
      description || null,
      parseFloat(price),
      parseInt(stock),
      image_url || null, // Use the URL directly from the form
      category || null,
      parseFloat(commission_rate) || 5.00  // Default to 5% if not specified
    ]);
    
    res.redirect('/merchant-user/products?success=Product created successfully');
  } catch (err) {
    console.error('Product creation error:', err);
    res.redirect('/merchant-user/products/create?error=Failed to create product. Please try again.');
  }
});

// Update a product - Also modified to use image URL
app.post('/merchant-user/products/:id/edit', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const productId = req.params.id;
    const merchantId = req.session.userId;
    const {
      name,
      description,
      price,
      stock,
      category,
      commission_rate,
      is_active,
      image_url // Changed from file upload to direct URL
    } = req.body;
    
    // Verify product belongs to this merchant
    const [products] = await pool.query(`
      SELECT *
      FROM products
      WHERE id = ? AND merchant_id = ?
    `, [productId, merchantId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', { message: 'Product not found or you don\'t have permission to edit it.' });
    }
    
    // Update the product with the direct image URL
    await pool.query(`
      UPDATE products
      SET name = ?,
          description = ?,
          price = ?,
          stock = ?,
          image_url = ?,
          category = ?,
          commission_rate = ?,
          is_active = ?
      WHERE id = ? AND merchant_id = ?
    `, [
      name,
      description || null,
      parseFloat(price),
      parseInt(stock),
      image_url, // Use the provided URL directly
      category || null,
      parseFloat(commission_rate) || 5.00,
      is_active ? 1 : 0,
      productId,
      merchantId
    ]);
    
    res.redirect(`/merchant-user/products?success=Product updated successfully`);
  } catch (err) {
    console.error('Product update error:', err);
    res.redirect(`/merchant-user/products/${req.params.id}/edit?error=Failed to update product. Please try again.`);
  }
});
app.get('/merchant-user/products/create', isAuthenticated, isMerchant, async (req, res) => {
  try {
    // Get default commission rate from config
    const commissionRate = await getConfig('commission_rate');
    
    res.render('merchant/product-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      product: null, // null means new product
      defaultCommissionRate: parseFloat(commissionRate), // Change variable name to match template
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Product form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Create a new product


// Edit a product

app.get('/merchant-user/products/:id/edit', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const productId = req.params.id;
    const merchantId = req.session.userId;
    
    // Get product details, ensuring it belongs to this merchant
    const [products] = await pool.query(`
      SELECT * FROM products
      WHERE id = ? AND merchant_id = ?
    `, [productId, merchantId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', { message: 'Product not found or you don\'t have permission to edit it.' });
    }
    
    // Get default commission rate from config
    const commissionRate = await getConfig('commission_rate');
    
    res.render('merchant/product-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      product: products[0],
      defaultCommissionRate: parseFloat(commissionRate), // Change variable name here too
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Edit product form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});


// View product details
app.get('/merchant-user/products/:id', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const productId = req.params.id;
    const merchantId = req.session.userId;
    
    // Get product details, ensuring it belongs to this merchant
    const [products] = await pool.query(`
      SELECT *
      FROM products
      WHERE id = ? AND merchant_id = ?
    `, [productId, merchantId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', { message: 'Product not found or you don\'t have permission to view it.' });
    }
    
    const product = products[0];
    
    // Get analytics data for this product
    const [analytics] = await pool.query(`
      SELECT 
        COUNT(DISTINCT oi.id) as total_orders,
        SUM(oi.quantity) as total_sold,
        SUM(oi.price * oi.quantity) as total_revenue
      FROM order_items oi
      WHERE oi.product_id = ?
    `, [productId]);
    
    // If no analytics records were found, initialize with zeros
    const analyticsData = analytics.length > 0 ? analytics[0] : { 
      total_orders: 0, 
      total_sold: 0, 
      total_revenue: 0 
    };
    
    // Get recent orders for this product
    const [orders] = await pool.query(`
      SELECT 
        o.id as order_id,
        o.created_at,
        o.status,
        oi.quantity,
        oi.price,
        u.username as customer_name
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN users u ON o.user_id = u.id
      WHERE oi.product_id = ?
      ORDER BY o.created_at DESC
      LIMIT 10
    `, [productId]);
    
    res.render('merchant/product-details', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      product: product,
      analytics: analyticsData,
      orders: orders,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant product details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Delete a product
app.delete('/merchant-user/products/:id/delete', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const productId = req.params.id;
    const merchantId = req.session.userId;
    
    // Verify product belongs to this merchant
    const [products] = await pool.query(`
      SELECT *
      FROM products
      WHERE id = ? AND merchant_id = ?
    `, [productId, merchantId]);
    
    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or you don\'t have permission to delete it'
      });
    }
    
    // Check if the product has any orders
    const [orderItems] = await pool.query(`
      SELECT COUNT(*) as count
      FROM order_items
      WHERE product_id = ?
    `, [productId]);
    
    if (orderItems[0].count > 0) {
      // If product has orders, just mark it as inactive instead of deleting
      await pool.query(`
        UPDATE products
        SET is_active = false
        WHERE id = ? AND merchant_id = ?
      `, [productId, merchantId]);
      
      return res.json({
        success: true,
        message: 'Product has been deactivated because it has associated orders'
      });
    }
    
    // Delete the product if it has no orders
    await pool.query(`
      DELETE FROM products
      WHERE id = ? AND merchant_id = ?
    `, [productId, merchantId]);
    
    // Delete product image if it exists
    if (products[0].image_url) {
      const imagePath = path.join(__dirname, 'public', products[0].image_url);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Song upload routes
app.get('/merchant/upload-song', isAuthenticated, isMerchant, async (req, res) => {
  try {
    res.render('merchant/song-upload', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Song upload page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Configure multer for song uploads
const songUpload = multer({
  dest: path.join(__dirname, 'public', 'uploads'),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for audio files
  },
  fileFilter: function (req, file, cb) {
    if (file.fieldname === 'audio_file') {
      const allowedAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/flac', 'audio/x-wav'];
      if (!allowedAudioTypes.includes(file.mimetype)) {
        return cb(new Error('Only MP3, WAV, M4A, and FLAC audio files are allowed'));
      }
    }
    cb(null, true);
  }
});

app.post('/merchant/upload-song', isAuthenticated, isMerchant, songUpload.single('audio_file'), async (req, res) => {
  try {
    const { title, description, price, style, genre, lyrics } = req.body;
    const merchantId = req.session.userId;
    
    // Validate required fields
    if (!title || !price || !style || !genre || !req.file) {
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path); // Clean up uploaded file
      }
      return res.redirect('/merchant/upload-song?error=Title, price, style, genre, and audio file are required');
    }
    
    // Validate price
    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0.99) {
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.redirect('/merchant/upload-song?error=Price must be at least $0.99');
    }
    
    // Generate unique filename for audio
    const audioExt = path.extname(req.file.originalname);
    const audioFilename = `song_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${audioExt}`;
    const audioPath = path.join(__dirname, 'public', 'uploads', audioFilename);
    
    // Move uploaded file to final location
    fs.renameSync(req.file.path, audioPath);
    
    // Get audio duration (simplified - in production you'd use a library like node-ffmpeg)
    const audioUrl = `/uploads/${audioFilename}`;
    
    // Generate a random preview start time (will be set properly later with audio processing)
    const previewStart = Math.floor(Math.random() * 60); // Random start within first 60 seconds
    
    // Generate cover image using Canvas (simplified version)
    const coverFilename = `cover_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    const coverUrl = `/uploads/${coverFilename}`;
    
    // Insert song into products table
    const [result] = await pool.query(`
      INSERT INTO products (
        name, product_type, description, price, stock, 
        merchant_id, audio_file, lyrics, genre, style, 
        preview_start, cover_image, is_active
      ) VALUES (?, 'song', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, true)
    `, [
      title, description, numericPrice, merchantId, 
      audioUrl, lyrics || '', genre, style, previewStart, coverUrl
    ]);
    
    // Generate cover image server-side using a simple approach
    // In production, you could use libraries like node-canvas
    generateSongCover(title, genre, style, path.join(__dirname, 'public', 'uploads', coverFilename));
    
    res.redirect('/merchant-user/products?success=Song uploaded successfully!');
  } catch (err) {
    console.error('Song upload error:', err);
    // Clean up uploaded file on error
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.redirect('/merchant/upload-song?error=Failed to upload song. Please try again.');
  }
});

// Simple cover generation function (placeholder)
function generateSongCover(title, genre, style, outputPath) {
  try {
    // For now, create a simple text file as placeholder
    // In production, you'd use canvas or image processing library
    const coverData = {
      title: title,
      genre: genre,
      style: style,
      timestamp: new Date().toISOString()
    };
    
    // Create a simple placeholder image info file
    fs.writeFileSync(outputPath + '.json', JSON.stringify(coverData, null, 2));
    
    // You could use libraries like 'canvas' or 'sharp' to generate actual images
    console.log(`Cover generated for song: ${title}`);
  } catch (err) {
    console.error('Error generating cover:', err);
  }
}

// Song purchase route
app.post('/purchase-song/:id', isAuthenticated, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.session.userId;
    const refCode = req.query.ref; // Get referral code from URL
    
    // Check if song exists and is not sold
    const [song] = await pool.query(
      'SELECT * FROM products WHERE id = ? AND product_type = "song" AND is_sold = false AND is_active = true',
      [songId]
    );
    
    if (song.length === 0) {
      return res.status(404).json({ error: 'Song not found or already sold' });
    }
    
    const songData = song[0];
    
    // Check if user is trying to buy their own song
    if (songData.merchant_id === userId) {
      return res.status(400).json({ error: 'You cannot purchase your own song' });
    }
    
    // Check user balance (assuming you have a balance system)
    const [userBalance] = await pool.query('SELECT balance FROM users WHERE id = ?', [userId]);
    
    if (userBalance.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (userBalance[0].balance < songData.price) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Get commission settings
    const songAdminCommissionRate = parseFloat(await getConfig('song_admin_commission_rate') || '40');
    const songUserCommissionPercentage = parseFloat(await getConfig('song_user_commission_percentage') || '40');
    
    // Calculate commissions
    const adminCommission = songData.price * (songAdminCommissionRate / 100);
    const sellerEarnings = songData.price - adminCommission;
    
    let userCommission = 0;
    let referrerUserId = null;
    
    // Check if there's a referral code and find the referrer
    if (refCode) {
      const [sharedSong] = await pool.query(
        'SELECT * FROM shared_songs WHERE share_code = ? AND song_id = ?',
        [refCode, songId]
      );
      
      if (sharedSong.length > 0) {
        referrerUserId = sharedSong[0].user_id;
        // User gets a percentage of admin commission
        userCommission = adminCommission * (songUserCommissionPercentage / 100);
        
        // Update shared song stats
        await pool.query(
          'UPDATE shared_songs SET purchases = purchases + 1, earnings = earnings + ? WHERE id = ?',
          [userCommission, sharedSong[0].id]
        );
      }
    }
    
    // Final admin earnings after user commission
    const finalAdminEarnings = adminCommission - userCommission;
    
    // Process the purchase transaction
    await pool.query('START TRANSACTION');
    
    try {
      // Deduct from buyer's balance
      await pool.query(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [songData.price, userId]
      );
      
      // Add to seller's balance
      await pool.query(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [sellerEarnings, songData.merchant_id]
      );
      
      // Add commission to referrer if applicable
      if (referrerUserId && userCommission > 0) {
        await pool.query(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [userCommission, referrerUserId]
        );
      }
      
      // Mark song as sold
      await pool.query(
        'UPDATE products SET is_sold = true, sold_at = NOW(), buyer_id = ? WHERE id = ?',
        [userId, songId]
      );
      
      // Create transaction record for buyer
      await pool.query(`
        INSERT INTO transactions (user_id, product_id, amount, type, status, created_at)
        VALUES (?, ?, ?, 'song_purchase', 'completed', NOW())
      `, [userId, songId, songData.price]);
      
      // Create transaction record for seller
      await pool.query(`
        INSERT INTO transactions (user_id, product_id, amount, type, status, details, created_at)
        VALUES (?, ?, ?, 'song_sale', 'completed', 'Song sale earnings', NOW())
      `, [songData.merchant_id, songId, sellerEarnings]);
      
      // Create commission record for referrer if applicable
      if (referrerUserId && userCommission > 0) {
        await pool.query(`
          INSERT INTO transactions (user_id, product_id, amount, type, status, details, created_at)
          VALUES (?, ?, ?, 'commission', 'completed', 'Song sharing commission', NOW())
        `, [referrerUserId, songId, userCommission]);
      }
      
      // Create admin commission record
      await pool.query(`
        INSERT INTO transactions (user_id, product_id, amount, type, status, details, created_at)
        VALUES (1, ?, ?, 'admin_commission', 'completed', 'Song sale admin commission', NOW())
      `, [songId, finalAdminEarnings]);
      
      await pool.query('COMMIT');
      
      res.json({ 
        success: true, 
        message: 'Song purchased successfully!',
        download_url: songData.audio_file,
        commission_paid: userCommission > 0 ? userCommission : null
      });
      
    } catch (transactionError) {
      await pool.query('ROLLBACK');
      throw transactionError;
    }
    
  } catch (err) {
    console.error('Song purchase error:', err);
    res.status(500).json({ error: 'Failed to purchase song. Please try again.' });
  }
});

// Song preview route (for 35-second previews)
app.get('/song-preview/:id', async (req, res) => {
  try {
    const songId = req.params.id;
    
    const [song] = await pool.query(
      'SELECT audio_file, preview_start, duration FROM products WHERE id = ? AND product_type = "song" AND is_active = true',
      [songId]
    );
    
    if (song.length === 0) {
      return res.status(404).json({ error: 'Song not found' });
    }
    
    const songData = song[0];
    
    res.json({
      audio_url: songData.audio_file,
      preview_start: songData.preview_start || 0,
      preview_duration: 35 // 35-second preview
    });
    
  } catch (err) {
    console.error('Song preview error:', err);
    res.status(500).json({ error: 'Failed to load song preview' });
  }
});

// Share song route
app.post('/share-song/:id', isAuthenticated, async (req, res) => {
  try {
    const songId = req.params.id;
    const userId = req.session.userId;
    
    // Check if song exists and is not sold
    const [song] = await pool.query(
      'SELECT * FROM products WHERE id = ? AND product_type = "song" AND is_sold = false AND is_active = true',
      [songId]
    );
    
    if (song.length === 0) {
      return res.status(404).json({ error: 'Song not found or already sold' });
    }
    
    // Check if user already has a share for this song
    const [existingShare] = await pool.query(
      'SELECT * FROM shared_songs WHERE song_id = ? AND user_id = ?',
      [songId, userId]
    );
    
    if (existingShare.length > 0) {
      return res.json({
        success: true,
        share_code: existingShare[0].share_code,
        share_url: `${req.protocol}://${req.get('host')}/song/${songId}?ref=${existingShare[0].share_code}`
      });
    }
    
    // Generate unique share code
    let shareCode;
    let isUnique = false;
    while (!isUnique) {
      shareCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const [existing] = await pool.query('SELECT id FROM shared_songs WHERE share_code = ?', [shareCode]);
      isUnique = existing.length === 0;
    }
    
    // Create shared song record
    await pool.query(
      'INSERT INTO shared_songs (song_id, user_id, share_code) VALUES (?, ?, ?)',
      [songId, userId, shareCode]
    );
    
    res.json({
      success: true,
      share_code: shareCode,
      share_url: `${req.protocol}://${req.get('host')}/song/${songId}?ref=${shareCode}`
    });
    
  } catch (err) {
    console.error('Share song error:', err);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Song detail page with referral tracking
app.get('/song/:id', async (req, res) => {
  try {
    const songId = req.params.id;
    const refCode = req.query.ref;
    
    // Get song details
    const [song] = await pool.query(`
      SELECT p.*, u.username as artist_name, u.business_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.id = ? AND p.product_type = 'song' AND p.is_sold = false AND p.is_active = true
    `, [songId]);
    
    if (song.length === 0) {
      return res.status(404).render('error', { message: 'Song not found or no longer available' });
    }
    
    const songData = song[0];
    
    // Track click if there's a referral code
    if (refCode) {
      const [sharedSong] = await pool.query(
        'SELECT * FROM shared_songs WHERE share_code = ? AND song_id = ?',
        [refCode, songId]
      );
      
      if (sharedSong.length > 0) {
        // Update click count
        await pool.query(
          'UPDATE shared_songs SET clicks = clicks + 1 WHERE id = ?',
          [sharedSong[0].id]
        );
        
        // Log the click
        await pool.query(
          'INSERT INTO song_clicks (shared_song_id, ip_address, device_info, referrer) VALUES (?, ?, ?, ?)',
          [
            sharedSong[0].id,
            req.ip,
            req.get('User-Agent'),
            req.get('Referer') || null
          ]
        );
      }
    }
    
    res.render('song-detail', {
      song: songData,
      ref_code: refCode,
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null
    });
    
  } catch (err) {
    console.error('Song detail page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Get user's shared songs
app.get('/my-shared-songs', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const [sharedSongs] = await pool.query(`
      SELECT ss.*, p.name as song_name, p.price, p.cover_image, u.username as artist_name
      FROM shared_songs ss
      JOIN products p ON ss.song_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE ss.user_id = ? AND p.is_sold = false
      ORDER BY ss.created_at DESC
    `, [userId]);
    
    res.render('user/shared-songs', {
      sharedSongs: sharedSongs,
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      baseUrl: `${req.protocol}://${req.get('host')}`
    });
    
  } catch (err) {
    console.error('My shared songs error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Get available songs (not sold)
app.get('/api/songs', async (req, res) => {
  try {
    const { genre, style, search, limit = 20, offset = 0 } = req.query;
    
    let query = `
      SELECT p.*, u.username as artist_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.product_type = 'song' 
        AND p.is_sold = false 
        AND p.is_active = true
    `;
    const params = [];
    
    if (genre && genre !== 'all') {
      query += ' AND p.genre = ?';
      params.push(genre);
    }
    
    if (style && style !== 'all') {
      query += ' AND p.style = ?';
      params.push(style);
    }
    
    if (search) {
      query += ' AND (p.name LIKE ? OR p.description LIKE ? OR u.username LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const [songs] = await pool.query(query, params);
    
    res.json(songs);
    
  } catch (err) {
    console.error('Get songs error:', err);
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
});

// Songs marketplace page
app.get('/songs', async (req, res) => {
  try {
    res.render('songs', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null
    });
  } catch (err) {
    console.error('Songs page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Profile page route


// Route for sharing links
app.get('/links/:id/share', isAuthenticated, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Check if link exists
    const [links] = await pool.query('SELECT * FROM links WHERE id = ?', [linkId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found.' });
    }
    
    const link = links[0];
    
    // Check if user has already shared this link
    const [existingShares] = await pool.query(
      'SELECT * FROM shared_links WHERE link_id = ? AND user_id = ?',
      [linkId, userId]
    );
    
    let shareCode;
    
    if (existingShares.length > 0) {
      // User already has a share code for this link
      shareCode = existingShares[0].share_code;
    } else {
      // Generate a new share code
      shareCode = uuidv4().substring(0, 8);
      
      // Create a new shared link record
      await pool.query(
        'INSERT INTO shared_links (link_id, user_id, share_code) VALUES (?, ?, ?)',
        [linkId, userId, shareCode]
      );
    }
    
    // Get active banners for this link
    let banners = [];
    try {
      const [allBanners] = await pool.query(`
        SELECT b.* FROM banners b
        WHERE b.status = 'approved' AND b.is_active = TRUE 
        ORDER BY b.display_order DESC, b.created_at DESC
      `);

      // Filter banners based on target type
      for (const banner of allBanners) {
        if (banner.target_type === 'all') {
          banners.push(banner);
        } else if (banner.target_type === 'specific') {
          // Check if this specific link is targeted
          const [specificLink] = await pool.query(`
            SELECT 1 FROM banner_target_links btl 
            WHERE btl.banner_id = ? AND btl.link_id = ?
          `, [banner.id, linkId]);
          
          if (specificLink.length > 0) {
            banners.push(banner);
          }
        } else if (banner.target_type === 'popular') {
          // Check if this link meets the popularity threshold
          if (link.clicks_count >= banner.min_clicks) {
            banners.push(banner);
          }
        }
      }
    } catch (bannerErr) {
      console.error('Error fetching banners:', bannerErr);
      // Continue without banners if there's an error
    }

    res.render('user/share', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: link,
      shareCode: shareCode,
      shareUrl: `${req.protocol}://${req.get('host')}/l/${shareCode}`,
      banners: banners
    });
  } catch (err) {
    console.error('Link sharing error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Route for sharing products
app.get('/products/:id/share', isAuthenticated, async (req, res) => {
  try {
    const productId = req.params.id;
    const userId = req.session.userId;
    
    // Check if product exists and is active
    const [products] = await pool.query('SELECT p.*, u.username as merchant_name FROM products p JOIN users u ON p.merchant_id = u.id WHERE p.id = ? AND p.is_active = 1', [productId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', { message: 'Product not found or inactive.' });
    }
    
    const product = products[0];
    
    // Check if user has already shared this product
    const [existingShares] = await pool.query(
      'SELECT * FROM shared_products WHERE product_id = ? AND user_id = ?',
      [productId, userId]
    );
    
    let shareCode;
    
    if (existingShares.length > 0) {
      // User already has a share code for this product
      shareCode = existingShares[0].share_code;
    } else {
      // Generate a new share code
      const { v4: uuidv4 } = require('uuid');
      shareCode = uuidv4().substring(0, 8);
      
      // Create a new shared product record
      await pool.query(
        'INSERT INTO shared_products (product_id, user_id, share_code, created_at) VALUES (?, ?, ?, NOW())',
        [productId, userId, shareCode]
      );
    }
    
    // Get commission rates with fallbacks
    const adminCommissionRate = await getConfig('admin_commission_rate') || 10;
    const userCommissionPercentage = await getConfig('user_commission_percentage') || 30;
    
    console.log('Share product rendering with:', {
      adminCommissionRate,
      userCommissionPercentage,
      productId,
      userId
    });
    
    res.render('user/share-product', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      product: product,
      shareCode: shareCode,
      shareUrl: `${req.protocol}://${req.get('host')}/p/${shareCode}`,
      adminCommissionRate: adminCommissionRate,
      userCommissionPercentage: userCommissionPercentage
    });
  } catch (err) {
    console.error('Product sharing error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Route for handling shared product links with shortcodes
app.get('/p/:code', async (req, res) => {
  try {
    const shareCode = req.params.code;
    
    // Find the shared product with this code
    const [sharedProducts] = await pool.query(`
      SELECT sp.*, p.id as product_id, p.name, p.description, p.price, p.image_url, p.merchant_id, u.username as merchant_name
      FROM shared_products sp
      JOIN products p ON sp.product_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE sp.share_code = ? AND p.is_active = 1
    `, [shareCode]);
    
    if (sharedProducts.length === 0) {
      return res.status(404).render('error', { message: 'Product link not found or it may have been removed.' });
    }
    
    const sharedProduct = sharedProducts[0];
    
    // Record the click
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers.referer || req.headers.referrer || '';
    
    // Insert click record for products
    await pool.query(`
      INSERT INTO product_clicks (shared_product_id, ip_address, device_info, referrer, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [sharedProduct.id, ip, userAgent, referrer]);
    
    // Update click count in shared_products table
    await pool.query(`
      UPDATE shared_products SET clicks = clicks + 1 WHERE id = ?
    `, [sharedProduct.id]);
    
    // Redirect to the product page with referral tracking
    return res.redirect(`/products/${sharedProduct.product_id}?ref=${shareCode}`);
  } catch (err) {
    console.error('Shared product error:', err);
    return res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// API endpoint to extend session
app.post('/api/extend-session', (req, res) => {
  if (req.session && req.session.userId) {
    // Reset the session maxAge to configured timeout
    const sessionTimeoutHours = parseInt(process.env.SESSION_TIMEOUT_HOURS) || 1;
    const sessionTimeoutMs = sessionTimeoutHours * 60 * 60 * 1000;
    req.session.cookie.maxAge = sessionTimeoutMs;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ success: false, message: 'Failed to extend session' });
      }
      res.json({ success: true, message: 'Session extended successfully' });
    });
  } else {
    res.status(401).json({ success: false, message: 'No active session' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Route to view user's shared products
app.get('/user/shared-products', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get user's shared products with earnings data
    const [sharedProducts] = await pool.query(`
      SELECT sp.*, p.name, p.description, p.price, p.image_url, p.commission_rate,
             u.username as merchant_name, u.business_name
      FROM shared_products sp
      JOIN products p ON sp.product_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE sp.user_id = ? AND p.is_active = 1
      ORDER BY sp.created_at DESC
    `, [userId]);
    
    // Get total stats
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_shared,
        SUM(clicks) as total_clicks,
        SUM(earnings) as total_earnings
      FROM shared_products
      WHERE user_id = ?
    `, [userId]);
    
    const userStats = stats[0] || { total_shared: 0, total_clicks: 0, total_earnings: 0 };
    
    // Construct base URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.render('user/shared-products', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      sharedProducts: sharedProducts,
      stats: userStats,
      baseUrl: baseUrl,
      adminCommissionRate: await getConfig('admin_commission_rate') || 10,
      userCommissionPercentage: await getConfig('user_commission_percentage') || 30,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Shared products page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Dashboard routes
// app.get('/dashboard', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//     const user = users[0];
    
//     let data = {
//       user: user,
//       stats: {}
//     };
    
//     if (user.role === 'admin') {
//       // Admin dashboard data
//       const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
//       const [merchantCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role = ?', ['merchant']);
//       const [linkCount] = await pool.query('SELECT COUNT(*) as count FROM links');
//       const [clickCount] = await pool.query('SELECT COUNT(*) as count FROM clicks');

//       // In the dashboard route, replace the existing gatewayStats query with this:
// const [gatewayStats] = await pool.query(`
//   SELECT 
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayVolume,
    
//     COUNT(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND status = 'completed' 
//       THEN 1 
//     END) as umvapayCount,
    
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND type = 'upgrade' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayUpgrades,
    
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND type = 'withdrawal' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayWithdrawals
//   FROM transactions
//   WHERE details LIKE '%via Umva Pay%'
// `);

//       // Get recent gateway transactions
//       const [recentGatewayTransactions] = await pool.query(`
//         SELECT t.*, u.username 
//         FROM transactions t 
//         JOIN users u ON t.user_id = u.id 
//         WHERE t.details LIKE '%via Umva Pay%'
//         ORDER BY t.created_at DESC 
//         LIMIT 10
//       `);
      
//       data.stats = {
//         userCount: userCount[0].count,
//         merchantCount: merchantCount[0].count,
//         linkCount: linkCount[0].count,
//         clickCount: clickCount[0].count,
//         recentTransactions: recentGatewayTransactions,
//         ...gatewayStats[0],
//         recentGatewayTransactions
//       };
      
//       // Get config settings
//       const [configSettings] = await pool.query('SELECT * FROM config');
//       data.config = configSettings;
//     } 
//     else if (user.role === 'merchant') {
//       // Merchant dashboard data
//       const [links] = await pool.query('SELECT * FROM links WHERE merchant_id = ?', [userId]);
//       const [totalClicks] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         JOIN links l ON sl.link_id = l.id
//         WHERE l.merchant_id = ?
//       `, [userId]);
      
//       data.stats = {
//         linkCount: links.length,
//         totalClicks: totalClicks[0].count,
//         amountToPay: parseFloat(user.amount_to_pay || 0).toFixed(4),
//         paidBalance: parseFloat(user.paid_balance || 0).toFixed(4),
//         links: links
//       };
//     } 
//     else {
//       // Regular user dashboard data
//       const [sharedLinks] = await pool.query(`
//         SELECT sl.*, l.title, l.type, l.url, l.image_url 
//         FROM shared_links sl
//         JOIN links l ON sl.link_id = l.id
//         WHERE sl.user_id = ?
//       `, [userId]);
      
//       const [totalClicks] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         WHERE sl.user_id = ?
//       `, [userId]);
      
//       data.stats = {
//         sharedLinkCount: sharedLinks.length,
//         totalClicks: totalClicks[0].count,
//         totalEarnings: user.earnings,
//         sharedLinks: sharedLinks
//       };
      
//       // Fetch available links to share
//       const [availableLinks] = await pool.query(`
//         SELECT l.*, u.username as merchant_name, u.business_name
//         FROM links l
//         JOIN users u ON l.merchant_id = u.id
//         WHERE l.is_active = true
//         ORDER BY l.created_at DESC
//         LIMIT 20
//       `);
      
//       data.availableLinks = availableLinks;
//     }
    
//     res.render('dashboard', data);
//   } catch (err) {
//     console.error('Dashboard error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

// Wallet route
// app.get('/wallet', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//     const user = users[0];

//     // Get minimum payout amount from config
//     const minPayout = await getConfig('min_payout');
    
//     // Get manual payment instructions
//     const manualInstructions = await getConfig('manual_payment_instructions');

//     // Get user's transactions
//     const [transactions] = await pool.query(`
//       SELECT * FROM transactions 
//       WHERE user_id = ? AND (type = 'commission' OR type = 'withdrawal')
//       ORDER BY created_at DESC
//     `, [userId]);

//     res.render('user/wallet', { 
//       user,
//       transactions,
//       minPayout: parseFloat(minPayout),
//       manualInstructions: manualInstructions || 'Please transfer the amount to our account and upload a screenshot/receipt as proof of payment.'
//     });
//   } catch (err) {
//     console.error('Wallet page error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });


// Route for sharing links
app.get('/links/:id/share', isAuthenticated, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Check if link exists
    const [links] = await pool.query('SELECT * FROM links WHERE id = ?', [linkId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found.' });
    }
    
    const link = links[0];
    
    // Check if user has already shared this link
    const [existingShares] = await pool.query(
      'SELECT * FROM shared_links WHERE link_id = ? AND user_id = ?',
      [linkId, userId]
    );
    
    let shareCode;
    
    if (existingShares.length > 0) {
      // User already has a share code for this link
      shareCode = existingShares[0].share_code;
    } else {
      // Generate a new share code
      shareCode = uuidv4().substring(0, 8);
      
      // Create a new shared link record
      await pool.query(
        'INSERT INTO shared_links (link_id, user_id, share_code) VALUES (?, ?, ?)',
        [linkId, userId, shareCode]
      );
    }
    
    res.render('user/share', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: link,
      shareCode: shareCode,
      shareUrl: `${req.protocol}://${req.get('host')}/l/${shareCode}`
    });
  } catch (err) {
    console.error('Link sharing error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});




// Dashboard routes
// app.get('/dashboard', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//     const user = users[0];
    
//     let data = {
//       user: user,
//       stats: {}
//     };
    
//     if (user.role === 'admin') {
//       // Admin dashboard data
//       const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
//       const [merchantCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role = ?', ['merchant']);
//       const [linkCount] = await pool.query('SELECT COUNT(*) as count FROM links');
//       const [clickCount] = await pool.query('SELECT COUNT(*) as count FROM clicks');

//       // In the dashboard route, replace the existing gatewayStats query with this:
// const [gatewayStats] = await pool.query(`
//   SELECT 
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayVolume,
    
//     COUNT(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND status = 'completed' 
//       THEN 1 
//     END) as umvapayCount,
    
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND type = 'upgrade' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayUpgrades,
    
//     COALESCE(SUM(CASE 
//       WHEN details LIKE '%via Umva Pay%' AND type = 'withdrawal' AND status = 'completed' 
//       THEN amount 
//     END), 0) as umvapayWithdrawals
//   FROM transactions
//   WHERE details LIKE '%via Umva Pay%'
// `);

//       // Get recent gateway transactions
//       const [recentGatewayTransactions] = await pool.query(`
//         SELECT t.*, u.username 
//         FROM transactions t 
//         JOIN users u ON t.user_id = u.id 
//         WHERE t.details LIKE '%via Umva Pay%'
//         ORDER BY t.created_at DESC 
//         LIMIT 10
//       `);
      
//       data.stats = {
//         userCount: userCount[0].count,
//         merchantCount: merchantCount[0].count,
//         linkCount: linkCount[0].count,
//         clickCount: clickCount[0].count,
//         recentTransactions: recentGatewayTransactions,
//         ...gatewayStats[0],
//         recentGatewayTransactions
//       };
      
//       // Get config settings
//       const [configSettings] = await pool.query('SELECT * FROM config');
//       data.config = configSettings;
//     } 
//     else if (user.role === 'merchant') {
//       // Merchant dashboard data
//       const [links] = await pool.query('SELECT * FROM links WHERE merchant_id = ?', [userId]);
//       const [totalClicks] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         JOIN links l ON sl.link_id = l.id
//         WHERE l.merchant_id = ?
//       `, [userId]);
      
//       data.stats = {
//         linkCount: links.length,
//         totalClicks: totalClicks[0].count,
//         amountToPay: parseFloat(user.amount_to_pay || 0).toFixed(4),
//         paidBalance: parseFloat(user.paid_balance || 0).toFixed(4),
//         links: links
//       };
//     } 
//     else {
//       // Regular user dashboard data
//       const [sharedLinks] = await pool.query(`
//         SELECT sl.*, l.title, l.type, l.url, l.image_url 
//         FROM shared_links sl
//         JOIN links l ON sl.link_id = l.id
//         WHERE sl.user_id = ?
//       `, [userId]);
      
//       const [totalClicks] = await pool.query(`
//         SELECT COUNT(*) as count FROM clicks c
//         JOIN shared_links sl ON c.shared_link_id = sl.id
//         WHERE sl.user_id = ?
//       `, [userId]);
      
//       data.stats = {
//         sharedLinkCount: sharedLinks.length,
//         totalClicks: totalClicks[0].count,
//         totalEarnings: user.earnings,
//         sharedLinks: sharedLinks
//       };
      
//       // Fetch available links to share
//       const [availableLinks] = await pool.query(`
//         SELECT l.*, u.username as merchant_name, u.business_name
//         FROM links l
//         JOIN users u ON l.merchant_id = u.id
//         WHERE l.is_active = true
//         ORDER BY l.created_at DESC
//         LIMIT 20
//       `);
      
//       data.availableLinks = availableLinks;
//     }
    
//     res.render('dashboard', data);
//   } catch (err) {
//     console.error('Dashboard error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });

// Wallet route
// app.get('/wallet', isAuthenticated, async (req, res) => {
//   try {
//     const userId = req.session.userId;
//     const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
//     const user = users[0];

//     // Get minimum payout amount from config
//     const minPayout = await getConfig('min_payout');
    
//     // Get manual payment instructions
//     const manualInstructions = await getConfig('manual_payment_instructions');

//     // Get user's transactions
//     const [transactions] = await pool.query(`
//       SELECT * FROM transactions 
//       WHERE user_id = ? AND (type = 'commission' OR type = 'withdrawal')
//       ORDER BY created_at DESC
//     `, [userId]);

//     res.render('user/wallet', { 
//       user,
//       transactions,
//       minPayout: parseFloat(minPayout),
//       manualInstructions: manualInstructions || 'Please transfer the amount to our account and upload a screenshot/receipt as proof of payment.'
//     });
//   } catch (err) {
//     console.error('Wallet page error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });


// Merchant link management routes
app.get('/merchant/links', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get all links for this merchant
    const [links] = await pool.query(`
      SELECT l.*, 
             COUNT(DISTINCT sl.id) as share_count,
             SUM(sl.clicks) as total_clicks
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      WHERE l.merchant_id = ?
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [userId]);
    
    res.render('merchant/links', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      links: links,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant links error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

app.get('/merchant/links/create', isAuthenticated, isMerchant, async (req, res) => {
  try {
    // Get cost per click from config
    const costPerClick = await getConfig('cost_per_click');
    
    res.render('merchant/link-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: null, // null means new link
      costPerClick: parseFloat(costPerClick),
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Link form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

app.post('/merchant/links/create', isAuthenticated, isMerchant, upload.single('image'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const {
      title,
      description,
      type,
      url,
      category,
      click_target,
      cost_per_click
    } = req.body;
    
    // Validate merchant has enough balance
    const [merchants] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const merchant = merchants[0];
    
    // Get the file path if an image was uploaded
    let imageUrl = null;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }
    
    // Calculate total cost
    const totalCost = parseFloat(click_target) * parseFloat(cost_per_click);
    
    // Insert the new link
    await pool.query(`
      INSERT INTO links (
        title, 
        description, 
        merchant_id, 
        type, 
        url, 
        image_url, 
        category, 
        click_target, 
        cost_per_click
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      title,
      description,
      userId,
      type,
      url,
      imageUrl,
      category,
      click_target,
      cost_per_click
    ]);
    
    res.redirect('/merchant/links?success=Link created successfully');
  } catch (err) {
    console.error('Link creation error:', err);
    res.redirect('/merchant/links/create?error=Failed to create link. Please try again.');
  }
});

app.get('/merchant/links/:id/edit', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Get link details, ensuring it belongs to this merchant
    const [links] = await pool.query(`
      SELECT * FROM links
      WHERE id = ? AND merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to edit it.' });
    }
    
    // Get cost per click from config
    const costPerClick = await getConfig('cost_per_click');
    
    res.render('merchant/link-form', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: links[0],
      costPerClick: parseFloat(costPerClick),
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Edit link form error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

app.post('/merchant/links/:id/edit', isAuthenticated, isMerchant, upload.single('image'), async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    const {
      title,
      description,
      type,
      url,
      category,
      click_target,
      cost_per_click,
      is_active
    } = req.body;
    
    // Verify link belongs to this merchant
    const [links] = await pool.query(`
      SELECT l.*
      FROM links l
      WHERE l.id = ? AND l.merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to edit it.' });
    }
    
    // Get the file path if a new image was uploaded
    let imageUrl = links[0].image_url;
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
      
      // Delete old image if it exists
      if (links[0].image_url) {
        const oldImagePath = path.join(__dirname, 'public', links[0].image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
    }
    
    // Update the link
    await pool.query(`
      UPDATE links
      SET title = ?,
          description = ?,
          type = ?,
          url = ?,
          image_url = ?,
          category = ?,
          click_target = ?,
          cost_per_click = ?,
          is_active = ?
      WHERE id = ? AND merchant_id = ?
    `, [
      title,
      description,
      type,
      url,
      imageUrl,
      category,
      click_target,
      cost_per_click,
      is_active ? 1 : 0,
      linkId,
      userId
    ]);
    
    res.redirect(`/merchant/links?success=Link updated successfully`);
  } catch (err) {
    console.error('Link update error:', err);
    res.redirect(`/merchant/links/${req.params.id}/edit?error=Failed to update link. Please try again.`);
  }
});

// Route to view a specific merchant link
app.get('/merchant/links/:id', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const linkId = req.params.id;
    const userId = req.session.userId;
    
    // Get link details, ensuring it belongs to this merchant
    const [links] = await pool.query(`
      SELECT l.*
      FROM links l
      WHERE l.id = ? AND l.merchant_id = ?
    `, [linkId, userId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', { message: 'Link not found or you don\'t have permission to view it.' });
    }
    
    const link = links[0];
    
    // Get analytics data for this link with corrected queries
    const [analytics] = await pool.query(`
      SELECT 
        COUNT(DISTINCT sl.id) as total_shares,
        SUM(sl.clicks) as total_clicks,
        COALESCE(SUM(sl.earnings), 0) as total_earnings
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      WHERE l.id = ?
      GROUP BY l.id
    `, [linkId]);
    
    // If no analytics records were found, initialize with zeros
    const analyticsData = analytics.length > 0 ? analytics[0] : { 
      total_shares: 0, 
      total_clicks: 0, 
      total_earnings: 0 
    };
    
    // Get users who shared this link with correct click count calculation
    const [shares] = await pool.query(`
      SELECT 
        sl.*, 
        u.username, 
        sl.clicks as click_count,
        COALESCE(sl.earnings, 0) as user_earnings
      FROM shared_links sl
      JOIN users u ON sl.user_id = u.id
      WHERE sl.link_id = ?
      ORDER BY sl.clicks DESC
    `, [linkId]);
    
    res.render('merchant/link-details', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      link: link,
      analytics: analyticsData,
      shares: shares,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchant link details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Admin merchants route
// app.get('/admin/merchants', isAuthenticated, isAdmin, async (req, res) => {
//   try {
//     // Get all merchants with their account details
//     const [merchants] = await pool.query(`
//       SELECT * FROM users 
//       WHERE role = 'merchant'
//       ORDER BY created_at DESC
//     `);
    
//     // Get merchant payments and balance stats
//     const merchantsWithStats = await Promise.all(merchants.map(async (merchant) => {
//       // Get total amount paid
//       const [payments] = await pool.query(`
//         SELECT SUM(amount) as total_paid
//         FROM transactions
//         WHERE user_id = ? AND type = 'payment' AND status = 'completed'
//       `, [merchant.id]);
      
//       // Get total links count
//       const [links] = await pool.query(`
//         SELECT COUNT(*) as total_links
//         FROM links
//         WHERE merchant_id = ?
//       `, [merchant.id]);
      
//       return {
//         ...merchant,
//         total_paid: payments[0].total_paid || 0,
//         total_links: links[0].total_links || 0
//       };
//     }));
    
//     res.render('admin/merchants', { 
//       merchants: merchantsWithStats,
//       success: req.query.success,
//       error: req.query.error
//     });
//   } catch (err) {
//     console.error('Merchants page error:', err);
//     res.status(500).render('error', { message: 'Server error. Please try again later.' });
//   }
// });
app.get('/admin/merchants', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get all merchants with their account details
    const [merchants] = await pool.query(`
      SELECT * FROM users 
      WHERE role = 'merchant'
      ORDER BY created_at DESC
    `);
    
    // Get merchant payments and balance stats
    const merchantsWithStats = await Promise.all(merchants.map(async (merchant) => {
      // Get total amount paid
      const [payments] = await pool.query(`
        SELECT SUM(amount) as total_paid
        FROM transactions
        WHERE user_id = ? AND type = 'payment' AND status = 'completed'
      `, [merchant.id]);
      
      // Get total links count
      const [links] = await pool.query(`
        SELECT COUNT(*) as total_links
        FROM links
        WHERE merchant_id = ?
      `, [merchant.id]);
      
      return {
        ...merchant,
        total_paid: payments[0].total_paid || 0,
        total_links: links[0].total_links || 0
      };
    }));
    
    // Get recent merchant payments
    const [paymentRecords] = await pool.query(`
      SELECT t.*, u.username 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.type = 'payment' 
      ORDER BY t.created_at DESC
      LIMIT 20
    `);
    
    res.render('admin/merchants', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      merchants: merchantsWithStats,
      payments: paymentRecords,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Merchants page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});
// Route to edit a merchant
app.get('/admin/merchants/:id/edit', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;
    
    // Get merchant details
    const [merchants] = await pool.query('SELECT * FROM users WHERE id = ? AND role = "merchant"', [merchantId]);
    
    if (merchants.length === 0) {
      return res.status(404).render('error', { message: 'Merchant not found' });
    }
    
    res.render('admin/merchant-edit', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      merchant: merchants[0],
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Edit merchant error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Route to update a merchant
app.post('/admin/merchants/:id/update', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;
    const { username, email, business_name, business_description, is_verified } = req.body;
    
    // Update merchant details
    await pool.query(`
      UPDATE users 
      SET username = ?, email = ?, business_name = ?, business_description = ?, is_verified = ?
      WHERE id = ? AND role = "merchant"
    `, [
      username,
      email,
      business_name || null,
      business_description || null,
      is_verified === 'on' ? true : false,
      merchantId
    ]);
    
    res.redirect('/admin/merchants?success=Merchant updated successfully');
  } catch (err) {
    console.error('Update merchant error:', err);
    res.redirect(`/admin/merchants/${req.params.id}/edit?error=Error updating merchant`);
  }
});
// Route to mark a merchant as paid
app.post('/admin/merchants/:id/mark-paid', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;
    
    // Get merchant details
    const [merchants] = await pool.query('SELECT * FROM users WHERE id = ? AND role = "merchant"', [merchantId]);
    
    if (merchants.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found'
      });
    }
    
    const merchant = merchants[0];
    const amountToPay = parseFloat(merchant.amount_to_pay) || 0;
    
    if (amountToPay <= 0) {
      return res.json({
        success: true,
        message: 'Merchant has no outstanding balance'
      });
    }
    
    // Record payment transaction
    await pool.query(`
      INSERT INTO transactions (
        user_id, type, amount, status, details
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      merchantId,
      'payment',
      amountToPay,
      'completed',
      'Payment processed by admin'
    ]);
    
    // Update merchant's payment status
    await pool.query(`
      UPDATE users 
      SET paid_balance = paid_balance + ?, amount_to_pay = 0
      WHERE id = ?
    `, [amountToPay, merchantId]);
    
    res.json({
      success: true,
      message: 'Merchant marked as paid successfully',
      amount: amountToPay
    });
  } catch (err) {
    console.error('Mark merchant as paid error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route to delete a merchant
app.delete('/admin/merchants/:id/delete', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;
    
    // Check if merchant exists
    const [merchants] = await pool.query('SELECT * FROM users WHERE id = ? AND role = "merchant"', [merchantId]);
    
    if (merchants.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found'
      });
    }
    
    // Don't allow admins to delete themselves
    if (merchantId == req.session.userId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account'
      });
    }
    
    // Delete merchant (in a real application, you might want to soft-delete instead)
    await pool.query('DELETE FROM users WHERE id = ?', [merchantId]);
    
    res.json({
      success: true,
      message: 'Merchant deleted successfully'
    });
  } catch (err) {
    console.error('Delete merchant error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});
// Route to create a new merchant from admin panel
app.post('/admin/merchants/create', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { username, email, password, business_name, business_description, is_verified } = req.body;
    
    // Check if username or email already exists
    const [existingUsers] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existingUsers.length > 0) {
      return res.redirect('/admin/merchants?error=Username or email already in use');
    }
    
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create the merchant account
    await pool.query(`
      INSERT INTO users (
        username, email, password, role, business_name, 
        business_description, is_verified, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      username,
      email,
      hashedPassword,
      'merchant',
      business_name || null,
      business_description || null,
      is_verified === 'on' ? true : false
    ]);
    
    res.redirect('/admin/merchants?success=Merchant created successfully');
  } catch (err) {
    console.error('Create merchant error:', err);
    res.redirect('/admin/merchants?error=Error creating merchant');
  }
});
// Admin users management route
// Admin users management route - MOVED TO adminRoutes.js
/*
app.get('/admin/users', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get filter parameters
    const roleFilter = req.query.role;
    const searchQuery = req.query.search || '';
    const minWallet = req.query.minWallet ? parseFloat(req.query.minWallet) : null;
    const maxWallet = req.query.maxWallet ? parseFloat(req.query.maxWallet) : null;
    const minReferrals = req.query.minReferrals ? parseInt(req.query.minReferrals) : null;
    const maxReferrals = req.query.maxReferrals ? parseInt(req.query.maxReferrals) : null;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    
    // Build WHERE clause for filters
    let whereConditions = [];
    let queryParams = [];
    
    if (roleFilter) {
      whereConditions.push('u.role = ?');
      queryParams.push(roleFilter);
    }
    
    if (searchQuery) {
      whereConditions.push('(u.username LIKE ? OR u.email LIKE ?)');
      queryParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    
    if (minWallet !== null) {
      whereConditions.push('(u.wallet >= ? OR u.wallet IS NULL)');
      queryParams.push(minWallet);
    }
    
    if (maxWallet !== null) {
      whereConditions.push('(u.wallet <= ? OR u.wallet IS NULL)');
      queryParams.push(maxWallet);
    }
    
    if (minReferrals !== null) {
      whereConditions.push('COALESCE(referral_count, 0) >= ?');
      queryParams.push(minReferrals);
    }
    
    if (maxReferrals !== null) {
      whereConditions.push('COALESCE(referral_count, 0) <= ?');
      queryParams.push(maxReferrals);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Get users with referral counts, shared links, and orders
    const [users] = await pool.query(`
      SELECT u.*, 
             COALESCE(referrals.referral_count, 0) as referral_count,
             COALESCE(links.total_shared_links, 0) as total_shared_links,
             COALESCE(orders.total_orders, 0) as total_orders
      FROM users u
      LEFT JOIN (
        SELECT referred_by, COUNT(*) as referral_count
        FROM users 
        WHERE referred_by IS NOT NULL
        GROUP BY referred_by
      ) referrals ON u.id = referrals.referred_by
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_shared_links
        FROM links
        GROUP BY user_id
      ) links ON u.id = links.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_orders
        FROM orders
        GROUP BY user_id
      ) orders ON u.id = orders.user_id
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);
    
    // Get total count for pagination
    const [countResult] = await pool.query(`
      SELECT COUNT(DISTINCT u.id) as total_count
      FROM users u
      LEFT JOIN (
        SELECT referred_by, COUNT(*) as referral_count
        FROM users 
        WHERE referred_by IS NOT NULL
        GROUP BY referred_by
      ) referrals ON u.id = referrals.referred_by
      ${whereClause}
    `, queryParams);
    
    const totalUsers = countResult[0].total_count;
    const totalPages = Math.ceil(totalUsers / limit);
    
    // Get recent user registrations
    const [recentRegistrations] = await pool.query(`
      SELECT * FROM users
      WHERE role = 'user'
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    // Get user statistics
    const [userStats] = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as regular_users,
        SUM(CASE WHEN role = 'merchant' THEN 1 ELSE 0 END) as merchant_users,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_users,
        SUM(CASE WHEN has_lifetime_commission = 1 THEN 1 ELSE 0 END) as premium_users
      FROM users
    `);
    
    res.render('admin/users', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      users: users,
      recentRegistrations: recentRegistrations,
      stats: userStats[0],
      currentPage: page,
      totalPages: totalPages,
      totalUsers: totalUsers,
      selectedRole: roleFilter || '',
      searchQuery: searchQuery,
      filters: {
        minWallet: minWallet,
        maxWallet: maxWallet,
        minReferrals: minReferrals,
        maxReferrals: maxReferrals
      },
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin users page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});
*/

// Route to toggle user premium status
app.post('/admin/users/:id/toggle-premium', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get current user status
    const [users] = await pool.query('SELECT has_lifetime_commission FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const currentStatus = users[0].has_lifetime_commission ? true : false;
    const newStatus = !currentStatus;
    
    // Update premium status
    await pool.query('UPDATE users SET has_lifetime_commission = ? WHERE id = ?', [newStatus, userId]);
    
    res.json({
      success: true,
      message: `User premium status updated to ${newStatus ? 'premium' : 'standard'}`,
      newStatus: newStatus
    });
  } catch (err) {
    console.error('Toggle premium status error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route to update a user's details
app.post('/admin/users/:id/update', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { username, email, role, wallet, has_lifetime_commission, notes } = req.body;
    
    // Validate inputs
    if (!username || !email || !role) {
      return res.status(400).json({
        success: false,
        message: 'Username, email and role are required'
      });
    }
    
    // Check if user exists
    const [existingUser] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (existingUser.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if username or email is already taken by someone else
    const [duplicateCheck] = await pool.query(
      'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?', 
      [username, email, userId]
    );
    
    if (duplicateCheck.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Username or email already in use by another user'
      });
    }
    
    // Update the user
    await pool.query(`
      UPDATE users 
      SET username = ?,
          email = ?,
          role = ?,
          wallet = ?,
          has_lifetime_commission = ?,
          notes = ?
      WHERE id = ?
    `, [
      username,
      email,
      role,
      parseFloat(wallet) || 0,
      has_lifetime_commission ? 1 : 0,
      notes || null,
      userId
    ]);
    
    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route to delete a user
app.delete('/admin/users/:id/delete', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check if user exists
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Don't allow admins to delete themselves
    if (userId == req.session.userId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account'
      });
    }
    
    // Delete user
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route to create a new user
app.post('/admin/users/create', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { username, email, role, password, generate } = req.body;
    
    // Check if username or email already exists
    const [existingUsers] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existingUsers.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Username or email already in use'
      });
    }
    
    // Generate password if requested
    let userPassword = password;
    if (generate) {
      // Generate a random password
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
      userPassword = "";
      for (let i = 0; i < 12; i++) {
        userPassword += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    }
    
    // Validate password
    if (!userPassword || userPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }
    
    // Hash the password
    const hashedPassword = await bcrypt.hash(userPassword, 10);
    
    // Create the user
    const [result] = await pool.query(`
      INSERT INTO users (
        username, 
        email, 
        password, 
        role, 
        created_at
      ) VALUES (?, ?, ?, ?, NOW())
    `, [
      username,
      email,
      hashedPassword,
      role
    ]);
    
    res.json({
      success: true, 
      message: 'User created successfully',
      userId: result.insertId,
      generatedPassword: generate ? userPassword : null
    });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route to set a user's password (admin only)
app.post('/admin/users/:id/set-password', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { new_password } = req.body;
    
    // Validate the userId
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Validate password
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }
    
    // Check if password has letters and numbers
    const hasLetters = /[A-Za-z]/.test(new_password);
    const hasNumbers = /[0-9]/.test(new_password);
    
    if (!hasLetters || !hasNumbers) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain both letters and numbers'
      });
    }
    
    // Hash and update the password
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
    
    return res.json({
      success: true,
      message: `Password has been set successfully for user ${users[0].username}`
    });
  } catch (err) {
    console.error('Set user password error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});
// Admin settings route
app.get('/admin/settings', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get all configuration settings
    const [configs] = await pool.query('SELECT * FROM config ORDER BY key_name ASC');
    
    res.render('admin/settings', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      configs: configs,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin settings page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Admin settings update route
// Admin settings update route

app.post('/admin/settings/update', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { key_name, value } = req.body;
    
    if (!key_name || value === undefined) {
      return res.redirect('/admin/settings?error=Missing required fields');
    }

    await pool.query(
      'UPDATE config SET value = ? WHERE key_name = ?',
      [value, key_name]
    );

    return res.redirect('/admin/settings?success=Setting updated successfully');
  } catch (err) {
    console.error('Settings update error:', err);
    return res.redirect('/admin/settings?error=Error updating settings');
  }56
});
// Admin settings add route
app.post('/admin/settings/add', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { key_name, value, description } = req.body;
    
    // Check if key already exists
    const [existingKey] = await pool.query('SELECT * FROM config WHERE key_name = ?', [key_name]);
    
    if (existingKey.length > 0) {
      return res.redirect('/admin/settings?error=Setting key already exists');
    }
    
    // Add new setting
    await pool.query(
      'INSERT INTO config (key_name, value, description) VALUES (?, ?, ?)',
      [key_name, value, description]
    );
    
    res.redirect('/admin/settings?success=New setting added successfully');
  } catch (err) {
    console.error('Add setting error:', err);
    res.redirect('/admin/settings?error=Error adding new setting');
  }
});

// Admin settings delete route
app.post('/admin/settings/delete', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { key_name } = req.body;
    
    // Delete the setting
    await pool.query('DELETE FROM config WHERE key_name = ?', [key_name]);
    
    res.redirect('/admin/settings?success=Setting deleted successfully');
  } catch (err) {
    console.error('Delete setting error:', err);
    res.redirect('/admin/settings?error=Error deleting setting');
  }
});
// Route to set a user's password (admin only)
app.post('/admin/users/:id/set-password', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { new_password } = req.body;
    
    // Validate the userId
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Validate password
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }
    
    // Check if password has letters and numbers
    const hasLetters = /[A-Za-z]/.test(new_password);
    const hasNumbers = /[0-9]/.test(new_password);
    
    if (!hasLetters || !hasNumbers) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain both letters and numbers'
      });
    }
    
    // Hash and update the password
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
    
    return res.json({
      success: true,
      message: `Password has been set successfully for user ${users[0].username}`
    });
  } catch (err) {
    console.error('Set user password error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Admin transactions route
app.get('/admin/transactions', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get filter parameters
    const typeFilter = req.query.type;
    const statusFilter = req.query.status;
    
    // Build WHERE clause for filters
    let whereClause = '';
    let queryParams = [];
    
    if (typeFilter && typeFilter !== 'all') {
      whereClause += 'WHERE t.type = ?';
      queryParams.push(typeFilter);
    }
    
    if (statusFilter && statusFilter !== 'all') {
      if (whereClause) {
        whereClause += ' AND t.status = ?';
      } else {
        whereClause += 'WHERE t.status = ?';
      }
      queryParams.push(statusFilter);
    }
    
    // Get transactions with user information
    const [transactions] = await pool.query(`
      SELECT t.*, u.username 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ${whereClause}
      ORDER BY t.created_at DESC
    `, queryParams);
    
    // Get transaction statistics
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_count,
        SUM(CASE WHEN type = 'payment' THEN 1 ELSE 0 END) as payment_count,
        SUM(CASE WHEN type = 'withdrawal' THEN 1 ELSE 0 END) as withdrawal_count,
        SUM(CASE WHEN type = 'commission' THEN 1 ELSE 0 END) as commission_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
      FROM transactions
    `);
    
    res.render('admin/transactions', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      transactions: transactions,
      stats: stats[0],
      currentFilter: {
        type: typeFilter || 'all',
        status: statusFilter || 'all'
      },
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Transactions page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Process transaction route
app.post('/admin/transactions/:id/process', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const { status, notes } = req.body;
    
    // Get transaction details
    const [transactions] = await pool.query('SELECT * FROM transactions WHERE id = ?', [transactionId]);
    
    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }
    
    const transaction = transactions[0];
    
    // Update transaction status
    await pool.query(
      'UPDATE transactions SET status = ?, notes = ?, updated_at = NOW() WHERE id = ?',
      [status, notes || transaction.notes, transactionId]
    );
    
    // Handle wallet balance for withdrawal transactions
    if (transaction.type === 'withdrawal') {
      if (status === 'rejected' || status === 'failed') {
        // Only refund if the transaction was previously in 'pending' status
        // This prevents double refunds if admin changes status multiple times
        if (transaction.status === 'pending') {
          // If withdrawal is rejected/failed, add the amount back to user's wallet
          await pool.query(
            'UPDATE users SET wallet = wallet + ? WHERE id = ?',
            [transaction.amount, transaction.user_id]
          );
        }
      }
      // Note: We don't deduct again for 'completed' status because 
      // the amount was already deducted when the withdrawal was requested
      
      // Send notification to user about withdrawal status change
      try {
        const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [transaction.user_id]);
        if (users.length > 0) {
          await sendWithdrawalNotification(users[0], transaction, status);
        }
      } catch (emailError) {
        console.error('Failed to send withdrawal notification:', emailError);
        // Don't fail the transaction if email fails
      }
    }
    
    return res.json({
      success: true,
      message: `Transaction ${status}`
    });
  } catch (err) {
    console.error('Process transaction error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});
// Route for upgrading to lifetime commission
app.get('/upgrade-commission', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Check if user already has lifetime commission
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];
    
    if (user.has_lifetime_commission) {
      return res.render('user/already-upgraded', { user });
    }
    
    // Get upgrade fee from config
    const upgradeFee = await getConfig('lifetime_commission_fee');
    const fee = parseFloat(upgradeFee);
    
    // Check if wallet balance is sufficient
    const hasEnoughBalance = parseFloat(user.wallet) >= fee;
    
    res.render('user/upgrade', { 
      user,
      upgradeFee: fee,
      hasEnoughBalance,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Upgrade commission page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// API route for processing the upgrade
app.post('/api/upgrade-commission', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Check if user already has lifetime commission
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];
    
    if (user.has_lifetime_commission) {
      return res.json({
        success: false,
        message: 'You already have lifetime commission benefits'
      });
    }
    
    // Get upgrade fee from config
    const upgradeFee = parseFloat(await getConfig('lifetime_commission_fee'));
    
    // Check if user has enough balance in wallet
    if (parseFloat(user.wallet) < upgradeFee) {
      return res.json({
        success: false,
        message: 'Insufficient wallet balance. Please add funds to your wallet first.'
      });
    }
    
    // Begin transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
      // Deduct fee from wallet
      await connection.query(
        'UPDATE users SET wallet = wallet - ?, has_lifetime_commission = true WHERE id = ?',
        [upgradeFee, userId]
      );
      
      // Record the transaction
      await connection.query(`
        INSERT INTO transactions (
          user_id, type, amount, status, details
        ) VALUES (?, 'upgrade', ?, 'completed', ?)
      `, [
        userId,
        upgradeFee,
        'Lifetime commission upgrade via wallet balance'
      ]);
      
      await connection.commit();
      
      res.json({
        success: true,
        message: 'Upgrade successful! You now have lifetime commission benefits.'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Upgrade commission error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Route for individual product details
// Route for individual product details
app.get('/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    
    // Get product details
    const [products] = await pool.query(`
      SELECT p.*, u.username as merchant_name, u.business_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.id = ? AND p.is_active = true
    `, [productId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', { message: 'Product not found or no longer available.' });
    }
    
    const product = products[0];
    
    // Get product's merchant information
    const [merchants] = await pool.query(`
      SELECT id, username, business_name, business_description
      FROM users
      WHERE id = ?
    `, [product.merchant_id]);
    
    const merchant = merchants.length > 0 ? merchants[0] : null;
    
    // Check if this product has a referrer in the query (from shared links)
    let referrerUsername = null;
    if (req.query.ref) {
      const [sharedLinks] = await pool.query(`
        SELECT sl.*, u.username
        FROM shared_links sl
        JOIN users u ON sl.user_id = u.id
        WHERE sl.share_code = ?
      `, [req.query.ref]);
      
      if (sharedLinks.length > 0) {
        referrerUsername = sharedLinks[0].username;
      }
    }
    
    // Get cart count for authenticated user
    let cartCount = 0;
    if (req.session.userId) {
      const [cartItems] = await pool.query(`
        SELECT SUM(quantity) as count
        FROM cart_items
        WHERE user_id = ?
      `, [req.session.userId]);
      
      cartCount = cartItems[0].count || 0;
    }
    
    // Render the product details page
    res.render('user/product-details', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      product,
      merchant,
      referrerUsername,
      cartCount
    });
  } catch (err) {
    console.error('Product details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Withdrawal API endpoints
app.post('/api/withdraw', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { amount, gateway } = req.body;
    
    // Validate the amount
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.json({ success: false, message: 'Please enter a valid amount' });
    }
    
    // Get user information
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const user = users[0];
    
    // Check if the user has enough balance
    if (parseFloat(user.wallet) < parseFloat(amount)) {
      return res.json({ success: false, message: 'Insufficient funds in your wallet' });
    }
    
    // Get minimum payout amount from config
    const minPayout = await getConfig('min_payout');
    if (parseFloat(amount) < parseFloat(minPayout)) {
      return res.json({ success: false, message: `Minimum withdrawal amount is $${minPayout}` });
    }
    
    // Check if user has provided bank details
    if (!user.account_number || !user.bank_code || !user.account_name) {
      return res.json({ success: false, message: 'Please update your bank account details in your profile first' });
    }
    
    // Create a withdrawal transaction - without gateway column
    const [result] = await pool.query(`
      INSERT INTO transactions (
        user_id, type, amount, status, details
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      userId,
      'withdrawal',
      parseFloat(amount),
      'pending',
      `Withdrawal request via ${gateway}`
    ]);
    
    // Deduct the amount from the user's wallet
    await pool.query(`
      UPDATE users SET wallet = wallet - ? WHERE id = ?
    `, [parseFloat(amount), userId]);
    
    return res.json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error('Withdrawal request error:', err);
    return res.json({ success: false, message: 'Server error. Please try again later.' });
  }
});

// Manual withdrawal API endpoint
app.post('/api/withdraw-manual', isAuthenticated, async (req, res) => {
  try {
    // First, try to activate the user if they meet requirements
    const activationService = req.app.locals.activationService;
    const activated = await activationService.activateUser(req.session.userId);
    
    if (!activated) {
      return res.json({ success: false, message: 'Please complete activation requirements first' });
    }
    const userId = req.session.userId;
    const { amount, gateway } = req.body;
    
    // Validate the amount
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.json({ success: false, message: 'Please enter a valid amount' });
    }
    
    // Get user information
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const user = users[0];
    
    // Check if the user has enough balance
    if (parseFloat(user.wallet) < parseFloat(amount)) {
      return res.json({ success: false, message: 'Insufficient funds in your wallet' });
    }
    
    // Get minimum payout amount from config
    const minPayout = await getConfig('min_payout');
    if (parseFloat(amount) < parseFloat(minPayout)) {
      return res.json({ success: false, message: `Minimum withdrawal amount is $${minPayout}` });
    }
    
    // Check if user has provided bank details
    if (!user.account_number || !user.bank_code || !user.account_name) {
      return res.json({ success: false, message: 'Please update your bank account details in your profile first' });
    }
    
    // Create a withdrawal transaction - without gateway column
    const [result] = await pool.query(`
      INSERT INTO transactions (
        user_id, type, amount, status, details
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      userId,
      'withdrawal',
      parseFloat(amount),
      'pending',
      `Manual withdrawal request to ${user.bank_code}, Account: ${user.account_number}, Name: ${user.account_name}`
    ]);
    
    // Deduct the amount from the user's wallet
    await pool.query(`
      UPDATE users SET wallet = wallet - ? WHERE id = ?
    `, [parseFloat(amount), userId]);
    
    return res.json({ success: true, message: 'Withdrawal request submitted successfully. Your request will be reviewed by admin.' });
  } catch (err) {
    console.error('Manual withdrawal request error:', err);
    return res.json({ success: false, message: 'Server error. Please try again later.' });
  }

});
// Admin orders route
// Admin orders route
app.get('/admin/orders', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get all orders with customer and merchant information
    const [orders] = await pool.query(`
      SELECT o.*, 
             u.username as customer_name,
             u.email as customer_email,
             COUNT(oi.id) as item_count,
             GROUP_CONCAT(DISTINCT p.merchant_id) as merchant_ids
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);

    // Get all merchants for filtering
    const [merchants] = await pool.query(`
      SELECT id, username, business_name
      FROM users
      WHERE role = 'merchant'
      ORDER BY business_name, username
    `);

    // Calculate order statistics - exclude cancelled orders from revenue
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'completed' OR status = 'delivered' THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_orders,
        SUM(CASE WHEN status != 'cancelled' THEN total_amount ELSE 0 END) as total_revenue
      FROM orders
    `);

    res.render('admin/orders', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      orders: orders,
      merchants: merchants,
      stats: stats[0],
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin orders page error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// Admin cancel order route

app.post('/admin/orders/:id/cancel', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    
    // Update order status to cancelled
    await pool.query(`
      UPDATE orders 
      SET status = 'cancelled' 
      WHERE id = ?
    `, [orderId]);
    
    // Reverse any commission given to referrers
    const [orderItems] = await pool.query(`
      SELECT oi.*, u.wallet, u.earnings
      FROM order_items oi
      LEFT JOIN users u ON oi.referrer_id = u.id
      WHERE oi.order_id = ? AND oi.referrer_id IS NOT NULL
    `, [orderId]);
    
    // Process each item with a referrer
    for (const item of orderItems) {
      if (item.referrer_id) {
        // Deduct the commission from referrer's wallet and earnings
        await pool.query(`
          UPDATE users 
          SET wallet = wallet - ?,
              earnings = earnings - ?
          WHERE id = ?
        `, [item.commission_earned, item.commission_earned, item.referrer_id]);
        
        // Record a transaction for the commission reversal
        await pool.query(`
          INSERT INTO transactions (user_id, type, amount, status, details)
          VALUES (?, 'commission', ?, 'completed', ?)
        `, [
          item.referrer_id,
          -item.commission_earned,
          `Commission reversed for cancelled order #${orderId}`
        ]);
      }
    }
    
    res.json({
      success: true,
      message: 'Order cancelled successfully'
    });
  } catch (err) {
    console.error('Cancel order error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});
// Admin order details API route
app.get('/admin/orders/:id/details', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    
    // Get order details
    const [orders] = await pool.query(`
      SELECT o.*, u.username as customer_name, u.email as customer_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `, [orderId]);
    
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    
    // Get order items with product and merchant details
    const [items] = await pool.query(`
      SELECT oi.*, p.name, p.image_url, u.username as merchant_name, u.business_name
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE oi.order_id = ?
    `, [orderId]);
    
    // Get order history (if you have a history table, otherwise this is a placeholder)
    const history = [
      {
        action: 'Order created',
        timestamp: orders[0].created_at,
        notes: 'Customer placed the order'
      }
    ];
    
    // Add status changes to history if you track them
    if (orders[0].status !== 'pending') {
      history.push({
        action: `Status changed to ${orders[0].status}`,
        timestamp: new Date(), // This should come from your database if you track it
        notes: ''
      });
    }
    
    res.json({
      success: true,
      order: orders[0],
      items: items,
      history: history
    });
  } catch (err) {
    console.error('Order details API error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
  }
});

// Admin update order status route
app.post('/admin/orders/:id/update-status', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status, notes, notifyCustomer } = req.body;
    
    // Validate status
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    
    // Get current order status
    const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    
    const currentStatus = orders[0].status;
    
    // Update order status
    await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, orderId]);
    
    // If order is marked as delivered, process commissions for shared products and admin
    if (status === 'delivered') {
      await processAdminCommissions(orderId);
      await processProductCommissions(orderId);
    }
    
    // If you have an order history table, record the status change
    // Here's a placeholder for that logic:
    /*
    await pool.query(`
      INSERT INTO order_history (order_id, action, notes, created_by)
      VALUES (?, ?, ?, ?)
    `, [orderId, `Status changed from ${currentStatus} to ${status}`, notes || null, req.session.userId]);
    */
    
    // Notify customer if requested (this is a placeholder for email logic)
    if (notifyCustomer) {
      const [orderDetails] = await pool.query(`
        SELECT o.*, u.email, u.username
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.id = ?
      `, [orderId]);
      
      if (orderDetails.length > 0) {
        const customerEmail = orderDetails[0].email;
        const customerName = orderDetails[0].username;
        
        // Email content would depend on the new status
        let subject = `Your Order #${orderId} Status Update`;
        let message = `<p>Hello ${customerName},</p>
                      <p>Your order #${orderId} status has been updated to: <strong>${status}</strong></p>`;
        
        if (notes) {
          message += `<p>Additional information: ${notes}</p>`;
        }
        
        message += `<p>Thank you for shopping with us!</p>
                   <p>Best regards,<br>The BenixSpace Team</p>`;
        
        // Send email (this would call your email sending function)
        try {
          await sendEmail(customerEmail, subject, message);
        } catch (emailErr) {
          console.error('Error sending notification email:', emailErr);
        }
      }
    }
    
    res.json({
      success: true,
      message: `Order status updated to ${status}`
    });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
  }
});


// Admin contact customer route
app.post('/admin/orders/contact-customer', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { orderId, email, subject, message } = req.body;
    
    // Validate input
    if (!email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, subject and message are required' 
      });
    }
    
    // Send email
    await sendEmail(email, subject, message);
    
    // Record this communication in the database if you have a table for it
    /*
    await pool.query(`
      INSERT INTO customer_communications (order_id, sent_by, email, subject, message)
      VALUES (?, ?, ?, ?, ?)
    `, [orderId, req.session.userId, email, subject, message]);
    */
    
    res.json({
      success: true,
      message: 'Message sent successfully'
    });
  } catch (err) {
    console.error('Contact customer error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
  }
});

// Admin export orders route
app.get('/admin/orders/export', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { status, merchant, search, sort } = req.query;
    
    // Build query based on filters
    let query = `
      SELECT o.*, 
             u.username as customer_name,
             u.email as customer_email,
             COUNT(oi.id) as item_count,
             GROUP_CONCAT(DISTINCT m.username) as merchant_names
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      JOIN users m ON p.merchant_id = m.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    // Apply filters
    if (status && status !== 'all') {
      query += ' AND o.status = ?';
      queryParams.push(status);
    }
    
    if (merchant && merchant !== 'all') {
      query += ' AND p.merchant_id = ?';
      queryParams.push(merchant);
    }
    
    if (search) {
      query += ' AND (o.id LIKE ? OR u.username LIKE ? OR u.email LIKE ?)';
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }
    
    query += ' GROUP BY o.id';
    
    // Apply sorting
    if (sort === 'oldest') {
      query += ' ORDER BY o.created_at ASC';
    } else if (sort === 'highest') {
      query += ' ORDER BY o.total_amount DESC';
    } else if (sort === 'lowest') {
      query += ' ORDER BY o.total_amount ASC';
    } else {
      query += ' ORDER BY o.created_at DESC'; // Default: newest first
    }
    
    const [orders] = await pool.query(query, queryParams);
    
    // Generate CSV content
    let csv = 'Order ID,Customer,Email,Date,Items,Total Amount,Status,Merchants\n';
    
    orders.forEach(order => {
      csv += `${order.id},`;
      csv += `"${order.customer_name}",`;
      csv += `"${order.customer_email}",`;
      csv += `"${new Date(order.created_at).toLocaleString()}",`;
      csv += `${order.item_count},`;
      csv += `$${parseFloat(order.total_amount).toFixed(4)},`;
      csv += `"${order.status}",`;
      csv += `"${order.merchant_names || ''}"\n`;
    });
    
    // Set response headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    
    // Send the CSV data
    res.send(csv);
  } catch (err) {
    console.error('Export orders error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});
// Initialize activation system tables and columns
async function initializeActivationSystem() {
  try {
    console.log('🔄 Initializing activation system...');

    // Add activation status and tracking columns to users table
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS activation_status ENUM('pending', 'active', 'suspended') DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS last_withdraw_clicks INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS weekly_login_days INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_shared_links INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_login_week INT DEFAULT NULL
    `);

    // Create or update activation settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activation_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        is_activation_required BOOLEAN DEFAULT TRUE,
        min_shared_links INT DEFAULT 100,
        min_login_days INT DEFAULT 2,
        min_clicks_before_withdraw INT DEFAULT 500,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Check if we need to insert default settings
    const [settings] = await pool.query('SELECT * FROM activation_settings LIMIT 1');
    if (settings.length === 0) {
      await pool.query(`
        INSERT INTO activation_settings 
        (is_activation_required, min_shared_links, min_login_days, min_clicks_before_withdraw)
        VALUES 
        (TRUE, 100, 2, 500)
      `);
    }

    console.log('✅ Activation system initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize activation system:', error);
    throw error;
  }
}

app.listen(PORT, async () => {
  try {
    console.log('Starting BenixSpace server...');
    
    // Initialize database tables
    await initializeDatabase();
    
    // Initialize activation system
    await initializeActivationSystem();
    
    // Initialize currency service
    await currencyService.initialize();
    
    // Initialize notification system
    await notificationService.initializeService();
    
    // Start report scheduler
    reportScheduler.startScheduler();
    
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Database initialized successfully`);
    console.log(`✓ Currency service initialized`);
    console.log(`✓ Commission system ready`);
    console.log(`✓ Email service configured`);
    console.log(`✓ Notification system ready`);
    console.log(`✓ Report scheduler started`);
    
    if (flutterwaveService.isConfigured()) {
      console.log(`✓ Flutterwave payment service configured`);
    } else {
      console.log(`⚠ Flutterwave not configured - update .env file with your keys`);
    }
    
    // Send startup notification to admins
    await notificationService.notifyAdminAlert({
      type: 'System Startup',
      message: 'BenixSpace server started successfully',
      details: `Server started on port ${PORT} with all services initialized`,
      priority: 1
    });
    
  } catch (err) {
    console.error('Server startup error:', err);
    
    // Try to send critical alert if notification service is available
    try {
      await notificationService.notifyAdminAlert({
        type: 'Critical Server Error',
        message: 'Server failed to start',
        details: err.message,
        priority: 5
      });
    } catch (notifErr) {
      console.error('Failed to send startup error notification:', notifErr);
    }
    
    process.exit(1);
  }
});
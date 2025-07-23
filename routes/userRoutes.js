const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'benixs_benix',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Auth middleware to check if user is logged in
const isAuthenticated = async (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

  try {
    const [users] = await pool.query(
      'SELECT * FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length === 0) {
      return res.status(403).render('error', {
        message: 'User not found',
        error: { status: 403, stack: '' }
      });
    }

    // Add user to request
    req.user = users[0];
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).render('error', {
      message: 'Server error',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
};

// Auth middleware to check if user is logged in AND activated
const isActivated = async (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

  try {
    const [users] = await pool.query(
      'SELECT * FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length === 0) {
      return res.status(403).render('error', {
        message: 'User not found',
        error: { status: 403, stack: '' }
      });
    }

    const user = users[0];
    req.user = user;

    // Check if user is activated (except for activation page itself)
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
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).render('error', {
      message: 'Server error',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
};

// Helper function to get config values from the database
async function getConfig(key) {
  const [rows] = await pool.query('SELECT value FROM config WHERE key_name = ?', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

// User profile page
router.get('/profile', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get user data with all fields
    const [users] = await pool.query(`
      SELECT id, username, email, role, country, phone_number,
             business_name, business_description, account_name,
             account_number, bank_code, created_at, has_lifetime_commission,
             wallet, earnings
      FROM users 
      WHERE id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).render('error', { message: 'User not found' });
    }
    
    const user = users[0];
    console.log('Retrieved user data:', user);
    
    // Parse the phone number to separate country code and number
    let phoneDetails = { countryCode: '+1', number: '' };
    if (user.phone_number) {
      console.log('Processing phone number:', user.phone_number);
      // Try different phone number formats
      let match = user.phone_number.match(/^(\+\d{1,3}|\d{1,3})(\d+)$/);
      if (match) {
        phoneDetails.countryCode = match[1].startsWith('+') ? match[1] : '+' + match[1];
        phoneDetails.number = match[2];
      } else {
        // If format is completely different, try to extract numbers
        const numbers = user.phone_number.replace(/[^\d]/g, '');
        if (numbers.length > 3) {
          // Assume first 1-3 digits are country code
          const countryCode = numbers.slice(0, Math.min(3, numbers.length - 4));
          phoneDetails.countryCode = '+' + countryCode;
          phoneDetails.number = numbers.slice(countryCode.length);
        } else {
          // If all else fails, treat entire number as local number
          phoneDetails.number = numbers;
        }
      }
      console.log('Parsed phone details:', phoneDetails);
    }
    
    // Get user's shared links stats
    const [sharedLinksStats] = await pool.query(`
      SELECT COUNT(sl.id) as total_links, SUM(sl.clicks) as total_clicks, 
             COUNT(DISTINCT sl.link_id) as unique_links
      FROM shared_links sl
      WHERE sl.user_id = ?
    `, [userId]);
    
    let cartCount = 0;
    // Get user's cart count
    try {
      const [cartItems] = await pool.query(
        'SELECT SUM(quantity) as total FROM cart_items WHERE user_id = ?', 
        [userId]
      );
      if (cartItems && cartItems[0] && cartItems[0].total) {
        cartCount = parseInt(cartItems[0].total) || 0;
      }
    } catch (cartErr) {
      console.error('Error fetching cart count:', cartErr);
      // Continue with cartCount = 0
    }
    
    // Get user's recent orders
    let orders = [];
    try {
      const [ordersResult] = await pool.query(`
        SELECT o.*, op.product_count,
          (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) as total_items
        FROM orders o
        LEFT JOIN (
          SELECT order_id, COUNT(DISTINCT product_id) as product_count
          FROM order_items
          GROUP BY order_id
        ) op ON o.id = op.order_id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
        LIMIT 5
      `, [userId]);
      
      if (ordersResult && ordersResult.length > 0) {
        orders = ordersResult;
      }
    } catch (ordersErr) {
      console.error('Error fetching user orders:', ordersErr);
      // Continue with empty orders array
    }
    
    // Get user's recently shared links
    let recentLinks = [];
    try {
      const [recentLinksResult] = await pool.query(`
        SELECT sl.*, l.title, l.url, l.type, u.username as merchant_name,
        CONCAT('/l/', sl.share_code) as short_url
        FROM shared_links sl
        JOIN links l ON sl.link_id = l.id
        JOIN users u ON l.merchant_id = u.id
        WHERE sl.user_id = ?
        ORDER BY sl.created_at DESC
        LIMIT 5
      `, [userId]);
      
      if (recentLinksResult && recentLinksResult.length > 0) {
        recentLinks = recentLinksResult;
      }
    } catch (linksErr) {
      console.error('Error fetching recent links:', linksErr);
      // Continue with empty recentLinks array
    }
    
    // Get total earnings
    const [earnings] = await pool.query(`
      SELECT SUM(amount) as total
      FROM transactions
      WHERE user_id = ? AND type = 'commission'
    `, [userId]);
    
    const totalEarnings = earnings[0]?.total || 0;
    
    // Compile stats based on user role
    const stats = {
      totalLinks: sharedLinksStats[0]?.total_links || 0,
      totalClicks: sharedLinksStats[0]?.total_clicks || 0,
      uniqueLinks: sharedLinksStats[0]?.unique_links || 0,
      totalEarnings: parseFloat(totalEarnings || user.earnings || 0),
      orderCount: orders?.length || 0
    };
    
    // Additional stats for merchant users
    if (user.role === 'merchant') {
      const [linkCountResults] = await pool.query('SELECT COUNT(*) as count FROM links WHERE merchant_id = ?', [userId]);
      stats.totalLinks = linkCountResults[0].count || 0;
      
      const [clickResults] = await pool.query(`
        SELECT COALESCE(SUM(sl.clicks), 0) as totalClicks
        FROM links l
        LEFT JOIN shared_links sl ON l.id = sl.link_id
        WHERE l.merchant_id = ?
      `, [userId]);
      
      stats.totalClicks = clickResults[0].totalClicks || 0;
    }
    
    // Render user profile page with all the data
    res.render('user/profile', {
      user: user,
      stats: stats,
      phoneDetails: phoneDetails,
      orders: orders || [],
      recentLinks: recentLinks || [],
      cartCount: cartCount,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Profile page error:', err);
    res.status(500).render('error', { 
      message: 'Error loading profile',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Profile update route
router.post('/profile/update', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const {
      username,
      email,
      current_password,
      new_password,
      business_name,
      business_description,
      account_name,
      account_number,
      bank_code,
      country,
      phone,
      dialCode
    } = req.body;

    // Debug log the received form data
    console.log('Form data received:', {
      country,
      phone,
      dialCode
    });

    // Check if username or email already exists
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?',
      [username, email, userId]
    );

    if (existingUsers.length > 0) {
      // Get user data for re-rendering the page with error
      const [users] = await pool.query(`
        SELECT id, username, email, role, country, phone_number,
               business_name, business_description, account_name,
               account_number, bank_code, created_at, has_lifetime_commission
        FROM users WHERE id = ?`, [userId]);
      
      return res.render('user/profile', {
        user: users[0],
        error: 'Username or email already in use',
        stats: { totalLinks: 0, totalClicks: 0, totalEarnings: 0, orderCount: 0 },
        orders: [],
        recentLinks: [],
        phoneDetails: { countryCode: dialCode || '+1', number: phone || '' }
      });
    }
    
    // Format phone number with country code if both values exist
    let phone_number = null;
    if (phone || dialCode) {
      // Ensure we have both values
      if (!phone || !dialCode) {
        const [users] = await pool.query(`
          SELECT id, username, email, role, country, phone_number,
                 business_name, business_description, account_name,
                 account_number, bank_code, created_at, has_lifetime_commission 
          FROM users WHERE id = ?`, [userId]);
        
        return res.render('user/profile', {
          user: users[0],
          error: 'Please provide both phone number and select a country',
          stats: { totalLinks: 0, totalClicks: 0, totalEarnings: 0, orderCount: 0 },
          orders: [],
          recentLinks: [],
          phoneDetails: { countryCode: dialCode || '+1', number: phone || '' }
        });
      }
      
      // Clean up the phone number and dial code
      const cleanPhone = phone.replace(/[^\d]/g, '');
      const cleanDialCode = dialCode.replace(/[^\d]/g, '').replace(/^([^+])/, '+$1');
      
      // Validate phone number format
      if (cleanPhone.length < 6 || cleanPhone.length > 15) {
        const [users] = await pool.query(`
          SELECT id, username, email, role, country, phone_number,
                 business_name, business_description, account_name,
                 account_number, bank_code, created_at, has_lifetime_commission 
          FROM users WHERE id = ?`, [userId]);
        
        return res.render('user/profile', {
          user: users[0],
          error: 'Please enter a valid phone number (6-15 digits)',
          stats: { totalLinks: 0, totalClicks: 0, totalEarnings: 0, orderCount: 0 },
          orders: [],
          recentLinks: [],
          phoneDetails: { countryCode: cleanDialCode, number: cleanPhone }
        });
      }
      
      console.log('Setting phone number with:', { cleanDialCode, cleanPhone });
      phone_number = `${cleanDialCode}${cleanPhone}`;
      console.log('Final phone_number:', phone_number);
    }

    // Update basic info
    await pool.query(`
      UPDATE users 
      SET username = ?, 
          email = ?,
          business_name = ?,
          business_description = ?,
          account_name = ?,
          account_number = ?,
          bank_code = ?,
          country = ?,
          phone_number = ?
      WHERE id = ?
    `, [
      username,
      email,
      business_name || null,
      business_description || null,
      account_name || null,
      account_number || null,
      bank_code || null,
      country || null,
      phone_number || null,
      userId
    ]);

    // Update password if provided
    if (current_password && new_password) {
      const [user] = await pool.query('SELECT password FROM users WHERE id = ?', [userId]);
      const passwordMatch = await bcrypt.compare(current_password, user[0].password);

      if (!passwordMatch) {
        return res.redirect('/profile?error=' + encodeURIComponent('Current password is incorrect'));
      }

      const hashedPassword = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
    }

    // Redirect to the profile page with success message
    return res.redirect('/profile?success=' + encodeURIComponent('Profile updated successfully'));
    
  } catch (err) {
    console.error('Profile update error:', err);
    return res.status(500).render('error', { 
      message: 'Server error. Please try again later.',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Update payment details route (for the withdrawal flow)
router.post('/profile/update-payment-details', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { account_name, account_number, bank_code } = req.body;

    console.log('Payment details update request:', {
      userId,
      body: req.body,
      account_name,
      account_number,
      bank_code
    });

    // Validate required fields (check for empty strings and null/undefined)
    if (!account_name || account_name.trim() === '' || 
        !account_number || account_number.trim() === '' || 
        !bank_code || bank_code.trim() === '') {
      console.log('Validation failed - missing fields:', {
        account_name: account_name || 'missing',
        account_number: account_number || 'missing',
        bank_code: bank_code || 'missing'
      });
      return res.status(400).json({
        success: false,
        message: 'All payment details are required'
      });
    }

    // Update payment details
    await pool.query(`
      UPDATE users 
      SET account_name = ?, 
          account_number = ?,
          bank_code = ?
      WHERE id = ?
    `, [
      account_name.trim(),
      account_number.trim(),
      bank_code.trim(),
      userId
    ]);

    console.log('Payment details updated successfully for user:', userId);

    return res.json({
      success: true,
      message: 'Payment details updated successfully'
    });
    
  } catch (err) {
    console.error('Payment details update error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// View all shared links for a user
router.get('/shared-links', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get all shared links for the user with details
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, l.title, l.url, l.type, l.created_at as link_created,
             u.username as merchant_name, u.id as merchant_id,
             CONCAT('/l/', sl.share_code) as short_url
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON l.merchant_id = u.id
      WHERE sl.user_id = ?
      ORDER BY sl.clicks DESC
    `, [userId]);
    
    // Get total clicks and earnings from these links
    const [stats] = await pool.query(`
      SELECT COUNT(id) as total_links, SUM(clicks) as total_clicks
      FROM shared_links
      WHERE user_id = ?
    `, [userId]);
    
    // Get total earnings
    const [earnings] = await pool.query(`
      SELECT SUM(amount) as total
      FROM transactions
      WHERE user_id = ? AND type = 'commission'
    `, [userId]);
    
    // Create base URL for the links
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    // Render the shared links page
    res.render('user/shared-links', {
      user: req.user,
      sharedLinks,
      baseUrl,
      stats: {
        totalLinks: stats[0]?.total_links || 0,
        totalClicks: stats[0]?.total_clicks || 0,
        totalEarnings: earnings[0]?.total || 0
      },
      page: 'shared-links'
    });
  } catch (err) {
    console.error('Error fetching shared links:', err);
    res.status(500).render('error', {
      message: 'Error loading shared links',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// View all orders for a user
router.get('/orders', isActivated, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get user's orders with summary information
    const [orders] = await pool.query(`
      SELECT o.*, 
             COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [userId]);
    
    // Get summary stats
    const [statsData] = await pool.query(`
      SELECT COUNT(id) as total_orders, 
             SUM(total_amount) as total_spent,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders
      FROM orders
      WHERE user_id = ?
    `, [userId]);
    
    // Prepare stats object
    const stats = {
      totalOrders: statsData[0]?.total_orders || 0,
      totalSpent: statsData[0]?.total_spent || 0,
      completedOrders: statsData[0]?.completed_orders || 0
    };
    
    res.render('user/orders', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      orders: orders,
      stats: stats
    });
  } catch (err) {
    console.error('User orders error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// View single order details
router.get('/orders/:id', isActivated, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.session.userId;
    
    // Get order details
    const [orders] = await pool.query(`
      SELECT * FROM orders
      WHERE id = ? AND user_id = ?
    `, [orderId, userId]);
    
    if (orders.length === 0) {
      return res.status(404).render('error', { message: 'Order not found.' });
    }
    
    // Get order items
    const [orderItems] = await pool.query(`
      SELECT oi.*, p.name, p.image_url, u.username as merchant_name
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN users u ON p.merchant_id = u.id
      WHERE oi.order_id = ?
    `, [orderId]);
    
    // Get payment information from config
    const bankName = await getConfig('manual_payment_bank_name');
    const accountName = await getConfig('manual_payment_account_name');
    const accountNumber = await getConfig('manual_payment_account_number');
    const swiftCode = await getConfig('manual_payment_swift_code');
    
    const paymentInfo = {
      bankName: bankName || 'Bank of Africa',
      accountName: accountName || 'BenixSpace Ltd',
      accountNumber: accountNumber || '00012345678',
      swiftCode: swiftCode || null
    };
    
    res.render('user/order-details', {
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      },
      order: orders[0],
      items: orderItems,
      paymentInfo: paymentInfo
    });
  } catch (err) {
    console.error('Order details error:', err);
    res.status(500).render('error', { message: 'Server error. Please try again later.' });
  }
});

// User Activation Payment Routes
router.get('/user/activate', isAuthenticated, async (req, res) => {
  try {
    // Check if user is already activated
    if (req.user.status === 'active' && req.user.activation_paid) {
      return res.redirect('/dashboard?success=Your account is already activated');
    }

    // Get activation fee from settings
    const [settings] = await pool.query(`
      SELECT setting_key, setting_value, setting_type 
      FROM system_settings 
      WHERE setting_key IN ('activation_fee_rwf', 'supported_currencies')
    `);

    const settingsMap = {};
    settings.forEach(setting => {
      let value = setting.setting_value;
      if (setting.setting_type === 'json') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = setting.setting_value;
        }
      } else if (setting.setting_type === 'number') {
        value = parseFloat(value);
      }
      settingsMap[setting.setting_key] = value;
    });

    const activationFeeRwf = settingsMap.activation_fee_rwf || 3000;
    const supportedCurrencies = settingsMap.supported_currencies || ['RWF', 'USD', 'UGX', 'KES'];

    // Get currency conversion rates
    const currencyService = req.app.locals.currencyService;
    const exchangeRates = await currencyService.getExchangeRates();

    // Calculate fees in different currencies
    const fees = {};
    for (const currency of supportedCurrencies) {
      if (currency === 'RWF') {
        fees[currency] = activationFeeRwf;
      } else {
        fees[currency] = await currencyService.convertCurrency(activationFeeRwf, 'RWF', currency);
      }
    }

    res.render('user/activate', {
      user: req.user,
      activationFeeRwf: activationFeeRwf,
      fees: fees,
      supportedCurrencies: supportedCurrencies,
      exchangeRates: exchangeRates,
      successMessage: req.query.success,
      errorMessage: req.query.error,
      protocol: req.protocol,
      host: req.get('host')
    });
  } catch (err) {
    console.error('Activation page error:', err);
    res.redirect('/dashboard?error=Failed to load activation page');
  }
});

router.post('/user/activate/payment', isAuthenticated, async (req, res) => {
  try {
    console.log('Received request body:', req.body);
    console.log('Request headers:', req.headers['content-type']);
    
    const { currency, amount } = req.body;
    
    console.log('Extracted values - Currency:', currency, 'Amount:', amount);

    // Validate input parameters
    if (!currency || !amount) {
      console.log('Validation failed - missing currency or amount');
      return res.json({ success: false, error: 'Currency and amount are required' });
    }

    // Convert amount to number and validate
    const numericAmount = parseFloat(amount);
    console.log('Numeric amount:', numericAmount);
    
    if (isNaN(numericAmount) || numericAmount <= 0) {
      console.log('Invalid numeric amount:', numericAmount);
      return res.json({ success: false, error: 'Invalid amount provided' });
    }

    // Check if user is already activated
    if (req.user.status === 'active' && req.user.activation_paid) {
      return res.json({ success: false, error: 'Your account is already activated' });
    }

    // Validate user email
    console.log('User object:', JSON.stringify(req.user, null, 2));
    if (!req.user.email || req.user.email.trim() === '') {
      return res.json({ success: false, error: 'User email is required for payment processing' });
    }
    console.log('User email validation passed:', req.user.email);

    // Get services
    const flutterwaveService = req.app.locals.flutterwaveService;
    const currencyService = req.app.locals.currencyService;

    // Convert amount to USD for database storage
    let amountUsd;
    try {
      amountUsd = await currencyService.convertCurrency(numericAmount, currency, 'USD');
      console.log('Converted amount to USD:', amountUsd);
      
      // Validate conversion result
      if (isNaN(amountUsd) || amountUsd <= 0) {
        return res.json({ success: false, error: 'Currency conversion failed' });
      }
    } catch (conversionError) {
      console.error('Currency conversion error:', conversionError);
      return res.json({ success: false, error: 'Currency conversion failed' });
    }

    // Create payment with Flutterwave
    const paymentData = {
      tx_ref: `ACTIVATE_${req.user.id}_${Date.now()}`,
      amount: numericAmount,
      currency: currency.toUpperCase(),
      email: req.user.email.trim(),
      phone_number: req.user.phone_number || '',
      name: req.user.username || 'BenixSpace User',
      redirect_url: `${req.protocol}://${req.get('host')}/user/activate/callback`,
      meta: {
        user_id: req.user.id,
        purpose: 'activation'
      }
    };

    console.log('Payment data for Flutterwave:', JSON.stringify(paymentData, null, 2));

    const paymentResult = await flutterwaveService.createPaymentLink(paymentData);
    console.log('Payment result:', paymentResult);

    if (!paymentResult.success) {
      return res.json({ success: false, error: paymentResult.error || 'Failed to create payment link' });
    }

    const paymentLink = paymentResult.payment_link;
    console.log('Payment link created:', paymentLink);

    // Store payment record
    await pool.query(`
      INSERT INTO activation_payments (
        user_id, amount_usd, amount_original, currency, 
        flutterwave_tx_ref, payment_status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
    `, [req.user.id, amountUsd, numericAmount, currency.toUpperCase(), paymentData.tx_ref]);

    console.log('Payment record stored in database');

    res.json({ success: true, payment_link: paymentLink });
  } catch (err) {
    console.error('Activation payment error:', err);
    res.json({ success: false, error: 'Failed to create payment. Please try again.' });
  }
});

router.get('/user/activate/callback', async (req, res) => {
  try {
    const { tx_ref, status } = req.query;

    if (status === 'successful') {
      // Verify payment with Flutterwave
      const flutterwaveService = req.app.locals.flutterwaveService;
      const verification = await flutterwaveService.verifyPaymentByTxRef(tx_ref);

      if (verification.success) {
        // Update payment record
        await pool.query(`
          UPDATE activation_payments 
          SET payment_status = 'successful', 
              flutterwave_tx_id = ?,
              payment_response = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE flutterwave_tx_ref = ?
        `, [verification.data.id, JSON.stringify(verification.data), tx_ref]);

        // Get payment record to find user
        const [payments] = await pool.query(`
          SELECT user_id FROM activation_payments WHERE flutterwave_tx_ref = ?
        `, [tx_ref]);

        if (payments.length > 0) {
          const userId = payments[0].user_id;

          // Activate user
          await pool.query(`
            UPDATE users 
            SET status = 'active', 
                activation_paid = TRUE, 
                activated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `, [userId]);

          // Process commissions
          const commissionService = req.app.locals.commissionService;
          await commissionService.processActivationCommissions(userId);

          res.redirect('/dashboard?success=Account activated successfully! Welcome to BenixSpace!');
        } else {
          res.redirect('/user/activate?error=Payment verification failed');
        }
      } else {
        res.redirect('/user/activate?error=Payment verification failed');
      }
    } else if (status === 'cancelled') {
      // Update payment record
      await pool.query(`
        UPDATE activation_payments 
        SET payment_status = 'cancelled', 
            updated_at = CURRENT_TIMESTAMP
        WHERE flutterwave_tx_ref = ?
      `, [tx_ref]);
      
      res.redirect('/user/activate?error=Payment was cancelled');
    } else {
      res.redirect('/user/activate?error=Payment failed');
    }
  } catch (err) {
    console.error('Activation callback error:', err);
    res.redirect('/user/activate?error=Payment processing failed');
  }
});

module.exports = router;
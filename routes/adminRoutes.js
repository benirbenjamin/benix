const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Configure email transporter with enhanced error handling
const createEmailTransporter = () => {
  const config = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || ''
    },
    // Add debugging options
    debug: process.env.SMTP_DEBUG === 'true',
    logger: process.env.SMTP_DEBUG === 'true',
    // Connection timeout
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  };
  
  console.log('Email configuration:', {
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.auth.user ? config.auth.user.substring(0, 3) + '***' : 'not set'
  });
  
  return nodemailer.createTransport(config);
};

const transporter = createEmailTransporter();

// Test email connection and provide helpful error messages
const testEmailConnection = async () => {
  try {
    await transporter.verify();
    console.log('✅ Email server connection successful');
    return { success: true };
  } catch (error) {
    console.error('❌ Email server connection failed:', error.message);
    
    let helpMessage = '';
    if (error.code === 'ESOCKET' || error.code === 'ETIMEDOUT') {
      helpMessage = 'Connection timeout - check SMTP host and port settings';
    } else if (error.code === 'EAUTH') {
      helpMessage = 'Authentication failed - check SMTP username and password';
    } else if (error.responseCode === 535) {
      helpMessage = 'Invalid credentials - use app-specific password for Gmail';
    }
    
    return { 
      success: false, 
      error: error.message,
      help: helpMessage
    };
  }
};

// Test connection on startup (don't block the app)
testEmailConnection().then(result => {
  if (!result.success) {
    console.log('📧 Email setup help:', result.help);
    console.log('💡 Consider using Gmail with app-specific password or Mailtrap for testing');
  }
});

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

// Admin middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

  try {
    const [users] = await pool.query(
      'SELECT * FROM users WHERE id = ? AND role = "admin"',
      [req.session.userId]
    );

    if (users.length === 0) {
      return res.status(403).render('error', {
        message: 'Access Denied',
        error: { status: 403, stack: '' }
      });
    }

    // Add user to request
    req.user = users[0];
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).render('error', {
      message: 'Server error',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
};

// Admin dashboard route
router.get('/admin/dashboard', isAdmin, async (req, res) => {
  try {
    // Get counts for various entities
    const [productResults] = await pool.query('SELECT COUNT(*) as count FROM products');
    const [linkResults] = await pool.query('SELECT COUNT(*) as count FROM links');
    const [userResults] = await pool.query('SELECT COUNT(*) as count FROM users');
    const [orderResults] = await pool.query('SELECT COUNT(*) as count FROM orders');

    // Get recent products
    const [recentProducts] = await pool.query(`
      SELECT p.*, u.username as merchant_name 
      FROM products p 
      JOIN users u ON p.merchant_id = u.id
      ORDER BY p.created_at DESC LIMIT 5
    `);

    // Get recent links
    const [recentLinks] = await pool.query(`
      SELECT l.*, u.username as merchant_name 
      FROM links l 
      JOIN users u ON l.merchant_id = u.id
      ORDER BY l.created_at DESC LIMIT 5
    `);

    res.render('admin/dashboard', {
      user: req.user,
      counts: {
        products: productResults[0].count,
        links: linkResults[0].count,
        users: userResults[0].count,
        orders: orderResults[0].count
      },
      recentProducts,
      recentLinks
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).render('error', {
      message: 'Error loading admin dashboard',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Admin Products Management Routes
router.get('/admin/products', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const selectedMerchant = req.query.merchant || '';
    const selectedCategory = req.query.category || '';
    const selectedStatus = req.query.status || '';

    // Build the query with filters
    let query = `
      SELECT p.*, u.username as merchant_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (selectedMerchant) {
      query += ` AND p.merchant_id = ?`;
      queryParams.push(selectedMerchant);
    }
    
    if (selectedCategory) {
      query += ` AND p.category = ?`;
      queryParams.push(selectedCategory);
    }
    
    if (selectedStatus !== '') {
      query += ` AND p.is_active = ?`;
      queryParams.push(selectedStatus);
    }
    
    // Count query for pagination
    const [countResults] = await pool.query(
      `SELECT COUNT(*) as total FROM products p WHERE 1=1 ${
        selectedMerchant ? ' AND p.merchant_id = ?' : ''
      }${selectedCategory ? ' AND p.category = ?' : ''}${
        selectedStatus !== '' ? ' AND p.is_active = ?' : ''
      }`,
      queryParams
    );
    
    const totalProducts = countResults[0].total;
    const totalPages = Math.ceil(totalProducts / limit);
    
    // Add pagination to the query
    query += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    // Execute the query
    const [products] = await pool.query(query, queryParams);
    
    // Get merchants for filter
    const [merchants] = await pool.query(
      'SELECT id, username FROM users WHERE role = "merchant" ORDER BY username'
    );
    
    // Get all unique categories
    const [categoryResults] = await pool.query(
      'SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != "" ORDER BY category'
    );
    const categories = categoryResults.map(row => row.category);
    
    res.render('admin/products', {
      user: req.user,
      products,
      merchants,
      categories,
      currentPage: page,
      totalPages,
      selectedMerchant,
      selectedCategory,
      selectedStatus
    });
  } catch (err) {
    console.error('Admin products error:', err);
    res.status(500).render('error', {
      message: 'Error loading products',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Admin Links Management Routes
router.get('/admin/links', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const selectedMerchant = req.query.merchant || '';
    const selectedType = req.query.type || '';
    const selectedStatus = req.query.status || '';

    // Build the query with filters
    let query = `
      SELECT l.*, u.username as merchant_name,
      CASE WHEN l.type = 'product' THEN p.name ELSE NULL END as product_name
      FROM links l
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN products p ON l.type = 'product' AND l.id = p.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (selectedMerchant) {
      query += ` AND l.merchant_id = ?`;
      queryParams.push(selectedMerchant);
    }
    
    if (selectedType) {
      query += ` AND l.type = ?`;
      queryParams.push(selectedType);
    }
    
    if (selectedStatus !== '') {
      query += ` AND l.is_active = ?`;
      queryParams.push(selectedStatus);
    }
    
    // Count query for pagination
    const [countResults] = await pool.query(
      `SELECT COUNT(*) as total FROM links l WHERE 1=1 ${
        selectedMerchant ? ' AND l.merchant_id = ?' : ''
      }${selectedType ? ' AND l.type = ?' : ''}${
        selectedStatus !== '' ? ' AND l.is_active = ?' : ''
      }`,
      queryParams
    );
    
    const totalLinks = countResults[0].total;
    const totalPages = Math.ceil(totalLinks / limit);
    
    // Add pagination to the query
    query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    // Execute the query
    const [links] = await pool.query(query, queryParams);
    
    // Get merchants for filter
    const [merchants] = await pool.query(
      'SELECT id, username FROM users WHERE role = "merchant" ORDER BY username'
    );
    
    res.render('admin/links', {
      user: req.user,
      links,
      merchants,
      currentPage: page,
      totalPages,
      selectedMerchant,
      selectedType,
      selectedStatus
    });
  } catch (err) {
    console.error('Admin links error:', err);
    res.status(500).render('error', {
      message: 'Error loading links',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// API routes for admin actions

// Toggle product status
router.post('/admin/api/products/:id/toggle-status', isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const { is_active } = req.body;
    
    await pool.query(
      'UPDATE products SET is_active = ? WHERE id = ?',
      [is_active, productId]
    );
    
    res.json({ success: true, message: 'Product status updated successfully' });
  } catch (err) {
    console.error('Error updating product status:', err);
    res.status(500).json({ success: false, message: 'Failed to update product status' });
  }
});

// Toggle link status
router.post('/admin/api/links/:id/toggle-status', isAdmin, async (req, res) => {
  try {
    const linkId = req.params.id;
    const { is_active } = req.body;
    
    await pool.query(
      'UPDATE links SET is_active = ? WHERE id = ?',
      [is_active, linkId]
    );
    
    res.json({ success: true, message: 'Link status updated successfully' });
  } catch (err) {
    console.error('Error updating link status:', err);
    res.status(500).json({ success: false, message: 'Failed to update link status' });
  }
});

// Toggle user premium status
router.post('/admin/users/:id/toggle-premium', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get current premium status
    const [users] = await pool.query('SELECT has_lifetime_commission FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const currentStatus = users[0].has_lifetime_commission || 0;
    const newStatus = currentStatus ? 0 : 1;
    
    // Update user's premium status
    await pool.query(
      'UPDATE users SET has_lifetime_commission = ? WHERE id = ?',
      [newStatus, userId]
    );
    
    res.json({
      success: true,
      message: newStatus ? 'User upgraded to premium successfully' : 'Premium status removed successfully'
    });
  } catch (err) {
    console.error('Error toggling user premium status:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update user premium status'
    });
  }
});

// Product detail view for admin
router.get('/admin/products/:id', isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    
    const [products] = await pool.query(`
      SELECT p.*, u.username as merchant_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.id = ?
    `, [productId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', {
        message: 'Product not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const product = products[0];
    
    // Get merchant details if available
    let merchant = null;
    if (product.merchant_id) {
      const [merchantResults] = await pool.query(
        'SELECT id, username, email, phone_number FROM users WHERE id = ?', 
        [product.merchant_id]
      );
      
      if (merchantResults.length > 0) {
        merchant = merchantResults[0];
      }
    }
    
    // Get shared links for this product
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, u.username as shared_by
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON sl.user_id = u.id
      WHERE l.type = 'product' AND l.id = ?
      ORDER BY sl.clicks DESC
    `, [productId]);
    
    res.render('admin/product-detail', {
      user: req.user,
      product,
      merchant,
      sharedLinks
    });
  } catch (err) {
    console.error('Admin product detail error:', err);
    res.status(500).render('error', {
      message: 'Error loading product details',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Link detail view for admin
router.get('/admin/links/:id', isAdmin, async (req, res) => {
  try {
    const linkId = req.params.id;
    
    const [links] = await pool.query(`
      SELECT l.*, u.username as merchant_name,
      CASE WHEN l.type = 'product' THEN p.name ELSE NULL END as product_name,
      CASE WHEN l.type = 'product' THEN p.image_url ELSE NULL END as product_image
      FROM links l
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN products p ON l.type = 'product' AND l.id = p.id
      WHERE l.id = ?
    `, [linkId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', {
        message: 'Link not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const link = links[0];
    
    // Get shared links info
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, u.username as shared_by
      FROM shared_links sl
      JOIN users u ON sl.user_id = u.id
      WHERE sl.link_id = ?
      ORDER BY sl.clicks DESC
    `, [linkId]);
    
    res.render('admin/link-detail', {
      user: req.user,
      link,
      sharedLinks
    });
  } catch (err) {
    console.error('Admin link detail error:', err);
    res.status(500).render('error', {
      message: 'Error loading link details',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Edit product form for admin
router.get('/admin/products/:id/edit', isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    
    // Get product details
    const [products] = await pool.query(`
      SELECT p.*, u.username as merchant_name
      FROM products p
      JOIN users u ON p.merchant_id = u.id
      WHERE p.id = ?
    `, [productId]);
    
    if (products.length === 0) {
      return res.status(404).render('error', {
        message: 'Product not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const product = products[0];
    
    // Get all merchants for dropdown
    const [merchants] = await pool.query(
      'SELECT id, username FROM users WHERE role = "merchant" ORDER BY username'
    );
    
    // Get all unique categories for dropdown
    const [categoryResults] = await pool.query(
      'SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != "" ORDER BY category'
    );
    const categories = categoryResults.map(row => row.category);
      res.render('admin/edit-product', {
      user: req.user,
      product,
      merchants,
      categories,
      req: req,
      error: req.query.error,
      success: req.query.success
    });
  } catch (err) {
    console.error('Admin edit product error:', err);
    res.status(500).render('error', {
      message: 'Error loading product edit form',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Update product (form submission)
router.post('/admin/products/:id/edit', isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    
    console.log('Product update form data:', req.body); // Log form data for debugging
    console.log('Form fields received:', Object.keys(req.body)); // Log the field names
    
    // Extract form fields with proper defaults
    const name = req.body.name || '';
    const description = req.body.description || '';
    const price = req.body.price || '0';
    const stock = req.body.stock || '0';
    const category = req.body.category || '';
    const merchant_id = req.body.merchant_id || null;
    const commission_rate = req.body.commission_rate || '0';
    const is_active = req.body.is_active || false;
    
    // Validate form data to prevent NaN values
    if (!name || name.trim() === '') {
      console.log('Name validation failed, received:', name);
      return res.redirect(`/admin/products/${productId}/edit?error=Product name is required`);
    }
    
    // Parse numeric values safely
    const safePrice = parseFloat(price) || 0;
    const safeStock = parseInt(stock) || 0;
    const safeCommissionRate = parseFloat(commission_rate) || 0;
    
    // Check for NaN values
    if (isNaN(safePrice) || isNaN(safeStock) || isNaN(safeCommissionRate)) {
      console.log('Numeric validation failed:', { safePrice, safeStock, safeCommissionRate });
      return res.redirect(`/admin/products/${productId}/edit?error=Invalid numeric values provided`);
    }
    
    // Ensure is_active is properly set
    const isActiveValue = is_active === 'on' || is_active === '1' || is_active === true ? 1 : 0;    console.log('About to update product with data:', {
      name,
      description,
      price: safePrice,
      stock: safeStock,
      category,
      merchant_id,
      commission_rate: safeCommissionRate,
      is_active: isActiveValue,
      productId
    });

    // Check if the updated_at column exists in the products table
    try {
      // Update product in database with updated_at timestamp
      await pool.query(`
        UPDATE products 
        SET name = ?, description = ?, price = ?, stock = ?, 
            category = ?, merchant_id = ?, commission_rate = ?, is_active = ?,
            updated_at = NOW()
        WHERE id = ?
      `, [
        name, 
        description || null, 
        safePrice, 
        safeStock, 
        category || null, 
        merchant_id || null, 
        safeCommissionRate, 
        isActiveValue,
        productId
      ]);
    } catch (innerErr) {
      // If the error is about the updated_at column missing
      if (innerErr.sqlMessage && innerErr.sqlMessage.includes("Unknown column 'updated_at'")) {
        // Try again without the updated_at field
        await pool.query(`
          UPDATE products 
          SET name = ?, description = ?, price = ?, stock = ?, 
              category = ?, merchant_id = ?, commission_rate = ?, is_active = ?
          WHERE id = ?
        `, [
          name, 
          description || null, 
          safePrice, 
          safeStock, 
          category || null, 
          merchant_id || null, 
          safeCommissionRate, 
          isActiveValue,
          productId
        ]);
        
        console.log('Product updated without updated_at field. Consider running the migration to add this column.');
      } else {
        // Re-throw the error if it's not about the missing column
        throw innerErr;
      }
    }
      res.redirect(`/admin/products/${productId}?success=Product updated successfully`);} catch (err) {
    console.error('Admin update product error:', err);
    res.redirect(`/admin/products/${req.params.id}/edit?error=Failed to update product.`);
  }
});

// Edit link form for admin
router.get('/admin/links/:id/edit', isAdmin, async (req, res) => {
  try {
    const linkId = req.params.id;
    
    // Get link details
    const [links] = await pool.query(`
      SELECT l.*, u.username as merchant_name
      FROM links l
      JOIN users u ON l.merchant_id = u.id
      WHERE l.id = ?
    `, [linkId]);
    
    if (links.length === 0) {
      return res.status(404).render('error', {
        message: 'Link not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const link = links[0];
    
    // Get all merchants for dropdown
    const [merchants] = await pool.query(
      'SELECT id, username FROM users WHERE role = "merchant" ORDER BY username'
    );
    
    res.render('admin/edit-link', {
      user: req.user,
      link,
      merchants,
      req: req,
      error: req.query.error,
      success: req.query.success
    });
  } catch (err) {
    console.error('Admin edit link error:', err);
    res.status(500).render('error', {
      message: 'Error loading link edit form',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Update link (form submission)
router.post('/admin/links/:id/edit', isAdmin, async (req, res) => {
  try {
    const linkId = req.params.id;
    const { 
      title, description, type, url, category, 
      merchant_id, click_target, cost_per_click, is_active 
    } = req.body;
    
    // Validate form data
    if (!title || title.trim() === '') {
      return res.redirect(`/admin/links/${linkId}/edit?error=Link title is required`);
    }
    
    if (!url || url.trim() === '') {
      return res.redirect(`/admin/links/${linkId}/edit?error=URL is required`);
    }
    
    // Parse numeric values safely
    const safeClickTarget = click_target ? parseInt(click_target) : 0;
    const safeCostPerClick = cost_per_click ? parseFloat(cost_per_click) : 0;
    
    // Check for NaN values
    if (isNaN(safeClickTarget) || isNaN(safeCostPerClick)) {
      return res.redirect(`/admin/links/${linkId}/edit?error=Invalid numeric values provided`);
    }
    
    // Ensure is_active is properly set
    const isActiveValue = is_active === 'on' || is_active === '1' || is_active === true ? 1 : 0;
    
    // Update link in database
    await pool.query(`
      UPDATE links 
      SET title = ?, description = ?, type = ?, url = ?, 
          category = ?, merchant_id = ?, click_target = ?, 
          cost_per_click = ?, is_active = ?
      WHERE id = ?
    `, [
      title, 
      description || null, 
      type,
      url, 
      category || null, 
      merchant_id, 
      safeClickTarget, 
      safeCostPerClick,
      isActiveValue,
      linkId
    ]);
    
    res.redirect(`/admin/links/${linkId}?success=Link updated successfully`);
  } catch (err) {
    console.error('Admin update link error:', err);
    res.redirect(`/admin/links/${req.params.id}/edit?error=Failed to update link. ${err.message}`);
  }
});

// Migration handler route for admin
router.get('/admin/run-migration/:name', isAdmin, async (req, res) => {
  try {
    const migrationName = req.params.name;
    
    // Validate migration name to prevent security issues
    if (!/^[a-z0-9_]+$/i.test(migrationName)) {
      return res.status(400).send('Invalid migration name format');
    }
    
    // Path to migration file
    const migrationPath = path.join(__dirname, '..', 'migrations', `${migrationName}.sql`);
    
    // Check if file exists
    if (!fs.existsSync(migrationPath)) {
      return res.status(404).send(`Migration file ${migrationName}.sql not found`);
    }
    
    // Read SQL from file
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the SQL (for complex migrations with multiple statements, you might need to split and execute separately)
    await pool.query(sql);
    
    return res.send(`Migration ${migrationName} applied successfully`);
  } catch (err) {
    console.error('Migration error:', err);
    return res.status(500).send(`Migration failed: ${err.message}`);
  }
});

// Users management route
router.get('/admin/users', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const selectedRole = req.query.role || '';
    const searchQuery = req.query.search || '';

    // Build the query with filters - check which tables exist
    let hasSharedLinksTable = false;
    let hasOrdersTable = false;
    
    try {
      await pool.query('SELECT 1 FROM shared_links LIMIT 1');
      hasSharedLinksTable = true;
    } catch (err) {
      console.log('Shared_links table not found in users list');
    }
    
    try {
      await pool.query('SELECT 1 FROM orders LIMIT 1');
      hasOrdersTable = true;
    } catch (err) {
      console.log('Orders table not found in users list');
    }
    
    let query = `
      SELECT u.*
             ${hasSharedLinksTable ? ', (SELECT COUNT(*) FROM shared_links WHERE user_id = u.id) as total_shared_links' : ', 0 as total_shared_links'}
             ${hasOrdersTable ? ', (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders' : ', 0 as total_orders'}
      FROM users u
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (selectedRole) {
      query += ` AND u.role = ?`;
      queryParams.push(selectedRole);
    }
    
    if (searchQuery) {
      query += ` AND (u.username LIKE ? OR u.email LIKE ?)`;
      queryParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    
    // Count query for pagination
    const [countResults] = await pool.query(
      `SELECT COUNT(*) as total FROM users u WHERE 1=1 ${
        selectedRole ? ' AND u.role = ?' : ''
      }${searchQuery ? ' AND (u.username LIKE ? OR u.email LIKE ?)' : ''}`,
      queryParams
    );
    
    const totalUsers = countResults[0].total;
    const totalPages = Math.ceil(totalUsers / limit);
    
    // Add pagination to the query
    query += ` ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    // Execute the query
    const [users] = await pool.query(query, queryParams);
    
    res.render('admin/users', {
      user: req.user,
      users,
      currentPage: page,
      totalPages,
      selectedRole,
      searchQuery
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).render('error', {
      message: 'Error loading users',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Export users (must be before /admin/users/:id route)
router.get('/admin/users/export', isAdmin, async (req, res) => {
  try {
    const selectedRole = req.query.role || '';
    const searchQuery = req.query.search || '';
    const format = req.query.format || 'page';

    // Build the query with filters (same as users list)
    // Check which tables exist to avoid errors
    let hasCommissionsTable = false;
    let hasSharedLinksTable = false;
    let hasOrdersTable = false;
    
    try {
      await pool.query('SELECT 1 FROM commissions LIMIT 1');
      hasCommissionsTable = true;
    } catch (err) {
      console.log('Commissions table not found, skipping commission data');
    }
    
    try {
      await pool.query('SELECT 1 FROM shared_links LIMIT 1');
      hasSharedLinksTable = true;
    } catch (err) {
      console.log('Shared_links table not found, skipping shared links data');
    }
    
    try {
      await pool.query('SELECT 1 FROM orders LIMIT 1');
      hasOrdersTable = true;
    } catch (err) {
      console.log('Orders table not found, skipping orders data');
    }

    // Check if updated_at column exists
    let hasUpdatedAtColumn = false;
    try {
      await pool.query('SELECT updated_at FROM users LIMIT 1');
      hasUpdatedAtColumn = true;
    } catch (err) {
      console.log('Updated_at column not found in users table for export');
    }

    let query = `
      SELECT u.id, u.username, u.email, u.role, u.wallet, u.has_lifetime_commission,
             u.created_at${hasUpdatedAtColumn ? ', u.updated_at' : ', u.created_at as updated_at'}
             ${hasSharedLinksTable ? ', (SELECT COUNT(*) FROM shared_links WHERE user_id = u.id) as total_shared_links' : ', 0 as total_shared_links'}
             ${hasOrdersTable ? ', (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders' : ', 0 as total_orders'}
             ${hasCommissionsTable ? ', (SELECT COALESCE(SUM(commission_amount), 0) FROM commissions WHERE user_id = u.id) as total_commissions' : ', 0 as total_commissions'}
      FROM users u
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (selectedRole && selectedRole !== '') {
      query += ' AND u.role = ?';
      queryParams.push(selectedRole);
    }
    
    if (searchQuery && searchQuery.trim() !== '') {
      query += ' AND (u.username LIKE ? OR u.email LIKE ?)';
      queryParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    
    query += ' ORDER BY u.created_at DESC';
    
    console.log('Export query:', query);
    console.log('Export params:', queryParams);
    
    // Execute the query
    const [users] = await pool.query(query, queryParams);
    
    console.log(`Found ${users.length} users for export`);

    if (format === 'csv') {
      // Generate CSV
      const csv = generateCSV(users);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="users_export_${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } else if (format === 'json') {
      // Return JSON
      res.json({
        success: true,
        data: users,
        count: users.length
      });
    } else {
      // Render export results page
      res.render('admin/export-results', {
        success: true,
        data: users,
        count: users.length,
        filters: {
          role: selectedRole,
          search: searchQuery
        }
      });
    }
  } catch (err) {
    console.error('Error exporting users:', err);
    
    if (req.query.format === 'csv' || req.query.format === 'json') {
      res.status(500).json({
        success: false,
        message: 'Failed to export users: ' + err.message
      });
    } else {
      // Render error page
      res.render('admin/export-results', {
        success: false,
        message: err.message,
        data: [],
        count: 0,
        filters: {
          role: req.query.role || '',
          search: req.query.search || ''
        }
      });
    }
  }
});

// Helper function to generate CSV
function generateCSV(users) {
  const headers = [
    'ID', 'Username', 'Email', 'Role', 'Wallet Balance', 'Premium Status',
    'Total Shared Links', 'Total Orders', 'Total Commissions', 'Joined Date', 'Last Updated'
  ];
  
  let csv = headers.join(',') + '\n';
  
  users.forEach(user => {
    const row = [
      user.id,
      `"${user.username}"`,
      `"${user.email}"`,
      user.role,
      parseFloat(user.wallet || 0).toFixed(4),
      user.has_lifetime_commission ? 'Premium' : 'Regular',
      user.total_shared_links || 0,
      user.total_orders || 0,
      parseFloat(user.total_commissions || 0).toFixed(4),
      `"${new Date(user.created_at).toLocaleDateString()}"`,
      `"${new Date(user.updated_at || user.created_at).toLocaleDateString()}"`
    ];
    csv += row.join(',') + '\n';
  });
  
  return csv;
}

// User detail view for admin
router.get('/admin/users/:id', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check which tables exist
    let hasSharedLinksTable = false;
    let hasOrdersTable = false;
    let hasTransactionsTable = false;
    let hasReferralsTable = false;
    
    try {
      await pool.query('SELECT 1 FROM shared_links LIMIT 1');
      hasSharedLinksTable = true;
    } catch (err) {
      console.log('Shared_links table not found in user detail');
    }
    
    try {
      await pool.query('SELECT 1 FROM orders LIMIT 1');
      hasOrdersTable = true;
    } catch (err) {
      console.log('Orders table not found in user detail');
    }
    
    try {
      await pool.query('SELECT 1 FROM transactions LIMIT 1');
      hasTransactionsTable = true;
    } catch (err) {
      console.log('Transactions table not found in user detail');
    }
    
    try {
      await pool.query('SELECT 1 FROM referrals LIMIT 1');
      hasReferralsTable = true;
    } catch (err) {
      console.log('Referrals table not found in user detail');
    }
    
    // Get detailed user information
    const [users] = await pool.query(`
      SELECT u.*
             ${hasSharedLinksTable ? ', (SELECT COUNT(*) FROM shared_links WHERE user_id = u.id) as total_shared_links' : ', 0 as total_shared_links'}
             ${hasOrdersTable ? ', (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders' : ', 0 as total_orders'}
      FROM users u
      WHERE u.id = ?
    `, [userId]);
    
    if (users.length === 0) {
      return res.status(404).render('error', {
        message: 'User not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const user = users[0];
    
    // Get user's orders (if table exists)
    let orders = [];
    if (hasOrdersTable) {
      try {
        const [orderResults] = await pool.query(`
          SELECT o.*, 
                 COUNT(oi.id) as item_count,
                 SUM(oi.price * oi.quantity) as order_value
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          WHERE o.user_id = ?
          GROUP BY o.id
          ORDER BY o.created_at DESC
          LIMIT 10
        `, [userId]);
        orders = orderResults;
      } catch (err) {
        console.log('Error fetching orders:', err.message);
        orders = [];
      }
    }
    
    // Get user's shared links (if table exists)
    let sharedLinks = [];
    if (hasSharedLinksTable) {
      try {
        const [sharedLinkResults] = await pool.query(`
          SELECT sl.*, l.title, l.type, l.url, u.username as merchant_name
          FROM shared_links sl
          JOIN links l ON sl.link_id = l.id
          JOIN users u ON l.merchant_id = u.id
          WHERE sl.user_id = ?
          ORDER BY sl.clicks DESC
          LIMIT 10
        `, [userId]);
        sharedLinks = sharedLinkResults;
      } catch (err) {
        console.log('Error fetching shared links:', err.message);
        sharedLinks = [];
      }
    }
    
    // Get user's transactions (if table exists)
    let transactions = [];
    if (hasTransactionsTable) {
      try {
        const [transactionResults] = await pool.query(`
          SELECT * FROM transactions
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `, [userId]);
        transactions = transactionResults;
      } catch (err) {
        console.log('Error fetching transactions:', err.message);
        transactions = [];
      }
    }
    
    // Get referrals (if table exists)
    let referrals = [];
    if (hasReferralsTable) {
      try {
        const [referralResults] = await pool.query(`
          SELECT r.*, u.username as referred_username, u.email as referred_email,
                 u.created_at as referred_created_at
          FROM referrals r
          JOIN users u ON r.referred_id = u.id
          WHERE r.referrer_id = ?
          ORDER BY r.created_at DESC
        `, [userId]);
        referrals = referralResults;
      } catch (err) {
        console.log('Error fetching referrals:', err.message);
        referrals = [];
      }
    }
    
    res.render('admin/user-detail', {
      user: req.user, // Admin user
      targetUser: user, // User being viewed
      orders,
      sharedLinks,
      transactions,
      referrals,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin user detail error:', err);
    res.status(500).render('error', {
      message: 'Error loading user details',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Edit user form
router.get('/admin/users/:id/edit', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get user information
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).render('error', {
        message: 'User not found',
        error: { status: 404, stack: '' }
      });
    }
    
    const targetUser = users[0];
    
    res.render('admin/user-edit', {
      user: req.user, // Admin user
      targetUser: targetUser, // User being edited
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin user edit form error:', err);
    res.status(500).render('error', {
      message: 'Error loading user edit form',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Update user information
router.post('/admin/users/:id/edit', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { 
      username, email, role, phone_number, wallet, earnings, 
      has_lifetime_commission, business_name, business_description,
      account_name, account_number, bank_name, notes 
    } = req.body;
    
    // Validate required fields
    if (!username || !email) {
      return res.redirect(`/admin/users/${userId}/edit?error=Username and email are required`);
    }
    
    // Check if username/email already exists (excluding current user)
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?',
      [username, email, userId]
    );
    
    if (existingUsers.length > 0) {
      return res.redirect(`/admin/users/${userId}/edit?error=Username or email already exists`);
    }
    
    // Parse numeric values safely
    const safeWallet = wallet ? parseFloat(wallet) : 0;
    const safeEarnings = earnings ? parseFloat(earnings) : 0;
    const safePremiumStatus = has_lifetime_commission === '1' ? 1 : 0;
    
    // Check for NaN values
    if (isNaN(safeWallet) || isNaN(safeEarnings)) {
      return res.redirect(`/admin/users/${userId}/edit?error=Invalid numeric values provided`);
    }
    
    // Update user information - handle missing columns gracefully
    try {
      // Try with all fields including updated_at timestamp
      await pool.query(`
        UPDATE users 
        SET username = ?, email = ?, role = ?, phone_number = ?, wallet = ?, 
            earnings = ?, has_lifetime_commission = ?, business_name = ?, 
            business_description = ?, account_name = ?, account_number = ?, 
            bank_name = ?, notes = ?, updated_at = NOW()
        WHERE id = ?
      `, [
        username, email, role, phone_number || null, safeWallet, 
        safeEarnings, safePremiumStatus, business_name || null, 
        business_description || null, account_name || null, 
        account_number || null, bank_name || null, notes || null, userId
      ]);
    } catch (innerErr) {
      // If some columns don't exist, try with basic fields only
      if (innerErr.sqlMessage && (innerErr.sqlMessage.includes("Unknown column") || innerErr.sqlMessage.includes("doesn't exist"))) {
        console.log('Some columns missing, trying with basic fields:', innerErr.sqlMessage);
        
        // Try with minimal columns that should exist
        await pool.query(`
          UPDATE users 
          SET username = ?, email = ?, role = ?, business_name = ?, business_description = ?
          WHERE id = ?
        `, [username, email, role, business_name || null, business_description || null, userId]);
        
        console.log('User updated with basic fields only. Some advanced fields may not be saved due to missing columns.');
      } else {
        throw innerErr;
      }
    }
    
    res.redirect(`/admin/users/${userId}?success=User updated successfully`);
  } catch (err) {
    console.error('Admin user update error:', err);
    res.redirect(`/admin/users/${req.params.id}/edit?error=Failed to update user`);
  }
});

// Reset user password
router.post('/admin/users/:id/set-password', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { new_password } = req.body;
    
    console.log('Password reset request:', { userId, passwordLength: new_password ? new_password.length : 'undefined', password: new_password });
    
    if (!new_password || new_password.trim().length < 8) {
      console.log('Password validation failed:', { received: new_password, length: new_password ? new_password.length : 'undefined' });
      
      // Check if it's an AJAX request
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') || 
          req.headers['x-requested-with'] === 'XMLHttpRequest' ||
          req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }
      
      // For regular form submissions, render an error page
      return res.status(400).render('error', {
        error: 'Password Reset Failed',
        message: 'Password must be at least 8 characters long',
        details: 'Please ensure the password is at least 8 characters long and try again.',
        backUrl: '/admin/users'
      });
    }
    
    // Check if user exists
    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') || 
          req.headers['x-requested-with'] === 'XMLHttpRequest' ||
          req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      return res.status(404).render('error', {
        error: 'User Not Found',
        message: 'The specified user could not be found',
        details: 'The user may have been deleted or the ID is invalid.',
        backUrl: '/admin/users'
      });
    }
    
    // Hash the new password
    const bcrypt = require('bcrypt');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);
    
    // Update user's password
    await pool.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );
    
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') || 
        req.headers['x-requested-with'] === 'XMLHttpRequest' ||
        req.headers.accept && req.headers.accept.includes('application/json')) {
      res.json({
        success: true,
        message: 'Password has been reset successfully'
      });
    } else {
      // For regular form submissions, redirect with success message
      req.flash('success', 'Password has been reset successfully');
      res.redirect('/admin/users');
    }
  } catch (err) {
    console.error('Error resetting user password:', err);
    
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') || 
        req.headers['x-requested-with'] === 'XMLHttpRequest' ||
        req.headers.accept && req.headers.accept.includes('application/json')) {
      res.status(500).json({
        success: false,
        message: 'Failed to reset password'
      });
    } else {
      res.status(500).render('error', {
        error: 'Password Reset Failed',
        message: 'An error occurred while resetting the password',
        details: 'Please try again later or contact support if the problem persists.',
        backUrl: '/admin/users'
      });
    }
  }
});

// Update user notes
router.post('/admin/users/:id/update-notes', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { notes } = req.body;
    
    // Check if user exists
    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Update user's notes
    await pool.query(
      'UPDATE users SET notes = ? WHERE id = ?',
      [notes, userId]
    );
    
    res.json({
      success: true,
      message: 'User notes updated successfully'
    });
  } catch (err) {
    console.error('Error updating user notes:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update user notes'
    });
  }
});

// Delete user
router.delete('/admin/users/:id/delete', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check if user exists
    const [users] = await pool.query('SELECT id, role FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Don't allow deletion of admin users
    if (users[0].role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete admin users'
      });
    }
    
    // Delete user (in production, you might want to use a transaction here)
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    res.json({
      success: true,
      message: 'User has been deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
});

// Contact individual user
router.post('/admin/users/contact-individual', isAdmin, async (req, res) => {
  try {
    console.log('Individual contact request received:', {
      body: req.body,
      hasSubject: !!req.body.subject,
      hasMessage: !!req.body.message,
      subjectLength: req.body.subject ? req.body.subject.length : 0,
      messageLength: req.body.message ? req.body.message.length : 0
    });
    
    const { userId, email, subject, message } = req.body;

    if (!userId || !email || !subject || !message) {
      console.log('Validation failed:', { userId: !!userId, email: !!email, subject: !!subject, message: !!message });
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Get user information
    const [users] = await pool.query('SELECT id, username, email FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    // Send email using nodemailer
    const mailOptions = {
      from: `"BenixSpace Admin" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
            <h2 style="color: #212529;">BenixSpace</h2>
            <p style="color: #6c757d;">Admin Message</p>
          </div>
          <div style="padding: 30px; background-color: white;">
            <h3 style="color: #212529;">Hello ${user.username},</h3>
            <div style="line-height: 1.6; color: #495057;">
              ${message.replace(/\n/g, '<br>')}
            </div>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
            <p style="color: #6c757d; font-size: 14px;">
              This message was sent by BenixSpace Admin. If you have any questions, please contact our support team.
            </p>
          </div>
          <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
            <p style="color: #6c757d; font-size: 12px; margin: 0;">
              © 2025 BenixSpace. All rights reserved.
            </p>
          </div>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully to user ${userId}`);
    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError);
      
      // Provide specific error messages
      let errorMessage = 'Failed to send email';
      if (emailError.code === 'ESOCKET' || emailError.code === 'ETIMEDOUT') {
        errorMessage = 'Email server connection timeout. Please check SMTP settings.';
      } else if (emailError.code === 'EAUTH') {
        errorMessage = 'Email authentication failed. Please check credentials.';
      } else if (emailError.responseCode === 535) {
        errorMessage = 'Invalid email credentials. Use app-specific password for Gmail.';
      }
      
      return res.status(500).json({
        success: false,
        message: errorMessage,
        details: emailError.message
      });
    }

    // Log the email in the database (optional - you can create an emails table)
    // await pool.query(
    //   'INSERT INTO admin_emails (admin_id, user_id, subject, message, sent_at) VALUES (?, ?, ?, ?, NOW())',
    //   [req.user.id, userId, subject, message]
    // );

    res.json({
      success: true,
      message: 'Email sent successfully'
    });
  } catch (err) {
    console.error('Error sending email to user:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send email: ' + err.message
    });
  }
});

// Contact all users (bulk email)
router.post('/admin/users/contact-all', isAdmin, async (req, res) => {
  try {
    console.log('Bulk contact request received:', {
      body: req.body,
      hasSubject: !!req.body.subject,
      hasMessage: !!req.body.message,
      subjectLength: req.body.subject ? req.body.subject.length : 0,
      messageLength: req.body.message ? req.body.message.length : 0,
      filters: { role: req.body.role, search: req.body.search }
    });
    
    const { subject, message, role, search } = req.body;

    if (!subject || !message) {
      console.log('Bulk contact validation failed:', { subject: !!subject, message: !!message });
      return res.status(400).json({
        success: false,
        message: 'Subject and message are required'
      });
    }

    // Build the query with filters (same as the display query)
    let query = 'SELECT id, username, email, role FROM users WHERE 1=1';
    const queryParams = [];
    
    // Apply the same filters as the current view
    if (role && role !== '') {
      query += ' AND role = ?';
      queryParams.push(role);
    }
    
    if (search && search.trim() !== '') {
      query += ' AND (username LIKE ? OR email LIKE ?)';
      queryParams.push(`%${search}%`, `%${search}%`);
    }

    // Get all users matching the filters
    const [users] = await pool.query(query, queryParams);

    if (users.length === 0) {
      return res.json({
        success: false,
        message: 'No users found matching the current filters'
      });
    }

    // Send emails to all users
    let successCount = 0;
    let failedCount = 0;

    for (const user of users) {
      try {
        const mailOptions = {
          from: `"BenixSpace Admin" <${process.env.SMTP_USER}>`,
          to: user.email,
          subject: subject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                <h2 style="color: #212529;">BenixSpace</h2>
                <p style="color: #6c757d;">Admin ${role ? role.charAt(0).toUpperCase() + role.slice(1) + ' ' : ''}Announcement</p>
              </div>
              <div style="padding: 30px; background-color: white;">
                <h3 style="color: #212529;">Hello ${user.username},</h3>
                <div style="line-height: 1.6; color: #495057;">
                  ${message.replace(/\n/g, '<br>')}
                </div>
                <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
                <p style="color: #6c757d; font-size: 14px;">
                  This message was sent to ${role ? 'all ' + role + 's' : 'users'} on BenixSpace. If you have any questions, please contact our support team.
                </p>
              </div>
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                <p style="color: #6c757d; font-size: 12px; margin: 0;">
                  © 2025 BenixSpace. All rights reserved.
                </p>
              </div>
            </div>
          `
        };

        try {
          await transporter.sendMail(mailOptions);
          successCount++;
          console.log(`✅ Email sent to ${user.email}`);
        } catch (emailError) {
          failedCount++;
          console.error(`❌ Failed to send email to ${user.email}:`, emailError.message);
        }

        // Add a small delay to avoid overwhelming the SMTP server
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (emailError) {
        console.error(`Failed to send email to ${user.email}:`, emailError);
        failedCount++;
      }
    }

    // Build result message
    let resultMessage = `Email sent to ${successCount} ${role || 'user'}${successCount !== 1 ? 's' : ''}`;
    if (failedCount > 0) {
      resultMessage += `, ${failedCount} failed`;
    }

    res.json({
      success: true,
      message: resultMessage,
      count: successCount,
      failed: failedCount,
      filters: { role, search }
    });
  } catch (err) {
    console.error('Error sending bulk email:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send bulk email: ' + err.message
    });
  }
});

// Contact all merchants specifically
router.post('/admin/users/contact-merchants', isAdmin, async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Subject and message are required'
      });
    }

    // Get all merchants
    const [merchants] = await pool.query('SELECT id, username, email FROM users WHERE role = "merchant"');

    if (merchants.length === 0) {
      return res.json({
        success: false,
        message: 'No merchants found'
      });
    }

    // Send emails to all merchants
    let successCount = 0;
    let failedCount = 0;

    for (const merchant of merchants) {
      try {
        const mailOptions = {
          from: `"BenixSpace Admin" <${process.env.SMTP_USER}>`,
          to: merchant.email,
          subject: subject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                <h2 style="color: #212529;">BenixSpace</h2>
                <p style="color: #6c757d;">Admin Message to Merchants</p>
              </div>
              <div style="padding: 30px; background-color: white;">
                <h3 style="color: #212529;">Hello ${merchant.username},</h3>
                <div style="line-height: 1.6; color: #495057;">
                  ${message.replace(/\n/g, '<br>')}
                </div>
                <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
                <p style="color: #6c757d; font-size: 14px;">
                  This message was sent to all merchants on BenixSpace. If you have any questions, please contact our support team.
                </p>
              </div>
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                <p style="color: #6c757d; font-size: 12px; margin: 0;">
                  © 2025 BenixSpace. All rights reserved.
                </p>
              </div>
            </div>
          `
        };

        try {
          await transporter.sendMail(mailOptions);
          successCount++;
          console.log(`✅ Email sent to merchant ${merchant.email}`);
        } catch (emailError) {
          failedCount++;
          console.error(`❌ Failed to send email to merchant ${merchant.email}:`, emailError.message);
        }

        // Add a small delay to avoid overwhelming the SMTP server
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (emailError) {
        console.error(`Failed to send email to merchant ${merchant.email}:`, emailError);
        failedCount++;
      }
    }

    res.json({
      success: true,
      message: `Email sent to ${successCount} merchant${successCount !== 1 ? 's' : ''}${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
      count: successCount,
      failed: failedCount
    });
  } catch (err) {
    console.error('Error sending email to merchants:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send email to merchants: ' + err.message
    });
  }
});

// Test email configuration route (only in development)
router.get('/admin/test-email', isAdmin, async (req, res) => {
  try {
    // Test connection first
    const connectionTest = await testEmailConnection();
    
    if (!connectionTest.success) {
      return res.json({
        success: false,
        message: 'Email server connection failed',
        error: connectionTest.error,
        help: connectionTest.help,
        config: {
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          secure: process.env.SMTP_SECURE,
          user: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 3) + '***' : 'not set'
        }
      });
    }

    // Send test email
    const testMailOptions = {
      from: `"BenixSpace Test" <${process.env.SMTP_USER}>`,
      to: req.user.email,
      subject: 'Email Configuration Test - BenixSpace',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #28a745; padding: 20px; text-align: center;">
            <h2 style="color: white; margin: 0;">✅ Email Test Successful!</h2>
          </div>
          <div style="padding: 30px; background-color: white;">
            <h3>Congratulations ${req.user.username}!</h3>
            <p>Your email configuration is working correctly.</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <strong>Configuration Details:</strong><br>
              Host: ${process.env.SMTP_HOST}<br>
              Port: ${process.env.SMTP_PORT}<br>
              Secure: ${process.env.SMTP_SECURE}<br>
              User: ${process.env.SMTP_USER}
            </div>
            <p>You can now use the email features in your admin panel.</p>
          </div>
        </div>
      `
    };

    await transporter.sendMail(testMailOptions);

    res.json({
      success: true,
      message: 'Test email sent successfully! Check your inbox.',
      sentTo: req.user.email
    });

  } catch (error) {
    console.error('Test email failed:', error);
    
    let errorMessage = 'Test email failed';
    if (error.code === 'ESOCKET' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Connection timeout - check SMTP host and port';
    } else if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed - check SMTP credentials';
    }
    
    res.json({
      success: false,
      message: errorMessage,
      error: error.message,
      config: {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE,
        user: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 3) + '***' : 'not set'
      }
    });
  }
});

// Admin register new user route
router.get('/admin/register', isAdmin, async (req, res) => {
  try {
    res.render('admin/register-user', {
      user: req.user,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin register form error:', err);
    res.status(500).render('error', {
      message: 'Error loading register form',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Admin register new user POST route
router.post('/admin/register', isAdmin, async (req, res) => {
  try {
    const { 
      username, email, password, role, phone_number, wallet, earnings,
      has_lifetime_commission, business_name, business_description,
      account_name, account_number, bank_name, notes 
    } = req.body;
    
    // Validate required fields
    if (!username || !email || !password) {
      return res.redirect('/admin/register?error=Username, email, and password are required');
    }
    
    if (password.length < 8) {
      return res.redirect('/admin/register?error=Password must be at least 8 characters long');
    }
    
    // Check if username/email already exists
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existingUsers.length > 0) {
      return res.redirect('/admin/register?error=Username or email already exists');
    }
    
    // Hash password
    const bcrypt = require('bcrypt');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Parse numeric values safely
    const safeWallet = wallet ? parseFloat(wallet) : 0;
    const safeEarnings = earnings ? parseFloat(earnings) : 0;
    const safePremiumStatus = has_lifetime_commission === '1' ? 1 : 0;
    
    // Check for NaN values
    if (isNaN(safeWallet) || isNaN(safeEarnings)) {
      return res.redirect('/admin/register?error=Invalid numeric values provided');
    }
    
    // Insert new user - handle missing columns gracefully
    try {
      // Try with all fields first
      const [result] = await pool.query(`
        INSERT INTO users (
          username, email, password, role, phone_number, wallet, 
          earnings, has_lifetime_commission, business_name, business_description,
          account_name, account_number, bank_name, notes, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())
      `, [
        username, email, hashedPassword, role || 'user', phone_number || null,
        safeWallet, safeEarnings, safePremiumStatus, business_name || null,
        business_description || null, account_name || null, account_number || null,
        bank_name || null, notes || null
      ]);
      
      const newUserId = result.insertId;
      return res.redirect(`/admin/users/${newUserId}?success=User created successfully`);
    } catch (innerErr) {
      // If some columns don't exist, try progressively with fewer columns
      if (innerErr.sqlMessage && (innerErr.sqlMessage.includes("Unknown column") || innerErr.sqlMessage.includes("doesn't exist"))) {
        console.log('Some columns missing, trying with basic fields:', innerErr.sqlMessage);
        
        try {
          // Try with basic fields but include status and timestamps
          const [result] = await pool.query(`
            INSERT INTO users (username, email, password, role, business_name, business_description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())
          `, [username, email, hashedPassword, role || 'user', business_name || null, business_description || null]);
          
          const newUserId = result.insertId;
          return res.redirect(`/admin/users/${newUserId}?success=User created successfully (some fields may not be saved due to missing columns)`);
        } catch (secondErr) {
          // Try with minimal columns
          if (secondErr.sqlMessage && (secondErr.sqlMessage.includes("Unknown column 'status'") || secondErr.sqlMessage.includes("Unknown column 'updated_at'"))) {
            const [result] = await pool.query(`
              INSERT INTO users (username, email, password, role, business_name, business_description)
              VALUES (?, ?, ?, ?, ?, ?)
            `, [username, email, hashedPassword, role || 'user', business_name || null, business_description || null]);
            
            const newUserId = result.insertId;
            return res.redirect(`/admin/users/${newUserId}?success=User created successfully (basic fields only)`);
          }
          throw secondErr;
        }
      } else {
        throw innerErr;
      }
    }
  } catch (err) {
    console.error('Admin register user error:', err);
    res.redirect('/admin/register?error=Failed to create user: ' + err.message);
  }
});

module.exports = router;
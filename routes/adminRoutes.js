const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

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

    // Build the query with filters
    let query = `
      SELECT u.*, 
             (SELECT COUNT(*) FROM shared_links WHERE user_id = u.id) as total_shared_links,
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders
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

// User detail view for admin
router.get('/admin/users/:id', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get detailed user information
    const [users] = await pool.query(`
      SELECT u.*, 
             (SELECT COUNT(*) FROM shared_links WHERE user_id = u.id) as total_shared_links,
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders
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
    
    // Get user's orders
    const [orders] = await pool.query(`
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
    
    // Get user's shared links
    const [sharedLinks] = await pool.query(`
      SELECT sl.*, l.title, l.type, l.url, u.username as merchant_name
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON l.merchant_id = u.id
      WHERE sl.user_id = ?
      ORDER BY sl.clicks DESC
      LIMIT 10
    `, [userId]);
    
    // Get user's transactions
    const [transactions] = await pool.query(`
      SELECT * FROM transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `, [userId]);
    
    // Get referrals if any
    const [referrals] = await pool.query(`
      SELECT r.*, u.username as referred_username, u.email as referred_email,
             u.created_at as referred_created_at
      FROM referrals r
      JOIN users u ON r.referred_id = u.id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `, [userId]);
    
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

// Reset user password
router.post('/admin/users/:id/set-password', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { new_password } = req.body;
    
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }
    
    // Check if user exists
    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
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
    
    res.json({
      success: true,
      message: 'Password has been reset successfully'
    });
  } catch (err) {
    console.error('Error resetting user password:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password'
    });
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

module.exports = router;
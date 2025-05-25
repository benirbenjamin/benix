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

module.exports = router;
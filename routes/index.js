const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');

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

// Homepage route with proper stats calculation
router.get('/', async (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Get links recently shared by the current user (last 24 hours) to exclude them
    let recentlySharedLinkIds = [];
    if (userId) {
      try {
        const [recentShares] = await pool.query(`
          SELECT DISTINCT link_id 
          FROM shared_links 
          WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        `, [userId]);
        recentlySharedLinkIds = recentShares.map(share => share.link_id);
      } catch (err) {
        console.log('Error fetching recently shared links:', err);
        // Continue without filtering if table doesn't exist
      }
    }

    // Build exclusion condition for recently shared links
    const excludeRecentShares = recentlySharedLinkIds.length > 0 
      ? `AND l.id NOT IN (${recentlySharedLinkIds.map(() => '?').join(',')})` 
      : '';

    // Get top 3 most viewed links (any type) based on views, excluding recently shared by user
    const popularVideosQuery = `
      SELECT l.*, l.clicks_count AS total_clicks, u.business_name as merchant_name, u.username
      FROM links l 
      JOIN users u ON l.merchant_id = u.id 
      WHERE l.is_active = true ${excludeRecentShares}
      ORDER BY l.clicks_count DESC, l.created_at DESC
      LIMIT 3
    `;
    const popularVideos = await pool.query(popularVideosQuery, recentlySharedLinkIds);

    // Get all links to filter out the popular ones for recent links, excluding recently shared by user
    const allLinksQuery = `
      SELECT l.*, l.clicks_count AS total_clicks, u.business_name as merchant_name, u.username
      FROM links l 
      JOIN users u ON l.merchant_id = u.id 
      WHERE l.is_active = true ${excludeRecentShares}
      ORDER BY l.created_at DESC
    `;
    const allLinksForFiltering = await pool.query(allLinksQuery, recentlySharedLinkIds);

    // Filter out the popular links from all links to get recent ones
    const popularIds = (popularVideos[0] || []).map(link => link.id);
    const filteredRecentLinks = (allLinksForFiltering[0] || []).filter(link => !popularIds.includes(link.id));
    const recentLinks = [filteredRecentLinks.slice(0, 3)];

    // Get remaining links (skip first 6: 3 popular + 3 recent)
    const remainingLinks = filteredRecentLinks.slice(3, 103); // Get 100 more links
    const mainLinks = [remainingLinks];

    // Get all products
    const products = await pool.query(`
      SELECT p.*, u.business_name as merchant_name, u.username 
      FROM products p 
      JOIN users u ON p.merchant_id = u.id 
      WHERE p.is_active = true 
      ORDER BY p.created_at DESC 
      LIMIT 6
    `);

    // Get featured merchants
    const merchants = await pool.query(`
      SELECT u.*, COUNT(p.id) as product_count 
      FROM users u 
      LEFT JOIN products p ON u.id = p.merchant_id 
      WHERE u.role = 'merchant' 
      GROUP BY u.id 
      ORDER BY product_count DESC 
      LIMIT 6
    `);

    // Calculate proper stats
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users WHERE role != "admin"');
    const clickCountResult = await pool.query('SELECT COUNT(*) as total FROM clicks');
    const linkCountResult = await pool.query('SELECT COUNT(*) as count FROM links WHERE is_active = true');
    const earningsResult = await pool.query('SELECT SUM(earnings) as total FROM users WHERE earnings > 0');

    const stats = {
      userCount: userCountResult[0][0]?.count || 0,
      clickCount: clickCountResult[0][0]?.total || 0,
      totalLinks: linkCountResult[0][0]?.count || 0,
      totalEarnings: earningsResult[0][0]?.total || 0
    };

    res.render('index', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      popularVideos: popularVideos[0] || [],
      recentLinks: recentLinks[0] || [],
      links: mainLinks[0] || [],
      products: products[0] || [],
      merchants: merchants[0] || [],
      stats: stats
    });
  } catch (error) {
    console.error('Homepage error:', error);
    res.render('index', {
      user: req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      popularVideos: [],
      recentLinks: [],
      links: [],
      products: [],
      merchants: [],
      stats: { userCount: 0, clickCount: 0, linkCount: 0, totalEarnings: 0 }
    });
  }
});

// Currency converter test page
router.get('/currency-test', (req, res) => {
  res.render('currency-test', {
    user: req.session.userId ? {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role
    } : null,
    cartCount: req.session.cartCount || 0
  });
});

// API endpoint for loading more links
router.get('/api/links/load-more', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 14;
    const offset = (page - 1) * limit;
    const userId = req.session.userId;

    // Get links recently shared by the current user (last 24 hours) to exclude them
    let recentlySharedLinkIds = [];
    if (userId) {
      try {
        const [recentShares] = await pool.query(`
          SELECT DISTINCT link_id 
          FROM shared_links 
          WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        `, [userId]);
        recentlySharedLinkIds = recentShares.map(share => share.link_id);
      } catch (err) {
        console.log('Error fetching recently shared links for load-more:', err);
        // Continue without filtering if table doesn't exist
      }
    }

    // Build exclusion condition for recently shared links
    const excludeRecentShares = recentlySharedLinkIds.length > 0 
      ? `AND l.id NOT IN (${recentlySharedLinkIds.map(() => '?').join(',')})` 
      : '';

    const queryParams = [...recentlySharedLinkIds, limit, offset];
    const linksQuery = `
      SELECT l.*, l.clicks_count AS total_clicks, u.business_name as merchant_name, u.username
      FROM links l 
      JOIN users u ON l.merchant_id = u.id 
      WHERE l.is_active = true ${excludeRecentShares}
      ORDER BY l.created_at DESC 
      LIMIT ? OFFSET ?
    `;

    const links = await pool.query(linksQuery, queryParams);

    res.json({
      success: true,
      links: links[0],
      page: page,
      hasMore: links[0].length === limit
    });
  } catch (error) {
    console.error('Error loading more links:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load more links'
    });
  }
});

// API endpoint for loading more products
router.get('/api/products/load-more', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 14;
    const offset = (page - 1) * limit;

    const products = await pool.query(`
      SELECT p.*, u.business_name as merchant_name 
      FROM products p 
      JOIN users u ON p.merchant_id = u.id 
      WHERE p.is_active = true 
      ORDER BY p.created_at DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({
      success: true,
      products: products[0],
      page: page,
      hasMore: products[0].length === limit
    });
  } catch (error) {
    console.error('Error loading more products:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load more products'
    });
  }
});

// API endpoint for time ago calculations
router.get('/api/time-ago/:timestamp', (req, res) => {
  try {
    const timestamp = decodeURIComponent(req.params.timestamp);
    const date = new Date(timestamp);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);
    
    let timeAgo;
    if (diffInSeconds < 60) {
      timeAgo = 'Just now';
    } else if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      timeAgo = `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 86400) {
      const hours = Math.floor(diffInSeconds / 3600);
      timeAgo = `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 2592000) {
      const days = Math.floor(diffInSeconds / 86400);
      timeAgo = `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 31536000) {
      const months = Math.floor(diffInSeconds / 2592000);
      timeAgo = `${months} month${months > 1 ? 's' : ''} ago`;
    } else {
      const years = Math.floor(diffInSeconds / 31536000);
      timeAgo = `${years} year${years > 1 ? 's' : ''} ago`;
    }
    
    res.json({ timeAgo });
  } catch (error) {
    console.error('Error calculating time ago:', error);
    res.json({ timeAgo: 'Recently' });
  }
});

// User profile route
router.get('/user/:username', async (req, res) => {
  try {
    const username = req.params.username;
    
    // Get user information
    const [users] = await pool.query(
      'SELECT id, username, business_name, business_description, created_at, role FROM users WHERE username = ?',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(404).render('error', {
        message: 'User not found',
        error: { status: 404, stack: '' },
        user: req.session.userId ? req.user : undefined
      });
    }
    
    const profileUser = users[0];
    
    // Get user's links (if they're a merchant)
    let userLinks = [];
    if (profileUser.role === 'merchant') {
      const [links] = await pool.query(`
        SELECT l.*, l.clicks_count AS total_clicks
        FROM links l 
        WHERE l.merchant_id = ? AND l.is_active = true
        ORDER BY l.created_at DESC
        LIMIT 10
      `, [profileUser.id]);
      userLinks = links;
    }
    
    // Get user's products (if they're a merchant)
    let userProducts = [];
    if (profileUser.role === 'merchant') {
      const [products] = await pool.query(`
        SELECT * FROM products 
        WHERE merchant_id = ? 
        ORDER BY created_at DESC
        LIMIT 10
      `, [profileUser.id]);
      userProducts = products;
    }
    
    // Get stats for this user
    const stats = {
      totalLinks: userLinks.length,
      totalProducts: userProducts.length,
      totalViews: userLinks.reduce((sum, link) => sum + (link.total_clicks || 0), 0)
    };
    
    res.render('user-profile', {
      user: req.session.userId ? req.user : undefined,
      profileUser,
      userLinks,
      userProducts,
      stats,
      title: `${profileUser.business_name || profileUser.username} - Profile`
    });
    
  } catch (error) {
    console.error('Error loading user profile:', error);
    res.status(500).render('error', {
      message: 'Error loading user profile',
      error: { status: 500, stack: error.stack },
      user: req.session.userId ? req.user : undefined
    });
  }
});

// Merchant profile route (alias for user profile but specifically for merchants)
router.get('/merchant/:username', async (req, res) => {
  try {
    const username = req.params.username;
    
    // Get merchant information
    const [users] = await pool.query(
      'SELECT id, username, business_name, business_description, created_at, role FROM users WHERE username = ? AND role = "merchant"',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(404).render('error', {
        message: 'Merchant not found',
        error: { status: 404, stack: '' },
        user: req.session.userId ? req.user : undefined
      });
    }
    
    const merchant = users[0];
    
    // Get merchant's links
    const [links] = await pool.query(`
      SELECT l.*, l.clicks_count AS total_clicks
      FROM links l 
      WHERE l.merchant_id = ? AND l.is_active = true
      ORDER BY l.created_at DESC
      LIMIT 20
    `, [merchant.id]);
    
    // Get merchant's products
    const [products] = await pool.query(`
      SELECT * FROM products 
      WHERE merchant_id = ? 
      ORDER BY created_at DESC
      LIMIT 20
    `, [merchant.id]);
    
    // Get stats for this merchant
    const stats = {
      totalLinks: links.length,
      totalProducts: products.length,
      totalViews: links.reduce((sum, link) => sum + (link.total_clicks || 0), 0)
    };
    
    res.render('merchant-profile', {
      user: req.session.userId ? req.user : undefined,
      merchant,
      links,
      products,
      stats,
      title: `${merchant.business_name || merchant.username} - Merchant Profile`
    });
    
  } catch (error) {
    console.error('Error loading merchant profile:', error);
    res.status(500).render('error', {
      message: 'Error loading merchant profile',
      error: { status: 500, stack: error.stack },
      user: req.session.userId ? req.user : undefined
    });
  }
});

module.exports = router;
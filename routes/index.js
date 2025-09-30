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

// Helper function to get config values
async function getConfig(key) {
  const [rows] = await pool.query('SELECT value FROM config WHERE key_name = ?', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

// Homepage route with proper stats calculation and lazy loading
router.get('/', async (req, res) => {
  try {
    const userId = req.session.userId;
    console.log('Home page accessed with session userId:', userId);

    // Get basic stats (lightweight query)
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

    // Get minimal blog posts for hero section
    let blogPosts = [];
    let userCommissionPercentage = 30;
    
    try {
      userCommissionPercentage = await getConfig('user_commission_percentage') || 30;
      
      const blogPostsQuery = `
        SELECT 
          bp.id, bp.title, bp.excerpt, bp.featured_image, bp.slug, bp.created_at,
          COALESCE(bp.content, bp.excerpt, 'No preview available') as description,
          COALESCE(u.business_name, u.username, 'BenixSpace') as author_name,
          COALESCE(bp.view_count, 0) as view_count
        FROM blog_posts bp
        JOIN users u ON bp.merchant_id = u.id
        WHERE bp.is_active = true
        ORDER BY bp.created_at DESC
        LIMIT 3
      `;
      const blogResult = await pool.query(blogPostsQuery);
      blogPosts = blogResult[0] || [];
    } catch (blogError) {
      console.log('Blog posts query error:', blogError.message);
    }

    // Get featured merchants
    const merchants = await pool.query(`
      SELECT u.id, u.username, u.business_name, u.business_description, u.created_at,
             COUNT(p.id) as product_count
      FROM users u 
      LEFT JOIN products p ON u.id = p.merchant_id AND p.is_active = true
      WHERE u.role = 'merchant'
      GROUP BY u.id, u.username, u.business_name, u.business_description, u.created_at
      ORDER BY u.created_at DESC
      LIMIT 6
    `);

    // Format dates for merchants to avoid "Invalid Date" issues
    const formattedMerchants = merchants[0].map(merchant => {
      let formattedDate = 'recently';
      
      if (merchant.created_at) {
        try {
          const joinDate = new Date(merchant.created_at);
          if (joinDate && !isNaN(joinDate.getTime())) {
            formattedDate = joinDate.toLocaleDateString();
          }
        } catch (e) {
          console.log(`Error formatting date for merchant ${merchant.id}:`, e);
        }
      }
      
      return {
        ...merchant,
        formatted_join_date: formattedDate
      };
    });

    // Load initial content for ALL users (both logged-in and non-logged-in)
    let initialData = {
      recentLinks: [],
      popularVideos: [],
      links: [],
      products: []
    };

    try {
      // Get recent links with proper merchant names - load all to show shared links
      const recentLinksQuery = `
        SELECT l.id, l.title, l.description, l.image_url, l.type, l.url, l.clicks_count, l.created_at,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username,
               ${userId ? `CASE WHEN sl.id IS NOT NULL THEN 1 ELSE 0 END` : '0'} as is_shared_by_user
        FROM links l 
        JOIN users u ON l.merchant_id = u.id 
        ${userId ? 'LEFT JOIN shared_links sl ON l.id = sl.link_id AND sl.user_id = ?' : ''}
        WHERE l.is_active = true
        ORDER BY ${userId ? 'is_shared_by_user ASC,' : ''} l.created_at DESC
      `;
      const recentLinksParams = userId ? [userId] : [];
      const recentLinks = await pool.query(recentLinksQuery, recentLinksParams);
      initialData.recentLinks = (recentLinks[0] || []).map(link => ({
        ...link,
        is_shared_by_user: Boolean(link.is_shared_by_user)
      }));

      // Get popular links
      const popularLinksQuery = `
        SELECT l.id, l.title, l.description, l.image_url, l.type, l.url, l.clicks_count, l.created_at,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username,
               ${userId ? `CASE WHEN sl.id IS NOT NULL THEN 1 ELSE 0 END` : '0'} as is_shared_by_user
        FROM links l 
        JOIN users u ON l.merchant_id = u.id 
        ${userId ? 'LEFT JOIN shared_links sl ON l.id = sl.link_id AND sl.user_id = ?' : ''}
        WHERE l.is_active = true
        ORDER BY ${userId ? 'is_shared_by_user ASC,' : ''} l.clicks_count DESC, l.created_at DESC
        LIMIT 6
      `;
      const popularLinksParams = userId ? [userId] : [];
      const popularLinks = await pool.query(popularLinksQuery, popularLinksParams);
      initialData.popularVideos = (popularLinks[0] || []).map(link => ({
        ...link,
        is_shared_by_user: Boolean(link.is_shared_by_user)
      }));
      
      // If no popular links found, use recent links as fallback
      if (initialData.popularVideos.length === 0) {
        console.log('No popular links found, using recent links as fallback');
        initialData.popularVideos = initialData.recentLinks.slice(0, 3);
      }

      // Get main links for the main section
      const mainLinksQuery = `
        SELECT l.id, l.title, l.description, l.image_url, l.type, l.url, l.clicks_count, l.created_at,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username,
               ${userId ? `CASE WHEN sl.id IS NOT NULL THEN 1 ELSE 0 END` : '0'} as is_shared_by_user
        FROM links l 
        JOIN users u ON l.merchant_id = u.id 
        ${userId ? 'LEFT JOIN shared_links sl ON l.id = sl.link_id AND sl.user_id = ?' : ''}
        WHERE l.is_active = true
        ORDER BY ${userId ? 'is_shared_by_user ASC,' : ''} l.created_at DESC
      `;
      const mainLinksParams = userId ? [userId] : [];
      const mainLinks = await pool.query(mainLinksQuery, mainLinksParams);
      initialData.links = (mainLinks[0] || []).map(link => ({
        ...link,
        is_shared_by_user: Boolean(link.is_shared_by_user)
      }));

      // Get products
      const productsQuery = `
        SELECT p.id, p.name, p.description, p.image_url, p.price, p.created_at,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username 
        FROM products p 
        JOIN users u ON p.merchant_id = u.id 
        WHERE p.is_active = true 
        ORDER BY p.created_at DESC 
        LIMIT 8
      `;
      const products = await pool.query(productsQuery);
      initialData.products = products[0] || [];
      
      console.log('Homepage data loaded for user:', userId ? 'logged in' : 'not logged in');
      console.log('- Recent links:', initialData.recentLinks.length);
      console.log('- Popular videos:', initialData.popularVideos.length);
      console.log('- Main links:', initialData.links.length);
      console.log('- Products:', initialData.products.length);
      
      // Debug sample data
      if (initialData.recentLinks.length > 0) {
        console.log('Sample recent link:', {
          id: initialData.recentLinks[0].id,
          title: initialData.recentLinks[0].title,
          merchant_name: initialData.recentLinks[0].merchant_name,
          type: initialData.recentLinks[0].type,
          clicks_count: initialData.recentLinks[0].clicks_count,
          is_shared_by_user: initialData.recentLinks[0].is_shared_by_user,
          is_shared_by_user_type: typeof initialData.recentLinks[0].is_shared_by_user
        });
      }
      
      // Debug sharing status for all links
      if (userId && initialData.links.length > 0) {
        const sharedCount = initialData.links.filter(link => link.is_shared_by_user === true).length;
        console.log(`User ${userId} has shared ${sharedCount} out of ${initialData.links.length} links on homepage`);
      }
    } catch (contentError) {
      console.error('Error loading initial content:', contentError);
      // Continue with empty arrays - page will still load
    }

    res.render('index', {
      user: userId ? {
        id: userId,
        username: req.session.username,
        role: req.session.role
      } : null,
      popularVideos: initialData.popularVideos,
      recentLinks: initialData.recentLinks,
      links: initialData.links, // Now populated for all users
      products: initialData.products,
      merchants: formattedMerchants || [],
      blogPosts: blogPosts,
      userCommissionPercentage: userCommissionPercentage,
      stats: stats,
      lazyLoad: false // Disable lazy loading, show all initial content immediately
    });
    
    console.log('Home page rendered with user:', userId ? 'logged in' : 'not logged in', '- lazy loading disabled');
  } catch (error) {
    console.error('Homepage error:', error);
    // Fallback response to ensure page still loads
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
      blogPosts: [],
      userCommissionPercentage: 30,
      stats: { userCount: 0, clickCount: 0, totalLinks: 0, totalEarnings: 0 },
      lazyLoad: false
    });
  }
});



// Auto Ads API Routes
router.get('/api/ads/active', async (req, res) => {
  try {
    const [ads] = await pool.query(`
      SELECT b.* 
      FROM banners b
      WHERE b.status = 'approved' 
      AND b.is_active = true
      ORDER BY RAND()
      LIMIT 4
    `);

    res.json(ads);
  } catch (err) {
    console.error('Error fetching active ads:', err);
    res.status(500).json({ error: 'Failed to fetch ads' });
  }
});

// Ad impression and click tracking moved to adRoutes.js

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

// API endpoint for loading more links (updated for both user types)
router.get('/api/links/load-more', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 14;
    const offset = (page - 1) * limit;
    const userId = req.session.userId;

    // Skip the first 12 items that were already loaded on the homepage
    const adjustedOffset = offset + 12;

    let links;
    if (userId) {
      // Query for logged-in users with share status and proper ordering
      const linksQuery = `
        SELECT l.id, l.title, l.description, l.image_url, l.type, l.url, l.clicks_count, l.created_at, l.price,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username,
               CASE 
                 WHEN sl.id IS NOT NULL THEN 1 
                 ELSE 0 
               END as is_shared_by_user
        FROM links l 
        JOIN users u ON l.merchant_id = u.id 
        LEFT JOIN shared_links sl ON l.id = sl.link_id AND sl.user_id = ?
        WHERE l.is_active = true
        ORDER BY is_shared_by_user ASC, l.created_at DESC 
        LIMIT ? OFFSET ?
      `;
      links = await pool.query(linksQuery, [userId, limit, adjustedOffset]);
    } else {
      // Query for non-logged-in users (no share status needed)
      const linksQuery = `
        SELECT l.id, l.title, l.description, l.image_url, l.type, l.url, l.clicks_count, l.created_at, l.price,
               COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name, 
               u.username,
               0 as is_shared_by_user
        FROM links l 
        JOIN users u ON l.merchant_id = u.id 
        WHERE l.is_active = true
        ORDER BY l.created_at DESC 
        LIMIT ? OFFSET ?
      `;
      links = await pool.query(linksQuery, [limit, adjustedOffset]);
    }

    res.json({
      success: true,
      links: (links[0] || []).map(link => ({
        ...link,
        is_shared_by_user: Boolean(link.is_shared_by_user)
      })),
      page: page,
      hasMore: (links[0] || []).length === limit
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

    // Skip the first 8 items that were already loaded on the homepage
    const adjustedOffset = offset + 8;

    const products = await pool.query(`
      SELECT p.*, COALESCE(u.business_name, u.username, 'BenixSpace') as merchant_name 
      FROM products p 
      JOIN users u ON p.merchant_id = u.id 
      WHERE p.is_active = true 
      ORDER BY p.created_at DESC 
      LIMIT ? OFFSET ?
    `, [limit, adjustedOffset]);

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
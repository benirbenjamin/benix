const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const analyticsService = require('../services/analyticsService');

// Configure multer for file uploads
const upload = multer({
  dest: path.join(__dirname, '../public/uploads/'),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      req.fileValidationError = 'Please upload only JPG, PNG, or GIF images.';
      return cb(null, false);
    }
    cb(null, true);
  }
});

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

// Get database configuration
const config = require('../config');
const pool = mysql.createPool(config.db);

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
    // Get time period from query params
    const period = req.query.period || 'today';
    const customStart = req.query.startDate;
    const customEnd = req.query.endDate;

    // Get total counts for all entities
    const [[productResults], [linkResults], [userResults], [orderResults], [blogResults]] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM products'),
      pool.query('SELECT COUNT(*) as count FROM links'),
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM orders'),
      pool.query('SELECT COUNT(*) as count FROM blog_posts')
    ]);

    // Fetch analytics data for all user types
    const [usersData, merchantsData, platformData] = await Promise.all([
      analyticsService.getUsersAnalytics(period, customStart, customEnd),
      analyticsService.getMerchantsAnalytics(period, customStart, customEnd),
      analyticsService.getPlatformAnalytics(period, customStart, customEnd)
    ]);

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

    // Get recent blog posts
    let recentBlogPosts = [];
    try {
      const [blogPostsResult] = await pool.query(`
        SELECT bp.*, u.username as author_name,
               COALESCE(bp.view_count, 0) as total_views,
               COALESCE(bp.click_count, 0) as total_clicks,
               (SELECT COUNT(*) FROM blog_post_shares WHERE blog_post_id = bp.id) as total_shares
        FROM blog_posts bp 
        LEFT JOIN users u ON bp.merchant_id = u.id
        ORDER BY bp.created_at DESC LIMIT 5
      `);
      recentBlogPosts = blogPostsResult;
    } catch (blogError) {
      console.error('Error fetching recent blog posts for dashboard:', blogError);
      recentBlogPosts = []; // Set to empty array if there's an error
    }

    // Get top performers leaderboard
    const [topPerformers] = await pool.query(`
      SELECT u.id, u.username, u.wallet, u.earnings,
             COALESCE(referrals.referral_count, 0) as referral_count,
             COALESCE(links.total_shared_links, 0) as total_shared_links,
             COALESCE(orders.total_orders, 0) as total_orders,
             COALESCE(orders.total_spent, 0) as total_spent,
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
        SELECT user_id, COUNT(*) as total_orders, SUM(total_amount) as total_spent
        FROM orders
        WHERE status = 'completed'
        GROUP BY user_id
      ) orders ON u.id = orders.user_id
      WHERE u.role != 'admin'
      ORDER BY performance_score DESC
      LIMIT 5
    `);

    res.render('admin/dashboard', {
      user: req.user,
      counts: {
        products: productResults.count,
        links: linkResults.count,
        users: userResults.count,
        orders: orderResults.count,
        blogPosts: blogResults.count
      },
      analytics: {
        users: usersData,
        merchants: merchantsData,
        platform: platformData,
        period: period,
        customStart: customStart,
        customEnd: customEnd
      },
      recentProducts,
      recentLinks,
      recentBlogPosts,
      topPerformers
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).render('error', {
      message: 'Error loading admin dashboard',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// // Admin Performance Analytics Dashboard
// router.get('/admin/performance', isAdmin, async (req, res) => {
//   try {
//     // Overall System Financial Analytics
//     // Get banner performance data
//     const [bannerStats] = await pool.query(`
//       SELECT 
//         (SELECT COUNT(*) FROM banners WHERE status = 'active') as total_banners,
//         (SELECT COUNT(*) FROM banner_views) as total_views,
//         (SELECT COUNT(*) FROM banner_clicks) as total_clicks,
//         (SELECT COALESCE(SUM(b.cost_per_click * bc.id), 0) FROM banners b JOIN banner_clicks bc ON b.id = bc.banner_id) as click_revenue,
//         (SELECT COALESCE(SUM(b.cost_per_view * bv.id / 1000), 0) FROM banners b JOIN banner_views bv ON b.id = bv.banner_id) as view_revenue,
//         (SELECT COUNT(*) FROM banner_views WHERE viewed_at >= ?) as period_views,
//         (SELECT COUNT(*) FROM banner_clicks WHERE clicked_at >= ?) as period_clicks
//     `, [startDate, startDate]);

//     // Get blog performance data
//     const [blogStats] = await pool.query(`
//       SELECT 
//         COUNT(DISTINCT bp.id) as total_posts,
//         COALESCE(SUM(bp.views), 0) as total_views,
//         COALESCE(SUM(bp.likes), 0) as total_likes,
//         COUNT(DISTINCT CASE WHEN bp.created_at >= ? THEN bp.id END) as new_posts,
//         COALESCE(SUM(CASE WHEN bp.created_at >= ? THEN bp.views ELSE 0 END), 0) as period_views,
//         COALESCE(SUM(CASE WHEN bp.created_at < ? THEN bp.views ELSE 0 END), 0) as previous_period_views
//       FROM blog_posts bp
//     `, [startDate, startDate, startDate]);

//     // Get system stats
//     const [systemStats] = await pool.query(`
//       SELECT 
//         (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users,
//         (SELECT COUNT(*) FROM users WHERE role = 'merchant') as total_merchants,
//         (SELECT COUNT(*) FROM links) as total_links,
//         (SELECT COUNT(*) FROM clicks) as total_clicks,
//         (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders,
//         (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'completed') as total_revenue,
//         (SELECT COALESCE(SUM(amount_to_pay), 0) FROM users WHERE role = 'merchant') as total_amount_due,
//         (SELECT COALESCE(SUM(paid_balance), 0) FROM users WHERE role = 'merchant') as total_amount_paid,
//         (SELECT COALESCE(SUM(earnings), 0) FROM users) as total_user_earnings,
//         (SELECT COALESCE(SUM(wallet), 0) FROM users) as total_user_wallets
//     `);

//     // Get links performance by time frame
//     const [linkStats] = await pool.query(`
//       SELECT 
//         COUNT(DISTINCT l.id) as total_links,
//         COUNT(DISTINCT c.id) as total_clicks,
//         COUNT(DISTINCT sl.id) as total_shares,
//         COALESCE(SUM(sl.earnings), 0) as total_earnings,
//         COUNT(DISTINCT CASE WHEN l.created_at >= ? THEN l.id END) as new_links,
//         COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks,
//         COUNT(DISTINCT CASE WHEN c.created_at < ? THEN c.id END) as previous_period_clicks
//       FROM links l
//       LEFT JOIN shared_links sl ON l.id = sl.link_id
//       LEFT JOIN clicks c ON sl.id = c.shared_link_id
//     `, [startDate, startDate, startDate]);

//     // Monthly Revenue Trend (last 12 months)
//     const [monthlyRevenue] = await pool.query(`
//       SELECT 
//         DATE_FORMAT(created_at, '%Y-%m') as month,
//         COUNT(*) as orders,
//         COALESCE(SUM(total_amount), 0) as revenue
//       FROM orders 
//       WHERE status = 'completed' 
//         AND created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
//       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
//       ORDER BY month ASC
//     `);

//     // Top Performing Links by Time Frame
//     const [topLinks] = await pool.query(`
//       SELECT 
//         l.id,
//         l.title,
//         l.url,
//         u.username as merchant_name,
//         COUNT(DISTINCT c.id) as total_clicks,
//         COUNT(DISTINCT sl.id) as total_shares,
//         COALESCE(SUM(sl.earnings), 0) as total_earnings,
//         COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks
//       FROM links l
//       LEFT JOIN shared_links sl ON l.id = sl.link_id
//       LEFT JOIN clicks c ON sl.id = c.shared_link_id
//       LEFT JOIN users u ON l.merchant_id = u.id
//       WHERE c.created_at >= ?
//       GROUP BY l.id
//       ORDER BY period_clicks DESC
//       LIMIT 10
//     `, [startDate, startDate]);

//     // Top Performing Merchants by Revenue Generated
//     const [topMerchantsByRevenue] = await pool.query(`
//       SELECT 
//         u.id,
//         u.username,
//         u.business_name,
//         COUNT(DISTINCT l.id) as total_links,
//         COUNT(DISTINCT c.id) as total_clicks,
//         COALESCE(SUM(sl.earnings), 0) as total_earnings_paid,
//         u.amount_to_pay,
//         u.paid_balance,
//         (u.amount_to_pay + u.paid_balance) as total_revenue_generated,
//         COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks
//       FROM users u
//       LEFT JOIN links l ON u.id = l.merchant_id
//       LEFT JOIN shared_links sl ON l.id = sl.link_id
//       LEFT JOIN clicks c ON sl.id = c.shared_link_id
//       WHERE u.role = 'merchant'
//       GROUP BY u.id
//       ORDER BY total_revenue_generated DESC
//       LIMIT 10
//     `, [startDate]);

//     // Daily Performance with Detailed Metrics
//     const [dailyPerformance] = await pool.query(`
//       SELECT 
//         DATE(c.created_at) as date,
//         COUNT(c.id) as clicks,
//         COUNT(DISTINCT sl.link_id) as unique_links,
//         COUNT(DISTINCT sl.user_id) as active_users,
//         COALESCE(SUM(CASE WHEN t.type = 'commission' THEN t.amount ELSE 0 END), 0) as commissions_paid,
//         COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total_amount ELSE 0 END), 0) as revenue
//       FROM clicks c
//       LEFT JOIN shared_links sl ON c.shared_link_id = sl.id
//       LEFT JOIN transactions t ON sl.user_id = t.user_id AND DATE(c.created_at) = DATE(t.created_at)
//       LEFT JOIN orders o ON DATE(c.created_at) = DATE(o.created_at) AND o.status = 'completed'
//       WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
//       GROUP BY DATE(c.created_at)
//       ORDER BY date DESC
//     `);

//     // Calculate Net Profit
//     const stats = systemStats[0];
//     const netProfit = parseFloat(stats.total_revenue) - parseFloat(stats.total_user_earnings);

//     // Calculate period growth rates
//     const timeRange = req.query.range || '30';
//     const startDate = new Date();
//     startDate.setDate(startDate.getDate() - parseInt(timeRange));

//     // Get period performance
//     const [periodStats] = await pool.query(`
//       SELECT 
//         COUNT(DISTINCT c.id) as clicks,
//         COUNT(DISTINCT o.id) as orders,
//         COALESCE(SUM(o.total_amount), 0) as revenue,
//         COUNT(DISTINCT u.id) as new_users
//       FROM clicks c
//       LEFT JOIN orders o ON o.status = 'completed' AND o.created_at >= ?
//       LEFT JOIN users u ON u.created_at >= ?
//       WHERE c.created_at >= ?
//     `, [startDate, startDate, startDate]);

//     // Get analytics data for charts
//     const [dailyAnalytics] = await pool.query(`
//       SELECT DATE(c.created_at) as date, COUNT(c.id) as clicks, COALESCE(SUM(o.total_amount), 0) as revenue
//       FROM clicks c
//       LEFT JOIN shared_links sl ON c.shared_link_id = sl.id
//       LEFT JOIN orders o ON o.status = 'completed' AND DATE(o.created_at) = DATE(c.created_at)
//       WHERE c.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
//       GROUP BY DATE(c.created_at)
//       ORDER BY date
//     `);

//     const [weeklyAnalytics] = await pool.query(`
//       SELECT YEARWEEK(c.created_at) as week, COUNT(c.id) as clicks, COALESCE(SUM(o.total_amount), 0) as revenue
//       FROM clicks c
//       LEFT JOIN shared_links sl ON c.shared_link_id = sl.id
//       LEFT JOIN orders o ON o.status = 'completed' AND YEARWEEK(o.created_at) = YEARWEEK(c.created_at)
//       WHERE c.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 12 WEEK)
//       GROUP BY YEARWEEK(c.created_at)
//       ORDER BY week
//     `);

//     const [monthlyAnalytics] = await pool.query(`
//       SELECT DATE_FORMAT(c.created_at, '%Y-%m') as month, COUNT(c.id) as clicks, COALESCE(SUM(o.total_amount), 0) as revenue
//       FROM clicks c
//       LEFT JOIN shared_links sl ON c.shared_link_id = sl.id
//       LEFT JOIN orders o ON o.status = 'completed' AND DATE_FORMAT(o.created_at, '%Y-%m') = DATE_FORMAT(c.created_at, '%Y-%m')
//       WHERE c.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 12 MONTH)
//       GROUP BY DATE_FORMAT(c.created_at, '%Y-%m')
//       ORDER BY month
//     `);

//     const [yearlyAnalytics] = await pool.query(`
//       SELECT YEAR(c.created_at) as year, COUNT(c.id) as clicks, COALESCE(SUM(o.total_amount), 0) as revenue
//       FROM clicks c
//       LEFT JOIN shared_links sl ON c.shared_link_id = sl.id
//       LEFT JOIN orders o ON o.status = 'completed' AND YEAR(o.created_at) = YEAR(c.created_at)
//       GROUP BY YEAR(c.created_at)
//       ORDER BY year
//     `);

//     res.render('admin/performance', {
//       user: req.user,
//       currentPath: '/admin/performance',
//       timeRange,
//       stats: {
//         ...stats,
//         net_profit: netProfit,
//         period: {
//           ...periodStats[0],
//           growth: ((periodStats[0].revenue || 0) / (stats.total_revenue || 1) * 100).toFixed(2)
//         },
//         links: {
//           total_links: linkStats[0].total_links,
//           total_clicks: linkStats[0].total_clicks,
//           new_links: linkStats[0].new_links,
//           growth: ((linkStats[0].period_clicks - linkStats[0].previous_period_clicks) / 
//                   (linkStats[0].previous_period_clicks || 1) * 100).toFixed(2)
//         },
//         banners: {
//           total_banners: bannerStats[0].total_banners,
//           total_views: bannerStats[0].total_views,
//           total_clicks: bannerStats[0].total_clicks,
//           revenue: parseFloat(bannerStats[0].click_revenue || 0) + parseFloat(bannerStats[0].view_revenue || 0),
//           growth: ((bannerStats[0].period_clicks) / (bannerStats[0].total_clicks - bannerStats[0].period_clicks || 1) * 100).toFixed(2)
//         },
//         blog: {
//           total_posts: blogStats[0].total_posts,
//           total_views: blogStats[0].total_views,
//           new_posts: blogStats[0].new_posts,
//           growth: ((blogStats[0].period_views - blogStats[0].previous_period_views) / 
//                   (blogStats[0].previous_period_views || 1) * 100).toFixed(2)
//         }
//       },
//       topLinks,
//       monthlyRevenue,
//       topMerchantsByRevenue,
//       dailyPerformance,
//       analytics: {
//         daily: dailyAnalytics,
//         weekly: weeklyAnalytics,
//         monthly: monthlyAnalytics,
//         yearly: yearlyAnalytics
//       }
//     });
//   } catch (err) {
//     console.error('Admin performance error:', err);
//     res.status(500).render('error', {
//       message: 'Error loading performance analytics',
//       error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
//     });
//   }
// });

// Admin Performance Analytics Dashboard
router.get('/admin/performance', isAdmin, async (req, res) => {
  try {
    // Initialize date range
    const timeRange = req.query.range || '30'; // Default to 30 days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(timeRange));

    // Get banner performance data
    const [bannerStats] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM banners WHERE status = 'active') as total_banners, (SELECT COUNT(*) FROM banner_views) as total_views, (SELECT COUNT(*) FROM banner_clicks) as total_clicks, (SELECT COALESCE(SUM(b.cost_per_click * bc.id), 0) FROM banners b JOIN banner_clicks bc ON b.id = bc.banner_id) as click_revenue, (SELECT COALESCE(SUM(b.cost_per_view * bv.id / 1000), 0) FROM banners b JOIN banner_views bv ON b.id = bv.banner_id) as view_revenue, (SELECT COUNT(*) FROM banner_views WHERE viewed_at >= ?) as period_views, (SELECT COUNT(*) FROM banner_clicks WHERE clicked_at >= ?) as period_clicks",
      [startDate, startDate]
    );

    // Get blog performance data
    const [blogStats] = await pool.query(
      "SELECT COUNT(DISTINCT bp.id) as total_posts, COUNT(DISTINCT bps.id) as total_shares, COUNT(DISTINCT CASE WHEN bp.created_at >= ? THEN bp.id END) as new_posts, COUNT(DISTINCT CASE WHEN bps.created_at >= ? THEN bps.id END) as period_shares, COUNT(DISTINCT CASE WHEN bps.created_at < ? THEN bps.id END) as previous_period_shares FROM blog_posts bp LEFT JOIN blog_post_shares bps ON bp.id = bps.blog_post_id",
      [startDate, startDate, startDate]
    );

    // Get system stats
    const [systemStats] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users, (SELECT COUNT(*) FROM users WHERE role = 'merchant') as total_merchants, (SELECT COUNT(*) FROM links) as total_links, (SELECT COUNT(*) FROM clicks) as total_clicks, (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders, (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'completed') as total_revenue, (SELECT COALESCE(SUM(amount_to_pay), 0) FROM users WHERE role = 'merchant') as total_amount_due, (SELECT COALESCE(SUM(paid_balance), 0) FROM users WHERE role = 'merchant') as total_amount_paid, (SELECT COALESCE(SUM(earnings), 0) FROM users) as total_user_earnings, (SELECT COALESCE(SUM(wallet), 0) FROM users) as total_user_wallets"
    );

    // Get links performance by time frame
    const [linkStats] = await pool.query(
      "SELECT COUNT(DISTINCT l.id) as total_links, COUNT(DISTINCT c.id) as total_clicks, COUNT(DISTINCT sl.id) as total_shares, COALESCE(SUM(sl.earnings), 0) as total_earnings, COUNT(DISTINCT CASE WHEN l.created_at >= ? THEN l.id END) as new_links, COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks, COUNT(DISTINCT CASE WHEN c.created_at < ? THEN c.id END) as previous_period_clicks FROM links l LEFT JOIN shared_links sl ON l.id = sl.link_id LEFT JOIN clicks c ON sl.id = c.shared_link_id",
      [startDate, startDate, startDate]
    );

    // Top Performing Links by Time Frame
    const [topLinks] = await pool.query(
      "SELECT l.id, l.title, l.url, u.username as merchant_name, COUNT(DISTINCT c.id) as total_clicks, COUNT(DISTINCT sl.id) as total_shares, COALESCE(SUM(sl.earnings), 0) as total_earnings, COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks FROM links l LEFT JOIN shared_links sl ON l.id = sl.link_id LEFT JOIN clicks c ON sl.id = c.shared_link_id LEFT JOIN users u ON l.merchant_id = u.id WHERE c.created_at >= ? GROUP BY l.id ORDER BY period_clicks DESC LIMIT 10",
      [startDate, startDate]
    );

    // Monthly Revenue Trend (last 12 months)
    const [monthlyRevenue] = await pool.query(
      "SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as orders, COALESCE(SUM(total_amount), 0) as revenue FROM orders WHERE status = 'completed' AND created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH) GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month ASC"
    );

    // Top Performing Merchants by Revenue Generated
    const [topMerchantsByRevenue] = await pool.query(
      "SELECT u.id, u.username, u.business_name, COUNT(DISTINCT l.id) as total_links, COUNT(DISTINCT c.id) as total_clicks, COALESCE(SUM(sl.earnings), 0) as total_earnings_paid, u.amount_to_pay, u.paid_balance, (u.amount_to_pay + u.paid_balance) as total_revenue_generated, COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) as period_clicks FROM users u LEFT JOIN links l ON u.id = l.merchant_id LEFT JOIN shared_links sl ON l.id = sl.link_id LEFT JOIN clicks c ON sl.id = c.shared_link_id WHERE u.role = 'merchant' GROUP BY u.id ORDER BY total_revenue_generated DESC LIMIT 10",
      [startDate]
    );

    // Period Performance Stats
    const [periodStats] = await pool.query(
      "SELECT COUNT(DISTINCT c.id) as clicks, COUNT(DISTINCT o.id) as orders, COALESCE(SUM(o.total_amount), 0) as revenue, COUNT(DISTINCT u.id) as new_users FROM clicks c LEFT JOIN orders o ON o.status = 'completed' AND o.created_at >= ? LEFT JOIN users u ON u.created_at >= ? WHERE c.created_at >= ?",
      [startDate, startDate, startDate]
    );

    // Calculate Net Profit
    const stats = systemStats[0];
    const netProfit = parseFloat(stats.total_revenue) - parseFloat(stats.total_user_earnings);

    res.render('admin/performance', {
      user: req.user,
      currentPath: '/admin/performance',
      timeRange,
      stats: {
        ...stats,
        net_profit: netProfit,
        period: {
          ...periodStats[0]
        },
        links: {
          total_links: linkStats[0].total_links,
          total_clicks: linkStats[0].total_clicks,
          total_shares: linkStats[0].total_shares,
          total_earnings: parseFloat(linkStats[0].total_earnings || 0).toFixed(2),
          new_links: linkStats[0].new_links,
          period_clicks: linkStats[0].period_clicks,
          previous_period_clicks: linkStats[0].previous_period_clicks,
          growth: ((linkStats[0].period_clicks || 0) / (linkStats[0].previous_period_clicks || 1) * 100 - 100).toFixed(2)
        },
        banners: {
          total_views: bannerStats[0].total_views,
          total_clicks: bannerStats[0].total_clicks,
          total_revenue: parseFloat(bannerStats[0].click_revenue) + parseFloat(bannerStats[0].view_revenue),
          period_views: bannerStats[0].period_views,
          period_clicks: bannerStats[0].period_clicks
        },
        blog: {
          total_posts: blogStats[0].total_posts,
          total_shares: blogStats[0].total_shares,
          new_posts: blogStats[0].new_posts,
          period_shares: blogStats[0].period_shares,
          previous_period_shares: blogStats[0].previous_period_shares,
          growth: ((blogStats[0].period_shares || 0) / (blogStats[0].previous_period_shares || 1) * 100 - 100).toFixed(2)
        },
        topLinks: topLinks.map(link => ({
          id: link.id,
          title: link.title,
          url: link.url,
          merchant_name: link.merchant_name,
          total_clicks: link.total_clicks,
          total_shares: link.total_shares,
          total_earnings: parseFloat(link.total_earnings || 0).toFixed(2),
          period_clicks: link.period_clicks
        }))
      },
      analytics: {
        ...stats,
        net_profit: netProfit,
        period: {
          ...periodStats[0],
          growth: ((periodStats[0].revenue || 0) / (stats.total_revenue || 1) * 100).toFixed(2)
        },
        links: {
          total_links: linkStats[0].total_links,
          total_clicks: linkStats[0].total_clicks,
          new_links: linkStats[0].new_links,
          growth: ((linkStats[0].period_clicks - linkStats[0].previous_period_clicks) / 
                  (linkStats[0].previous_period_clicks || 1) * 100).toFixed(2)
        },
        banners: {
          total_banners: bannerStats[0].total_banners,
          total_views: bannerStats[0].total_views,
          total_clicks: bannerStats[0].total_clicks,
          revenue: parseFloat(bannerStats[0].click_revenue || 0) + parseFloat(bannerStats[0].view_revenue || 0),
          growth: ((bannerStats[0].period_clicks) / (bannerStats[0].total_clicks - bannerStats[0].period_clicks || 1) * 100).toFixed(2)
        },
        blog: {
          total_posts: blogStats[0].total_posts,
          total_shares: blogStats[0].total_shares || 0,
          new_posts: blogStats[0].new_posts || 0,
          growth: ((blogStats[0].period_shares - blogStats[0].previous_period_shares) / 
                  (blogStats[0].previous_period_shares || 1) * 100).toFixed(2)
        }
      },
      topLinks,
      monthlyRevenue,
      topMerchantsByRevenue
    });
  } catch (err) {
    console.error('Admin performance error:', err);
    res.status(500).render('error', {
      message: 'Error loading performance analytics',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});
// Enhanced Merchant Analytics
router.get('/admin/merchant-analytics/:id', isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;

    // Get merchant info
    const [merchants] = await pool.query(`
      SELECT * FROM users WHERE id = ? AND role = 'merchant'
    `, [merchantId]);

    if (merchants.length === 0) {
      return res.status(404).render('error', {
        message: 'Merchant not found',
        error: { status: 404, stack: '' }
      });
    }

    const merchant = merchants[0];

    // Get all links with detailed analytics
    const [linkAnalytics] = await pool.query(`
      SELECT 
        l.*,
        COUNT(DISTINCT sl.id) as total_shares,
        COUNT(DISTINCT c.id) as total_clicks,
        COALESCE(SUM(sl.earnings), 0) as total_commissions_paid,
        CASE 
          WHEN COUNT(DISTINCT sl.id) > 0 THEN COUNT(DISTINCT c.id) / COUNT(DISTINCT sl.id)
          ELSE 0 
        END as avg_clicks_per_share,
        (l.cost_per_click * COUNT(DISTINCT c.id)) as total_cost_incurred
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      LEFT JOIN clicks c ON sl.id = c.shared_link_id
      WHERE l.merchant_id = ?
      GROUP BY l.id
      ORDER BY total_clicks DESC
    `, [merchantId]);

    // Get individual link performance details
    const linkIds = linkAnalytics.map(link => link.id);
    let linkDetails = [];
    
    if (linkIds.length > 0) {
      const [details] = await pool.query(`
        SELECT 
          l.id,
          l.title,
          sl.user_id,
          u.username as sharer_name,
          COUNT(c.id) as clicks,
          sl.earnings,
          sl.created_at as shared_at
        FROM links l
        JOIN shared_links sl ON l.id = sl.link_id
        JOIN users u ON sl.user_id = u.id
        LEFT JOIN clicks c ON sl.id = c.shared_link_id
        WHERE l.id IN (${linkIds.map(() => '?').join(',')})
        GROUP BY l.id, sl.id, sl.user_id, u.username, sl.earnings, sl.created_at
        ORDER BY clicks DESC
      `, linkIds);
      linkDetails = details;
    }

    // Get monthly performance for this merchant
    const [monthlyPerformance] = await pool.query(`
      SELECT 
        DATE_FORMAT(c.created_at, '%Y-%m') as month,
        COUNT(c.id) as clicks,
        COALESCE(SUM(sl.earnings), 0) as commissions_paid
      FROM clicks c
      JOIN shared_links sl ON c.shared_link_id = sl.id
      JOIN links l ON sl.link_id = l.id
      WHERE l.merchant_id = ?
        AND c.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(c.created_at, '%Y-%m')
      ORDER BY month ASC
    `, [merchantId]);

    // Calculate totals
    const totalStats = {
      total_links: linkAnalytics.length,
      total_shares: linkAnalytics.reduce((sum, link) => sum + link.total_shares, 0),
      total_clicks: linkAnalytics.reduce((sum, link) => sum + link.total_clicks, 0),
      total_commissions_paid: linkAnalytics.reduce((sum, link) => sum + parseFloat(link.total_commissions_paid), 0),
      total_cost_incurred: linkAnalytics.reduce((sum, link) => sum + parseFloat(link.total_cost_incurred), 0)
    };

    res.render('admin/merchant-analytics', {
      user: req.user,
      merchant,
      linkAnalytics,
      linkDetails,
      monthlyPerformance,
      totalStats
    });
  } catch (err) {
    console.error('Merchant analytics error:', err);
    res.status(500).render('error', {
      message: 'Error loading merchant analytics',
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

// Admin Merchants Management Route
router.get('/admin/merchants', isAdmin, async (req, res) => {
  try {
    const searchQuery = req.query.search || '';
    const dueAmountFilter = req.query.dueAmount || '';

    // Build the query with search and filters
    let query = `
      SELECT u.*, 
        COUNT(DISTINCT l.id) as total_links,
        COALESCE(SUM(CASE WHEN t.type = 'payment' AND t.status = 'completed' THEN t.amount ELSE 0 END), 0) as total_paid
      FROM users u
      LEFT JOIN links l ON u.id = l.merchant_id
      LEFT JOIN transactions t ON u.id = t.user_id
      WHERE u.role = 'merchant'
    `;
    
    const queryParams = [];

    // Add search conditions
    if (searchQuery) {
      query += ` AND (
        u.username LIKE ? OR 
        u.email LIKE ? OR 
        u.business_name LIKE ?
      )`;
      const searchTerm = `%${searchQuery}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    // Add due amount filter
    if (dueAmountFilter) {
      switch (dueAmountFilter) {
        case '1': // Less than $100
          query += ` AND u.amount_to_pay < 100`;
          break;
        case '2': // $100 - $500
          query += ` AND u.amount_to_pay >= 100 AND u.amount_to_pay <= 500`;
          break;
        case '3': // $500 - $1000
          query += ` AND u.amount_to_pay > 500 AND u.amount_to_pay <= 1000`;
          break;
        case '4': // Over $1000
          query += ` AND u.amount_to_pay > 1000`;
          break;
      }
    }

    // Add sorting
    const sortOrder = req.query.sort || 'newest';
    let orderBy = '';

    switch (sortOrder) {
      case 'amount_asc':
        orderBy = 'u.amount_to_pay ASC';
        break;
      case 'amount_desc':
        orderBy = 'u.amount_to_pay DESC';
        break;
      case 'total_paid_asc':
        orderBy = 'total_paid ASC';
        break;
      case 'total_paid_desc':
        orderBy = 'total_paid DESC';
        break;
      case 'oldest':
        orderBy = 'u.created_at ASC';
        break;
      default: // 'newest'
        orderBy = 'u.created_at DESC';
    }

    query += ` GROUP BY u.id ORDER BY ${orderBy}`;

    // Execute the query
    const [merchants] = await pool.query(query, queryParams);

    // Get recent payments
    const [payments] = await pool.query(`
      SELECT t.*, u.username 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.type = 'payment' AND u.role = 'merchant'
      ORDER BY t.created_at DESC 
      LIMIT 10
    `);

    res.render('admin/merchants', {
      user: req.user,
      merchants,
      payments,
      searchQuery,
      dueAmountFilter,
      sort: sortOrder,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin merchants error:', err);
    res.status(500).render('error', {
      message: 'Error loading merchants',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});

// Toggle merchant verification status
router.post('/admin/merchants/:id/toggle-verification', isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;
    const { is_verified } = req.body;

    await pool.query(
      'UPDATE users SET is_verified = ? WHERE id = ? AND role = "merchant"',
      [is_verified, merchantId]
    );

    res.json({ 
      success: true, 
      message: `Merchant ${is_verified ? 'verified' : 'unverified'} successfully` 
    });
  } catch (err) {
    console.error('Toggle merchant verification error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update merchant verification status'
    });
  }
});

// Admin Merchant Management View
router.get('/admin/merchants/:id/manage', isAdmin, async (req, res) => {
  try {
    const merchantId = req.params.id;

    // Get merchant details with their statistics
    const [merchants] = await pool.query(`
      SELECT u.*, 
        COUNT(DISTINCT l.id) as total_links,
        COALESCE(SUM(CASE WHEN t.type = 'payment' AND t.status = 'completed' THEN t.amount ELSE 0 END), 0) as total_paid,
        COUNT(DISTINCT p.id) as total_products
      FROM users u
      LEFT JOIN links l ON u.id = l.merchant_id
      LEFT JOIN transactions t ON u.id = t.user_id
      LEFT JOIN products p ON u.id = p.merchant_id
      WHERE u.id = ? AND u.role = 'merchant'
      GROUP BY u.id
    `, [merchantId]);

    if (merchants.length === 0) {
      return res.status(404).render('error', {
        message: 'Merchant not found',
        error: { status: 404, stack: '' }
      });
    }

    const merchant = merchants[0];

    // Get recent transactions
    const [transactions] = await pool.query(`
      SELECT t.*,
             t.details as link_title
      FROM transactions t
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC
      LIMIT 10
    `, [merchantId]);

    // Get merchant's links
    const [links] = await pool.query(`
      SELECT l.*, COUNT(sl.id) as share_count, COUNT(c.id) as click_count
      FROM links l
      LEFT JOIN shared_links sl ON l.id = sl.link_id
      LEFT JOIN clicks c ON sl.id = c.shared_link_id
      WHERE l.merchant_id = ?
      GROUP BY l.id
      ORDER BY l.created_at DESC
      LIMIT 10
    `, [merchantId]);

    // Get merchant's products
    const [products] = await pool.query(`
      SELECT p.*, COUNT(oi.id) as orders_count
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      WHERE p.merchant_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 10
    `, [merchantId]);

    res.render('admin/merchant-manage', {
      user: req.user,
      merchant,
      transactions,
      links,
      products,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin merchant management error:', err);
    res.status(500).render('error', {
      message: 'Error loading merchant management view',
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

    const searchQuery = req.query.search || '';

    // Build the query with filters and search
    let query = `
      SELECT l.*, u.username as merchant_name,
      CASE WHEN l.type = 'product' THEN p.name ELSE NULL END as product_name
      FROM links l
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN products p ON l.type = 'product' AND l.id = p.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    // Add search conditions
    if (searchQuery) {
      query += ` AND (
        l.title LIKE ? OR 
        l.url LIKE ? OR 
        l.description LIKE ? OR
        u.username LIKE ? OR
        CASE WHEN l.type = 'product' THEN p.name ELSE l.url END LIKE ?
      )`;
      const searchTerm = `%${searchQuery}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
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
      selectedStatus,
      searchQuery // Include the search query in the template
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
    
    // Get link details before update
    const [links] = await pool.query('SELECT merchant_id, title, is_active FROM links WHERE id = ?', [linkId]);
    
    if (links.length === 0) {
      return res.status(404).json({ success: false, message: 'Link not found' });
    }
    
    const link = links[0];
    const wasActive = link.is_active;
    const nowActive = Boolean(is_active);
    
    await pool.query(
      'UPDATE links SET is_active = ? WHERE id = ?',
      [is_active, linkId]
    );
    
    // Send notification for status change
    const notificationService = req.app.locals.notificationService;
    if (notificationService && wasActive !== nowActive) {
      try {
        const action = nowActive ? 'link_approved' : 'link_rejected';
        await notificationService.notifyLinkActivity(link.merchant_id, {
          action: action,
          linkTitle: link.title || `Link #${linkId}`
        });
      } catch (notificationError) {
        console.error('Link status notification error:', notificationError);
      }
    }
    
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
    // Get filter parameters
    const roleFilter = req.query.role;
    const statusFilter = req.query.status;
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
    
    if (statusFilter) {
      if (statusFilter === 'verified') {
        whereConditions.push('u.is_verified = 1');
      } else if (statusFilter === 'pending') {
        whereConditions.push('u.is_verified = 0');
      }
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
             COALESCE(orders.total_orders, 0) as total_orders,
             CASE 
               WHEN u.is_verified = 1 THEN 'verified'
               ELSE 'pending'
             END as computed_status
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
        SELECT referrer_id, COUNT(*) as referral_count
        FROM users 
        WHERE referrer_id IS NOT NULL
        GROUP BY referrer_id
      ) referrals ON u.id = referrals.referrer_id
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
      user: req.user,
      users: users,
      recentRegistrations: recentRegistrations,
      stats: userStats[0],
      currentPage: page,
      totalPages: totalPages,
      totalUsers: totalUsers,
      selectedRole: roleFilter || '',
      selectedStatus: statusFilter || '',
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
      await pool.query('SELECT 1 FROM user_referrals LIMIT 1');
      hasReferralsTable = true;
    } catch (err) {
      console.log('User_referrals table not found in user detail');
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
          SELECT sl.*, l.title, l.type, l.url, u.username as merchant_name,
                 COUNT(c.id) as clicks
          FROM shared_links sl
          JOIN links l ON sl.link_id = l.id
          JOIN users u ON l.merchant_id = u.id
          LEFT JOIN clicks c ON sl.id = c.shared_link_id
          WHERE sl.user_id = ?
          GROUP BY sl.id, l.title, l.type, l.url, u.username
          ORDER BY clicks DESC
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
          SELECT ur.*, u.username as referred_username, u.email as referred_email,
                 u.created_at as referred_created_at, ur.status, ur.activated_at
          FROM user_referrals ur
          JOIN users u ON ur.referred_id = u.id
          WHERE ur.referrer_id = ?
          ORDER BY ur.created_at DESC
        `, [userId]);
        referrals = referralResults;
      } catch (err) {
        console.log('Error fetching referrals:', err.message);
        referrals = [];
      }
    }

    // Get merchant-specific analytics if user is a merchant
    let merchantAnalytics = null;
    if (user.role === 'merchant') {
      try {
        // Get merchant's links with detailed analytics
        const [linkAnalytics] = await pool.query(`
          SELECT 
            l.*,
            COUNT(DISTINCT sl.id) as total_shares,
            COUNT(DISTINCT c.id) as total_clicks,
            COALESCE(SUM(sl.earnings), 0) as total_commissions_paid,
            CASE 
              WHEN COUNT(DISTINCT sl.id) > 0 THEN COUNT(DISTINCT c.id) / COUNT(DISTINCT sl.id)
              ELSE 0 
            END as avg_clicks_per_share,
            (l.cost_per_click * COUNT(DISTINCT c.id)) as total_cost_incurred
          FROM links l
          LEFT JOIN shared_links sl ON l.id = sl.link_id
          LEFT JOIN clicks c ON sl.id = c.shared_link_id
          WHERE l.merchant_id = ?
          GROUP BY l.id
          ORDER BY total_clicks DESC
          LIMIT 10
        `, [userId]);

        // Get merchant's top performing shared links
        const [topSharedLinks] = await pool.query(`
          SELECT 
            sl.*,
            l.title as link_title,
            u.username as sharer_name,
            COUNT(c.id) as clicks,
            sl.earnings
          FROM shared_links sl
          JOIN links l ON sl.link_id = l.id
          JOIN users u ON sl.user_id = u.id
          LEFT JOIN clicks c ON sl.id = c.shared_link_id
          WHERE l.merchant_id = ?
          GROUP BY sl.id, l.title, u.username, sl.earnings
          ORDER BY clicks DESC
          LIMIT 10
        `, [userId]);

        // Get merchant's monthly performance
        const [monthlyStats] = await pool.query(`
          SELECT 
            DATE_FORMAT(c.created_at, '%Y-%m') as month,
            COUNT(c.id) as clicks,
            COALESCE(SUM(sl.earnings), 0) as commissions_paid
          FROM clicks c
          JOIN shared_links sl ON c.shared_link_id = sl.id
          JOIN links l ON sl.link_id = l.id
          WHERE l.merchant_id = ?
            AND c.created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
          GROUP BY DATE_FORMAT(c.created_at, '%Y-%m')
          ORDER BY month DESC
        `, [userId]);

        // Calculate totals
        const totalStats = {
          total_links: linkAnalytics.length,
          total_shares: linkAnalytics.reduce((sum, link) => sum + link.total_shares, 0),
          total_clicks: linkAnalytics.reduce((sum, link) => sum + link.total_clicks, 0),
          total_commissions_paid: linkAnalytics.reduce((sum, link) => sum + parseFloat(link.total_commissions_paid), 0),
          total_cost_incurred: linkAnalytics.reduce((sum, link) => sum + parseFloat(link.total_cost_incurred), 0)
        };

        merchantAnalytics = {
          linkAnalytics,
          topSharedLinks,
          monthlyStats,
          totalStats
        };
      } catch (err) {
        console.log('Error fetching merchant analytics:', err.message);
        merchantAnalytics = null;
      }
    }
    
    // Construct base URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.render('admin/user-detail', {
      user: req.user, // Admin user
      targetUser: user, // User being viewed
      orders,
      sharedLinks,
      transactions,
      referrals,
      merchantAnalytics,
      baseUrl: baseUrl,
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
      username, email, role, status, phone_number, wallet, earnings, 
      has_lifetime_commission, business_name, business_description,
      account_name, account_number, notes 
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
      // Try with core fields without updated_at (which may not exist)
      await pool.query(`
        UPDATE users 
        SET username = ?, email = ?, role = ?, status = ?, phone_number = ?, wallet = ?, 
            earnings = ?, has_lifetime_commission = ?, business_name = ?, 
            business_description = ?, account_name = ?, account_number = ?, notes = ?
        WHERE id = ?
      `, [
        username, email, role, status || 'active', phone_number || null, safeWallet, 
        safeEarnings, safePremiumStatus, business_name || null, 
        business_description || null, account_name || null, 
        account_number || null, notes || null, userId
      ]);
      
      console.log('User updated successfully with all available fields');
    } catch (innerErr) {
      // If some columns don't exist, try with core fields that should exist
      if (innerErr.sqlMessage && (innerErr.sqlMessage.includes("Unknown column") || innerErr.sqlMessage.includes("doesn't exist"))) {
        console.log('Some columns missing, trying with core fields:', innerErr.sqlMessage);
        
        try {
          // Try with core fields including wallet and earnings
          await pool.query(`
            UPDATE users 
            SET username = ?, email = ?, role = ?, status = ?, wallet = ?, earnings = ?, 
                has_lifetime_commission = ?, business_name = ?, business_description = ?
            WHERE id = ?
          `, [username, email, role, status || 'active', safeWallet, safeEarnings, 
              safePremiumStatus, business_name || null, business_description || null, userId]);
          
          console.log('User updated with core fields including wallet and earnings');
        } catch (coreErr) {
          console.log('Core fields failed, trying with minimal fields:', coreErr.sqlMessage);
          
          // Final fallback with absolute minimum fields
          await pool.query(`
            UPDATE users 
            SET username = ?, email = ?, role = ?, status = ?
            WHERE id = ?
          `, [username, email, role, status || 'active', userId]);
          
          console.log('User updated with minimal fields only. Financial data may not be saved due to missing columns.');
        }
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
      // Use the new notification service instead of direct nodemailer
      const notificationService = req.app.locals.notificationService;
      
      await notificationService.createNotification({
        userId: userId,
        type: 'info',
        category: 'admin_message',
        title: subject,
        message: message,
        actionUrl: '/dashboard',
        sendEmail: true,
        priority: 2
      });
      
      console.log(`✅ Email sent successfully to user ${userId} via notification service`);
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
      // Set status and activation based on environment variable
      const status = process.env.REQUIRE_ACTIVATION === 'true' ? 'pending' : 'active';
      const activation_paid = process.env.REQUIRE_ACTIVATION !== 'true';

      const [result] = await pool.query(`
        INSERT INTO users (
          username, email, password, role, phone_number, wallet, 
          earnings, has_lifetime_commission, business_name, business_description,
          account_name, account_number, bank_name, notes, status, activation_paid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        username, email, hashedPassword, role || 'user', phone_number || null,
        safeWallet, safeEarnings, safePremiumStatus, business_name || null,
        business_description || null, account_name || null, account_number || null,
        bank_name || null, notes || null, status, activation_paid
      ]);
      
      const newUserId = result.insertId;
      return res.redirect(`/admin/users/${newUserId}?success=User created successfully`);
    } catch (innerErr) {
      // If some columns don't exist, try progressively with fewer columns
      if (innerErr.sqlMessage && (innerErr.sqlMessage.includes("Unknown column") || innerErr.sqlMessage.includes("doesn't exist"))) {
        console.log('Some columns missing, trying with basic fields:', innerErr.sqlMessage);
        
        try {
          // Try with basic fields but include status and timestamps
          const status = process.env.REQUIRE_ACTIVATION === 'true' ? 'pending' : 'active';
          const activation_paid = process.env.REQUIRE_ACTIVATION !== 'true';
          
          const [result] = await pool.query(`
            INSERT INTO users (username, email, password, role, business_name, business_description, status, activation_paid, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `, [username, email, hashedPassword, role || 'user', business_name || null, business_description || null, status, activation_paid]);
          
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

// Unilevel System Settings Routes
router.get('/admin/settings', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    
    // Initialize banner settings if they don't exist
    await pool.query(`
      INSERT IGNORE INTO system_settings 
        (setting_key, setting_value, setting_type, description, created_at, updated_at) 
      VALUES 
        ('banner_cpc_usd', '0.001', 'number', 'Cost Per Click (USD) for banner ads', NOW(), NOW()),
        ('banner_cpm_usd', '0.05', 'number', 'Cost Per Mille (USD) for banner ads', NOW(), NOW())
    `);
    
    // Get general system settings from config table
    const [configs] = await pool.query(`
      SELECT key_name, value, description 
      FROM config 
      WHERE key_name IN (
        'manual_payment_instructions', 
        'manual_payment_bank_name', 
        'manual_payment_account_name', 
        'manual_payment_account_number', 
        'manual_payment_swift_code',
        'manual_payment_enabled',
        'admin_whatsapp_number',
        'activation_system_enabled',
        'min_required_clicks',
        'min_required_shares',
        'min_required_blog_posts',
        'weekly_login_requirement',
        'analytics_period_default'
      ) OR key_name NOT LIKE 'manual_payment%' AND key_name != 'admin_whatsapp_number'
      ORDER BY key_name
    `);
    
    // Get all unilevel system settings
    const [settings] = await pool.query(`
      SELECT setting_key, setting_value, setting_type, description 
      FROM system_settings 
      WHERE setting_key IN (
        'activation_fee_rwf', 
        'level1_commission_rwf', 
        'level2_commission_rwf', 
        'max_commission_levels', 
        'supported_currencies',
        'auto_activate_existing_users',
        'banner_cpc_usd',
        'banner_cpm_usd'
      )
      ORDER BY setting_key
    `);

    // Convert settings to key-value pairs
    const settingsMap = {};
    settings.forEach(setting => {
      let value = setting.setting_value;
      if (setting.setting_type === 'json') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = setting.setting_value;
        }
      } else if (setting.setting_type === 'boolean') {
        value = value === 'true';
      } else if (setting.setting_type === 'number') {
        value = parseFloat(value);
      }
      settingsMap[setting.setting_key] = {
        value: value,
        type: setting.setting_type,
        description: setting.description
      };
    });

    // Get commission statistics
    const [commissionStats] = await pool.query(`
      SELECT 
        COUNT(*) as total_commissions,
        SUM(CASE WHEN status = 'paid' THEN amount_usd ELSE 0 END) as total_paid,
        SUM(CASE WHEN status = 'pending' THEN amount_usd ELSE 0 END) as total_pending
      FROM commissions
    `);

    // Ensure numeric values for commission stats
    const formattedCommissionStats = commissionStats[0] ? {
      total_commissions: parseInt(commissionStats[0].total_commissions || 0),
      total_paid: parseFloat(commissionStats[0].total_paid || 0),
      total_pending: parseFloat(commissionStats[0].total_pending || 0)
    } : {
      total_commissions: 0,
      total_paid: 0,
      total_pending: 0
    };

    // Get user activation statistics
    const [userStats] = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_users,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_users,
        SUM(CASE WHEN activation_paid = 1 THEN 1 ELSE 0 END) as paid_activations
      FROM users
    `);

    res.render('admin/settings', {
      user: req.session.user,
      configs: configs, // Add configs data
      settings: settingsMap,
      commissionStats: formattedCommissionStats,
      userStats: userStats[0] || {},
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Admin settings error:', err);
    res.redirect('/admin/dashboard?error=Failed to load settings');
  }
});

router.post('/admin/settings', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    // Extract form data with proper defaults
    const {
      activation_fee_rwf,
      level1_commission_rwf,
      level2_commission_rwf,
      max_commission_levels,
      'supported_currencies[]': rawCurrencies,
      auto_activate_existing_users,
      banner_cpc_usd,
      banner_cpm_usd
    } = req.body;

    // Process supported currencies
    console.log('Raw form data:', req.body);
    
    let currencyValues = req.body['supported_currencies[]'];
    let supported_currencies = [];

    if (Array.isArray(currencyValues)) {
      supported_currencies = currencyValues;
    } else if (currencyValues) {
      supported_currencies = [currencyValues];
    }

    // Log raw currency data
    console.log('Currency processing:', {
      raw: currencyValues,
      initial: supported_currencies
    });

    // Filter and validate currencies
    supported_currencies = supported_currencies
      .filter(curr => typeof curr === 'string')
      .map(curr => curr.toUpperCase())
      .filter(curr => curr.length === 3 && /^[A-Z]{3}$/.test(curr));

    // Ensure RWF and USD are always included and appear only once
    supported_currencies = Array.from(new Set(['RWF', 'USD', ...supported_currencies]));

    // Log currencies for debugging
    console.log('Processing currencies:', {
      received: rawCurrencies,
      processed: supported_currencies,
      body: req.body
    });

    // Convert and validate numeric values
    const parsedActivationFee = Math.max(0, parseFloat(activation_fee_rwf) || 0);
    const parsedLevel1Commission = Math.max(0, parseFloat(level1_commission_rwf) || 0);
    const parsedLevel2Commission = Math.max(0, parseFloat(level2_commission_rwf) || 0);
    const parsedMaxLevels = Math.min(5, Math.max(1, parseInt(max_commission_levels) || 2));

    // Log the processed form data
    console.log('Received form data:', {
      supported_currencies,
      auto_activate_existing_users: auto_activate_existing_users === 'on',
      activation_fee: parsedActivationFee,
      level1_commission: parsedLevel1Commission,
      level2_commission: parsedLevel2Commission,
      max_levels: parsedMaxLevels
    });

    // Update settings with proper validation
    const settingsToUpdate = [
      ['activation_fee_rwf', parsedActivationFee.toString(), 'number'],
      ['level1_commission_rwf', parsedLevel1Commission.toString(), 'number'],
      ['level2_commission_rwf', parsedLevel2Commission.toString(), 'number'],
      ['max_commission_levels', parsedMaxLevels.toString(), 'number'],
      ['supported_currencies', JSON.stringify(supported_currencies), 'json'],
      ['auto_activate_existing_users', auto_activate_existing_users === 'on' ? 'true' : 'false', 'boolean'],
      ['banner_cpc_usd', parseFloat(banner_cpc_usd || 0).toFixed(4), 'number', 'Cost Per Click (USD) for banner ads'],
      ['banner_cpm_usd', parseFloat(banner_cpm_usd || 0).toFixed(4), 'number', 'Cost Per Mille (USD) for banner ads']
    ];

    // Log settings being updated
    console.log('Updating settings:', {
      currencies: JSON.stringify(supported_currencies),
      auto_activate: auto_activate_existing_users === 'true' ? 'true' : 'false'
    });

    for (const [key, value, type] of settingsToUpdate) {
      await pool.query(`
        INSERT INTO system_settings (setting_key, setting_value, setting_type) 
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
        setting_value = VALUES(setting_value),
        updated_at = CURRENT_TIMESTAMP
      `, [key, value, type]);
    }

    res.redirect('/admin/settings?success=Settings updated successfully');
  } catch (err) {
    console.error('Admin settings update error:', err);
    res.redirect('/admin/settings?error=Failed to update settings');
  }
});

// Email Service Status and Testing Routes
router.get('/admin/email-status', isAdmin, async (req, res) => {
  try {
    const emailService = req.app.locals.emailService;
    
    if (!emailService) {
      return res.render('admin/email-status', {
        user: req.session.user,
        status: {
          initialized: false,
          error: 'Email service not found'
        },
        testResult: null,
        errorMessage: 'Email service is not initialized in the application'
      });
    }

    const status = emailService.getServiceStatus();
    
    res.render('admin/email-status', {
      user: req.session.user,
      status,
      testResult: null,
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Email status error:', err);
    res.render('admin/email-status', {
      user: req.session.user,
      status: {
        initialized: false,
        error: err.message
      },
      testResult: null,
      errorMessage: 'Failed to check email service status'
    });
  }
});

// Test email service
router.post('/admin/test-email', isAdmin, async (req, res) => {
  try {
    const emailService = req.app.locals.emailService;
    const { testEmail } = req.body;
    
    if (!emailService) {
      return res.redirect('/admin/email-status?error=Email service not found');
    }

    const testResult = await emailService.testEmailService(testEmail);
    
    if (testResult.success) {
      res.redirect('/admin/email-status?success=Test email sent successfully');
    } else {
      res.redirect('/admin/email-status?error=' + encodeURIComponent(testResult.error));
    }
  } catch (err) {
    console.error('Test email error:', err);
    res.redirect('/admin/email-status?error=' + encodeURIComponent(err.message));
  }
});

// Route to handle manual payment settings update
router.post('/admin/settings/manual-payment', isAdmin, upload.single('manual_payment_screenshot'), async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      manual_payment_enabled,
      manual_payment_instructions,
      manual_payment_bank_name,
      manual_payment_account_name,
      manual_payment_account_number,
      manual_payment_swift_code,
      admin_whatsapp_number
    } = req.body;

    // Handle screenshot upload
    let screenshotUrl = null;
    if (req.file) {
      // Rename uploaded file with better naming
      const fileExtension = path.extname(req.file.originalname);
      const newFileName = `manual_payment_instructions_${Date.now()}${fileExtension}`;
      const oldPath = req.file.path;
      const newPath = path.join(path.dirname(oldPath), newFileName);
      
      fs.renameSync(oldPath, newPath);
      screenshotUrl = `/uploads/${newFileName}`;
    }

    // Update manual payment settings in config table
    const settingsToUpdate = [
      ['manual_payment_enabled', manual_payment_enabled === 'on' ? 'true' : 'false', 'Enable manual payment option for activations'],
      ['manual_payment_instructions', manual_payment_instructions || 'Please transfer the amount to our account and upload a screenshot/receipt as proof of payment.', 'Instructions for manual payment processing'],
      ['manual_payment_bank_name', manual_payment_bank_name || '', 'Bank name for manual payments'],
      ['manual_payment_account_name', manual_payment_account_name || '', 'Account name for manual payments'],
      ['manual_payment_account_number', manual_payment_account_number || '', 'Account number for manual payments'],
      ['manual_payment_swift_code', manual_payment_swift_code || '', 'SWIFT/BIC code for international transfers (optional)'],
      ['admin_whatsapp_number', admin_whatsapp_number || '250783987223', 'Admin WhatsApp number for manual payment notifications']
    ];

    // Add screenshot URL to settings if uploaded
    if (screenshotUrl) {
      settingsToUpdate.push(['manual_payment_screenshot', screenshotUrl, 'Screenshot showing manual payment instructions and account details']);
    }

    for (const [key, value, description] of settingsToUpdate) {
      await pool.query(`
        INSERT INTO config (key_name, value, description) 
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
        value = VALUES(value),
        description = VALUES(description)
      `, [key, value, description]);
    }

    res.redirect('/admin/settings?success=Manual payment settings updated successfully');
  } catch (err) {
    console.error('Manual payment settings update error:', err);
    res.redirect('/admin/settings?error=Failed to update manual payment settings');
  }
});

// Route to handle updating individual config settings
router.post('/admin/settings/update', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { key_name, value } = req.body;

    if (!key_name || value === undefined) {
      return res.redirect('/admin/settings?error=Missing required fields');
    }

    // Update or insert the config setting
    await pool.query(`
      INSERT INTO config (key_name, value) 
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE 
      value = VALUES(value)
    `, [key_name, value]);

    res.redirect('/admin/settings?success=' + encodeURIComponent(`${key_name} updated successfully`));
  } catch (err) {
    console.error('Config update error:', err);
    res.redirect('/admin/settings?error=Failed to update configuration');
  }
});

//  Activation Payments Management
router.get('/admin/activation-payments', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    
    const [payments] = await pool.query(`
      SELECT 
        ap.*,
        u.username,
        u.email,
        u.status as user_status,
        map.account_name as manual_account_name,
        map.phone_number as manual_phone_number,
        map.account_number as manual_account_number,
        map.payment_screenshot_url,
        map.status as manual_status,
        map.admin_notes,
        map.whatsapp_sent
      FROM activation_payments ap
      JOIN users u ON ap.user_id = u.id
      LEFT JOIN manual_activation_payments map ON ap.manual_payment_id = map.id
      ORDER BY ap.created_at DESC
      LIMIT 100
    `);

    res.render('admin/activation-payments', {
      user: req.session.user,
      payments: payments,
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Admin activation payments error:', err);
    res.redirect('/admin/dashboard?error=Failed to load activation payments');
  }
});

// Manual approval of activation payment
router.post('/admin/activation-payments/:id/approve', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const commissionService = req.app.locals.commissionService;
    const paymentId = req.params.id;
    const { admin_notes } = req.body;

    // Get payment details including manual payment info
    const [payments] = await pool.query(`
      SELECT 
        ap.*, 
        u.username, 
        u.email, 
        u.status as user_status,
        map.id as manual_payment_id
      FROM activation_payments ap
      JOIN users u ON ap.user_id = u.id
      LEFT JOIN manual_activation_payments map ON ap.manual_payment_id = map.id
      WHERE ap.id = ?
    `, [paymentId]);

    if (payments.length === 0) {
      return res.redirect('/admin/activation-payments?error=Payment not found');
    }

    const payment = payments[0];

    // Check if payment is already successful
    if (payment.payment_status === 'successful') {
      return res.redirect('/admin/activation-payments?error=Payment is already approved');
    }

    // Update payment status to successful
    await pool.query(`
      UPDATE activation_payments 
      SET payment_status = 'successful',
          payment_method = CASE 
            WHEN payment_type = 'manual' THEN 'manual_approval' 
            ELSE payment_method 
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [paymentId]);

    // If this is a manual payment, update the manual payment record
    if (payment.manual_payment_id) {
      await pool.query(`
        UPDATE manual_activation_payments 
        SET status = 'approved',
            admin_notes = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [admin_notes || 'Payment approved by admin', payment.manual_payment_id]);
    }

    // Activate user if not already active
    if (payment.user_status !== 'active') {
      await pool.query(`
        UPDATE users 
        SET status = 'active', 
            activation_paid = TRUE, 
            activated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [payment.user_id]);

      // Process commissions
      try {
        await commissionService.processActivationCommissions(payment.user_id);
      } catch (commissionError) {
        console.error('Commission processing error:', commissionError);
        // Continue even if commission processing fails
      }

      // Send activation notification
      const notificationService = req.app.locals.notificationService;
      if (notificationService) {
        try {
          // Get referrer info for notification
          const [referrerInfo] = await pool.query('SELECT referrer_id FROM users WHERE id = ?', [payment.user_id]);
          
          await notificationService.notifyUserActivated(payment.user_id, {
            username: payment.username,
            paymentMethod: 'Manual Approval',
            amount: `${payment.amount_original} ${payment.currency}`,
            referrerId: referrerInfo.length > 0 ? referrerInfo[0].referrer_id : null
          });
        } catch (notificationError) {
          console.error('Activation notification error:', notificationError);
        }
      }
    }

    res.redirect('/admin/activation-payments?success=' + encodeURIComponent(`Payment approved successfully for user ${payment.username}. User has been activated.`));
  } catch (err) {
    console.error('Manual approval error:', err);
    res.redirect('/admin/activation-payments?error=Failed to approve payment');
  }
});

// Reject activation payment
router.post('/admin/activation-payments/:id/reject', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const paymentId = req.params.id;
    const { reason } = req.body;

    // Get payment details including manual payment info
    const [payments] = await pool.query(`
      SELECT 
        ap.*, 
        u.username,
        map.id as manual_payment_id
      FROM activation_payments ap
      JOIN users u ON ap.user_id = u.id
      LEFT JOIN manual_activation_payments map ON ap.manual_payment_id = map.id
      WHERE ap.id = ?
    `, [paymentId]);

    if (payments.length === 0) {
      return res.redirect('/admin/activation-payments?error=Payment not found');
    }

    const payment = payments[0];

    // Update payment status to failed
    await pool.query(`
      UPDATE activation_payments 
      SET payment_status = 'failed',
          payment_response = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify({ rejection_reason: reason || 'Manually rejected by admin' }), paymentId]);

    // If this is a manual payment, update the manual payment record
    if (payment.manual_payment_id) {
      await pool.query(`
        UPDATE manual_activation_payments 
        SET status = 'rejected',
            admin_notes = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [reason || 'Payment rejected by admin', payment.manual_payment_id]);
    }

    // Send rejection notification
    const notificationService = req.app.locals.notificationService;
    if (notificationService) {
      try {
        await notificationService.notifyPaymentStatus(payment.user_id, {
          status: 'failed',
          amount: `${payment.amount_original} ${payment.currency}`,
          method: 'Manual Payment',
          paymentType: 'activation'
        });
      } catch (notificationError) {
        console.error('Payment rejection notification error:', notificationError);
      }
    }

    res.redirect('/admin/activation-payments?success=' + encodeURIComponent(`Payment rejected for user ${payment.username}`));
  } catch (err) {
    console.error('Manual rejection error:', err);
    res.redirect('/admin/activation-payments?error=Failed to reject payment');
  }
});

// Commission Management
router.get('/admin/commissions', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    
    const [commissions] = await pool.query(`
      SELECT 
        c.*,
        u.username as user_username,
        r.username as referrer_username,
        ru.username as referred_username
      FROM commissions c
      JOIN users u ON c.user_id = u.id
      JOIN users r ON c.referrer_id = r.id
      JOIN users ru ON c.referred_user_id = ru.id
      ORDER BY c.created_at DESC
      LIMIT 100
    `);

    res.render('admin/commissions', {
      user: req.session.user,
      commissions: commissions,
      successMessage: req.query.success,
      errorMessage: req.query.error
    });
  } catch (err) {
    console.error('Admin commissions error:', err);
    res.redirect('/admin/dashboard?error=Failed to load commissions');
  }
});

// // Banner Management Routes
router.get('/admin/banners', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    
    // Get pending banners count for notification badge
    const [pendingCount] = await pool.query(`
      SELECT COUNT(*) as count FROM banners WHERE status = 'pending'
    `);

    // Get all banners with merchant info and analytics
    // First, get raw view counts for debugging
    const [rawViews] = await pool.query(`
      SELECT banner_id, COUNT(*) as view_count 
      FROM banner_views 
      GROUP BY banner_id
    `);
    
    console.log('Raw banner views:', rawViews);

    const [banners] = await pool.query(`
      WITH banner_stats AS (
        SELECT 
          b.id as banner_id,
          COUNT(DISTINCT bv.id) as total_views,
          COUNT(DISTINCT bc.id) as total_clicks,
          COUNT(DISTINCT CASE WHEN DATE(bv.viewed_at) = CURDATE() THEN bv.id END) as today_views,
          COUNT(DISTINCT CASE WHEN DATE(bc.clicked_at) = CURDATE() THEN bc.id END) as today_clicks
        FROM banners b
        LEFT JOIN banner_views bv ON b.id = bv.banner_id
        LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
        GROUP BY b.id
      )
      SELECT 
        b.*,
        CASE 
          WHEN b.merchant_id IS NULL THEN 'Admin'
          ELSE u.username
        END as merchant_name,
        CASE 
          WHEN b.merchant_id IS NULL THEN 'System'
          ELSE u.business_name
        END as merchant_business,
        CASE 
          WHEN b.merchant_id IS NULL THEN 'admin@system'
          ELSE u.email
        END as merchant_email,
        COALESCE(bs.total_views, 0) as total_views,
        COALESCE(bs.total_clicks, 0) as total_clicks,
        COALESCE(bs.today_views, 0) as today_views,
        COALESCE(bs.today_clicks, 0) as today_clicks,
        CASE 
          WHEN bs.total_views > 0 
          THEN ROUND((bs.total_clicks / bs.total_views) * 100, 2)
          ELSE 0 
        END as ctr,
        TIME_TO_SEC(TIMEDIFF(NOW(), b.created_at)) as seconds_ago
      FROM banners b
      LEFT JOIN users u ON b.merchant_id = u.id
      LEFT JOIN banner_stats bs ON b.id = bs.banner_id
      ORDER BY 
        CASE b.status
          WHEN 'pending' THEN 1
          WHEN 'approved' THEN 2
          ELSE 3
        END,
        b.created_at DESC
    `);

    // Debug: Query raw counts directly for verification
    const [rawCounts] = await pool.query(`
      SELECT 
        'views' as type,
        banner_id,
        COUNT(DISTINCT id) as count
      FROM banner_views
      GROUP BY banner_id
      UNION ALL
      SELECT 
        'clicks' as type,
        banner_id,
        COUNT(DISTINCT id) as count
      FROM banner_clicks
      GROUP BY banner_id
    `);
    
    console.log('Raw counts from database:', rawCounts);
    
    // Calculate statistics with detailed logging
    console.log('Processing banners for stats:', banners.map(b => ({
      id: b.id,
      views: parseInt(b.total_views),
      clicks: parseInt(b.total_clicks),
      rawViews: typeof b.total_views
    })));

    const stats = {
      pending: banners.filter(b => b.status === 'pending').length,
      active: banners.filter(b => b.status === 'approved' && b.is_active).length,
      totalViews: banners.reduce((sum, b) => {
        const views = parseInt(b.total_views) || 0;
        console.log(`Banner ${b.id}: views = ${views} (raw: ${b.total_views})`);
        return sum + views;
      }, 0),
      totalClicks: banners.reduce((sum, b) => sum + (parseInt(b.total_clicks) || 0), 0),
      ctr: 0
    };
    
    // Calculate CTR if there are views
    if (stats.totalViews > 0) {
      stats.ctr = ((stats.totalClicks / stats.totalViews) * 100).toFixed(2);
    }

    res.render('admin/banners', {
      user: req.user,
      banners: banners,
      stats: stats,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin banners error:', err);
    res.redirect('/admin/dashboard?error=Failed to load banners');
  }
});

router.get('/admin/banners/create', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    
    // Get popular links for targeting options
    const [popularLinks] = await pool.query(`
      SELECT 
        sl.*,
        l.title,
        l.url,
        l.type,
        l.description,
        u.username as merchant_name,
        COALESCE(clicks.click_count, 0) as click_count
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN (
        SELECT shared_link_id, COUNT(*) as click_count 
        FROM clicks 
        GROUP BY shared_link_id
      ) clicks ON sl.id = clicks.shared_link_id
      ORDER BY click_count DESC
      LIMIT 50
    `);

    res.render('admin/banner-form', {
      user: req.session.user,
      banner: null,
      popularLinks: popularLinks,
      isEdit: false,
      errorMessage: req.query.error || null,
      successMessage: req.query.success || null,
      formData: null  // Add formData with null value for initial render
    });
  } catch (err) {
    console.error('Admin banner create error:', err);
    res.redirect('/admin/banners?error=Failed to load create form');
  }
});

router.post('/admin/banners/create', isAdmin, (req, res, next) => {
  const uploadMiddleware = upload.single('banner_image');
  uploadMiddleware(req, res, function(err) {
    const redirectWithError = (error) => {
      // Get any existing form data
      const formData = { ...req.body };
      delete formData.banner_image; // Remove the file input as it can't be preserved
      
      res.render('admin/banner-form', {
        user: req.session.user,
        banner: null,
        popularLinks: [],  // We'll refetch these in the main handler
        isEdit: false,
        errorMessage: error,
        formData: formData  // Pass back the form data
      });
    };

    if (err instanceof multer.MulterError) {
      // A Multer error occurred during upload
      if (err.code === 'LIMIT_FILE_SIZE') {
        return redirectWithError('File size is too large. Maximum size is 5MB.');
      }
      return redirectWithError('Error uploading file: ' + err.message);
    } else if (err) {
      // An unknown error occurred
      return redirectWithError('Error uploading file. Please try again.');
    }
    
    // Handle file validation error
    if (req.fileValidationError) {
      return redirectWithError(req.fileValidationError);
    }
    
    // Check if file was provided
    if (!req.file) {
      return redirectWithError('Please select a banner image to upload.');
    }
    
    next();
  });
}, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { title, targetUrl, target_type, min_clicks, target_links } = req.body;

    // Move uploaded file to proper location
    const fileName = req.file.filename;
    const imageUrl = `/uploads/${fileName}`;

    // No need to get rates anymore since we're not doing CPC/CPM

    // Create banner with click target and basic fields
    const [result] = await pool.query(`
      INSERT INTO banners (
        title, 
        image_url, 
        target_url, 
        status,
        is_active,
        target_type,
        min_clicks,
        merchant_id,
        display_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      title, 
      imageUrl, 
      targetUrl,
      'pending',  // Merchant banners start as pending
      false,      // inactive until approved
      target_type || 'all', 
      parseInt(min_clicks) || 0, 
      req.body.merchant_id,  // Merchant ID from the form
      parseInt(req.body.display_order) || 0  // display order from form
    ]);

    const bannerId = result.insertId;

    // If specific targeting, add target links
    if (target_type === 'specific' && target_links) {
      const linkIds = Array.isArray(target_links) ? target_links : [target_links];
      for (const linkId of linkIds) {
        if (linkId) {
          await pool.query(`
            INSERT INTO banner_target_links (banner_id, link_id)
            VALUES (?, ?)
          `, [bannerId, parseInt(linkId)]);
        }
      }
    }

    res.redirect('/admin/banners?success=Banner created successfully');
  } catch (err) {
    console.error('Admin banner create error:', err);
    res.redirect('/admin/banners/create?error=Failed to create banner');
  }
});

router.get('/admin/banners/:id/edit', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const bannerId = req.params.id;
    
    const [banners] = await pool.query('SELECT * FROM banners WHERE id = ?', [bannerId]);
    if (banners.length === 0) {
      return res.redirect('/admin/banners?error=Banner not found');
    }

    const [popularLinks] = await pool.query(`
      SELECT 
        sl.*,
        l.title,
        l.url,
        l.type,
        l.description,
        u.username as merchant_name,
        COALESCE(clicks.click_count, 0) as click_count,
        CASE WHEN btl.banner_id IS NOT NULL THEN 1 ELSE 0 END as is_targeted
      FROM shared_links sl
      JOIN links l ON sl.link_id = l.id
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN (
        SELECT shared_link_id, COUNT(*) as click_count 
        FROM clicks 
        GROUP BY shared_link_id
      ) clicks ON sl.id = clicks.shared_link_id
      LEFT JOIN banner_target_links btl ON sl.id = btl.link_id AND btl.banner_id = ?
      ORDER BY click_count DESC
      LIMIT 50
    `, [bannerId]);

    res.render('admin/banner-form', {
      user: req.session.user,
      banner: banners[0],
      popularLinks: popularLinks,
      isEdit: true
    });
  } catch (err) {
    console.error('Admin banner edit error:', err);
    res.redirect('/admin/banners?error=Failed to load banner');
  }
});

router.post('/admin/banners/:id/edit', isAdmin, upload.single('banner_image'), async (req, res) => {
  const bannerId = req.params.id; // Moved outside try block for error handling access
  try {
    console.log('Received form data:', req.body); // Debug log
    
    const pool = req.app.locals.pool;
    const { 
      title, 
      targetUrl, 
      merchantId, 
      status, 
      displayOrder, 
      is_active, // Changed from isActive to is_active to match form field name
      target_type = 'all',    // Default to 'all' if not provided
      min_clicks = 0,         // Default to 0 if not provided
      target_links 
    } = req.body;
    
    let imageUrl = null;
    if (req.file) {
      const fileName = req.file.filename;
      imageUrl = `/uploads/${fileName}`;
    }

    // Get current banner with all fields
    const [bannerData] = await pool.query(
      'SELECT merchant_id, status, is_active FROM banners WHERE id = ?', 
      [bannerId]
    );
    
    if (!bannerData || bannerData.length === 0) {
      return res.redirect('/admin/banners?error=Banner not found');
    }

    // Handle all the fields that need to be preserved or updated
    const finalMerchantId = merchantId || bannerData[0].merchant_id;
    const finalStatus = status || bannerData[0].status;
    
    // Convert is_active to boolean properly - handle all possible truthy values including 'on'
    const finalIsActive = is_active === '1' || is_active === 1 || is_active === true || is_active === 'true' || is_active === 'on';
    
    console.log('Active Status Update:', {
      received: is_active,
      converted: finalIsActive,
      previous: bannerData[0].is_active,
      type: typeof is_active
    });

    // Update banner
    if (imageUrl) {
      await pool.query(`
        UPDATE banners 
        SET title = ?, 
            image_url = ?, 
            target_url = ?, 
            merchant_id = ?, 
            status = ?, 
            display_order = ?, 
            is_active = ?, 
            target_type = ?, 
            min_clicks = ?
        WHERE id = ?
      `, [
        title, 
        imageUrl, 
        targetUrl, 
        finalMerchantId, 
        finalStatus,
        parseInt(displayOrder) || 0, 
        finalIsActive, 
        target_type,
        parseInt(min_clicks) || 0,
        bannerId
      ]);
    } else {
      await pool.query(`
        UPDATE banners 
        SET title = ?, 
            target_url = ?, 
            merchant_id = ?, 
            status = ?, 
            display_order = ?, 
            is_active = ?, 
            target_type = ?, 
            min_clicks = ?
        WHERE id = ?
      `, [
        title, 
        targetUrl, 
        finalMerchantId, 
        finalStatus,
        parseInt(displayOrder) || 0, 
        finalIsActive,
        target_type,
        parseInt(min_clicks) || 0,
        bannerId
      ]);
    }

    // Update target links if needed
    if (target_type === 'specific' && target_links) {
      // First delete existing target links
      await pool.query('DELETE FROM banner_target_links WHERE banner_id = ?', [bannerId]);
      
      // Then insert new ones
      const linkIds = Array.isArray(target_links) ? target_links : [target_links];
      for (const linkId of linkIds) {
        if (linkId) {
          await pool.query(`
            INSERT INTO banner_target_links (banner_id, link_id)
            VALUES (?, ?)
          `, [bannerId, parseInt(linkId)]);
        }
      }
    }

    res.redirect('/admin/banners?success=Banner updated successfully');
  } catch (err) {
    console.error('Admin banner update error:', err);
    res.redirect(`/admin/banners/${bannerId}/edit?error=Failed to update banner`);
  }
});
router.post('/admin/banners/:id/delete', isAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const bannerId = req.params.id;
    
    await pool.query('DELETE FROM banners WHERE id = ?', [bannerId]);
    
    res.redirect('/admin/banners?success=Banner deleted successfully');
  } catch (err) {
    console.error('Admin banner delete error:', err);
    res.redirect('/admin/banners?error=Failed to delete banner');
  }
});

const { logError } = require('../utils/logger');

router.get('/admin/banners/:id/analytics', isAdmin, async (req, res) => {
  try {
    console.log('Starting banner analytics fetch for ID:', req.params.id);
    const pool = req.app.locals.pool;
    const bannerId = req.params.id;
    
    console.log('Fetching banner details...');
    const [banner] = await pool.query('SELECT * FROM banners WHERE id = ?', [bannerId]);
    console.log('Banner query result:', banner);
    if (banner.length === 0) {
      return res.redirect('/admin/banners?error=Banner not found');
    }

    // Get comprehensive analytics data for the last 30 days
    console.log('Fetching analytics data...');
    const [analytics] = await pool.query(`
      WITH dates AS (
        SELECT CURDATE() - INTERVAL n DAY as date
        FROM (
          SELECT a.N + b.N * 10 as n
          FROM (SELECT 0 as N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
               (SELECT 0 as N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3) b
          WHERE a.N + b.N * 10 <= 30
        ) numbers
      )
      SELECT 
        d.date,
        COALESCE(views.count, 0) as views,
        COALESCE(clicks.count, 0) as clicks,
        CASE 
          WHEN COALESCE(views.count, 0) > 0 
          THEN ROUND((COALESCE(clicks.count, 0) / COALESCE(views.count, 0)) * 100, 2)
          ELSE 0 
        END as ctr
      FROM dates d
      LEFT JOIN (
        SELECT 
          DATE(viewed_at) as date,
          COUNT(*) as count
        FROM banner_views
        WHERE banner_id = ?
        GROUP BY DATE(viewed_at)
      ) views ON d.date = views.date
      LEFT JOIN (
        SELECT 
          DATE(clicked_at) as date,
          COUNT(*) as count
        FROM banner_clicks
        WHERE banner_id = ?
        GROUP BY DATE(clicked_at)
      ) clicks ON d.date = clicks.date
      ORDER BY d.date DESC
    `, [bannerId, bannerId]);

    // Get total statistics
    console.log('Fetching total statistics...');
    const [totalStats] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM banner_views WHERE banner_id = ?) as total_views,
        (SELECT COUNT(*) FROM banner_clicks WHERE banner_id = ?) as total_clicks,
        (SELECT COUNT(*) FROM banner_views WHERE banner_id = ? AND DATE(viewed_at) = CURDATE()) as today_views,
        (SELECT COUNT(*) FROM banner_clicks WHERE banner_id = ? AND DATE(clicked_at) = CURDATE()) as today_clicks,
        b.total_spent as total_revenue,
        b.cost_per_click,
        b.cost_per_view,
        CASE 
          WHEN (SELECT COUNT(*) FROM banner_views WHERE banner_id = ?) > 0 
          THEN ROUND(((SELECT COUNT(*) FROM banner_clicks WHERE banner_id = ?) * 100.0 / 
                     (SELECT COUNT(*) FROM banner_views WHERE banner_id = ?)), 2)
          ELSE 0 
        END as overall_ctr
      FROM banners b
      WHERE b.id = ?
    `, [bannerId, bannerId, bannerId, bannerId, bannerId, bannerId, bannerId, bannerId, bannerId]);

    // Get recent activity combining views and clicks
    const [recentActivity] = await pool.query(`
      SELECT * FROM (
        (SELECT 
          bv.id,
          'impression' as event_type,
          bv.viewed_at as timestamp,
          bv.ip_address,
          bv.user_agent,
          b.title as link_title,
          'Anonymous' as username
        FROM banner_views bv
        LEFT JOIN banners b ON bv.banner_id = b.id
        WHERE bv.banner_id = ?
        ORDER BY bv.viewed_at DESC
        LIMIT 25)
        
        UNION ALL
        
        (SELECT 
          bc.id,
          'click' as event_type,
          bc.clicked_at as timestamp,
          bc.ip_address,
          bc.user_agent,
          b.title as link_title,
          'Anonymous' as username
        FROM banner_clicks bc
        LEFT JOIN banners b ON bc.banner_id = b.id
        WHERE bc.banner_id = ?
        ORDER BY bc.clicked_at DESC
        LIMIT 25)
      ) as combined_events
      ORDER BY timestamp DESC
      LIMIT 50
    `, [bannerId, bannerId]);

    // Format stats to match the template's expected structure
    const formattedStats = [
      {
        event_type: 'impression',
        total: totalStats[0].total_views
      },
      {
        event_type: 'click',
        total: totalStats[0].total_clicks
      }
    ];

    // Format timestamps in recent activity
    const formattedRecentActivity = recentActivity.map(activity => ({
      ...activity,
      timestamp: new Date(activity.timestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    }));

    res.render('admin/banner-analytics', {
      user: req.session.user,
      banner: banner[0],
      analytics: analytics,
      totalStats: formattedStats,
      recentActivity: formattedRecentActivity
    });
  } catch (err) {
    logError('AdminRoutes.bannerAnalytics', err, {
      bannerId: req.params.id,
      user: req.user?.id,
      sqlState: err.sqlState,
      sqlMessage: err.sqlMessage
    });
    res.redirect('/admin/banners?error=Failed to load analytics');
  }
});

// ===== NOTIFICATION AND REPORTING SYSTEM ROUTES =====

// Admin notifications dashboard
router.get('/admin/notifications', isAdmin, async (req, res) => {
  try {
    const notificationService = req.app.locals.notificationService;
    
    // Get recent notifications
    const [notifications] = await pool.query(`
      SELECT n.*, u.username, u.email 
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
      LIMIT 100
    `);

    // Get notification stats
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN email_sent = 1 THEN 1 ELSE 0 END) as email_sent,
        SUM(CASE WHEN type = 'critical' THEN 1 ELSE 0 END) as critical
      FROM notifications 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);

    // Get email logs
    const [emailLogs] = await pool.query(`
      SELECT * FROM email_logs 
      ORDER BY created_at DESC 
      LIMIT 50
    `);

    res.render('admin/notifications', {
      user: req.session.user,
      notifications,
      stats: stats[0],
      emailLogs
    });
  } catch (err) {
    console.error('Admin notifications error:', err);
    res.redirect('/admin?error=Failed to load notifications');
  }
});

// Send manual report triggers
router.post('/admin/reports/trigger', isAdmin, async (req, res) => {
  try {
    const { reportType } = req.body;
    const reportScheduler = req.app.locals.reportScheduler;
    
    let result;
    switch (reportType) {
      case 'daily':
        result = await reportScheduler.triggerDailyReport();
        break;
      case 'weekly':
        result = await reportScheduler.triggerWeeklyReport();
        break;
      case 'monthly':
        result = await reportScheduler.triggerMonthlyReport();
        break;
      case 'health':
        result = await reportScheduler.triggerHealthCheck();
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid report type' });
    }

    res.json(result);
  } catch (err) {
    console.error('Manual report trigger error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// System status endpoint
router.get('/admin/system-status', isAdmin, async (req, res) => {
  try {
    const reportScheduler = req.app.locals.reportScheduler;
    const emailService = req.app.locals.emailService;
    
    // Get scheduler status
    const schedulerStatus = reportScheduler.getSchedulerStatus();
    
    // Check email service status
    let emailStatus = { connected: false, config: null };
    try {
      if (emailService.transporter) {
        await emailService.transporter.verify();
        emailStatus = {
          connected: true,
          config: emailService.currentConfig?.name || 'Unknown'
        };
      }
    } catch (error) {
      emailStatus.error = error.message;
    }

    // Get recent system stats
    const [systemStats] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'admin') as admin_users,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE()) as orders_today,
        (SELECT COUNT(*) FROM notifications WHERE is_read = 0) as unread_notifications,
        (SELECT COUNT(*) FROM email_logs WHERE status = 'failed' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) as failed_emails_hour
    `);

    res.json({
      success: true,
      scheduler: schedulerStatus,
      email: emailStatus,
      stats: systemStats[0],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('System status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Email test endpoint
router.post('/admin/test-email', isAdmin, async (req, res) => {
  try {
    const { email, testType = 'basic' } = req.body;
    const emailService = req.app.locals.emailService;
    
    let result;
    if (testType === 'basic') {
      result = await emailService.sendEmail({
        to: email,
        subject: '✅ BenixSpace Email Test',
        html: `
          <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white;">
              <h1>🎉 Email Test Successful!</h1>
            </div>
            <div style="padding: 30px; background: white;">
              <p>This is a test email from BenixSpace email service.</p>
              <p><strong>Test Details:</strong></p>
              <ul>
                <li>Sent at: ${new Date().toISOString()}</li>
                <li>Service: ${emailService.currentConfig?.name || 'Unknown'}</li>
                <li>SMTP Host: ${emailService.currentConfig?.host || 'Unknown'}</li>
              </ul>
              <p>If you received this email, your email configuration is working correctly!</p>
            </div>
          </div>
        `
      });
    } else if (testType === 'template') {
      result = await emailService.sendTemplatedEmail('welcome', email, {
        username: 'Test User',
        dashboard_url: process.env.BASE_URL + '/dashboard'
      });
    }

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    console.error('Email test error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// User notification preferences (for admin to view/edit)
router.get('/admin/users/:id/notifications', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Get user data
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!users.length) {
      return res.status(404).render('error', { message: 'User not found' });
    }
    
    // Get user's notification preferences
    const [preferences] = await pool.query(`
      SELECT * FROM notification_preferences WHERE user_id = ?
    `, [userId]);
    
    // Get user's recent notifications
    const [notifications] = await pool.query(`
      SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `, [userId]);

    res.render('admin/user-notifications', {
      user: req.session.user,
      targetUser: users[0],
      preferences: preferences[0] || {},
      notifications
    });
  } catch (err) {
    console.error('User notifications error:', err);
    res.redirect('/admin/users?error=Failed to load user notifications');
  }
});

// Update user notification preferences
router.post('/admin/users/:id/notifications', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const notificationService = req.app.locals.notificationService;
    
    await notificationService.updateNotificationPreferences(userId, {
      emailNotifications: req.body.email_notifications === 'on',
      commissionAlerts: req.body.commission_alerts === 'on',
      paymentAlerts: req.body.payment_alerts === 'on',
      systemAlerts: req.body.system_alerts === 'on',
      dailyReports: req.body.daily_reports === 'on',
      weeklyReports: req.body.weekly_reports === 'on',
      monthlyReports: req.body.monthly_reports === 'on',
      marketingEmails: req.body.marketing_emails === 'on'
    });

    res.redirect(`/admin/users/${userId}/notifications?success=Notification preferences updated`);
  } catch (err) {
    console.error('Update notification preferences error:', err);
    res.redirect(`/admin/users/${userId}/notifications?error=Failed to update preferences`);
  }
});

// Bulk notification to all users
router.post('/admin/notifications/broadcast', isAdmin, async (req, res) => {
  try {
    const { title, message, type = 'info', sendEmail = false } = req.body;
    const notificationService = req.app.locals.notificationService;
    
    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message are required' });
    }
    
    const result = await notificationService.notifyAllUsers({
      type,
      category: 'system',
      title,
      message,
      sendEmail: sendEmail === 'on',
      priority: 2
    });

    res.json({ success: true, message: 'Notification broadcast successfully' });
  } catch (err) {
    console.error('Broadcast notification error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test notification route
router.post('/admin/api/test-notification', isAdmin, async (req, res) => {
  try {
    const notificationService = req.app.locals.notificationService;
    const { type, userId } = req.body;

    if (!notificationService) {
      return res.json({ success: false, error: 'Notification service not available' });
    }

    let result;
    const testUserId = userId || 1; // Default to user ID 1 for testing

    switch (type) {
      case 'registration':
        result = await notificationService.notifyUserRegistered(testUserId, {
          username: 'TestUser',
          email: 'test@example.com',
          hasReferrer: true
        });
        break;
        
      case 'activation':
        result = await notificationService.notifyUserActivated(testUserId, {
          username: 'TestUser',
          paymentMethod: 'Test Payment',
          amount: '3000 RWF',
          referrerId: 2
        });
        break;
        
      case 'commission':
        result = await notificationService.notifyCommissionEarned(testUserId, {
          amount: '1500 RWF ($1.50)',
          source: 'Level 1 referral activation commission from TestUser2',
          currency: 'RWF',
          level: 1,
          referredUser: 'TestUser2'
        });
        break;
        
      case 'order':
        result = await notificationService.notifyOrderPlaced(testUserId, {
          orderId: '12345',
          totalAmount: '5000 RWF',
          items: 'Test Product 1, Test Product 2',
          merchantId: null
        });
        break;
        
      case 'payment_success':
        result = await notificationService.notifyPaymentStatus(testUserId, {
          status: 'success',
          amount: '3000 RWF',
          method: 'Flutterwave',
          paymentType: 'activation'
        });
        break;
        
      case 'security_login':
        result = await notificationService.notifySecurityEvent(testUserId, {
          eventType: 'login',
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0 Test Browser'
        });
        break;
        
      case 'link_click':
        result = await notificationService.notifyLinkActivity(testUserId, {
          action: 'new_click',
          linkTitle: 'Test Promotional Link',
          earnings: '0.0050 USD'
        });
        break;
        
      case 'link_milestone':
        result = await notificationService.notifyLinkActivity(testUserId, {
          action: 'milestone_reached',
          linkTitle: 'Test Promotional Link',
          clicks: 100
        });
        break;
        
      case 'referral_activity':
        result = await notificationService.notifyReferralActivity(testUserId, {
          action: 'commission_earned',
          referredUsername: 'TestReferral',
          level: 1,
          commissionAmount: '1500 RWF'
        });
        break;
        
      case 'promotion':
        result = await notificationService.notifyPromotion(testUserId, {
          title: 'Special Offer!',
          message: 'Get 50% off your next purchase',
          promoCode: 'SAVE50',
          expiryDate: '2024-12-31',
          actionUrl: '/products'
        });
        break;
        
      default:
        return res.json({ success: false, error: 'Invalid notification type' });
    }

    res.json({ 
      success: true, 
      message: `Test ${type} notification sent successfully`,
      result: result
    });

  } catch (error) {
    console.error('Test notification error:', error);
    res.json({ 
      success: false, 
      error: error.message || 'Failed to send test notification'
    });
  }
});

// Blog Management Routes

// Admin blog posts listing
router.get('/admin/blog-posts', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || '';

    let query = `
      SELECT 
        bp.*,
        u.username as author_name,
        COALESCE(bp.view_count, 0) as total_views,
        COALESCE(bp.click_count, 0) as total_clicks,
        (SELECT COUNT(*) FROM blog_post_shares WHERE blog_post_id = bp.id) as total_shares
      FROM blog_posts bp
      LEFT JOIN users u ON bp.merchant_id = u.id
      WHERE 1=1
    `;
    const queryParams = [];

    if (search) {
      query += ` AND (bp.title LIKE ? OR bp.excerpt LIKE ? OR u.username LIKE ?)`;
      queryParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status) {
      if (status === 'active') {
        query += ` AND bp.is_active = true`;
      } else if (status === 'inactive') {
        query += ` AND bp.is_active = false`;
      }
    }

    query += ` ORDER BY bp.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);

    const [posts] = await pool.query(query, queryParams);

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM blog_posts bp
      LEFT JOIN users u ON bp.merchant_id = u.id
      WHERE 1=1
    `;
    const countParams = [];

    if (search) {
      countQuery += ` AND (bp.title LIKE ? OR bp.excerpt LIKE ? OR u.username LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status) {
      if (status === 'active') {
        countQuery += ` AND bp.is_active = true`;
      } else if (status === 'inactive') {
        countQuery += ` AND bp.is_active = false`;
      }
    }

    const [countResult] = await pool.query(countQuery, countParams);
    const totalPosts = countResult[0].total;
    const totalPages = Math.ceil(totalPosts / limit);

    res.render('admin/blog-posts', {
      user: req.user,
      posts,
      currentPage: page,
      totalPages,
      search,
      status,
      totalPosts
    });
  } catch (error) {
    console.error('Error fetching blog posts:', error);
    res.status(500).render('error', { 
      message: 'Error fetching blog posts' 
    });
  }
});

// Toggle blog post status (active/inactive)
router.post('/admin/api/blog-posts/:id/toggle-status', isAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    
    // Get current status
    const [currentPost] = await pool.query(
      'SELECT is_active FROM blog_posts WHERE id = ?',
      [postId]
    );

    if (currentPost.length === 0) {
      return res.json({ success: false, error: 'Blog post not found' });
    }

    const newStatus = !currentPost[0].is_active;
    
    await pool.query(
      'UPDATE blog_posts SET is_active = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, postId]
    );

    res.json({ success: true, newStatus: newStatus ? 'active' : 'inactive' });
  } catch (error) {
    console.error('Error toggling blog post status:', error);
    res.json({ success: false, error: 'Failed to update status' });
  }
});

// Delete blog post
router.post('/admin/api/blog-posts/:id/delete', isAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    
    // Delete related records first
    // Delete clicks that are linked through shares
    await pool.query(`
      DELETE bpc FROM blog_post_clicks bpc 
      INNER JOIN blog_post_shares bps ON bpc.blog_post_share_id = bps.id 
      WHERE bps.blog_post_id = ?
    `, [postId]);
    await pool.query('DELETE FROM blog_post_shares WHERE blog_post_id = ?', [postId]);
    
    // Delete the blog post
    await pool.query('DELETE FROM blog_posts WHERE id = ?', [postId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting blog post:', error);
    res.json({ success: false, error: 'Failed to delete blog post' });
  }
});

// Admin blog post edit form
router.get('/admin/blog-posts/:id/edit', isAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    
    const [posts] = await pool.query(
      'SELECT * FROM blog_posts WHERE id = ?',
      [postId]
    );

    if (posts.length === 0) {
      return res.status(404).render('error', { 
        message: 'Blog post not found' 
      });
    }

    const [users] = await pool.query(
      'SELECT id, username FROM users ORDER BY username'
    );

    res.render('admin/blog-post-edit', {
      user: req.user,
      post: posts[0],
      users
    });
  } catch (error) {
    console.error('Error fetching blog post:', error);
    res.status(500).render('error', { 
      message: 'Error fetching blog post' 
    });
  }
});

// Admin blog post update
router.post('/admin/blog-posts/:id/edit', isAdmin, upload.single('featured_image'), async (req, res) => {
  try {
    const postId = req.params.id;
    const { 
      title, 
      excerpt, 
      content, 
      is_active, 
      meta_title, 
      meta_description, 
      tags,
      user_id
    } = req.body;

    let updateFields = {
      title,
      excerpt,
      content,
      is_active: is_active === 'true',
      meta_title,
      meta_description,
      merchant_id: user_id
    };

    // Handle featured image upload
    if (req.file) {
      updateFields.featured_image = req.file.filename;
    }

    const setClause = Object.keys(updateFields).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updateFields);
    values.push(postId);

    await pool.query(
      `UPDATE blog_posts SET ${setClause} WHERE id = ?`,
      values
    );

    res.redirect('/admin/blog-posts?message=Blog post updated successfully');
  } catch (error) {
    console.error('Error updating blog post:', error);
    res.redirect(`/admin/blog-posts/${req.params.id}/edit?error=Failed to update blog post`);
  }
});

// Admin create new blog post form
router.get('/admin/blog-posts/create', isAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username FROM users ORDER BY username'
    );

    res.render('admin/blog-post-create', {
      user: req.user,
      users
    });
  } catch (error) {
    console.error('Error loading create form:', error);
    res.status(500).render('error', { 
      message: 'Error loading create form' 
    });
  }
});

// Admin create new blog post
router.post('/admin/blog-posts/create', isAdmin, upload.single('featured_image'), async (req, res) => {
  try {
    const { 
      title, 
      excerpt, 
      content, 
      is_active, 
      meta_title, 
      meta_description, 
      tags,
      user_id
    } = req.body;

    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim('-');

    const postData = {
      merchant_id: user_id,
      title,
      slug,
      excerpt,
      content,
      featured_image: req.file ? req.file.filename : null,
      is_active: is_active === 'true',
      meta_title,
      meta_description,
      cpc: 0.01
    };

    const fields = Object.keys(postData).join(', ');
    const placeholders = Object.keys(postData).map(() => '?').join(', ');
    const values = Object.values(postData);

    await pool.query(
      `INSERT INTO blog_posts (${fields}) VALUES (${placeholders})`,
      values
    );

    res.redirect('/admin/blog-posts?message=Blog post created successfully');
  } catch (error) {
    console.error('Error creating blog post:', error);
    res.redirect('/admin/blog-posts/create?error=Failed to create blog post');
  }
});

// Blog post analytics/details
router.get('/admin/blog-posts/:id/analytics', isAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    
    const [posts] = await pool.query(`
      SELECT 
        bp.*,
        u.username as author_name
      FROM blog_posts bp
      LEFT JOIN users u ON bp.merchant_id = u.id
      WHERE bp.id = ?
    `, [postId]);

    if (posts.length === 0) {
      return res.status(404).render('error', { 
        message: 'Blog post not found' 
      });
    }

    // Get click analytics
    const [clickStats] = await pool.query(`
      SELECT 
        DATE(bpc.clicked_at) as date,
        COUNT(*) as clicks
      FROM blog_post_clicks bpc
      INNER JOIN blog_post_shares bps ON bpc.blog_post_share_id = bps.id
      WHERE bps.blog_post_id = ?
      GROUP BY DATE(bpc.clicked_at)
      ORDER BY date DESC
      LIMIT 30
    `, [postId]);

    // Get share analytics
    const [shareStats] = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as shares
      FROM blog_post_shares 
      WHERE blog_post_id = ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `, [postId]);

    // Get recent clicks with user info (through shares)
    const [recentClicks] = await pool.query(`
      SELECT 
        bpc.*,
        u.username,
        bps.unique_code as share_code
      FROM blog_post_clicks bpc
      INNER JOIN blog_post_shares bps ON bpc.blog_post_share_id = bps.id
      LEFT JOIN users u ON bps.user_id = u.id
      WHERE bps.blog_post_id = ?
      ORDER BY bpc.clicked_at DESC
      LIMIT 50
    `, [postId]);

    // Get total stats
    const [totalStats] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) 
         FROM blog_post_clicks bpc 
         INNER JOIN blog_post_shares bps ON bpc.blog_post_share_id = bps.id 
         WHERE bps.blog_post_id = ?) as total_clicks,
        (SELECT COUNT(*) FROM blog_post_shares WHERE blog_post_id = ?) as total_shares
    `, [postId, postId]);

    res.render('admin/blog-post-analytics', {
      user: req.user,
      post: posts[0],
      clickStats,
      shareStats,
      recentClicks,
      totalStats: totalStats[0]
    });
  } catch (error) {
    console.error('Error fetching blog post analytics:', error);
    res.status(500).render('error', { 
      message: 'Error fetching analytics' 
    });
  }
});

// Activation settings routes
router.get('/admin/activation-settings', isAdmin, async (req, res) => {
  try {
    const activationService = req.app.locals.activationService;
    let settings = await activationService.getActivationSettings();
    if (!settings) {
      // Initialize settings if they don't exist
      await req.app.locals.pool.query(`
        INSERT INTO activation_settings 
        (is_activation_required, min_shared_links, min_login_days, min_clicks_before_withdraw)
        VALUES (true, 0, 0, 0)
        ON DUPLICATE KEY UPDATE id = id
      `);
      const [newSettings] = await req.app.locals.pool.query('SELECT * FROM activation_settings LIMIT 1');
      settings = newSettings[0];
    }

    // Get activation statistics
    const [stats] = await req.app.locals.pool.query(`
      SELECT 
        COUNT(*) as totalUsers,
        SUM(CASE WHEN activation_status = 'active' THEN 1 ELSE 0 END) as activeUsers,
        SUM(CASE WHEN activation_status = 'pending' THEN 1 ELSE 0 END) as pendingUsers
      FROM users
    `);

    // Get flash messages if any
    const message = req.flash('message')[0];

    res.render('admin/activation-settings', {
      settings,
      stats: stats[0],
      message
    });
  } catch (error) {
    console.error('Error getting activation settings:', error);
    res.status(500).render('error', { message: 'Failed to load activation settings' });
  }
});

router.post('/admin/activation-settings', isAdmin, async (req, res) => {
  try {
    const {
      is_activation_required,
      min_shared_links,
      min_login_days,
      min_clicks_before_withdraw
    } = req.body;

    // Convert values to integers and booleans
    const newSettings = {
      is_activation_required: is_activation_required === 'on',
      min_shared_links: parseInt(min_shared_links),
      min_login_days: parseInt(min_login_days),
      min_clicks_before_withdraw: parseInt(min_clicks_before_withdraw)
    };

    // Update settings in database
    await req.app.locals.pool.query(`
      UPDATE activation_settings SET
        is_activation_required = ?,
        min_shared_links = ?,
        min_login_days = ?,
        min_clicks_before_withdraw = ?
      WHERE id = 1
    `, [
      newSettings.is_activation_required,
      newSettings.min_shared_links,
      newSettings.min_login_days,
      newSettings.min_clicks_before_withdraw
    ]);

    // Ensure the settings are immediately available in ActivationService
    const activationService = req.app.locals.activationService;
    await activationService.updateActivationSettingsCache();

    // Flash success message
    req.flash('message', {
      type: 'success',
      text: 'Activation requirements updated successfully'
    });
    res.redirect('/admin/activation-settings');
  } catch (error) {
    console.error('Error updating activation settings:', error);
    req.flash('error', 'Failed to update activation settings');
    res.redirect('/admin/activation-settings');
  }
});

module.exports = router;
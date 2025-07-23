const express = require('express');
const router = express.Router();
const db = require('../db');

// Homepage route with proper stats calculation
router.get('/', async (req, res) => {
  try {
    // Get all products
    const products = await db.query(`
      SELECT p.*, u.business_name as merchant_name 
      FROM products p 
      JOIN users u ON p.user_id = u.id 
      WHERE p.is_active = true 
      ORDER BY p.created_at DESC 
      LIMIT 6
    `);

    // Get all links
    const links = await db.query(`
      SELECT l.*, u.business_name as merchant_name, u.username
      FROM links l 
      JOIN users u ON l.user_id = u.id 
      WHERE l.is_active = true 
      ORDER BY l.created_at DESC 
      LIMIT 9
    `);

    // Get featured merchants
    const merchants = await db.query(`
      SELECT u.*, COUNT(p.id) as product_count 
      FROM users u 
      LEFT JOIN products p ON u.id = p.user_id 
      WHERE u.role = 'merchant' 
      GROUP BY u.id 
      ORDER BY product_count DESC 
      LIMIT 6
    `);

    // Get testimonials
    const testimonials = await db.query(`
      SELECT username, testimonial, role 
      FROM users 
      WHERE testimonial IS NOT NULL AND testimonial != '' 
      ORDER BY created_at DESC 
      LIMIT 6
    `);    // Calculate proper stats
    const userCountResult = await db.query('SELECT COUNT(*) as count FROM users WHERE role != "admin"');
    const clickCountResult = await db.query('SELECT COUNT(*) as total FROM clicks');
    const linkCountResult = await db.query('SELECT COUNT(*) as count FROM links WHERE is_active = true OR is_active = 1');
    const earningsResult = await db.query('SELECT SUM(earnings) as total FROM users WHERE earnings > 0');

    const stats = {
      userCount: userCountResult[0]?.count || 0,
      clickCount: clickCountResult[0]?.total || 0,
      linkCount: linkCountResult[0]?.count || 0,
      totalEarnings: earningsResult[0]?.total || 0
    };

    res.render('index', {
      user: req.user,
      products: products || [],
      links: links || [],
      merchants: merchants || [],
      testimonials: testimonials || [],
      stats: stats
    });
  } catch (error) {
    console.error('Homepage error:', error);
    res.render('index', {
      user: req.user,
      products: [],
      links: [],
      merchants: [],
      testimonials: [],
      stats: { userCount: 0, clickCount: 0, linkCount: 0, totalEarnings: 0 }
    });
  }
});

// Currency converter test page
router.get('/currency-test', (req, res) => {
  res.render('currency-test', {
    user: req.user,
    cartCount: req.session.cartCount || 0
  });
});

module.exports = router;
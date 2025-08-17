const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');

// Create MySQL connection pool - same configuration as in app.js
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'benix',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Product detail route (for users)
router.get('/product/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        // Initialize cartCount at the beginning to ensure it's always defined
        let cartCount = 0;
        
        // Get product details by ID
        const [products] = await pool.query(
            `SELECT p.*, u.username as merchant_name
             FROM products p 
             JOIN users u ON p.merchant_id = u.id
             WHERE p.id = ? AND p.is_active = 1`,
            [productId]
        );
        
        if (!products || products.length === 0) {
            return res.status(404).render('error', { 
                message: 'Product not found',
                error: { status: 404, stack: '' }
            });
        }
        
        const product = products[0];
        
        // Get cart count for the user if logged in
        if (req.session && req.session.userId) {
            try {
                const [cartItems] = await pool.query(
                    'SELECT SUM(quantity) as total FROM cart_items WHERE user_id = ?',
                    [req.session.userId]
                );
                if (cartItems && cartItems[0] && cartItems[0].total) {
                    cartCount = parseInt(cartItems[0].total) || 0;
                }
            } catch (cartErr) {
                console.error('Error fetching cart count:', cartErr);
                // Continue with cartCount = 0
            }
        }
        
        // Get related products in the same category
        let relatedProducts = [];
        if (product.category) {
            [relatedProducts] = await pool.query(
                `SELECT p.*, u.username as merchant_name
                 FROM products p
                 JOIN users u ON p.merchant_id = u.id
                 WHERE p.category = ? AND p.id != ? AND p.is_active = 1
                 LIMIT 4`,
                [product.category, productId]
            );
        }
        
        // Fetch user data if user is logged in
        let userData = null;
        if (req.session && req.session.userId) {
            try {
                const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
                if (users.length > 0) {
                    userData = users[0];
                }
            } catch (userErr) {
                console.error('Error fetching user data:', userErr);
            }
        }

        res.render('user/product-detail', {
            product,
            relatedProducts,
            user: userData,
            cartCount
        });
    } catch (err) {
        console.error('Error fetching product details:', err);
        res.status(500).render('error', { 
            message: 'Error loading product details', 
            error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
        });
    }
});

module.exports= router;
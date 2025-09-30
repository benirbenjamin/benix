const express = require('express');
const router = express.Router();

// Middleware to check if user is a merchant
const isMerchant = async (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const [users] = await req.pool.query(
            'SELECT * FROM users WHERE id = ? AND role = "merchant"',
            [req.session.userId]
        );

        if (users.length === 0) {
            req.flash('error', 'Merchant access required');
            return res.redirect('/dashboard');
        }

        req.merchant = users[0];
        next();
    } catch (err) {
        console.error('Merchant auth error:', err);
        res.status(500).render('error', {
            message: 'Server error',
            error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
        });
    }
};

// Merchant banner listing
router.get('/merchant/banners', isMerchant, async (req, res) => {
    const conn = await req.pool.getConnection();
    try {
        // Get all banners for this merchant with stats
        const [banners] = await conn.query(`
            SELECT 
                b.*,
                COUNT(DISTINCT bv.id) as total_impressions,
                COUNT(DISTINCT bc.id) as total_clicks,
                COALESCE(COUNT(DISTINCT bc.id) * 100.0 / NULLIF(COUNT(DISTINCT bv.id), 0), 0) as ctr
            FROM banners b
            LEFT JOIN banner_views bv ON b.id = bv.banner_id
            LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
            WHERE b.merchant_id = ?
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `, [req.merchant.id]);

        // Calculate merchant's overall stats
        const stats = {
            totalBanners: banners.length,
            activeCount: banners.filter(b => b.is_active).length,
            totalViews: banners.reduce((sum, b) => sum + (b.total_impressions || 0), 0),
            totalClicks: banners.reduce((sum, b) => sum + (b.total_clicks || 0), 0),
            totalCost: banners.reduce((sum, b) => {
                const clickCost = (b.total_clicks || 0) * (b.cost_per_click || 0);
                const viewCost = (b.total_impressions || 0) * (b.cost_per_view || 0);
                return sum + clickCost + viewCost;
            }, 0)
        };

        res.render('merchant/banners', {
            banners,
            stats,
            success: req.flash('success'),
            error: req.flash('error')
        });

    } catch (err) {
        console.error('Error fetching merchant banners:', err);
        req.flash('error', 'Failed to load banners');
        res.redirect('/merchant/dashboard');
    } finally {
        conn.release();
    }
});

// Merchant banner analytics
router.get('/merchant/banners/:id/analytics', isMerchant, async (req, res) => {
    const conn = await req.pool.getConnection();
    try {
        const bannerId = req.params.id;

        // Verify banner ownership
        const [[banner]] = await conn.query(`
            SELECT * FROM banners 
            WHERE id = ? AND merchant_id = ?
        `, [bannerId, req.merchant.id]);

        if (!banner) {
            req.flash('error', 'Banner not found or access denied');
            return res.redirect('/merchant/banners');
        }

        // Get daily stats for the last 30 days
        const [dailyStats] = await conn.query(`
            SELECT 
                DATE(stat_date) as date,
                SUM(CASE WHEN type = 'view' THEN count ELSE 0 END) as views,
                SUM(CASE WHEN type = 'click' THEN count ELSE 0 END) as clicks,
                SUM(CASE 
                    WHEN type = 'click' THEN count * ? 
                    ELSE count * ?
                END) as cost
            FROM (
                SELECT 
                    DATE(viewed_at) as stat_date, 
                    COUNT(*) as count,
                    'view' as type
                FROM banner_views
                WHERE banner_id = ? 
                AND viewed_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                GROUP BY DATE(viewed_at)
                UNION ALL
                SELECT 
                    DATE(clicked_at) as stat_date,
                    COUNT(*) as count,
                    'click' as type
                FROM banner_clicks
                WHERE banner_id = ?
                AND clicked_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                GROUP BY DATE(clicked_at)
            ) stats
            GROUP BY DATE(stat_date)
            ORDER BY date DESC
        `, [banner.cost_per_click || 0, banner.cost_per_view || 0, bannerId, bannerId]);

        // Get geographic distribution
        const [countryStats] = await conn.query(`
            SELECT 
                COALESCE(country, 'Unknown') as country,
                COUNT(*) as views,
                COUNT(DISTINCT bc.id) as clicks
            FROM banner_views bv
            LEFT JOIN banner_clicks bc ON bc.banner_id = bv.banner_id 
                AND bc.ip_address = bv.ip_address
                AND DATE(bc.clicked_at) = DATE(bv.viewed_at)
            WHERE bv.banner_id = ?
            GROUP BY COALESCE(country, 'Unknown')
            ORDER BY views DESC
            LIMIT 10
        `, [bannerId]);

        // Get recent activity with cost calculation
        const [recentActivity] = await conn.query(`
            (SELECT 
                'view' as type,
                viewed_at as timestamp,
                ip_address,
                user_agent,
                ? as cost
            FROM banner_views
            WHERE banner_id = ?
            ORDER BY viewed_at DESC
            LIMIT 10)
            UNION ALL
            (SELECT 
                'click' as type,
                clicked_at as timestamp,
                ip_address,
                user_agent,
                ? as cost
            FROM banner_clicks
            WHERE banner_id = ?
            ORDER BY clicked_at DESC
            LIMIT 10)
            ORDER BY timestamp DESC
            LIMIT 20
        `, [
            banner.cost_per_view || 0,
            bannerId,
            banner.cost_per_click || 0,
            bannerId
        ]);

        res.render('merchant/banner-analytics', {
            banner,
            dailyStats,
            countryStats,
            recentActivity,
            totalStats: {
                views: countryStats.reduce((sum, stat) => sum + stat.views, 0),
                clicks: countryStats.reduce((sum, stat) => sum + stat.clicks, 0),
                cost: dailyStats.reduce((sum, stat) => sum + (stat.cost || 0), 0)
            }
        });

    } catch (err) {
        console.error('Error fetching banner analytics:', err);
        req.flash('error', 'Failed to load banner analytics');
        res.redirect('/merchant/banners');
    } finally {
        conn.release();
    }
});

module.exports = router;
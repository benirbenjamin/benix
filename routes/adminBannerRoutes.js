const express = require('express');
const router = express.Router();

// Get all banners with stats
router.get('/banners', async (req, res) => {
    const conn = await req.pool.getConnection();
    try {
        // Get all banners with their stats
        const [banners] = await conn.query(`
            SELECT 
                b.*,
                u.username as created_by_name,
                COUNT(DISTINCT bv.id) as total_impressions,
                COUNT(DISTINCT bc.id) as total_clicks,
                COALESCE(COUNT(DISTINCT bc.id) * 100.0 / NULLIF(COUNT(DISTINCT bv.id), 0), 0) as ctr
            FROM banners b
            LEFT JOIN users u ON b.merchant_id = u.id
            LEFT JOIN banner_views bv ON b.id = bv.banner_id
            LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
            GROUP BY b.id, u.username
            ORDER BY b.created_at DESC
        `);

        res.render('admin/banners', {
            banners,
            successMessage: req.flash('success'),
            errorMessage: req.flash('error')
        });
    } catch (error) {
        console.error('Error fetching banners:', error);
        req.flash('error', 'Failed to load banners');
        res.redirect('/admin/dashboard');
    } finally {
        conn.release();
    }
});

// Get banner analytics
router.get('/banners/:id/analytics', async (req, res) => {
    const conn = await req.pool.getConnection();
    try {
        const bannerId = req.params.id;

        // Get banner details
        const [[banner]] = await conn.query(`
            SELECT b.*, u.username as merchant_name
            FROM banners b
            LEFT JOIN users u ON b.merchant_id = u.id
            WHERE b.id = ?
        `, [bannerId]);

        if (!banner) {
            req.flash('error', 'Banner not found');
            return res.redirect('/admin/banners');
        }

        // Get total stats
        const [totalStats] = await conn.query(`
            SELECT 
                'impression' as event_type,
                COUNT(DISTINCT id) as total
            FROM banner_views
            WHERE banner_id = ?
            UNION ALL
            SELECT 
                'click' as event_type,
                COUNT(DISTINCT id) as total
            FROM banner_clicks
            WHERE banner_id = ?
        `, [bannerId, bannerId]);

        // Get daily analytics for the last 30 days
        const [analytics] = await conn.query(`
            SELECT 
                DATE(viewed_at) as date,
                'impression' as event_type,
                COUNT(DISTINCT id) as count
            FROM banner_views
            WHERE banner_id = ?
                AND viewed_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DATE(viewed_at)
            UNION ALL
            SELECT 
                DATE(clicked_at) as date,
                'click' as event_type,
                COUNT(DISTINCT id) as count
            FROM banner_clicks
            WHERE banner_id = ?
                AND clicked_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DATE(clicked_at)
            ORDER BY date DESC
        `, [bannerId, bannerId]);

        // Get recent activity
        const [recentActivity] = await conn.query(`
            (
                SELECT 
                    'impression' as event_type,
                    ip_address,
                    user_agent,
                    viewed_at as created_at
                FROM banner_views
                WHERE banner_id = ?
                ORDER BY viewed_at DESC
                LIMIT 10
            )
            UNION ALL
            (
                SELECT 
                    'click' as event_type,
                    ip_address,
                    user_agent,
                    clicked_at as created_at
                FROM banner_clicks
                WHERE banner_id = ?
                ORDER BY clicked_at DESC
                LIMIT 10
            )
            ORDER BY created_at DESC
            LIMIT 20
        `, [bannerId, bannerId]);

        res.render('admin/banner-analytics', {
            banner,
            totalStats,
            analytics,
            recentActivity
        });

    } catch (error) {
        console.error('Error fetching banner analytics:', error);
        req.flash('error', 'Failed to load banner analytics');
        res.redirect('/admin/banners');
    } finally {
        conn.release();
    }
});

// Delete banner
router.post('/banners/:id/delete', async (req, res) => {
    const conn = await req.pool.getConnection();
    try {
        const bannerId = req.params.id;
        
        await conn.beginTransaction();

        // Delete related records first
        await conn.query('DELETE FROM banner_views WHERE banner_id = ?', [bannerId]);
        await conn.query('DELETE FROM banner_clicks WHERE banner_id = ?', [bannerId]);
        await conn.query('DELETE FROM banners WHERE id = ?', [bannerId]);

        await conn.commit();
        req.flash('success', 'Banner deleted successfully');
    } catch (error) {
        await conn.rollback();
        console.error('Error deleting banner:', error);
        req.flash('error', 'Failed to delete banner');
    } finally {
        conn.release();
    }
    res.redirect('/admin/banners');
});

module.exports = router;
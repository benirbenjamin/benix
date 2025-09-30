const express = require('express');
const router = express.Router();

// Middleware to track request metadata
const trackRequest = async (req, res, next) => {
    try {
        req.adRequest = {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            referer: req.get('Referer'),
            timestamp: new Date()
        };
        next();
    } catch (error) {
        console.error('Track request middleware error:', error);
        next(error);
    }
};

// Auto-inject ads endpoint - serves banners for auto placement
router.get('/serve', async (req, res) => {
    if (!req.pool) {
        console.error('Database connection not available');
        return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    try {
        // Get active banners with their stats
        const [banners] = await req.pool.query(`
            WITH banner_stats AS (
                SELECT 
                    b.id,
                    COUNT(DISTINCT bc.id) as click_count,
                    COUNT(DISTINCT bv.id) as view_count,
                    COUNT(DISTINCT CASE WHEN DATE(bv.viewed_at) = CURDATE() THEN bv.id END) as today_views,
                    COUNT(DISTINCT CASE WHEN DATE(bc.clicked_at) = CURDATE() THEN bc.id END) as today_clicks,
                    COALESCE(COUNT(DISTINCT bc.id) / NULLIF(COUNT(DISTINCT bv.id), 0) * 100, 0) as ctr,
                    b.min_clicks,
                    CASE 
                        WHEN b.min_clicks > 0 AND COUNT(DISTINCT bc.id) >= b.min_clicks THEN 0
                        ELSE 1
                    END as is_within_target
                FROM banners b
                LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
                LEFT JOIN banner_views bv ON b.id = bv.banner_id
                WHERE b.is_active = TRUE 
                    AND b.status = 'approved'
                    AND (b.min_clicks = 0 OR COALESCE(COUNT(DISTINCT bc.id), 0) < b.min_clicks)  -- Only if target not reached
                GROUP BY b.id
            )
            SELECT 
                b.*,
                bs.click_count,
                bs.view_count,
                bs.today_views,
                bs.today_clicks,
                bs.ctr
            FROM banners b
            JOIN banner_stats bs ON b.id = bs.id
            WHERE b.image_url IS NOT NULL
            ORDER BY 
                b.display_order DESC,
                bs.ctr DESC,
                RAND()
            LIMIT 4
        `);

        if (!banners.length) {
            return res.status(404).json({ 
                error: 'No active banners found',
                message: 'There are no approved banners available for display'
            });
        }

        // Map banners to response format
        const returnBanners = banners.map(banner => ({
            id: banner.id,
            title: banner.title,
            image_url: banner.image_url,
            target_url: banner.target_url,
            views: banner.view_count || 0,
            clicks: banner.click_count || 0,
            today_views: banner.today_views || 0, 
            today_clicks: banner.today_clicks || 0,
            ctr: banner.ctr || 0
        }));

        return res.json({ 
            success: true,
            banners: returnBanners 
        });

    } catch (error) {
        console.error('Error serving banners:', error);
        return res.status(500).json({ 
            error: 'Failed to serve banners',
            message: error.message || 'Internal server error'
        });
    }
});

// Track click endpoint
router.post('/click', trackRequest, async (req, res) => {
    if (!req.pool) {
        console.error('Database connection not available');
        return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    const { bannerId } = req.body;
    if (!bannerId || isNaN(bannerId)) {
        return res.status(400).json({ error: 'Valid Banner ID is required' });
    }

    if (!req.pool) {
        console.error('Database connection not available');
        return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    let conn;
    try {
        conn = await req.pool.getConnection();
        await conn.beginTransaction();
        console.log('Starting click processing for banner:', bannerId);
        
        // Get banner details including current click count
        const [[banner]] = await conn.query(`
            SELECT 
                b.*,
                u.id as merchant_id,
                u.amount_to_pay as current_amount_to_pay,
                (SELECT COUNT(*) FROM banner_clicks WHERE banner_id = b.id) as current_clicks
            FROM banners b 
            JOIN users u ON b.merchant_id = u.id 
            WHERE b.id = ? AND b.is_active = TRUE
        `, [bannerId]);

        if (!banner) {
            await conn.rollback();
            return res.status(404).json({ error: 'Banner not found or inactive' });
        }

        console.log('Found banner:', banner);

        try {
            // Record the click
            const [clickResult] = await conn.query(`
                INSERT INTO banner_clicks (
                    banner_id,
                    ip_address,
                    user_agent,
                    referrer,
                    country,
                    city,
                    clicked_at
                ) VALUES (?, ?, ?, ?, ?, ?, NOW())
            `, [
                bannerId,
                req.adRequest.ip || '',
                req.adRequest.userAgent || '',
                req.adRequest.referer || '',
                null,  // country - we can add geoip lookup later if needed
                null   // city - we can add geoip lookup later if needed
            ]);
            
            console.log('Click record result:', {
                insertId: clickResult.insertId,
                affectedRows: clickResult.affectedRows,
                timestamp: new Date().toISOString()
            });

            // Update banner stats and check click target
            const [updateBannerResult] = await conn.query(`
                UPDATE banners 
                SET 
                    clicks = clicks + 1,
                    is_active = CASE 
                        WHEN min_clicks > 0 AND clicks + 1 >= min_clicks THEN FALSE 
                        ELSE is_active 
                    END
                WHERE id = ? AND is_active = TRUE
            `, [bannerId]);

            // Process CPC payment if applicable
            if (updateBannerResult.affectedRows > 0 && banner.cost_per_click > 0) {
                console.log('Processing CPC charge:', {
                    merchantId: banner.merchant_id,
                    currentAmountToPay: banner.current_amount_to_pay,
                    costPerClick: banner.cost_per_click
                });

                // Update merchant's amount_to_pay
                await conn.query(`
                    UPDATE users 
                    SET amount_to_pay = COALESCE(amount_to_pay, 0) + ? 
                    WHERE id = ?
                `, [banner.cost_per_click, banner.merchant_id]);

                // Record transaction
                await conn.query(`
                    INSERT INTO transactions (
                        user_id,
                        type,
                        amount,
                        status,
                        details
                    ) VALUES (?, ?, ?, ?, ?)
                `, [
                    banner.merchant_id,
                    'payment',
                    banner.cost_per_click,
                    'completed',
                    `Cost for click on banner #${bannerId}`
                ]);
            }

            await conn.commit();
            return res.json({ 
                success: true, 
                url: banner.target_url 
            });

        } catch (trackingError) {
            console.error('Click tracking failed:', trackingError);
            await conn.rollback();
            // Still return the URL even if tracking fails
            return res.json({ 
                success: true, 
                url: banner.target_url,
                warning: 'Click tracking failed but URL is still valid',
                trackingError: {
                    message: trackingError.message,
                    code: trackingError.code || 'UNKNOWN'
                }
            });
        }

    } catch (error) {
        console.error('Banner click processing failed:', error);
        if (conn) {
            await conn.rollback();
        }
        return res.status(500).json({ 
            error: 'Failed to process banner click',
            message: error.message || 'Internal server error'
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
});

// Track impression endpoint
router.post('/impression', trackRequest, async (req, res) => {
    const { bannerId } = req.body;
    if (!bannerId || isNaN(bannerId)) {
        return res.status(400).json({ error: 'Valid Banner ID is required' });
    }

    const conn = await req.pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get banner details
        const [[banner]] = await conn.query(`
            SELECT b.*, u.id as merchant_id 
            FROM banners b 
            JOIN users u ON b.merchant_id = u.id 
            WHERE b.id = ? AND b.is_active = TRUE
        `, [bannerId]);

        if (!banner) {
            await conn.rollback();
            return res.status(404).json({ error: 'Banner not found or inactive' });
        }

        try {
            // Log impression
            await conn.query(`
                INSERT INTO banner_views (
                    banner_id,
                    ip_address,
                    user_agent,
                    viewed_at
                ) VALUES (?, ?, ?, NOW())
            `, [
                bannerId,
                req.adRequest.ip,
                req.adRequest.userAgent
            ]);

            // Check if we need to charge for impressions (CPM = cost per 1000 impressions)
            const impressionBatchSize = 1000;
            const [{ impressions }] = await conn.query(
                'SELECT COUNT(*) as impressions FROM banner_views WHERE banner_id = ?',
                [bannerId]
            );

            if (banner.cost_per_view > 0 && impressions % impressionBatchSize === 0) {
                const cpmCharge = banner.cost_per_view; // This is already per 1000 impressions
                
                // Update merchant's amount_to_pay
                await conn.query(`
                    UPDATE users 
                    SET amount_to_pay = COALESCE(amount_to_pay, 0) + ? 
                    WHERE id = ?
                `, [cpmCharge, banner.merchant_id]);

                // Record transaction
                await conn.query(`
                    INSERT INTO transactions (
                        user_id,
                        type,
                        amount,
                        status,
                        details
                    ) VALUES (?, ?, ?, ?, ?)
                `, [
                    banner.merchant_id,
                    'payment',
                    cpmCharge,
                    'completed',
                    `CPM charge for banner #${bannerId} (${impressions} impressions)`
                ]);
            }

            await conn.commit();
            return res.json({ success: true });

        } catch (trackingError) {
            console.error('Impression tracking failed:', trackingError);
            await conn.rollback();
            return res.json({ 
                success: true,
                warning: 'Impression tracking failed'
            });
        }

    } catch (error) {
        console.error('Banner impression processing failed:', error);
        if (conn) {
            await conn.rollback();
        }
        return res.status(500).json({ 
            error: 'Failed to process banner impression',
            message: error.message || 'Internal server error'
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
});

module.exports = router;
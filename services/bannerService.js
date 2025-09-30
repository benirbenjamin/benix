const mysql = require('mysql2/promise');
const { logError, logInfo } = require('../utils/logger');

class BannerService {
    constructor(pool) {
        this.pool = pool;
    }

    async initializeBannerSystem() {
        try {
            // Add settings if they don't exist
            await this.addBannerSettings();
            
            // Add impression tracking columns to banners table
            await this.updateBannerTable();
            
            console.log('✅ Banner system initialized successfully');
        } catch (error) {
            console.error('❌ Banner system initialization failed:', error);
            throw error;
        }
    }

    async addBannerSettings() {
        // No more settings needed for simple click targeting
        const settings = [];

        for (const [key, value, description] of settings) {
            await this.pool.query(`
                INSERT INTO system_settings (setting_key, setting_value, setting_type, description)
                SELECT ?, ?, 'number', ?
                WHERE NOT EXISTS (
                    SELECT 1 FROM system_settings WHERE setting_key = ?
                )
            `, [key, value, description, key]);
        }
    }

    async updateBannerTable() {
        // Add required columns for the new ad system
        const columns = [
            // Status and type columns
            ['is_active', 'TINYINT(1) DEFAULT 1'],
            ['format', "ENUM('display', 'vertical', 'mobile', 'all') DEFAULT 'all'"],
            ['priority', 'INT DEFAULT 0'],
            
            // Click target columns
            ['target_clicks', 'INT DEFAULT 0'],
            
            // Cost columns
            ['cost_per_click', 'DECIMAL(10,2) DEFAULT 0.00'],
            ['cost_per_view', 'DECIMAL(10,2) DEFAULT 0.00'],
            
            // Tracking columns
            ['impressions', 'INT DEFAULT 0'],
            ['clicks', 'INT DEFAULT 0'],
            ['total_spent', 'DECIMAL(15,2) DEFAULT 0.00'],
            ['last_impression_batch', 'INT DEFAULT 0'],
            
            // Ensure image column exists
            ['image_url', 'VARCHAR(255)']
        ];

        for (const [column, definition] of columns) {
            try {
                await this.pool.query(`
                    ALTER TABLE banners 
                    ADD COLUMN IF NOT EXISTS ${column} ${definition}
                `);
            } catch (error) {
                console.error(`Failed to add column ${column}:`, error);
                throw error;
            }
        }
    }

    async trackImpression(bannerId, userId) {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();

            // Get banner with merchant details
            const [[banner]] = await conn.query(`
                SELECT b.*, u.id as merchant_id, u.amount_due as current_amount_due
                FROM banners b
                JOIN users u ON b.merchant_id = u.id
                WHERE b.id = ? AND b.is_active = TRUE
            `, [bannerId]);

            if (!banner) throw new Error('Banner not found');

            // Update impression count
            const impressionBatchSize = 1000; // Process CPM per 1000 impressions
            const newImpressionCount = banner.impressions + 1;
            const lastBatch = banner.last_impression_batch || 0;
            
            // Calculate if we need to charge for impressions
            if (newImpressionCount - lastBatch >= impressionBatchSize && banner.cost_per_view > 0) {
                const completeBatches = Math.floor((newImpressionCount - lastBatch) / impressionBatchSize);
                const chargeAmount = (completeBatches * banner.cost_per_view);

                // Update banner stats and merchant's amount due
                await conn.query(`
                    UPDATE banners b
                    JOIN users u ON b.merchant_id = u.id
                    SET 
                        b.impressions = b.impressions + 1,
                        b.total_spent = b.total_spent + ?,
                        b.last_impression_batch = b.last_impression_batch + ?,
                        u.amount_due = u.amount_due + ?
                    WHERE b.id = ? AND b.is_active = TRUE
                `, [chargeAmount, completeBatches * impressionBatchSize, chargeAmount, bannerId]);

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
                    'banner_impression',
                    chargeAmount,
                    'completed',
                    `CPM charge for banner #${bannerId} - ${completeBatches * impressionBatchSize} impressions`
                ]);
            } else {
                // Just update impression count if no charge needed
                await conn.query(`
                    UPDATE banners 
                    SET impressions = impressions + 1
                    WHERE id = ? AND is_active = TRUE
                `, [bannerId]);
            }

            await conn.commit();
            return true;
        } catch (error) {
            await conn.rollback();
            logError('BannerService.trackImpression', error, { bannerId, userId });
            throw error;
        } finally {
            conn.release();
        }
    }

    async verifyDatabaseStructure() {
        try {
            // Verify tables exist
            const tables = ['banners', 'banner_views', 'banner_clicks', 'banner_target_links'];
            for (const table of tables) {
                const [rows] = await this.pool.query(
                    'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
                    [table]
                );
                if (rows.length === 0) {
                    throw new Error(`Table ${table} does not exist`);
                }
            }

            // Verify columns in banners table
            const requiredColumns = ['id', 'title', 'merchant_id', 'image_url', 'target_url', 'status', 'is_active', 
                                   'clicks', 'impressions', 'total_spent', 'cost_per_click', 'cost_per_view'];
            for (const column of requiredColumns) {
                const [rows] = await this.pool.query(
                    'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
                    ['banners', column]
                );
                if (rows.length === 0) {
                    throw new Error(`Column ${column} does not exist in banners table`);
                }
            }

            return true;
        } catch (error) {
            logError('BannerService.verifyDatabaseStructure', error);
            throw error;
        }
    }

    async trackClick(bannerId, userId, ip, userAgent) {
        // Log function entry with all parameters
        logError('BANNER_TRACKING', null, {
            event: 'service_entry',
            bannerId,
            userId,
            ip,
            userAgent,
            timestamp: new Date().toISOString(),
            functionName: 'trackClick'
        });

        const conn = await this.pool.getConnection();
        try {
            logError('BANNER_TRACKING', null, {
                event: 'verify_structure_start',
                bannerId,
                timestamp: new Date().toISOString()
            });
            await this.verifyDatabaseStructure();
            logInfo('BannerService.verifyStructure.Success', { bannerId });

            await conn.beginTransaction();

            // Get banner with merchant details
            logInfo('BannerService.getBanner.Start', { 
                bannerId,
                sql: `SELECT b.*, u.id as merchant_id, u.amount_due as current_amount_due
                      FROM banners b
                      JOIN users u ON b.merchant_id = u.id
                      WHERE b.id = ? AND b.is_active = TRUE`,
                params: [bannerId]
            });
            
            const [[banner]] = await conn.query(`
                SELECT b.*, u.id as merchant_id, u.amount_due as current_amount_due
                FROM banners b
                JOIN users u ON b.merchant_id = u.id
                WHERE b.id = ? AND b.is_active = TRUE
            `, [bannerId]);
            logInfo('BannerService.getBanner.Result', { 
                bannerId,
                found: !!banner,
                merchantId: banner?.merchant_id,
                isActive: banner?.is_active
            });

            if (!banner) {
                logError('BannerService.getBanner.NotFound', new Error('Banner not found'), { bannerId });
                throw new Error('Banner not found');
            }

            // Record the click first with detailed SQL logging
            const insertClickSQL = `
                INSERT INTO banner_clicks (
                    banner_id,
                    user_id,
                    ip_address,
                    user_agent,
                    clicked_at
                ) VALUES (?, ?, ?, ?, NOW())`;
            
            const clickParams = [bannerId, userId || null, ip || null, userAgent || null];
            
            logInfo('BannerService.recordClick.Start', {
                bannerId,
                userId,
                ip,
                userAgent,
                sql: insertClickSQL,
                params: clickParams,
                timestamp: new Date().toISOString()
            });

            try {
                const [clickResult] = await conn.query(insertClickSQL, clickParams);
                logError('BANNER_TRACKING', null, {
                    event: 'click_recorded',
                    bannerId,
                    insertId: clickResult.insertId,
                    affectedRows: clickResult.affectedRows,
                    timestamp: new Date().toISOString()
                });
            } catch (clickError) {
                logError('BannerService.recordClick.QueryError', clickError, {
                    bannerId,
                    sql: insertClickSQL,
                    params: clickParams,
                    sqlState: clickError.sqlState,
                    sqlMessage: clickError.sqlMessage,
                    timestamp: new Date().toISOString()
                });
                throw clickError;
            }

            logInfo('BannerService.recordClick.Success', {
                bannerId,
                timestamp: new Date().toISOString()
            });

            // Calculate charge amount
            const chargeAmount = parseFloat(banner.cost_per_click) || 0;
            logInfo('BannerService.chargeAmount', {
                bannerId,
                chargeAmount,
                originalAmount: banner.cost_per_click
            });

            // Log before updating banner stats
            logInfo('BannerService.updateStats.Start', {
                bannerId,
                userId,
                chargeAmount,
                timestamp: new Date().toISOString()
            });

            // Update banner stats and merchant's amount due
            await conn.query(`
                UPDATE banners b
                JOIN users u ON b.merchant_id = u.id
                SET 
                    b.clicks = b.clicks + 1,
                    b.total_spent = b.total_spent + ?,
                    b.is_active = CASE 
                        WHEN b.target_clicks > 0 AND b.clicks + 1 >= b.target_clicks THEN FALSE 
                        ELSE b.is_active 
                    END,
                    u.amount_due = u.amount_due + ?
                WHERE b.id = ? AND b.is_active = TRUE
            `, [chargeAmount, chargeAmount, bannerId]);

            // Record transaction
            logInfo('BannerService.transaction.Start', {
                bannerId,
                chargeAmount,
                merchantId: banner.merchant_id,
                timestamp: new Date().toISOString()
            });
            if (chargeAmount > 0) {
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
                    'banner_click',
                    chargeAmount,
                    'completed',
                    `CPC charge for banner #${bannerId}`
                ]);
            }

            logError('BANNER_TRACKING', null, {
                event: 'transaction_commit',
                bannerId,
                timestamp: new Date().toISOString()
            });
            await conn.commit();
            logInfo('BannerService.trackClick.Success', {
                bannerId,
                userId,
                ip,
                timestamp: new Date().toISOString()
            });
            return true;
        } catch (error) {
            await conn.rollback();
            logError('BannerService.trackClick.Error', error, {
                bannerId,
                userId,
                ip,
                sqlState: error.sqlState,
                sqlMessage: error.sqlMessage,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        } finally {
            conn.release();
            logInfo('BannerService.trackClick.Complete', {
                bannerId,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = BannerService;
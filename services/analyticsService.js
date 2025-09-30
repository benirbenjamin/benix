const mysql = require('mysql2/promise');
const config = require('../config');

class AnalyticsService {
    constructor() {
        this.pool = mysql.createPool(config.db);
    }

    // Helper function to get date range based on period
    getDateRange(period) {
        const now = new Date();
        const startDate = new Date();
        
        switch (period) {
            case 'today':
                startDate.setHours(0, 0, 0, 0);
                break;
            case 'week':
                startDate.setDate(now.getDate() - 7);
                break;
            case 'month':
                startDate.setMonth(now.getMonth() - 1);
                break;
            case 'year':
                startDate.setFullYear(now.getFullYear() - 1);
                break;
            case 'custom':
                // Custom date range will be handled by directly passing dates
                return { start: null, end: null };
            default:
                startDate.setHours(0, 0, 0, 0);
        }
        
        return {
            start: startDate,
            end: now
        };
    }

    // Get analytics for all users
    async getUsersAnalytics(period, customStart = null, customEnd = null) {
        const dateRange = period === 'custom' ? 
            { start: new Date(customStart), end: new Date(customEnd) } : 
            this.getDateRange(period);

        const [results] = await this.pool.execute(`
            SELECT 
                COUNT(DISTINCT sl.id) as total_links,
                COUNT(DISTINCT c.id) as total_clicks,
                COUNT(DISTINCT p.id) as total_posts,
                COUNT(DISTINCT bpc.id) as total_views,
                COUNT(DISTINCT u.id) as total_users
            FROM users u
            LEFT JOIN shared_links sl ON u.id = sl.user_id 
                AND sl.created_at BETWEEN ? AND ?
            LEFT JOIN links l ON sl.link_id = l.id
            LEFT JOIN clicks c ON sl.id = c.shared_link_id 
                AND c.created_at BETWEEN ? AND ?
            LEFT JOIN blog_posts p ON u.id = p.merchant_id 
                AND p.created_at BETWEEN ? AND ?
            LEFT JOIN blog_post_clicks bpc ON bpc.blog_post_id = p.id
                AND bpc.created_at BETWEEN ? AND ?
            WHERE u.role = 'user'
        `, [
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end
        ]);

        return results[0];
    }

    // Get analytics for all merchants
    async getMerchantsAnalytics(period, customStart = null, customEnd = null) {
        const dateRange = period === 'custom' ? 
            { start: new Date(customStart), end: new Date(customEnd) } : 
            this.getDateRange(period);

        const [results] = await this.pool.execute(`
            SELECT 
                COUNT(DISTINCT l.id) as total_links,
                COUNT(DISTINCT c.id) as total_clicks,
                COUNT(DISTINCT p.id) as total_products,
                COUNT(DISTINCT pc.id) as total_product_views,
                COUNT(DISTINCT m.id) as total_merchants
            FROM users m
            LEFT JOIN links l ON m.id = l.merchant_id 
                AND l.created_at BETWEEN ? AND ?
            LEFT JOIN shared_links sl ON l.id = sl.link_id
            LEFT JOIN clicks c ON sl.id = c.shared_link_id 
                AND c.created_at BETWEEN ? AND ?
            LEFT JOIN products p ON m.id = p.merchant_id 
                AND p.created_at BETWEEN ? AND ?
            LEFT JOIN product_clicks pc ON pc.shared_product_id = p.id
                AND pc.created_at BETWEEN ? AND ?
            WHERE m.role = 'merchant'
        `, [
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end
        ]);

        return results[0];
    }

    // Get overall platform analytics
    async getPlatformAnalytics(period, customStart = null, customEnd = null) {
        const dateRange = period === 'custom' ? 
            { start: new Date(customStart), end: new Date(customEnd) } : 
            this.getDateRange(period);

        const [results] = await this.pool.execute(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE role = 'user' AND created_at BETWEEN ? AND ?) as new_users,
                (SELECT COUNT(*) FROM users WHERE role = 'merchant' AND created_at BETWEEN ? AND ?) as new_merchants,
                (SELECT COUNT(*) FROM links WHERE created_at BETWEEN ? AND ?) as total_links,
                (SELECT COUNT(*) FROM clicks WHERE created_at BETWEEN ? AND ?) as total_clicks,
                (SELECT COUNT(*) FROM blog_posts WHERE created_at BETWEEN ? AND ?) as total_posts,
                (SELECT COUNT(*) FROM products WHERE created_at BETWEEN ? AND ?) as total_products,
                COALESCE((SELECT SUM(CAST(amount AS DECIMAL(10,2))) FROM transactions WHERE status = 'completed' AND created_at BETWEEN ? AND ?), 0) as total_revenue
        `, [
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end,
            dateRange.start, dateRange.end
        ]);

        return results[0];
    }
}

module.exports = new AnalyticsService();
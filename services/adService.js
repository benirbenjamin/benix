const db = require('./databaseInit');
const { v4: uuidv4 } = require('uuid');

class AdService {
    async createAd(adData) {
        try {
            const { title, description, image_url, target_url, status = 'active' } = adData;
            
            const query = `
                INSERT INTO ads (id, title, description, image_url, target_url, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                RETURNING *
            `;
            
            const values = [uuidv4(), title, description, image_url, target_url, status];
            const result = await db.query(query, values);
            
            return result.rows[0];
        } catch (error) {
            console.error('Error creating ad:', error);
            throw error;
        }
    }

    async getActiveAds() {
        try {
            const query = `
                SELECT * FROM ads 
                WHERE status = 'active'
                ORDER BY random()
                LIMIT 10
            `;
            
            const result = await db.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error fetching ads:', error);
            throw error;
        }
    }

    async trackImpression(adId) {
        try {
            const query = `
                UPDATE ads 
                SET impressions = impressions + 1 
                WHERE id = $1
            `;
            
            await db.query(query, [adId]);
        } catch (error) {
            console.error('Error tracking impression:', error);
        }
    }

    async trackClick(adId) {
        try {
            const query = `
                UPDATE ads 
                SET clicks = clicks + 1 
                WHERE id = $1
            `;
            
            await db.query(query, [adId]);
        } catch (error) {
            console.error('Error tracking click:', error);
        }
    }
}

module.exports = new AdService();
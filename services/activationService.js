class ActivationService {
  constructor(pool) {
    this.pool = pool;
    this.settingsCache = null;
  }

  async getActivationSettings() {
    // Return cached settings if available
    if (this.settingsCache) {
      return this.settingsCache;
    }

    const [settings] = await this.pool.query('SELECT * FROM activation_settings LIMIT 1');
    this.settingsCache = settings[0];
    return this.settingsCache;
  }

  async updateActivationSettingsCache() {
    // Force refresh the settings cache
    const [settings] = await this.pool.query('SELECT * FROM activation_settings LIMIT 1');
    this.settingsCache = settings[0];
    return this.settingsCache;
  }

  async updateUserActivationProgress(userId) {
    try {
      // Get current week number
      const currentWeek = this.getCurrentWeek();
      
      // Get user's current stats
      const [userStats] = await this.pool.query(
        'SELECT activation_status, weekly_login_days, total_shared_links, last_withdraw_clicks, last_login_week FROM users WHERE id = ?',
        [userId]
      );
      
      if (!userStats.length) {
        throw new Error('User not found');
      }

      const user = userStats[0];
      
      // Reset weekly login count if it's a new week
      if (user.last_login_week !== currentWeek) {
        await this.pool.query(
          'UPDATE users SET weekly_login_days = 1, last_login_week = ? WHERE id = ?',
          [currentWeek, userId]
        );
      } else {
        // Increment login days if not already counted for today
        await this.pool.query(
          'UPDATE users SET weekly_login_days = LEAST(weekly_login_days + 1, 7) WHERE id = ?',
          [userId]
        );
      }

      // Check if user meets activation criteria
      await this.checkActivationEligibility(userId);
    } catch (error) {
      console.error('Error updating activation progress:', error);
      throw error;
    }
  }

  async checkActivationEligibility(userId) {
    try {
      // Get activation settings
      const settings = await this.getActivationSettings();
      if (!settings.is_activation_required) {
        return true;
      }

      // Get user's current stats
      const [userStats] = await this.pool.query(
        `SELECT 
          activation_status, 
          weekly_login_days, 
          total_shared_links,
          last_withdraw_clicks
        FROM users 
        WHERE id = ?`,
        [userId]
      );

      if (!userStats.length) {
        throw new Error('User not found');
      }

      const user = userStats[0];

      // Check if all criteria are met
      const isEligible = 
        user.total_shared_links >= settings.min_shared_links &&
        user.weekly_login_days >= settings.min_login_days &&
        user.last_withdraw_clicks >= settings.min_clicks_before_withdraw;

      if (isEligible && user.activation_status === 'pending') {
        // Update user to active status
        await this.pool.query(
          'UPDATE users SET activation_status = "active" WHERE id = ?',
          [userId]
        );
      }

      return isEligible;
    } catch (error) {
      console.error('Error checking activation eligibility:', error);
      throw error;
    }
  }

  async getActivationProgress(userId) {
    try {
      // Get settings and user stats
      const [settings] = await this.pool.query('SELECT * FROM activation_settings LIMIT 1');
      
      // Get last withdrawal date
      const [lastWithdrawal] = await this.pool.query(`
        SELECT created_at 
        FROM transactions 
        WHERE user_id = ? AND type = 'withdrawal' AND status = 'completed'
        ORDER BY created_at DESC 
        LIMIT 1
      `, [userId]);

      const lastWithdrawDate = lastWithdrawal.length > 0 ? lastWithdrawal[0].created_at : new Date(0);

      // Get all shared content since last withdrawal (links and blogs)
      const [sharedContent] = await this.pool.query(`
        SELECT 
          COUNT(DISTINCT sl.id) as shared_links,
          COUNT(DISTINCT bp.id) as shared_blogs
        FROM users u
        LEFT JOIN shared_links sl ON u.id = sl.user_id AND sl.created_at > ?
        LEFT JOIN blog_post_shares bp ON u.id = bp.user_id AND bp.created_at > ?
        WHERE u.id = ?
      `, [lastWithdrawDate, lastWithdrawDate, userId]);

      // Get all clicks since last withdrawal (link clicks and blog clicks)
      const [clicks] = await this.pool.query(`
        SELECT 
          COUNT(DISTINCT c.id) as link_clicks,
          COUNT(DISTINCT bpc.id) as blog_clicks
        FROM users u
        LEFT JOIN shared_links sl ON u.id = sl.user_id
        LEFT JOIN clicks c ON sl.id = c.shared_link_id AND c.created_at > ?
        LEFT JOIN blog_post_shares bps ON u.id = bps.user_id
        LEFT JOIN blog_post_clicks bpc ON bps.id = bpc.blog_post_share_id AND bpc.created_at > ?
        WHERE u.id = ?
      `, [lastWithdrawDate, lastWithdrawDate, userId]);

      const [userStats] = await this.pool.query(
        'SELECT activation_status, weekly_login_days FROM users WHERE id = ?',
        [userId]
      );

      if (!settings.length || !userStats.length) {
        throw new Error('Settings or user not found');
      }

      const setting = settings[0];
      const user = userStats[0];
      
      // Calculate totals
      const totalSharedContent = (sharedContent[0].shared_links || 0) + 
                               (sharedContent[0].shared_blogs || 0);
                               
      const totalClicks = (clicks[0].link_clicks || 0) + 
                         (clicks[0].blog_clicks || 0);

      // Update user's stats in the database with the real counts
      await this.pool.query(`
        UPDATE users 
        SET total_shared_links = ?,
            last_withdraw_clicks = ?
        WHERE id = ?
      `, [totalSharedContent, totalClicks, userId]);

      return {
        isActivationRequired: setting.is_activation_required,
        status: user.activation_status,
        progress: {
          links: {
            current: totalSharedContent,
            required: setting.min_shared_links,
            remaining: Math.max(0, setting.min_shared_links - totalSharedContent),
            // Individual counts
            links: sharedContent[0].shared_links || 0,
            blogs: sharedContent[0].shared_blogs || 0
          },
          logins: {
            current: user.weekly_login_days,
            required: setting.min_login_days,
            remaining: Math.max(0, setting.min_login_days - user.weekly_login_days)
          },
          clicks: {
            current: totalClicks,
            required: setting.min_clicks_before_withdraw,
            remaining: Math.max(0, setting.min_clicks_before_withdraw - totalClicks),
            // Individual counts
            linkClicks: clicks[0].link_clicks || 0,
            blogClicks: clicks[0].blog_clicks || 0
          }
        }
      };
    } catch (error) {
      console.error('Error getting activation progress:', error);
      throw error;
    }
  }

  async updateClickCount(userId, clickCount) {
    try {
      await this.pool.query(
        'UPDATE users SET last_withdraw_clicks = last_withdraw_clicks + ? WHERE id = ?',
        [clickCount, userId]
      );
    } catch (error) {
      console.error('Error updating click count:', error);
      throw error;
    }
  }

  async incrementSharedLinks(userId) {
    try {
      await this.pool.query(
        'UPDATE users SET total_shared_links = total_shared_links + 1 WHERE id = ?',
        [userId]
      );
      await this.checkActivationEligibility(userId);
    } catch (error) {
      console.error('Error incrementing shared links:', error);
      throw error;
    }
  }

  getCurrentWeek() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    return Math.ceil((((now - start) / 86400000) + start.getDay() + 1) / 7);
  }

  async activateUser(userId) {
    try {
      const isEligible = await this.checkActivationEligibility(userId);
      if (!isEligible) {
        return false;
      }

      await this.pool.query(
        'UPDATE users SET activation_status = "active" WHERE id = ?',
        [userId]
      );

      return true;
    } catch (error) {
      console.error('Error activating user:', error);
      throw error;
    }
  }
}

module.exports = ActivationService;
// Commission Service for Unilevel System
class CommissionService {
  constructor(pool, currencyService, notificationService = null) {
    this.pool = pool;
    this.currencyService = currencyService;
    this.notificationService = notificationService;
  }

  // Set notification service (for cases where it's initialized later)
  setNotificationService(notificationService) {
    this.notificationService = notificationService;
  }

  // Get commission settings from system_settings table
  async getCommissionSettings() {
    try {
      const [rows] = await this.pool.query(`
        SELECT setting_key, setting_value, setting_type FROM system_settings 
        WHERE setting_key IN (
          'activation_fee_rwf', 'level1_commission_rwf', 'level2_commission_rwf',
          'max_commission_levels', 'supported_currencies'
        )
      `);

      const settings = {};
      rows.forEach(row => {
        let value = row.setting_value;
        if (row.setting_type === 'number') {
          value = parseFloat(value);
        } else if (row.setting_type === 'json') {
          try {
            value = JSON.parse(value);
          } catch (e) {
            value = row.setting_value;
          }
        } else if (row.setting_type === 'boolean') {
          value = value === 'true';
        }
        settings[row.setting_key] = value;
      });

      return {
        activationFeeRwf: settings.activation_fee_rwf || 3000,
        level1CommissionRwf: settings.level1_commission_rwf || 1500,
        level2CommissionRwf: settings.level2_commission_rwf || 500,
        maxLevels: settings.max_commission_levels || 2,
        supportedCurrencies: settings.supported_currencies || ['RWF', 'USD', 'UGX', 'KES'],
        enabled: true
      };
    } catch (error) {
      console.error('Error getting commission settings:', error);
      // Return default settings
      return {
        activationFeeRwf: 3000,
        level1CommissionRwf: 1500,
        level2CommissionRwf: 500,
        maxLevels: 2,
        supportedCurrencies: ['RWF', 'USD', 'UGX', 'KES'],
        enabled: true
      };
    }
  }

  // Update commission settings
  async updateCommissionSettings(settings) {
    try {
      const updates = [
        ['activation_fee_rwf', settings.activationFeeRwf],
        ['level1_commission_rwf', settings.level1CommissionRwf],
        ['level2_commission_rwf', settings.level2CommissionRwf],
        ['max_commission_levels', settings.maxLevels],
        ['commission_system_enabled', settings.enabled ? 'true' : 'false']
      ];

      // Convert RWF amounts to USD
      const activationFeeUsd = await this.currencyService.convertRwfToUsd(settings.activationFeeRwf);
      const level1CommissionUsd = await this.currencyService.convertRwfToUsd(settings.level1CommissionRwf);
      const level2CommissionUsd = await this.currencyService.convertRwfToUsd(settings.level2CommissionRwf);

      updates.push(
        ['activation_fee_usd', activationFeeUsd],
        ['level1_commission_usd', level1CommissionUsd],
        ['level2_commission_usd', level2CommissionUsd]
      );

      // Update all settings
      for (const [key, value] of updates) {
        await this.pool.query(`
          INSERT INTO config (key_name, value) VALUES (?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, [key, value.toString()]);
      }

      return true;
    } catch (error) {
      console.error('Error updating commission settings:', error);
      throw error;
    }
  }

  // Process commission when a user is activated
  async processActivationCommissions(userId) {
    try {
      console.log(`🔄 Processing activation commissions for user ${userId}`);
      
      const settings = await this.getCommissionSettings();
      
      if (!settings.enabled) {
        console.log('❌ Commission system is disabled');
        return;
      }

      // Get user's referrer chain
      const referrerChain = await this.getReferrerChain(userId, settings.maxLevels);
      
      if (referrerChain.length === 0) {
        console.log(`ℹ️  No referrers found for user ${userId}`);
        return;
      }

      console.log(`✅ Found ${referrerChain.length} referrers for user ${userId}`);
      const commissions = [];

      // Process commissions for each level
      for (let i = 0; i < referrerChain.length && i < settings.maxLevels; i++) {
        const referrer = referrerChain[i];
        const level = i + 1;
        
        let commissionRwf, commissionUsd;
        
        if (level === 1) {
          commissionRwf = settings.level1CommissionRwf;
          console.log(`Setting Level 1 commission: ${commissionRwf} RWF`);
        } else if (level === 2) {
          commissionRwf = settings.level2CommissionRwf;
          console.log(`Setting Level 2 commission: ${commissionRwf} RWF`);
        } else {
          // Additional levels can be added here
          console.log(`⚠️  Level ${level} not configured, skipping`);
          continue;
        }

        if (!commissionRwf || commissionRwf <= 0) {
          console.log(`❌ Invalid commission amount for level ${level}: ${commissionRwf}`);
          continue;
        }

        // Convert RWF to USD
        commissionUsd = await this.currencyService.convertCurrency(commissionRwf, 'RWF', 'USD');

        console.log(`💰 Processing Level ${level} commission: ${commissionRwf} RWF (${commissionUsd} USD) for referrer ${referrer.id} (${referrer.username})`);

        // Verify referrer exists and get current wallet before update
        const [beforeUpdate] = await this.pool.query(`
          SELECT id, username, wallet, earnings FROM users WHERE id = ?
        `, [referrer.id]);

        if (beforeUpdate.length === 0) {
          console.log(`❌ Referrer ${referrer.id} not found in database, skipping commission`);
          continue;
        }

        const beforeWallet = parseFloat(beforeUpdate[0].wallet || 0);
        const beforeEarnings = parseFloat(beforeUpdate[0].earnings || 0);
        
        console.log(`Before update - Wallet: ${beforeWallet}, Earnings: ${beforeEarnings}`);

        // Create commission record
        const [result] = await this.pool.query(`
          INSERT INTO commissions (
            user_id, referrer_id, referred_user_id, level, 
            amount_rwf, amount_usd, commission_type, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'activation', 'paid')
        `, [referrer.id, referrer.id, userId, level, commissionRwf, commissionUsd]);

        console.log(`✅ Commission record created with ID: ${result.insertId}`);

        commissions.push({
          id: result.insertId,
          referrerId: referrer.id,
          level,
          amountRwf: commissionRwf,
          amountUsd: commissionUsd
        });

        // Add commission to referrer's wallet and earnings
        const [updateResult] = await this.pool.query(`
          UPDATE users 
          SET wallet = COALESCE(wallet, 0) + ?, 
              earnings = COALESCE(earnings, 0) + ? 
          WHERE id = ?
        `, [commissionUsd, commissionUsd, referrer.id]);

        console.log(`✅ Wallet update affected ${updateResult.affectedRows} rows`);

        // Verify the update worked
        const [afterUpdate] = await this.pool.query(`
          SELECT wallet, earnings FROM users WHERE id = ?
        `, [referrer.id]);

        if (afterUpdate.length > 0) {
          const afterWallet = parseFloat(afterUpdate[0].wallet || 0);
          const afterEarnings = parseFloat(afterUpdate[0].earnings || 0);
          console.log(`After update - Wallet: ${afterWallet} (+${afterWallet - beforeWallet}), Earnings: ${afterEarnings} (+${afterEarnings - beforeEarnings})`);
        }

        // Send commission notification (if notification service is available)
        try {
          // Get the referred user's username for better messaging
          const [referredUser] = await this.pool.query(`
            SELECT username FROM users WHERE id = ?
          `, [userId]);
          
          const referredUsername = referredUser.length > 0 ? referredUser[0].username : `User #${userId}`;
          
          // Try to access notification service from global app locals
          // This is a temporary approach - ideally we'd inject the service
          if (this.notificationService) {
            await this.notificationService.notifyCommissionEarned(referrer.id, {
              amount: `${commissionRwf} RWF ($${commissionUsd})`,
              source: `Level ${level} referral activation commission from ${referredUsername}`,
              currency: 'RWF',
              level: level,
              referredUser: referredUsername
            });
            console.log(`✅ Commission notification sent to user ${referrer.id}`);
          } else {
            console.log(`⚠️ Notification service not available for commission notification`);
          }
        } catch (notificationError) {
          console.error(`❌ Failed to send commission notification to user ${referrer.id}:`, notificationError);
          // Continue processing even if notification fails
        }

        // Create transaction record
        try {
          const [transactionResult] = await this.pool.query(`
            INSERT INTO transactions (
              user_id, type, amount, status, details, created_at
            ) VALUES (?, 'commission', ?, 'completed', ?, NOW())
          `, [
            referrer.id,
            commissionUsd,
            `Level ${level} activation commission for user ID ${userId}`
          ]);
          
          console.log(`✅ Transaction record created with ID: ${transactionResult.insertId}`);
        } catch (transactionError) {
          console.error(`❌ Error creating transaction record for user ${referrer.id}:`, transactionError);
          // Continue processing even if transaction record fails
        }

        console.log(`✅ Paid commission: Level ${level}, User ${referrer.id} (${referrer.username}), Amount: ${commissionUsd} USD`);
      }

      // Update user referral records to activated
      await this.pool.query(`
        UPDATE user_referrals 
        SET status = 'activated', commission_paid = TRUE, activated_at = NOW()
        WHERE referred_id = ?
      `, [userId]);

      console.log(`🎉 Commission processing completed for user ${userId}. Processed ${commissions.length} commissions.`);
      return commissions;
    } catch (error) {
      console.error('Error processing activation commissions:', error);
      throw error;
    }
  }

  // Get referrer chain (upline) for a user
  async getReferrerChain(userId, maxLevels = 10) {
    try {
      const chain = [];
      let currentUserId = userId;

      for (let level = 0; level < maxLevels; level++) {
        // Get the current user's referrer_id first
        const [currentUser] = await this.pool.query(`
          SELECT referrer_id FROM users WHERE id = ? AND referrer_id IS NOT NULL
        `, [currentUserId]);

        if (currentUser.length === 0 || !currentUser[0].referrer_id) {
          console.log(`No referrer found for user ${currentUserId} at level ${level + 1}`);
          break; // No more referrers
        }

        const referrerId = currentUser[0].referrer_id;
        console.log(`User ${currentUserId} has referrer: ${referrerId}`);

        // Now get the referrer's details
        const [referrer] = await this.pool.query(`
          SELECT id, username, email, referrer_id 
          FROM users 
          WHERE id = ?
        `, [referrerId]);

        if (referrer.length === 0) {
          console.log(`Referrer ${referrerId} not found in database`);
          break;
        }

        const referrerInfo = referrer[0];
        chain.push(referrerInfo);
        
        console.log(`Level ${level + 1} referrer for user ${currentUserId}: ${referrerInfo.id} (${referrerInfo.username})`);
        
        // Move up the chain to the next referrer
        currentUserId = referrerInfo.id;

        // Prevent infinite loops
        if (referrerInfo.referrer_id === referrerInfo.id) {
          console.warn(`Infinite loop detected for user ${referrerInfo.id}`);
          break;
        }
      }

      console.log(`Found referrer chain for user ${userId}:`, chain.map(r => ({ id: r.id, username: r.username, level: chain.indexOf(r) + 1 })));
      return chain;
    } catch (error) {
      console.error('Error getting referrer chain:', error);
      return [];
    }
  }

  // Test method to debug referrer chain
  async debugReferrerChain(userId) {
    try {
      console.log(`🔍 Debugging referrer chain for user ${userId}`);
      
      // Get the direct referrer first
      const [directReferrer] = await this.pool.query(`
        SELECT referrer_id FROM users WHERE id = ?
      `, [userId]);
      
      if (directReferrer.length === 0 || !directReferrer[0].referrer_id) {
        console.log(`❌ User ${userId} has no direct referrer`);
        return { chain: [], debug: [] };
      }
      
      console.log(`✅ User ${userId} has direct referrer: ${directReferrer[0].referrer_id}`);
      
      // Now get the full chain manually
      const debug = [];
      let currentUserId = userId;
      
      for (let level = 0; level < 5; level++) {
        const [user] = await this.pool.query(`
          SELECT id, username, email, referrer_id FROM users WHERE id = ?
        `, [currentUserId]);
        
        if (user.length === 0) {
          debug.push(`Level ${level}: User ${currentUserId} not found`);
          break;
        }
        
        const userInfo = user[0];
        debug.push(`Level ${level}: User ${userInfo.id} (${userInfo.username}) -> referrer: ${userInfo.referrer_id}`);
        
        if (!userInfo.referrer_id) {
          debug.push(`Level ${level}: No referrer found, stopping chain`);
          break;
        }
        
        // Get referrer details
        const [referrer] = await this.pool.query(`
          SELECT id, username, email, referrer_id FROM users WHERE id = ?
        `, [userInfo.referrer_id]);
        
        if (referrer.length === 0) {
          debug.push(`Level ${level}: Referrer ${userInfo.referrer_id} not found in database`);
          break;
        }
        
        debug.push(`Level ${level}: Found referrer ${referrer[0].id} (${referrer[0].username})`);
        currentUserId = referrer[0].id;
      }
      
      // Now get the chain using the existing method
      const chain = await this.getReferrerChain(userId, 5);
      
      return { chain, debug };
    } catch (error) {
      console.error('Error debugging referrer chain:', error);
      return { chain: [], debug: [`Error: ${error.message}`] };
    }
  }

  // Get user's direct referrals
  async getUserReferrals(userId) {
    try {
      const [rows] = await this.pool.query(`
        SELECT id, username, email, is_activated, created_at 
        FROM users 
        WHERE referrer_id = ? 
        ORDER BY created_at DESC
      `, [userId]);

      return rows;
    } catch (error) {
      console.error('Error getting user referrals:', error);
      return [];
    }
  }

  // Get user's commission history
  async getUserCommissions(userId, page = 1, limit = 20) {
    try {
      const offset = (page - 1) * limit;
      
      const [rows] = await this.pool.query(`
        SELECT 
          c.*,
          ru.username as referred_username,
          ru.email as referred_email
        FROM commissions c
        JOIN users ru ON c.referred_user_id = ru.id
        WHERE c.user_id = ?
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
      `, [userId, limit, offset]);

      const [countRows] = await this.pool.query(`
        SELECT COUNT(*) as total FROM commissions WHERE user_id = ?
      `, [userId]);

      return {
        commissions: rows,
        total: countRows[0].total,
        page,
        totalPages: Math.ceil(countRows[0].total / limit)
      };
    } catch (error) {
      console.error('Error getting user commissions:', error);
      return { commissions: [], total: 0, page: 1, totalPages: 0 };
    }
  }

  // Get commission statistics for admin
  async getCommissionStats() {
    try {
      const [totalStats] = await this.pool.query(`
        SELECT 
          COUNT(*) as total_commissions,
          SUM(amount_usd) as total_amount_usd,
          SUM(amount_rwf) as total_amount_rwf
        FROM commissions
      `);

      const [statusStats] = await this.pool.query(`
        SELECT 
          status,
          COUNT(*) as count,
          SUM(amount_usd) as amount_usd,
          SUM(amount_rwf) as amount_rwf
        FROM commissions
        GROUP BY status
      `);

      const [levelStats] = await this.pool.query(`
        SELECT 
          level,
          COUNT(*) as count,
          SUM(amount_usd) as amount_usd,
          SUM(amount_rwf) as amount_rwf
        FROM commissions
        GROUP BY level
        ORDER BY level
      `);

      return {
        total: totalStats[0],
        byStatus: statusStats,
        byLevel: levelStats
      };
    } catch (error) {
      console.error('Error getting commission stats:', error);
      return {
        total: { total_commissions: 0, total_amount_usd: 0, total_amount_rwf: 0 },
        byStatus: [],
        byLevel: []
      };
    }
  }

  // Check if user needs to pay activation fee
  async userNeedsActivation(userId) {
    try {
      const [rows] = await this.pool.query(`
        SELECT is_activated, activation_paid_at FROM users WHERE id = ?
      `, [userId]);

      if (rows.length === 0) {
        return true; // User doesn't exist, needs activation
      }

      return !rows[0].is_activated;
    } catch (error) {
      console.error('Error checking user activation status:', error);
      return true; // Assume needs activation on error
    }
  }

  // Mark user as activated
  async activateUser(userId) {
    try {
      await this.pool.query(`
        UPDATE users 
        SET is_activated = TRUE, activation_paid_at = NOW()
        WHERE id = ?
      `, [userId]);

      // Process commissions for referrers
      await this.processActivationCommissions(userId);

      return true;
    } catch (error) {
      console.error('Error activating user:', error);
      throw error;
    }
  }
}

module.exports = CommissionService;

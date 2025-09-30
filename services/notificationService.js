// NotificationService.js - Comprehensive Notification System for BenixSpace
const EmailService = require('./emailService');

class NotificationService {
  constructor(pool, emailService) {
    this.pool = pool;
    this.emailService = emailService;
    this.initializeService();
    
    // Add debug logging
    console.log('NotificationService initialized with email service:', !!this.emailService);
  }

  async initializeService() {
    // Table creation is handled in app.js; nothing to create here.
    console.log('✅ Notification service initialized');
  }

  // Create a notification record (table creation is in app.js)
  async createNotification(options = {}) {
    try {
      const {
        userId = null,
        type = 'info',
        category = 'info',
        title,
        message,
        actionUrl = null,
        priority = 1,
        expiresAt = null,
        sendEmail = false
      } = options;

      console.log('Creating notification:', {
        userId,
        type,
        category,
        title,
        message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        sendEmail
      });

      const [result] = await this.pool.query(`
        INSERT INTO notifications (user_id, type, category, title, message, action_url, priority, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId, type, category, title, message, actionUrl, priority, expiresAt]);

      const notificationId = result.insertId;

      // Send email if requested and user has email notifications enabled
      if (sendEmail && userId) {
        console.log('Attempting to send notification email to user:', userId);
        try {
          // Verify email service is available
          if (!this.emailService?.transporter) {
            console.error('Email service not properly initialized');
            return;
          }

          await this.sendNotificationEmail(userId, {
            title,
            message,
            type,
            category,
            actionUrl
          });

          await this.pool.query(`
            UPDATE notifications SET email_sent = TRUE WHERE id = ?
          `, [notificationId]);
        } catch (emailError) {
          console.error('Failed to send notification email:', emailError.message);
          // Continue without failing the notification creation
        }
      }

      return { success: true, notificationId };
    } catch (error) {
      console.error('Failed to create notification:', error);
      return { success: false, error: error.message };
    }
  }

  // Send email notification
  async sendNotificationEmail(userId, notificationData) {
    try {
      // Get user data and preferences
      const [users] = await this.pool.query(`
        SELECT u.username, u.email, 
               COALESCE(np.email_notifications, TRUE) as email_enabled,
               COALESCE(np.commission_alerts, TRUE) as commission_alerts,
               COALESCE(np.payment_alerts, TRUE) as payment_alerts,
               COALESCE(np.system_alerts, TRUE) as system_alerts
        FROM users u
        LEFT JOIN notification_preferences np ON u.id = np.user_id
        WHERE u.id = ?
      `, [userId]);

      if (!users.length || !users[0].email_enabled) {
        return { success: false, reason: 'Email notifications disabled' };
      }

      const user = users[0];
      
      // Check category-specific preferences
      const categoryPrefs = {
        commission: user.commission_alerts,
        payment: user.payment_alerts,
        system: user.system_alerts
      };

      if (notificationData.category in categoryPrefs && !categoryPrefs[notificationData.category]) {
        return { success: false, reason: 'Category notifications disabled' };
      }

      // Choose email template based on category
      let template = 'notification_general';
      if (notificationData.category === 'commission') {
        template = 'commission_earned';
      } else if (notificationData.category === 'payment') {
        template = 'activation_payment';
      }

      await this.emailService.sendTemplatedEmail(template, user.email, {
        username: user.username,
        subject: notificationData.title,
        message: notificationData.message,
        action_url: notificationData.actionUrl,
        dashboard_url: process.env.BASE_URL + '/dashboard'
      });

      return { success: true };
    } catch (error) {
      console.error('Failed to send notification email:', error);
      return { success: false, error: error.message };
    }
  }

  // Commission notifications
  async notifyCommissionEarned(userId, commissionData) {
    const { amount, source, currency = 'RWF', level, referredUser } = commissionData;
    
    return await this.createNotification({
      userId,
      type: 'success',
      category: 'commission',
      title: '💰 New Commission Earned!',
      message: `You earned ${amount} from ${source}`,
      actionUrl: '/wallet',
      sendEmail: true,
      priority: 2
    });
  }

  // User registration notifications
  async notifyUserRegistered(userId, userData) {
    const { username, email, hasReferrer = false } = userData;
    
    const notifications = [];
    
    // Notify the new user
    notifications.push(await this.createNotification({
      userId,
      type: 'success',
      category: 'user_action',
      title: '🎉 Welcome to BenixSpace!',
      message: `Welcome ${username}! Please activate your account to start earning.`,
      actionUrl: '/user/activate',
      sendEmail: true,
      priority: 2
    }));

    // If user has a referrer, notify them too
    if (hasReferrer) {
      const [referrers] = await this.pool.query(`
        SELECT u1.referrer_id, u2.username as referrer_username 
        FROM users u1 
        JOIN users u2 ON u1.referrer_id = u2.id 
        WHERE u1.id = ?
      `, [userId]);

      if (referrers.length > 0) {
        const referrerId = referrers[0].referrer_id;
        notifications.push(await this.createNotification({
          userId: referrerId,
          type: 'info',
          category: 'user_action',
          title: '👥 New Referral Registered!',
          message: `${username} has registered using your referral link. Encourage them to activate their account to earn commissions!`,
          actionUrl: '/referrals',
          sendEmail: true,
          priority: 2
        }));
      }
    }

    // Notify admins about new registration
    await this.notifyAdminAlert({
      type: 'New User Registration',
      message: `New user registered: ${username} (${email})`,
      details: hasReferrer ? 'User has a referrer' : 'Direct registration',
      priority: 1
    });

    return notifications;
  }

  // User activation notifications
  async notifyUserActivated(userId, activationData) {
    const { username, paymentMethod, amount, referrerId = null } = activationData;
    
    const notifications = [];
    
    // Notify the activated user
    notifications.push(await this.createNotification({
      userId,
      type: 'success',
      category: 'payment',
      title: '✅ Account Activated Successfully!',
      message: 'Congratulations! Your account is now activated. You can now access all platform features and start earning!',
      actionUrl: '/dashboard',
      sendEmail: true,
      priority: 3
    }));

    // If user has a referrer, notify them about the activation
    if (referrerId) {
      notifications.push(await this.createNotification({
        userId: referrerId,
        type: 'success',
        category: 'commission',
        title: '🎯 Referral Activated!',
        message: `${username} has activated their account! You will receive your referral commission shortly.`,
        actionUrl: '/referrals',
        sendEmail: true,
        priority: 2
      }));
    }

    // Notify admins about activation
    await this.notifyAdminAlert({
      type: 'User Activation',
      message: `User activated: ${username}`,
      details: `Payment method: ${paymentMethod}, Amount: ${amount}`,
      priority: 1
    });

    return notifications;
  }

  // Order placement notifications
  async notifyOrderPlaced(userId, orderData) {
    const { orderId, totalAmount, items } = orderData;
    
    const notifications = [];
    
    // Notify the customer
    notifications.push(await this.createNotification({
      userId,
      type: 'success',
      category: 'user_action',
      title: '🛒 Order Placed Successfully!',
      message: `Your order #${orderId} for ${totalAmount} has been placed successfully. We'll notify you when it's processed.`,
      actionUrl: `/orders/${orderId}`,
      sendEmail: true,
      priority: 2
    }));

    // Get merchants involved in this order
    try {
      const [merchantIds] = await this.pool.query(`
        SELECT DISTINCT p.merchant_id, u.username as merchant_name
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        JOIN users u ON p.merchant_id = u.id
        WHERE oi.order_id = ?
      `, [orderId]);

      // Notify each merchant about the order
      for (const merchant of merchantIds) {
        notifications.push(await this.createNotification({
          userId: merchant.merchant_id,
          type: 'info',
          category: 'user_action',
          title: '🆕 New Order Received!',
          message: `You have received a new order #${orderId} for ${totalAmount}. Please process it promptly.`,
          actionUrl: `/orders/${orderId}`,
          sendEmail: true,
          priority: 3
        }));
      }
    } catch (merchantError) {
      console.error('Error notifying merchants about order:', merchantError);
    }

    // Notify admins about new order
    await this.notifyAdminAlert({
      type: 'New Order',
      message: `New order placed: #${orderId}`,
      details: `Amount: ${totalAmount}, Items: ${items}, Customer ID: ${userId}`,
      priority: 1
    });

    return notifications;
  }

  // Payment status notifications
  async notifyPaymentStatus(userId, paymentData) {
    const { status, amount, method, orderId = null, paymentType = 'general' } = paymentData;
    
    let title, message, type;
    
    switch (status) {
      case 'success':
      case 'completed':
        title = '✅ Payment Successful!';
        message = `Your payment of ${amount} via ${method} has been processed successfully.`;
        type = 'success';
        break;
      case 'pending':
        title = '⏳ Payment Pending';
        message = `Your payment of ${amount} via ${method} is being processed. We'll notify you once confirmed.`;
        type = 'info';
        break;
      case 'failed':
      case 'cancelled':
        title = '❌ Payment Failed';
        message = `Your payment of ${amount} via ${method} could not be processed. Please try again or contact support.`;
        type = 'error';
        break;
      default:
        title = '🔔 Payment Update';
        message = `Payment status update for ${amount} via ${method}: ${status}`;
        type = 'info';
    }

    const actionUrl = orderId ? `/orders/${orderId}` : '/wallet';

    return await this.createNotification({
      userId,
      type,
      category: 'payment',
      title,
      message,
      actionUrl,
      sendEmail: true,
      priority: status === 'failed' ? 3 : 2
    });
  }

  // Withdrawal notifications
  async notifyWithdrawal(userId, withdrawalData) {
    const { status, amount, method, requestId } = withdrawalData;
    
    let title, message, type;
    
    switch (status) {
      case 'approved':
        title = '✅ Withdrawal Approved!';
        message = `Your withdrawal request of ${amount} has been approved and will be processed via ${method}.`;
        type = 'success';
        break;
      case 'rejected':
        title = '❌ Withdrawal Rejected';
        message = `Your withdrawal request of ${amount} has been rejected. Please check requirements and try again.`;
        type = 'error';
        break;
      case 'processed':
        title = '💰 Withdrawal Processed!';
        message = `Your withdrawal of ${amount} has been successfully processed via ${method}.`;
        type = 'success';
        break;
      case 'pending':
        title = '⏳ Withdrawal Submitted';
        message = `Your withdrawal request of ${amount} has been submitted and is under review.`;
        type = 'info';
        break;
      default:
        title = '🔔 Withdrawal Update';
        message = `Withdrawal status update for ${amount}: ${status}`;
        type = 'info';
    }

    return await this.createNotification({
      userId,
      type,
      category: 'payment',
      title,
      message,
      actionUrl: '/wallet',
      sendEmail: true,
      priority: 2
    });
  }

  // Security notifications
  async notifySecurityEvent(userId, securityData) {
    const { eventType, details, ipAddress, userAgent } = securityData;
    
    let title, message;
    
    switch (eventType) {
      case 'login':
        title = '🔐 New Login Detected';
        message = `New login to your account from ${ipAddress}. If this wasn't you, please secure your account immediately.`;
        break;
      case 'password_change':
        title = '🔑 Password Changed';
        message = 'Your account password has been successfully changed. If you didn\'t make this change, contact support immediately.';
        break;
      case 'email_change':
        title = '📧 Email Address Changed';
        message = 'Your account email address has been updated. If you didn\'t make this change, contact support immediately.';
        break;
      case 'suspicious_activity':
        title = '⚠️ Suspicious Activity Detected';
        message = `Unusual activity detected on your account. Please review your account security.`;
        break;
      default:
        title = '🔔 Security Alert';
        message = `Security event: ${eventType}`;
    }

    return await this.createNotification({
      userId,
      type: eventType === 'suspicious_activity' ? 'warning' : 'info',
      category: 'system',
      title,
      message,
      actionUrl: '/profile',
      sendEmail: true,
      priority: 3
    });
  }

  // Product/Link notifications
  async notifyLinkActivity(userId, linkData) {
    const { action, linkTitle, earnings = null, clicks = null } = linkData;
    
    let title, message;
    
    switch (action) {
      case 'new_click':
        title = '👆 New Click on Your Link!';
        message = `Someone clicked on your link "${linkTitle}". ${earnings ? `You earned ${earnings}!` : ''}`;
        break;
      case 'milestone_reached':
        title = '🎯 Milestone Reached!';
        message = `Your link "${linkTitle}" has reached ${clicks} clicks! Keep sharing to earn more.`;
        break;
      case 'target_reached':
        title = '🎯 Target Reached - Link Deactivated';
        message = `Your link "${linkTitle}" has reached its target of ${clicks} clicks! The link has been automatically deactivated. Update the target to reactivate.`;
        break;
      case 'link_approved':
        title = '✅ Link Approved';
        message = `Your link "${linkTitle}" has been approved and is now active.`;
        break;
      case 'link_rejected':
        title = '❌ Link Rejected';
        message = `Your link "${linkTitle}" has been rejected. Please review our guidelines and resubmit.`;
        break;
      default:
        title = '🔗 Link Update';
        message = `Update for your link "${linkTitle}": ${action}`;
    }

    return await this.createNotification({
      userId,
      type: action.includes('rejected') ? 'warning' : 'success',
      category: 'user_action',
      title,
      message,
      actionUrl: '/shared-links',
      sendEmail: action === 'milestone_reached' || action.includes('approved') || action.includes('rejected'),
      priority: 1
    });
  }

  // Referral system notifications
  async notifyReferralActivity(userId, referralData) {
    const { action, referredUsername, level, commissionAmount } = referralData;
    
    let title, message;
    
    switch (action) {
      case 'new_referral':
        title = '👥 New Referral!';
        message = `${referredUsername} has joined using your referral link. Encourage them to activate for earning opportunities!`;
        break;
      case 'referral_activated':
        title = '🎉 Referral Activated!';
        message = `${referredUsername} has activated their account! You'll receive commission shortly.`;
        break;
      case 'commission_earned':
        title = '💰 Referral Commission!';
        message = `You earned ${commissionAmount} from ${referredUsername}'s ${level === 1 ? 'direct' : 'indirect'} referral activation!`;
        break;
      default:
        title = '👥 Referral Update';
        message = `Referral activity: ${action} - ${referredUsername}`;
    }

    return await this.createNotification({
      userId,
      type: 'success',
      category: 'commission',
      title,
      message,
      actionUrl: '/referrals',
      sendEmail: action === 'commission_earned' || action === 'referral_activated',
      priority: action === 'commission_earned' ? 2 : 1
    });
  }

  // System maintenance notifications
  async notifySystemMaintenance(maintenanceData) {
    const { type, message, scheduledTime, duration } = maintenanceData;
    
    return await this.notifyAllUsers({
      type: 'warning',
      category: 'system',
      title: `🔧 System ${type}`,
      message: `${message}. Scheduled for ${scheduledTime}, duration: ${duration}`,
      sendEmail: true,
      priority: 2
    });
  }

  // Promotional notifications
  async notifyPromotion(userId, promotionData) {
    const { title, message, promoCode, expiryDate, actionUrl } = promotionData;
    
    return await this.createNotification({
      userId,
      type: 'info',
      category: 'system',
      title: `🎁 ${title}`,
      message: `${message}${promoCode ? ` Use code: ${promoCode}` : ''}${expiryDate ? ` (Expires: ${expiryDate})` : ''}`,
      actionUrl: actionUrl || '/dashboard',
      sendEmail: true,
      priority: 1
    });
  }

  // Account status notifications
  async notifyAccountStatus(userId, statusData) {
    const { newStatus, reason, adminMessage } = statusData;
    
    let title, message, type;
    
    switch (newStatus) {
      case 'active':
        title = '✅ Account Activated';
        message = 'Your account has been activated successfully!';
        type = 'success';
        break;
      case 'suspended':
        title = '⚠️ Account Suspended';
        message = `Your account has been suspended. Reason: ${reason}`;
        type = 'warning';
        break;
      case 'banned':
        title = '🚫 Account Banned';
        message = `Your account has been banned. Reason: ${reason}`;
        type = 'error';
        break;
      default:
        title = '🔔 Account Status Update';
        message = `Your account status has been updated to: ${newStatus}`;
        type = 'info';
    }

    if (adminMessage) {
      message += `\n\nAdmin message: ${adminMessage}`;
    }

    return await this.createNotification({
      userId,
      type,
      category: 'system',
      title,
      message,
      actionUrl: '/dashboard',
      sendEmail: true,
      priority: 3
    });
  }

  // Payment notifications
  async notifyPaymentProcessed(userId, paymentData) {
    const { amount, method, status } = paymentData;
    
    return await this.createNotification({
      userId,
      type: status === 'success' ? 'success' : 'warning',
      category: 'payment',
      title: status === 'success' ? '✅ Payment Processed' : '⚠️ Payment Issue',
      message: `Payment of ${amount} via ${method} has been ${status}`,
      actionUrl: '/dashboard/payments',
      sendEmail: true,
      priority: 3
    });
  }

  // User action notifications
  async notifyUserAction(userId, actionData) {
    const { action, details } = actionData;
    
    return await this.createNotification({
      userId,
      type: 'info',
      category: 'user_action',
      title: `Action Required: ${action}`,
      message: details,
      actionUrl: '/dashboard',
      sendEmail: true,
      priority: 2
    });
  }

  // Admin alert notifications
  async notifyAdminAlert(alertData) {
    const { type, message, details, priority = 3 } = alertData;
    
    // Get all admin users
    const [admins] = await this.pool.query(`
      SELECT id, email, username FROM users WHERE role = 'admin'
    `);

    const notifications = [];
    for (const admin of admins) {
      const result = await this.createNotification({
        userId: admin.id,
        type: 'critical',
        category: 'admin_alert',
        title: `🚨 Admin Alert: ${type}`,
        message,
        priority,
        sendEmail: true
      });
      notifications.push(result);

      // Send immediate email to admin
      try {
        await this.emailService.sendTemplatedEmail('admin_alert', admin.email, {
          username: admin.username,
          alert_type: type,
          message,
          details,
          timestamp: new Date().toISOString(),
          admin_url: process.env.BASE_URL + '/admin'
        });
      } catch (error) {
        console.error(`Failed to send admin alert email to ${admin.email}:`, error);
      }
    }

    return notifications;
  }

  // System notification for all users
  async notifyAllUsers(notificationData) {
    try {
      const [users] = await this.pool.query(`
        SELECT id FROM users WHERE role != 'admin'
      `);

      const notifications = [];
      for (const user of users) {
        const result = await this.createNotification({
          userId: user.id,
          ...notificationData,
          sendEmail: false // Bulk email will be sent separately
        });
        notifications.push(result);
      }

      return notifications;
    } catch (error) {
      console.error('Failed to notify all users:', error);
      return { success: false, error: error.message };
    }
  }

  // Daily reports
  async sendDailyReports() {
    console.log('📊 Sending daily reports...');
    
    try {
      // Get users who want daily reports
      const [users] = await this.pool.query(`
        SELECT u.id, u.username, u.email
        FROM users u
        LEFT JOIN notification_preferences np ON u.id = np.user_id
        WHERE COALESCE(np.daily_reports, TRUE) = TRUE
        AND u.role != 'admin'
      `);

      for (const user of users) {
        const reportData = await this.generateUserDailyReport(user.id);
        
        await this.emailService.sendTemplatedEmail('daily_report', user.email, {
          username: user.username,
          date: new Date().toLocaleDateString(),
          dashboard_url: process.env.BASE_URL + '/dashboard',
          ...reportData
        });

        // Create notification
        await this.createNotification({
          userId: user.id,
          type: 'info',
          category: 'report',
          title: '📊 Daily Report Ready',
          message: 'Your daily performance report has been sent to your email',
          actionUrl: '/dashboard',
          priority: 1
        });
      }

      // Send admin daily report
      await this.sendAdminDailyReport();
      
      console.log(`✅ Daily reports sent to ${users.length} users`);
    } catch (error) {
      console.error('Failed to send daily reports:', error);
      await this.notifyAdminAlert({
        type: 'Report Generation Failed',
        message: 'Daily report generation failed',
        details: error.message
      });
    }
  }

  async generateUserDailyReport(userId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // Get today's stats
      const [clicksToday] = await this.pool.query(`
        SELECT COUNT(*) as count
        FROM clicks c
        JOIN shared_links sl ON c.shared_link_id = sl.id
        WHERE sl.user_id = ? AND DATE(c.created_at) = ?
      `, [userId, today]);

      const [earningsToday] = await this.pool.query(`
        SELECT COALESCE(SUM(commission_amount), 0) as total
        FROM commissions
        WHERE user_id = ? AND DATE(created_at) = ?
      `, [userId, today]);

      // Get total stats
      const [totalStats] = await this.pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM clicks c JOIN shared_links sl ON c.shared_link_id = sl.id WHERE sl.user_id = ?) as total_clicks,
          (SELECT COALESCE(SUM(commission_amount), 0) FROM commissions WHERE user_id = ?) as total_earnings,
          (SELECT COUNT(*) FROM shared_links WHERE user_id = ? AND is_active = 1) as active_links
      `, [userId, userId, userId]);

      const conversionRate = totalStats[0].total_clicks > 0 
        ? ((totalStats[0].total_earnings / totalStats[0].total_clicks) * 100).toFixed(2)
        : 0;

      return {
        clicks_today: clicksToday[0].count,
        earnings_today: `RWF ${earningsToday[0].total.toFixed(2)}`,
        total_clicks: totalStats[0].total_clicks,
        total_earnings: `RWF ${totalStats[0].total_earnings.toFixed(2)}`,
        active_links: totalStats[0].active_links,
        conversion_rate: conversionRate
      };
    } catch (error) {
      console.error('Failed to generate user daily report:', error);
      return {
        clicks_today: 0,
        earnings_today: 'RWF 0.00',
        total_clicks: 0,
        total_earnings: 'RWF 0.00',
        active_links: 0,
        conversion_rate: 0
      };
    }
  }

  async sendAdminDailyReport() {
    try {
      const [admins] = await this.pool.query(`
        SELECT id, username, email FROM users WHERE role = 'admin'
      `);

      const reportData = await this.generateAdminDailyReport();
      
      for (const admin of admins) {
        await this.emailService.sendTemplatedEmail('admin_daily_report', admin.email, {
          username: admin.username,
          date: new Date().toLocaleDateString(),
          admin_url: process.env.BASE_URL + '/admin',
          ...reportData
        });
      }
    } catch (error) {
      console.error('Failed to send admin daily report:', error);
    }
  }

  async generateAdminDailyReport() {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const [stats] = await this.pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM users WHERE DATE(created_at) = ?) as new_users,
          (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = ?) as new_orders,
          (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE DATE(created_at) = ?) as daily_revenue,
          (SELECT COUNT(*) FROM clicks WHERE DATE(created_at) = ?) as total_clicks,
          (SELECT COUNT(*) FROM shared_links WHERE DATE(created_at) = ?) as new_links
      `, [today, today, today, today, today]);

      return stats[0];
    } catch (error) {
      console.error('Failed to generate admin daily report:', error);
      return {
        new_users: 0,
        new_orders: 0,
        daily_revenue: 0,
        total_clicks: 0,
        new_links: 0
      };
    }
  }

  // Weekly and monthly reports (similar structure)
  async sendWeeklyReports() {
    console.log('📊 Sending weekly reports...');
    // Implementation similar to daily reports but with weekly data
  }

  async sendMonthlyReports() {
    console.log('📊 Sending monthly reports...');
    // Implementation similar to daily reports but with monthly data
  }

  // Utility methods
  async getUserNotifications(userId, limit = 50) {
    const [notifications] = await this.pool.query(`
      SELECT * FROM notifications 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `, [userId, limit]);

    return notifications;
  }

  async markNotificationAsRead(notificationId, userId) {
    await this.pool.query(`
      UPDATE notifications 
      SET is_read = TRUE, read_at = NOW() 
      WHERE id = ? AND user_id = ?
    `, [notificationId, userId]);
  }

  async updateNotificationPreferences(userId, preferences) {
    await this.pool.query(`
      INSERT INTO notification_preferences (user_id, email_notifications, commission_alerts, payment_alerts, system_alerts, daily_reports, weekly_reports, monthly_reports, marketing_emails)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email_notifications = VALUES(email_notifications),
        commission_alerts = VALUES(commission_alerts),
        payment_alerts = VALUES(payment_alerts),
        system_alerts = VALUES(system_alerts),
        daily_reports = VALUES(daily_reports),
        weekly_reports = VALUES(weekly_reports),
        monthly_reports = VALUES(monthly_reports),
        marketing_emails = VALUES(marketing_emails),
        updated_at = NOW()
    `, [
      userId,
      preferences.emailNotifications,
      preferences.commissionAlerts,
      preferences.paymentAlerts,
      preferences.systemAlerts,
      preferences.dailyReports,
      preferences.weeklyReports,
      preferences.monthlyReports,
      preferences.marketingEmails
    ]);
  }
}

module.exports = NotificationService;

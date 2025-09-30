// ReportScheduler.js - Automated Report Scheduling for BenixSpace
const cron = require('node-cron');

class ReportScheduler {
  constructor(notificationService) {
    this.notificationService = notificationService;
    this.scheduledJobs = new Map();
    this.initializeSchedules();
  }

  initializeSchedules() {
    console.log('🕒 Initializing report scheduler...');

    // Daily reports at 8:00 AM every day
    const dailyJob = cron.schedule('0 8 * * *', async () => {
      console.log('⏰ Executing daily report job...');
      try {
        await this.notificationService.sendDailyReports();
        console.log('✅ Daily reports completed');
      } catch (error) {
        console.error('❌ Daily reports failed:', error);
        await this.notificationService.notifyAdminAlert({
          type: 'Daily Report Failed',
          message: 'Daily report generation failed',
          details: error.message,
          priority: 2
        });
      }
    }, {
      scheduled: false,
      timezone: "Africa/Kigali"
    });

    // Weekly reports every Monday at 9:00 AM
    const weeklyJob = cron.schedule('0 9 * * 1', async () => {
      console.log('⏰ Executing weekly report job...');
      try {
        await this.notificationService.sendWeeklyReports();
        console.log('✅ Weekly reports completed');
      } catch (error) {
        console.error('❌ Weekly reports failed:', error);
        await this.notificationService.notifyAdminAlert({
          type: 'Weekly Report Failed',
          message: 'Weekly report generation failed',
          details: error.message,
          priority: 2
        });
      }
    }, {
      scheduled: false,
      timezone: "Africa/Kigali"
    });

    // Monthly reports on the 1st of each month at 10:00 AM
    const monthlyJob = cron.schedule('0 10 1 * *', async () => {
      console.log('⏰ Executing monthly report job...');
      try {
        await this.notificationService.sendMonthlyReports();
        console.log('✅ Monthly reports completed');
      } catch (error) {
        console.error('❌ Monthly reports failed:', error);
        await this.notificationService.notifyAdminAlert({
          type: 'Monthly Report Failed',
          message: 'Monthly report generation failed',
          details: error.message,
          priority: 2
        });
      }
    }, {
      scheduled: false,
      timezone: "Africa/Kigali"
    });

    // System health check every hour
    const healthCheckJob = cron.schedule('0 * * * *', async () => {
      try {
        await this.performSystemHealthCheck();
      } catch (error) {
        console.error('❌ Health check failed:', error);
      }
    }, {
      scheduled: false,
      timezone: "Africa/Kigali"
    });

    // Clean up old notifications every day at midnight
    const cleanupJob = cron.schedule('0 0 * * *', async () => {
      console.log('🧹 Cleaning up old notifications...');
      try {
        await this.cleanupOldNotifications();
        console.log('✅ Notification cleanup completed');
      } catch (error) {
        console.error('❌ Cleanup failed:', error);
      }
    }, {
      scheduled: false,
      timezone: "Africa/Kigali"
    });

    // Store jobs for management
    this.scheduledJobs.set('daily', dailyJob);
    this.scheduledJobs.set('weekly', weeklyJob);
    this.scheduledJobs.set('monthly', monthlyJob);
    this.scheduledJobs.set('health', healthCheckJob);
    this.scheduledJobs.set('cleanup', cleanupJob);

    console.log('✅ Report scheduler initialized with 5 jobs');
  }

  startScheduler() {
    console.log('🚀 Starting report scheduler...');
    this.scheduledJobs.forEach((job, name) => {
      job.start();
      console.log(`✅ Started ${name} job`);
    });
    console.log('🟢 All scheduled jobs are now active');
  }

  stopScheduler() {
    console.log('🛑 Stopping report scheduler...');
    this.scheduledJobs.forEach((job, name) => {
      job.stop();
      console.log(`⏹️ Stopped ${name} job`);
    });
    console.log('🔴 All scheduled jobs stopped');
  }

  async performSystemHealthCheck() {
    try {
      const pool = this.notificationService.pool;
      const issues = [];

      // Check database connectivity
      try {
        await pool.query('SELECT 1');
      } catch (error) {
        issues.push(`Database connectivity: ${error.message}`);
      }

      // Check email service
      try {
        await this.notificationService.emailService.transporter?.verify();
      } catch (error) {
        issues.push(`Email service: ${error.message}`);
      }

      // Check for stuck processes (orders pending too long)
      const [stuckOrders] = await pool.query(`
        SELECT COUNT(*) as count 
        FROM orders 
        WHERE status = 'pending' 
        AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `);

      if (stuckOrders[0].count > 0) {
        issues.push(`${stuckOrders[0].count} orders stuck in pending status for over 24 hours`);
      }

      // Check for failed payments in last hour
      try {
        const [failedPayments] = await pool.query(`
          SELECT COUNT(*) as count 
          FROM activation_payments 
          WHERE payment_status = 'failed' 
          AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        `);

        if (failedPayments[0].count > 5) {
          issues.push(`High number of failed payments: ${failedPayments[0].count} in the last hour`);
        }
      } catch (error) {
        console.log('Payment_status column not found in activation_payments, trying status column');
        // Try alternative query with status column if payment_status doesn't exist
        try {
          const [failedPayments] = await pool.query(`
            SELECT COUNT(*) as count 
            FROM activation_payments 
            WHERE status = 'failed' 
            AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
          `);

          if (failedPayments[0].count > 5) {
            issues.push(`High number of failed payments: ${failedPayments[0].count} in the last hour`);
          }
        } catch (fallbackError) {
          console.log('Neither payment_status nor status column found, skipping failed payment check');
          // Try basic count without status filter
          try {
            const [recentPayments] = await pool.query(`
              SELECT COUNT(*) as count 
              FROM activation_payments 
              WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
            `);
            console.log(`Recent payments in last hour: ${recentPayments[0].count}`);
          } catch (basicError) {
            console.error('Could not check activation_payments table:', basicError.message);
          }
        }
      }

      // Check disk space (simulated - you'd implement actual disk check)
      // issues.push('Disk space usage above 80%');

      // Alert admins if issues found
      if (issues.length > 0) {
        await this.notificationService.notifyAdminAlert({
          type: 'System Health Issues',
          message: `${issues.length} system health issues detected`,
          details: issues.join('\n'),
          priority: 3
        });
      }

      // Log health check
      await pool.query(`
        INSERT INTO email_logs (status, event_type, details)
        VALUES ('system', 'health_check', ?)
      `, [JSON.stringify({ issues_count: issues.length, issues })]);

    } catch (error) {
      console.error('Health check error:', error);
      await this.notificationService.notifyAdminAlert({
        type: 'Health Check Failed',
        message: 'System health check failed to complete',
        details: error.message,
        priority: 3
      });
    }
  }

  async cleanupOldNotifications() {
    try {
      const pool = this.notificationService.pool;

      // Delete read notifications older than 30 days
      const [readResult] = await pool.query(`
        DELETE FROM notifications 
        WHERE is_read = TRUE 
        AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      // Delete unread notifications older than 90 days
      const [unreadResult] = await pool.query(`
        DELETE FROM notifications 
        WHERE is_read = FALSE 
        AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
      `);

      // Delete old email logs older than 6 months
      const [emailResult] = await pool.query(`
        DELETE FROM email_logs 
        WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 MONTH)
      `);

      console.log(`🧹 Cleanup completed: ${readResult.affectedRows} read notifications, ${unreadResult.affectedRows} old unread notifications, ${emailResult.affectedRows} email logs`);

      // Log cleanup activity
      await pool.query(`
        INSERT INTO email_logs (status, event_type, details)
        VALUES ('system', 'cleanup_completed', ?)
      `, [JSON.stringify({
        read_notifications_deleted: readResult.affectedRows,
        unread_notifications_deleted: unreadResult.affectedRows,
        email_logs_deleted: emailResult.affectedRows
      })]);

    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  // Manual trigger methods for testing
  async triggerDailyReport() {
    console.log('🔧 Manually triggering daily report...');
    try {
      await this.notificationService.sendDailyReports();
      return { success: true, message: 'Daily report sent successfully' };
    } catch (error) {
      console.error('Manual daily report failed:', error);
      return { success: false, error: error.message };
    }
  }

  async triggerWeeklyReport() {
    console.log('🔧 Manually triggering weekly report...');
    try {
      await this.notificationService.sendWeeklyReports();
      return { success: true, message: 'Weekly report sent successfully' };
    } catch (error) {
      console.error('Manual weekly report failed:', error);
      return { success: false, error: error.message };
    }
  }

  async triggerMonthlyReport() {
    console.log('🔧 Manually triggering monthly report...');
    try {
      await this.notificationService.sendMonthlyReports();
      return { success: true, message: 'Monthly report sent successfully' };
    } catch (error) {
      console.error('Manual monthly report failed:', error);
      return { success: false, error: error.message };
    }
  }

  async triggerHealthCheck() {
    console.log('🔧 Manually triggering health check...');
    try {
      await this.performSystemHealthCheck();
      return { success: true, message: 'Health check completed' };
    } catch (error) {
      console.error('Manual health check failed:', error);
      return { success: false, error: error.message };
    }
  }

  getSchedulerStatus() {
    const status = {};
    this.scheduledJobs.forEach((job, name) => {
      status[name] = {
        running: job.running || false,
        scheduled: job.scheduled || false
      };
    });
    return status;
  }
}

module.exports = ReportScheduler;

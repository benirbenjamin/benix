const nodemailer = require('nodemailer');

class EmailService {
  constructor(pool) {
    this.pool = pool;
    this.transporter = null;
    this.initializationPromise = null;
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
    this.initializeTransporter();
  }

  async initializeTransporter() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const config = {
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS
            },
            tls: {
              rejectUnauthorized: false
            }
          };

          // Log SMTP configuration (without password)
          console.log('Attempting SMTP connection with config:', {
            ...config,
            auth: { user: config.auth.user }
          });

          this.transporter = nodemailer.createTransport(config);
          
          // Test the connection
          await this.transporter.verify();
          console.log('✅ Email service initialized successfully');
          return true;
        } catch (error) {
          console.error(`❌ Failed to initialize email service (attempt ${attempt}/${this.maxRetries}):`, error);
          
          if (attempt < this.maxRetries) {
            console.log(`Retrying in ${this.retryDelay/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          } else {
            this.transporter = null;
            this.initializationPromise = null;
            return false;
          }
        }
      }
    })();

    return this.initializationPromise;
  }

  async verifyEmailAddress(email) {
    // For now, just do basic format validation without sending test email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return {
      isValid: emailRegex.test(email),
      error: emailRegex.test(email) ? null : 'Invalid email format'
    };
  }

  async ensureTransporter() {
    if (!this.transporter) {
      const initialized = await this.initializeTransporter();
      if (!initialized) {
        throw new Error('Email service not available');
      }
    }
  }

  async sendEmail(to, subject, text, html) {
    try {
      await this.ensureTransporter();
      
      const mailOptions = {
        from: process.env.SMTP_USER,
        to,
        subject,
        text,
        html
      };

      console.log('Attempting to send email to:', to);
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully to:', to);
      return result;
    } catch (error) {
      console.error('❌ Failed to send email:', error);
      throw error;
    }
  }

  async sendTemplatedEmail(to, template, data) {
    try {
      // Template mapping
      const templates = {
        admin_alert: {
          subject: '🚨 Admin Alert: {{title}}',
          text: '{{message}}',
          html: `
            <h2>{{title}}</h2>
            <p>{{message}}</p>
            <hr>
            <p><small>This is an automated admin alert from BenixSpace.</small></p>
          `
        },
        // Add more templates here as needed
      };

      const selectedTemplate = templates[template];
      if (!selectedTemplate) {
        throw new Error(`Template '${template}' not found`);
      }

      // Replace template variables
      const replaceVariables = (str) => {
        return str.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] || match);
      };

      const subject = replaceVariables(selectedTemplate.subject);
      const text = replaceVariables(selectedTemplate.text);
      const html = replaceVariables(selectedTemplate.html);

      return await this.sendEmail(to, subject, text, html);
    } catch (error) {
      console.error('❌ Failed to send templated email:', error);
      throw error;
    }
  }
}

module.exports = EmailService;
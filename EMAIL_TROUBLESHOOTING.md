# Email Configuration Troubleshooting Guide

## Current Issue
Your email configuration is having connection timeout issues with `mail.benix.space`. This is a common issue when the SMTP server is not properly configured or accessible.

## Quick Solutions

### Option 1: Use Gmail (Recommended)
Gmail is the most reliable option for sending emails from your application.

1. **Update your `.env` file (Port 587 with STARTTLS):**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-app-password
SMTP_DEBUG=true
```

**Alternative (Port 465 with SSL/TLS):**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-app-password
SMTP_DEBUG=true
```

2. **Create an App Password:**
   - Go to your Google Account settings
   - Navigate to Security → 2-Step Verification
   - Click "App passwords"
   - Generate a new app password for "Mail"
   - Use this password instead of your regular Gmail password

### Option 2: Use Outlook/Hotmail

**Port 587 with STARTTLS (Recommended):**
```env
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
SMTP_DEBUG=true
```

**Port 465 with SSL/TLS (Alternative):**
```env
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
SMTP_DEBUG=true
```

### Option 3: Use Mailtrap (For Testing)
Mailtrap is perfect for testing emails without sending real emails:

1. Sign up at https://mailtrap.io
2. Get your credentials from the inbox settings
3. Update your `.env`:
```env
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_USER=your-mailtrap-user
SMTP_PASS=your-mailtrap-pass
SMTP_DEBUG=true
```

### Option 4: Fix Custom Domain SMTP
If you want to use `mail.benix.space`, you need to:

1. **Check DNS Records:** Ensure your domain has proper MX records
2. **Verify SMTP Server:** Test connection using telnet or mail client
3. **Check Port Access:** Ensure port 465/587 is not blocked
4. **Try Different Port/Security Settings:**

**Port 465 with SSL/TLS (Current):**
```env
SMTP_HOST=mail.benix.space
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=admin@benix.space
SMTP_PASS=1202!birthDATE
```

**Port 587 with STARTTLS (Alternative):**
```env
SMTP_HOST=mail.benix.space
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=admin@benix.space
SMTP_PASS=1202!birthDATE
```

## Understanding SMTP Security Settings

### Port 465 (SSL/TLS)
- **SMTP_SECURE=true**
- Uses SSL/TLS encryption from the beginning of the connection
- Also called "Implicit TLS" or "SMTPS"
- More secure but older standard

### Port 587 (STARTTLS)
- **SMTP_SECURE=false**
- Starts with an unencrypted connection, then upgrades to TLS
- Also called "Explicit TLS" or "Submission Port"
- Modern standard, widely supported

### Port 25 (Plain/STARTTLS)
- **SMTP_SECURE=false**
- Often blocked by ISPs to prevent spam
- Not recommended for client applications

**Important:** Always use encryption (either port 465 or 587) for production applications.

## Testing Your Configuration

After updating your `.env` file, restart your application and check the console logs. You should see:
- ✅ Email server connection successful (if working)
- ❌ Email server connection failed (with specific error details)

## Common Error Codes

- **ETIMEDOUT/ESOCKET**: Connection timeout - check host/port
- **EAUTH**: Authentication failed - check username/password
- **535**: Invalid credentials - use app-specific password for Gmail
- **550**: Mailbox unavailable - check email address format

## Security Notes

- Never commit real passwords to version control
- Use environment variables for all sensitive data
- Consider using app-specific passwords for better security
- Enable 2FA on your email account

## Need Help?

If you're still having issues:
1. Enable debug mode: `SMTP_DEBUG=true`
2. Check the detailed logs in your console
3. Try the Mailtrap option for immediate testing
4. Contact your hosting provider about SMTP restrictions

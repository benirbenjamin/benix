# Email Configuration Setup Guide

## 📧 Setting Up Email for User Contact Features

Your `.env` file has been updated with email configuration options. Follow the steps below to configure email sending:

## Option 1: Gmail (Recommended)

### Step 1: Enable 2-Factor Authentication
1. Go to your Google Account settings
2. Security → 2-Step Verification → Turn on

### Step 2: Generate App Password
1. Go to Google Account → Security → App passwords
2. Select "Mail" and generate a password
3. Use this 16-character password (not your regular Gmail password)

### Step 3: Update .env file

**Option A: Port 587 with STARTTLS (Recommended)**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-16-character-app-password
```

**Option B: Port 465 with SSL/TLS**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-16-character-app-password
```

## Option 2: Outlook/Hotmail

### Update .env file

**Option A: Port 587 with STARTTLS (Recommended)**
```env
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
```

**Option B: Port 465 with SSL/TLS (if supported)**
```env
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
```

## Option 3: Yahoo Mail

### Step 1: Enable App Passwords
1. Go to Yahoo Account Security
2. Generate an app password for "Mail"

### Step 2: Update .env file

**Option A: Port 587 with STARTTLS (Recommended)**
```env
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@yahoo.com
SMTP_PASS=your-app-password
```

**Option B: Port 465 with SSL/TLS**
```env
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@yahoo.com
SMTP_PASS=your-app-password
```

## Testing Email Configuration

After updating your `.env` file:

1. **Restart your application** (important!)
   ```bash
   # Stop your current server (Ctrl+C)
   # Then restart it
   npm start
   ```

2. **Check the console logs** when the app starts:
   - ✅ "SMTP server is ready to send emails" = Success
   - ❌ "SMTP connection error" = Configuration issue

3. **Test sending an email**:
   - Go to Admin → Users
   - Try contacting a user or yourself
   - Check if the email is received

## Troubleshooting

### Common Issues:

1. **"Invalid login" error**:
   - For Gmail: Make sure you're using an App Password, not your regular password
   - Enable 2-Factor Authentication first

2. **"Connection timeout"**:
   - Check if your firewall/antivirus is blocking port 587
   - Try port 465 with `SMTP_SECURE=true`

3. **Emails going to spam**:
   - This is normal for new sending domains
   - Ask users to check spam folder and mark as "not spam"

### Alternative Ports:
If port 587 doesn't work, try:

**Port 465 with SSL/TLS:**
```env
SMTP_PORT=465
SMTP_SECURE=true
```

**Port 587 with STARTTLS:**
```env
SMTP_PORT=587
SMTP_SECURE=false
```

### Port Configuration Explained:
- **Port 587**: Uses STARTTLS (starts unencrypted, then upgrades to TLS) → `SMTP_SECURE=false`
- **Port 465**: Uses SSL/TLS from the beginning (implicit TLS) → `SMTP_SECURE=true`
- **Port 25**: Unencrypted (not recommended for production)

## Security Notes

- ⚠️ Never commit your `.env` file to version control
- 🔒 Use App Passwords instead of regular passwords
- 📝 The `.env` file is already in your `.gitignore`

## Professional Email Services (Optional)

For production environments, consider:
- **SendGrid** (free tier: 100 emails/day)
- **Mailgun** (free tier: 5,000 emails/month)
- **Amazon SES** (pay per use)

These services provide better deliverability and detailed analytics.

## Current Features Using Email

✅ **Contact Individual User**: Send personalized emails to specific users
✅ **Contact All Users**: Send announcements to all users (filtered)
✅ **Professional Templates**: Branded HTML emails with BenixSpace styling
✅ **Error Handling**: Proper success/failure notifications

---

**Next Steps:**
1. Update the SMTP credentials in your `.env` file
2. Restart your application
3. Test the email functionality
4. Start contacting your users! 🚀

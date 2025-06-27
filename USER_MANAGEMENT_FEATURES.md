# User Management Features

## New Features Added

### 1. Contact Individual Users
- **Location**: Individual user actions dropdown
- **Functionality**: Send personalized emails to specific users
- **Route**: `POST /admin/users/contact`
- **Features**:
  - Professional email template with BenixSpace branding
  - HTML formatted emails
  - Error handling and success notifications

### 2. Contact All Users (Bulk Email)
- **Location**: Top action bar button "Contact All Users"
- **Functionality**: Send announcement emails to all users (filtered by current search/role filters)
- **Route**: `POST /admin/users/contact-all`
- **Features**:
  - Respects current page filters (role, search)
  - Batch processing with delay to avoid SMTP overload
  - Success/failure counting
  - Professional email template

### 3. Export Users
- **Location**: Top action bar button "Export Users"
- **Functionality**: Download user data as CSV file
- **Route**: `GET /admin/users/export`
- **Features**:
  - Respects current page filters (role, search)
  - CSV format with comprehensive user data
  - Includes statistics (orders, shared links, commissions)
  - Timestamped filename

## Email Configuration

The system uses the existing nodemailer configuration from your app.js file. Make sure your environment variables are set:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

## CSV Export Fields

The export includes the following fields:
- ID
- Username
- Email
- Role
- Wallet Balance
- Premium Status
- Total Shared Links
- Total Orders
- Total Commissions
- Joined Date
- Last Updated

## Security Features

- All routes require admin authentication
- Input validation for email content
- Protection against admin user deletion
- Email rate limiting (100ms delay between bulk emails)
- Error handling and logging

## UI Improvements

- Bootstrap modals for email composition
- Loading states for buttons during operations
- Success/error notifications
- Professional email templates with branding
- Responsive design

## Usage

1. **Contact Individual User**: Click the dropdown arrow next to "View" button → "Contact User"
2. **Contact All Users**: Click "Contact All Users" button in the top action bar
3. **Export Users**: Click "Export Users" button in the top action bar

All operations respect the current page filters, so you can filter users by role or search term before performing bulk operations.

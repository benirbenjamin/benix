# Commission System Update

## Overview
The commission system has been updated to implement a two-tier commission structure where:
1. **Admin gets a commission** from product sales (configurable percentage)
2. **Users get a percentage of the admin's commission** (not directly from product price)

## Example
- Product price: $400
- Admin commission rate: 10% → Admin gets $40
- User commission percentage: 30% → User gets 30% of $40 = $12

## Changes Made

### 1. New Configuration Settings
Added two new settings in the config table:
- `admin_commission_rate`: Admin commission percentage from product sales (default: 10%)
- `user_commission_percentage`: User commission as percentage of admin commission (default: 30%)

### 2. Updated Commission Calculation Logic
Modified `processProductCommissions()` function in `app.js`:
- Calculates admin commission first: `product_price * admin_commission_rate / 100`
- Calculates user commission from admin commission: `admin_commission * user_commission_percentage / 100`

### 3. Added Admin Commission Tracking
Created new `processAdminCommissions()` function that:
- Calculates total admin commission for completed orders
- Updates admin user's earnings and wallet
- Records admin commission transactions

### 4. Updated Admin Settings Interface
- Added new commission settings to essential settings section
- Added percentage symbol (%) for rate and percentage fields
- Updated field validation for numeric inputs

### 5. Updated User Interface
Updated templates to show correct commission calculations:
- `views/user/share-product.ejs`: Shows user commission as percentage of admin commission
- `views/user/shared-products.ejs`: Displays actual dollar amount users earn per sale

### 6. Route Updates
Updated routes to pass commission configuration data:
- Product sharing routes now include `adminCommissionRate` and `userCommissionPercentage`
- Templates can calculate correct commission amounts

## Database Changes
The system uses existing tables with new config entries. No schema changes required.

## Configuration Access
Admins can configure the commission rates through:
`/admin/settings` → Essential Settings section

## How It Works Now

### When a Product is Sold (Order Status: "delivered"):
1. **Admin Commission**: Calculated as percentage of product price
2. **User Commission**: Calculated as percentage of admin commission (for referred sales only)
3. Both commissions are recorded as separate transactions
4. User sees their actual earning potential based on the two-tier system

### For Users Sharing Products:
- They see the actual dollar amount they'll earn per sale
- Commission is shown as "You earn X% of admin commission"
- More transparent about the commission structure

## Benefits
1. **Admin Control**: Admin can adjust both commission rates independently
2. **Scalable**: Admin commission covers platform costs, user commission incentivizes sharing
3. **Transparent**: Users understand they get a portion of admin commission
4. **Flexible**: Easy to adjust rates based on business needs

## Testing
To test the new system:
1. Update admin commission rate in settings (e.g., 15%)
2. Update user commission percentage in settings (e.g., 25%)
3. Create test orders with referral codes
4. Mark orders as "delivered" to trigger commission processing
5. Check transaction records for both admin and user commissions

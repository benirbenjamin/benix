// Authentication and authorization middleware

// Check if user is logged in and load user data
const isAuthenticated = async (req, res, next) => {
  if (req.session && req.session.userId) {
    try {
      // Load user data
      const [users] = await req.pool.query(
        'SELECT id, username, email, role, business_name FROM users WHERE id = ?',
        [req.session.userId]
      );
      
      if (users.length > 0) {
        req.user = users[0];  // Attach user data to request object
        
        // If user is admin, fetch pending counts
        if (users[0].role === 'admin') {
          try {
            // Fetch pending banner count
            const [bannerResult] = await req.pool.query(
              'SELECT COUNT(*) as count FROM banners WHERE status = ?',
              ['pending']
            );
            req.user.pendingBannerCount = parseInt(bannerResult[0].count) || 0;

            // Fetch pending activation payment count
            const [paymentResult] = await req.pool.query(
              'SELECT COUNT(*) as count FROM activation_payments WHERE payment_status = ?',
              ['pending']
            );
            req.user.pendingPaymentCount = parseInt(paymentResult[0].count) || 0;

            // Fetch pending orders count
            const [orderResult] = await req.pool.query(
              'SELECT COUNT(*) as count FROM orders WHERE status = ?',
              ['pending']
            );
            req.user.pendingOrderCount = parseInt(orderResult[0].count) || 0;

            console.log('Admin Notification Counts:', {
              banners: req.user.pendingBannerCount,
              payments: req.user.pendingPaymentCount,
              orders: req.user.pendingOrderCount
            });
          } catch (error) {
            console.error('Error fetching notification counts:', error);
            // Set default values if queries fail
            req.user.pendingBannerCount = 0;
            req.user.pendingPaymentCount = 0;
            req.user.pendingOrderCount = 0;
          }
        }
        
        return next();
      }
    } catch (err) {
      console.error('Error loading user data:', err);
    }
  }
  
  req.flash('error', 'Please login to continue');
  res.redirect('/login');
};

// Check if user is an admin
const isAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    req.flash('error', 'Please login to continue');
    return res.redirect('/login');
  }

  try {
    const [users] = await req.pool.query(
      'SELECT role FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length > 0 && users[0].role === 'admin') {
      return next();
    }

    req.flash('error', 'Access denied. Admin privileges required.');
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error checking admin status:', err);
    req.flash('error', 'An error occurred. Please try again.');
    res.redirect('/dashboard');
  }
};

// Check if user is a merchant
const isMerchant = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    req.flash('error', 'Please login to continue');
    return res.redirect('/login');
  }

  try {
    const [users] = await req.pool.query(
      'SELECT role FROM users WHERE id = ?',
      [req.session.userId]
    );

    console.log('Checking merchant status for user:', {
      userId: req.session.userId,
      role: users[0]?.role,
      userObj: users[0]
    });

    if (users.length > 0 && (users[0].role === 'merchant' || users[0].role === 'admin')) {
      return next();
    }

    req.flash('error', 'Access denied. Merchant account required.');
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error checking merchant status:', err);
    req.flash('error', 'An error occurred. Please try again.');
    res.redirect('/dashboard');
  }
};

// Check if user is activated (if activation is required)
const isActivated = async (req, res, next) => {
  // Skip activation check if not required
  if (process.env.REQUIRE_ACTIVATION !== 'true') {
    return next();
  }

  if (!req.session || !req.session.userId) {
    req.flash('error', 'Please login to continue');
    return res.redirect('/login');
  }

  try {
    const [users] = await req.app.locals.pool.query(
      'SELECT is_activated FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length > 0 && users[0].is_activated) {
      return next();
    }

    req.flash('error', 'Please activate your account to access this feature.');
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error checking activation status:', err);
    req.flash('error', 'An error occurred. Please try again.');
    res.redirect('/dashboard');
  }
};

module.exports = {
  isAuthenticated,
  isAdmin,
  isMerchant,
  isActivated
};
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAuthenticated, isMerchant, isAdmin } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const geoip = require('geoip-lite');

// Create uploads directory for banners if it doesn't exist
const bannerUploadDir = path.join(__dirname, '..', 'public', 'uploads', 'banners');
if (!fs.existsSync(bannerUploadDir)) {
  fs.mkdirSync(bannerUploadDir, { recursive: true });
}

// Configure multer for banner image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, bannerUploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = uuidv4();
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Banner monetization endpoints
const { logError, logInfo } = require('../utils/logger');

router.post('/api/banners/click', async (req, res) => {
  // Log raw request details to file
  logError('BANNER_TRACKING', null, {
    event: 'request_received',
    path: req.path,
    method: req.method,
    body: req.body,
    query: req.query,
    headers: req.headers,
    ip: req.ip,
    timestamp: new Date().toISOString()
  });

  try {
    // Log incoming request details
    logInfo('BannerClick.Request', {
      path: req.path,
      method: req.method,
      body: req.body,
      headers: req.headers,
      userId: req.session?.userId,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString(),
      isAuthenticated: !!req.session?.userId,
      sessionData: req.session
    });

    const { bannerId } = req.body;
    const userId = req.session?.userId;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || '';
    
    if (!bannerId) {
      logError('BannerClick.Validation', new Error('Missing bannerId'), { body: req.body });
      return res.status(400).json({ success: false, error: 'Banner ID is required' });
    }

    const bannerService = req.app.get('bannerService');
    if (!bannerService) {
      logError('BannerClick.Service', new Error('Banner service not initialized'));
      return res.status(500).json({ success: false, error: 'Banner service not available' });
    }

    // Log before tracking click
    logInfo('BannerClick.TrackingStart', {
      bannerId,
      userId,
      ip,
      timestamp: new Date().toISOString()
    });

    await bannerService.trackClick(bannerId, userId, ip, userAgent);
    
    // Log after successful tracking
    logInfo('BannerClick.TrackingSuccess', {
      bannerId,
      userId,
      timestamp: new Date().toISOString()
    });

    // Get banner target URL for redirection
    const [[banner]] = await req.pool.query(
      'SELECT target_url FROM banners WHERE id = ?',
      [bannerId]
    );

    if (!banner) {
      logError('BannerClick.BannerNotFound', new Error('Banner not found'), { bannerId });
      return res.status(404).json({ success: false, error: 'Banner not found' });
    }

    // Log successful response
    logInfo('BannerClick.Response', {
      bannerId,
      hasTargetUrl: !!banner?.target_url,
      timestamp: new Date().toISOString()
    });
    
    logInfo('BANNER_TRACKING', {
      event: 'request_success',
      bannerId,
      hasUrl: !!banner?.target_url,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, url: banner?.target_url });
  } catch (error) {
    logError('BannerClick.Error', error, {
      body: req.body,
      userId: req.session?.userId,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ success: false, error: 'Failed to track banner click' });
  }
});

router.post('/api/banners/impression', async (req, res) => {
  try {
    const { bannerId } = req.body;
    const userId = req.session?.userId;
    
    const bannerService = req.app.get('bannerService');
    await bannerService.trackImpression(bannerId, userId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Banner impression tracking failed:', error);
    res.status(500).json({ error: 'Failed to track banner impression' });
  }
});

// Banner settings management
router.get('/api/banners/settings', isAdmin, async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT * FROM settings 
      WHERE key IN ('banner_cpc', 'banner_cpm', 'banner_impression_batch')
    `);
    
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    
    res.json(settings);
  } catch (error) {
    console.error('Failed to fetch banner settings:', error);
    res.status(500).json({ error: 'Failed to fetch banner settings' });
  }
});

router.put('/api/banners/settings', isAdmin, async (req, res) => {
  const { cpc, cpm, impressionBatch } = req.body;
  const conn = await req.pool.getConnection();
  
  try {
    await conn.beginTransaction();
    
    if (cpc) {
      await conn.query('UPDATE settings SET value = ? WHERE key = "banner_cpc"', [cpc]);
    }
    if (cpm) {
      await conn.query('UPDATE settings SET value = ? WHERE key = "banner_cpm"', [cpm]);
    }
    if (impressionBatch) {
      await conn.query('UPDATE settings SET value = ? WHERE key = "banner_impression_batch"', [impressionBatch]);
    }
    
    await conn.commit();
    res.json({ success: true });
  } catch (error) {
    await conn.rollback();
    console.error('Failed to update banner settings:', error);
    res.status(500).json({ error: 'Failed to update banner settings' });
  } finally {
    conn.release();
  }
});

// Merchant routes for banner management
router.get('/merchant-user/banners', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const [banners] = await req.pool.query(`
      SELECT 
        b.*,
        COUNT(DISTINCT bv.id) as total_views,
        COUNT(DISTINCT bc.id) as total_clicks,
        b.cost_per_click,
        b.cost_per_view,
        (COUNT(DISTINCT bc.id) * b.cost_per_click) as clicks_cost,
        (COUNT(DISTINCT bv.id) * b.cost_per_view / 1000) as views_cost,
        ((COUNT(DISTINCT bc.id) * b.cost_per_click) + 
         (COUNT(DISTINCT bv.id) * b.cost_per_view / 1000)) as total_cost
      FROM banners b
      LEFT JOIN banner_views bv ON b.id = bv.banner_id
      LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
      WHERE b.merchant_id = ?
      GROUP BY b.id
      ORDER BY b.created_at DESC`,
      [req.session.userId]
    );

    res.render('merchant-user/banners', {
      user: req.user,
      banners: banners,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Error fetching merchant banners:', err);
    res.status(500).render('error', { message: 'Failed to fetch banners' });
  }
});

router.get('/merchant-user/banners/create', isAuthenticated, isMerchant, async (req, res) => {
  try {
    // Get current banner rates from settings
    const [settings] = await req.pool.query(`
      SELECT setting_key, setting_value 
      FROM system_settings 
      WHERE setting_key IN ('banner_cpc_usd', 'banner_cpm_usd')
    `);

    const rates = {
      banner_cpc_usd: '0.00',
      banner_cpm_usd: '0.00'
    };
    settings.forEach(setting => {
      rates[setting.setting_key] = parseFloat(setting.setting_value).toFixed(2);
    });

    res.render('merchant-user/create-banner', {
      user: req.user,
      settings: rates,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Error loading banner creation form:', err);
    res.redirect('/merchant-user/banners?error=Failed to load banner creation form');
  }
});

router.post('/merchant-user/banners/create', isAuthenticated, isMerchant, upload.single('bannerImage'), async (req, res) => {
  const conn = await req.pool.getConnection();
  try {
    const { title, targetUrl, targetClicks } = req.body;
    if (!req.file) {
      return res.redirect('/merchant-user/banners/create?error=Banner image is required');
    }

    if (!targetClicks || isNaN(targetClicks)) {
      return res.redirect('/merchant-user/banners/create?error=Please select a valid target clicks value');
    }

    await conn.beginTransaction();

    // Get current banner rates
    const [[rates]] = await conn.query(`
      SELECT 
        MAX(CASE WHEN setting_key = 'banner_cpc_usd' THEN setting_value END) as cpc,
        MAX(CASE WHEN setting_key = 'banner_cpm_usd' THEN setting_value END) as cpm
      FROM system_settings 
      WHERE setting_key IN ('banner_cpc_usd', 'banner_cpm_usd')
    `);

    // Construct the image URL
    const imageUrl = `/uploads/banners/${req.file.filename}`;

    // Insert banner with rates and target clicks
    await conn.query(`
      INSERT INTO banners (
        merchant_id, 
        title, 
        image_url, 
        target_url, 
        status, 
        is_active, 
        target_clicks,
        cost_per_click,
        cost_per_view,
        created_at
      ) VALUES (?, ?, ?, ?, 'pending', false, ?, ?, ?, NOW())`,
      [
        req.session.userId, 
        title, 
        imageUrl, 
        targetUrl,
        parseInt(targetClicks),
        parseFloat(rates.cpc) || 0,
        parseFloat(rates.cpm) || 0
      ]
    );

    await conn.commit();
    res.redirect('/merchant-user/banners?success=Banner submitted successfully and is pending approval');
  } catch (err) {
    await conn.rollback();
    console.error('Error creating banner:', err);
    res.redirect('/merchant-user/banners/create?error=Failed to create banner');
  } finally {
    conn.release();
  }
});

// Admin routes for banner management
// Route to update banner status
router.post('/admin/banners/update-status', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { bannerId, status, adminNotes, isActive } = req.body;
    
    await req.pool.query(`
      UPDATE banners 
      SET status = ?, 
          admin_notes = ?,
          is_active = ?,
          updated_at = NOW()
      WHERE id = ?`,
      [status, adminNotes, isActive && status === 'approved', bannerId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating banner status:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update banner status'
    });
  }
});

router.get('/admin/banners', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Get a list of all merchants for the create form
    const [merchants] = await req.pool.query(`
      SELECT id, username, business_name, email 
      FROM users 
      WHERE role = 'merchant'
      ORDER BY username ASC
    `);

    // Get all banners with merchant info and analytics
    const [banners] = await req.pool.query(`
      SELECT 
        b.*,
        u.username as merchant_name,
        u.business_name as merchant_business,
        u.email as merchant_email,
        COUNT(DISTINCT bv.id) as total_views,
        COUNT(DISTINCT bc.id) as total_clicks
      FROM banners b 
      LEFT JOIN users u ON b.merchant_id = u.id
      LEFT JOIN banner_views bv ON b.id = bv.banner_id
      LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
      GROUP BY b.id
      ORDER BY 
        CASE 
          WHEN b.status = 'pending' THEN 1
          WHEN b.status = 'approved' THEN 2
          ELSE 3
        END,
        b.created_at DESC
    `);

    // Calculate statistics
    const pendingCount = banners.filter(b => b.status === 'pending').length;
    const activeCount = banners.filter(b => b.status === 'approved' && b.is_active).length;
    const totalViews = banners.reduce((sum, b) => sum + (parseInt(b.total_views) || 0), 0);
    const totalClicks = banners.reduce((sum, b) => sum + (parseInt(b.total_clicks) || 0), 0);

    res.render('admin/banners', {
      user: req.user,
      banners,
      merchants,
      stats: {
        pending: pendingCount,
        active: activeCount,
        totalViews,
        totalClicks,
        ctr: totalViews ? ((totalClicks / totalViews) * 100).toFixed(2) : 0
      },
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Error fetching banners:', err);
    res.status(500).render('error', { message: 'Failed to fetch banners' });
  }
});

router.get('/admin/banners/:id/edit', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [banners] = await req.pool.query(
      'SELECT * FROM banners WHERE id = ?',
      [req.params.id]
    );

    if (banners.length === 0) {
      return res.status(404).render('error', { message: 'Banner not found' });
    }

    // Get list of merchants for assignment
    const [merchants] = await req.pool.query(`
      SELECT id, username, email 
      FROM users 
      WHERE account_type = 'merchant'
      ORDER BY username`
    );

    res.render('admin/edit-banner', {
      user: req.user,
      banner: banners[0],
      merchants: merchants,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Error fetching banner:', err);
    res.status(500).render('error', { message: 'Failed to fetch banner details' });
  }
});

router.post('/admin/banners/:id/edit', isAuthenticated, isAdmin, upload.single('bannerImage'), async (req, res) => {
  try {
    const { title, merchantId, targetUrl, displayOrder, status, isActive } = req.body;
    const bannerId = req.params.id;

    let updateQuery = `
      UPDATE banners 
      SET title = ?, 
          merchant_id = ?, 
          target_url = ?, 
          display_order = ?, 
          status = ?, 
          is_active = ?
    `;
    let params = [title, merchantId || null, targetUrl, displayOrder, status, isActive === '1'];

    if (req.file) {
      updateQuery += `, image_path = ?`;
      params.push(req.file.filename);
    }

    updateQuery += ` WHERE id = ?`;
    params.push(bannerId);

    await req.pool.query(updateQuery, params);

    res.redirect('/admin/banners?success=Banner updated successfully');
  } catch (err) {
    console.error('Error updating banner:', err);
    res.redirect(`/admin/banners/${req.params.id}/edit?error=Failed to update banner`);
  }
});

router.get('/merchant-user/banners/:id/analytics', isAuthenticated, isMerchant, async (req, res) => {
  try {
    const bannerId = req.params.id;
    
    // Verify banner belongs to merchant and get financial info
    const [banners] = await req.pool.query(`
      SELECT 
        b.*,
        COUNT(DISTINCT bv.id) as total_views,
        COUNT(DISTINCT bc.id) as total_clicks,
        COALESCE(SUM(t.amount), 0) as total_charged,
        (COUNT(DISTINCT bc.id) * b.cost_per_click) as click_costs,
        (COUNT(DISTINCT bv.id) * b.cost_per_view) as view_costs
      FROM banners b
      LEFT JOIN banner_views bv ON b.id = bv.banner_id
      LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
      LEFT JOIN transactions t ON t.reference = CAST(b.id AS CHAR) COLLATE utf8mb4_general_ci
        AND t.type = 'payment'
        AND t.status = 'completed'
        AND t.details LIKE '%banner charge%'
      WHERE b.id = ? AND b.merchant_id = ?
      GROUP BY b.id`,
      [bannerId, req.session.userId]
    );

    if (banners.length === 0) {
      return res.status(404).render('error', { message: 'Banner not found' });
    }

    // Get banner statistics with costs
    const [stats] = await req.pool.query(`
      SELECT 
        b.*,
        COUNT(DISTINCT bv.id) as total_views,
        COUNT(DISTINCT bc.id) as total_clicks,
        b.cost_per_click,
        b.cost_per_view,
        (COUNT(DISTINCT bc.id) * b.cost_per_click) as click_costs,
        (COUNT(DISTINCT bv.id) * b.cost_per_view / 1000) as view_costs,
        ((COUNT(DISTINCT bc.id) * b.cost_per_click) + 
         (COUNT(DISTINCT bv.id) * b.cost_per_view / 1000)) as total_cost
      FROM banners b
      LEFT JOIN banner_views bv ON b.id = bv.banner_id
      LEFT JOIN banner_clicks bc ON b.id = bc.banner_id
      WHERE b.id = ?
      GROUP BY b.id`,
      [bannerId]
    );

    // Get detailed click data for geographic analysis
    const [clicks] = await req.pool.query(`
      SELECT 
        DATE(clicked_at) as date,
        country,
        city,
        COUNT(*) as click_count
      FROM banner_clicks
      WHERE banner_id = ?
      GROUP BY DATE(clicked_at), country, city
      ORDER BY date DESC, click_count DESC`,
      [bannerId]
    );

    // Get detailed view data for geographic analysis
    const [views] = await req.pool.query(`
      SELECT 
        DATE(viewed_at) as date,
        country,
        city,
        COUNT(*) as view_count
      FROM banner_views
      WHERE banner_id = ?
      GROUP BY DATE(viewed_at), country, city
      ORDER BY date DESC, view_count DESC`,
      [bannerId]
    );

    // Process data for charts
    const dailyStats = [];
    const countryStats = [];
    const cityStats = [];

    // Calculate total views and clicks
    const totalViews = views.reduce((sum, view) => sum + view.view_count, 0);
    const totalClicks = clicks.reduce((sum, click) => sum + click.click_count, 0);

    // Process country stats
    const countryMap = new Map();
    views.forEach(view => {
      const country = view.country || 'Unknown';
      if (!countryMap.has(country)) {
        countryMap.set(country, { country, views: 0, clicks: 0 });
      }
      countryMap.get(country).views += view.view_count;
    });
    clicks.forEach(click => {
      const country = click.country || 'Unknown';
      if (!countryMap.has(country)) {
        countryMap.set(country, { country, views: 0, clicks: 0 });
      }
      countryMap.get(country).clicks += click.click_count;
    });
    countryMap.forEach(stat => countryStats.push(stat));

    // Process city stats similarly
    const cityMap = new Map();
    views.forEach(view => {
      const city = view.city || 'Unknown';
      if (!cityMap.has(city)) {
        cityMap.set(city, { city, views: 0, clicks: 0 });
      }
      cityMap.get(city).views += view.view_count;
    });
    clicks.forEach(click => {
      const city = click.city || 'Unknown';
      if (!cityMap.has(city)) {
        cityMap.set(city, { city, views: 0, clicks: 0 });
      }
      cityMap.get(city).clicks += click.click_count;
    });
    cityMap.forEach(stat => cityStats.push(stat));

    // Get all unique dates
    const dates = new Set([
      ...views.map(v => v.date),
      ...clicks.map(c => c.date)
    ].sort());

    // Process daily stats
    dates.forEach(date => {
      const dateViews = views
        .filter(v => v.date.getTime() === date.getTime())
        .reduce((sum, v) => sum + v.view_count, 0);
      const dateClicks = clicks
        .filter(c => c.date.getTime() === date.getTime())
        .reduce((sum, c) => sum + c.click_count, 0);
      dailyStats.push({
        date: date.toISOString().split('T')[0],
        views: dateViews,
        clicks: dateClicks
      });
    });

    // No need to explicitly pass user as it's handled by the global middleware
    res.render('merchant-user/banner-analytics', {
      banner: banners[0],
      stats: stats,
      dailyStats,
      countryStats: countryStats.sort((a, b) => b.views - a.views),
      cityStats: cityStats.sort((a, b) => b.views - a.views),
      clicks: clicks || [], // Pass empty array if no clicks
      views: views || []    // Pass empty array if no views
    });
  } catch (err) {
    console.error('Error fetching banner analytics:', err);
    res.status(500).render('error', { message: 'Failed to fetch analytics' });
  }
});

// Admin routes for banner management
router.get('/admin/banners', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [banners] = await req.pool.query(`
      SELECT b.*, u.username as merchant_name, u.business_name 
      FROM banners b
      LEFT JOIN users u ON b.merchant_id = u.id
      ORDER BY b.created_at DESC`
    );

    res.render('admin/banners', {
      user: req.user,
      banners: banners,
      success: req.query.success,
      error: req.query.error
    });
  } catch (err) {
    console.error('Error fetching admin banners:', err);
    res.status(500).render('error', { message: 'Failed to fetch banners' });
  }
});

router.post('/admin/banners/:id/update', isAuthenticated, isAdmin, upload.single('image'), async (req, res) => {
  try {
    const bannerId = req.params.id;
    const { title, target_url, status, merchant_id, is_active, admin_notes, display_order } = req.body;

    let updateFields = [];
    let updateValues = [];

    // Add fields that are always updated
    updateFields.push('title = ?', 'target_url = ?', 'status = ?', 'is_active = ?', 'admin_notes = ?', 'display_order = ?');
    updateValues.push(title, target_url, status, is_active === 'on', admin_notes || null, display_order || 0);

    // Add image_url if a new image was uploaded
    if (req.file) {
      updateFields.push('image_url = ?');
      updateValues.push('/uploads/banners/' + req.file.filename);
    }

    // Add merchant_id if provided
    if (merchant_id) {
      updateFields.push('merchant_id = ?');
      updateValues.push(merchant_id);
    }

    // Add bannerId at the end for WHERE clause
    updateValues.push(bannerId);

    await req.pool.query(`
      UPDATE banners 
      SET ${updateFields.join(', ')}
      WHERE id = ?`,
      updateValues
    );

    res.redirect('/admin/banners?success=Banner updated successfully');
  } catch (err) {
    console.error('Error updating banner:', err);
    res.redirect('/admin/banners?error=Failed to update banner');
  }
});

router.post('/admin/banners/create', isAuthenticated, isAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, target_url, merchant_id, is_active, admin_notes, display_order } = req.body;
    
    if (!req.file) {
      return res.redirect('/admin/banners?error=Banner image is required');
    }

    const image_url = '/uploads/banners/' + req.file.filename;

    await req.pool.query(`
      INSERT INTO banners (
        merchant_id, title, image_url, target_url, 
        status, is_active, admin_notes, display_order
      ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`,
      [merchant_id, title, image_url, target_url, is_active === 'on', admin_notes || null, display_order || 0]
    );

    res.redirect('/admin/banners?success=Banner created successfully');
  } catch (err) {
    console.error('Error creating banner:', err);
    res.redirect('/admin/banners?error=Failed to create banner');
  }
});

// API routes for banner tracking
router.post('/api/banners/:id/view', async (req, res) => {
  try {
    const bannerId = req.params.id;
    const ip = req.ip || req.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    
    await req.pool.query(`
      INSERT INTO banner_views (
        banner_id, ip_address, user_agent, 
        country, city
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        bannerId, 
        ip,
        req.get('User-Agent'),
        geo ? geo.country : null,
        geo ? geo.city : null
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error recording banner view:', err);
    res.status(500).json({ success: false });
  }
});

router.post('/api/banners/:id/click', async (req, res) => {
  try {
    const bannerId = req.params.id;
    const ip = req.ip || req.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    
    await req.pool.query(`
      INSERT INTO banner_clicks (
        banner_id, ip_address, user_agent,
        referrer, country, city
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        bannerId,
        ip,
        req.get('User-Agent'),
        req.get('Referrer'),
        geo ? geo.country : null,
        geo ? geo.city : null
      ]
    );

    // Get banner target URL
    const [banners] = await req.pool.query(
      'SELECT target_url FROM banners WHERE id = ?',
      [bannerId]
    );

    if (banners.length > 0) {
      res.json({ success: true, url: banners[0].target_url });
    } else {
      res.status(404).json({ success: false, error: 'Banner not found' });
    }
  } catch (err) {
    console.error('Error recording banner click:', err);
    res.status(500).json({ success: false });
  }
});

// API endpoint for merchant search (used by admin)
router.get('/api/merchants/search', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const searchTerm = req.query.term;
    
    const [merchants] = await req.pool.query(`
      SELECT id, username, business_name 
      FROM users 
      WHERE role = 'merchant' 
        AND (username LIKE ? OR business_name LIKE ?)
      LIMIT 10`,
      [`%${searchTerm}%`, `%${searchTerm}%`]
    );

    res.json(merchants);
  } catch (err) {
    console.error('Error searching merchants:', err);
    res.status(500).json({ error: 'Failed to search merchants' });
  }
});

module.exports = router;
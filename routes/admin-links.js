// Admin Links Management Routes
router.get('/admin/links', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const selectedMerchant = req.query.merchant || '';
    const selectedType = req.query.type || '';
    const selectedStatus = req.query.status || '';
    const searchQuery = req.query.search || '';

    // Get all merchants for the filter dropdown
    const [merchants] = await pool.query(
      'SELECT id, username FROM users WHERE role = "merchant" ORDER BY username'
    );

    // Build the base query
    let baseQuery = `
      FROM links l
      JOIN users u ON l.merchant_id = u.id
      LEFT JOIN products p ON l.type = 'product' AND l.product_id = p.id
      WHERE 1=1
    `;

    const queryParams = [];

    // Add search conditions if search query exists
    if (searchQuery) {
      baseQuery += ` AND (
        l.title LIKE ? OR 
        l.url LIKE ? OR 
        l.description LIKE ? OR
        u.username LIKE ? OR
        CASE WHEN l.type = 'product' THEN p.name ELSE l.url END LIKE ?
      )`;
      const searchTerm = `%${searchQuery}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Add other filters
    if (selectedMerchant) {
      baseQuery += ` AND l.merchant_id = ?`;
      queryParams.push(selectedMerchant);
    }

    if (selectedType) {
      baseQuery += ` AND l.type = ?`;
      queryParams.push(selectedType);
    }

    if (selectedStatus !== '') {
      baseQuery += ` AND l.is_active = ?`;
      queryParams.push(selectedStatus);
    }

    // Count total results for pagination
    const [countResults] = await pool.query(
      `SELECT COUNT(*) as total ${baseQuery}`,
      queryParams
    );

    // Get the actual results with pagination
    const query = `
      SELECT l.*, 
             u.username as merchant_name,
             CASE WHEN l.type = 'product' THEN p.name ELSE NULL END as product_name
      ${baseQuery}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // Add pagination parameters
    const finalQueryParams = [...queryParams, limit, offset];
    const [links] = await pool.query(query, finalQueryParams);

    // Add formatted dates and process link data
    links.forEach(link => {
      link.created_at_formatted = new Date(link.created_at).toLocaleDateString();
      link.updated_at_formatted = new Date(link.updated_at).toLocaleDateString();
      
      // Format numbers
      link.clicks_formatted = link.clicks_count?.toLocaleString() || '0';
      link.earnings_formatted = link.earnings ? `$${link.earnings.toFixed(2)}` : '$0.00';
      
      // Truncate long URLs
      if (link.url && link.url.length > 50) {
        link.url_truncated = link.url.substring(0, 47) + '...';
      } else {
        link.url_truncated = link.url;
      }
    });

    res.render('admin/links', {
      links,
      merchants,
      pagination: {
        current: page,
        pages: Math.ceil(countResults[0].total / limit)
      },
      selectedMerchant,
      selectedType,
      selectedStatus,
      searchQuery
    });
  } catch (err) {
    console.error('Admin links error:', err);
    res.status(500).render('error', {
      message: 'Error loading links',
      error: { status: 500, stack: process.env.NODE_ENV === 'development' ? err.stack : '' }
    });
  }
});
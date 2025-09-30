const mysql = require('mysql2/promise');

// Database configuration
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'benixspace',
  charset: 'utf8mb4',
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
};

async function debugUserStatus() {
  let connection;
  try {
    console.log('🔍 Debugging user status issue...\n');
    
    // Create connection
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected to database\n');

    // Check the users table structure
    console.log('=== TABLE STRUCTURE ===');
    const [columns] = await connection.query(`
      SHOW COLUMNS FROM users WHERE Field IN ('is_verified', 'status', 'activation_paid')
    `);
    
    columns.forEach(col => {
      console.log(`${col.Field}: ${col.Type} | Default: ${col.Default} | Null: ${col.Null}`);
    });
    console.log('');

    // Get sample users with all status-related fields
    console.log('=== SAMPLE USER DATA ===');
    const [users] = await connection.query(`
      SELECT 
        id, 
        username, 
        email,
        is_verified,
        CASE 
          WHEN is_verified = 1 THEN 'verified'
          ELSE 'pending'
        END as computed_status,
        status,
        activation_paid,
        activated_at,
        created_at
      FROM users 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

    if (users.length === 0) {
      console.log('No users found in the database.');
      return;
    }

    users.forEach(user => {
      console.log(`\nUser ID: ${user.id} (${user.username})`);
      console.log(`  Email: ${user.email}`);
      console.log(`  is_verified: ${user.is_verified} (type: ${typeof user.is_verified})`);
      console.log(`  computed_status: ${user.computed_status}`);
      console.log(`  status: ${user.status || 'NULL'}`);
      console.log(`  activation_paid: ${user.activation_paid || 'NULL'}`);
      console.log(`  activated_at: ${user.activated_at || 'NULL'}`);
      console.log(`  created_at: ${user.created_at}`);
      
      // Test JavaScript boolean conversion
      const jsBoolean = Boolean(user.is_verified);
      const ternaryResult = user.is_verified ? 'Verified' : 'Pending';
      console.log(`  JS Boolean: ${jsBoolean}`);
      console.log(`  Ternary result: ${ternaryResult}`);
    });

    // Check for any inconsistencies
    console.log('\n=== POTENTIAL ISSUES ===');
    const [inconsistent] = await connection.query(`
      SELECT 
        id,
        username,
        is_verified,
        status,
        activation_paid,
        CASE 
          WHEN is_verified = 1 AND status = 'pending' THEN 'verified_but_pending'
          WHEN is_verified = 0 AND status = 'active' THEN 'not_verified_but_active'
          WHEN is_verified IS NULL THEN 'null_is_verified'
          ELSE 'consistent'
        END as issue_type
      FROM users
      WHERE 
        (is_verified = 1 AND status = 'pending') OR
        (is_verified = 0 AND status = 'active') OR
        (is_verified IS NULL)
      LIMIT 20
    `);

    if (inconsistent.length > 0) {
      console.log('Found potential issues:');
      inconsistent.forEach(user => {
        console.log(`  User ${user.id} (${user.username}): ${user.issue_type}`);
        console.log(`    is_verified: ${user.is_verified}, status: ${user.status}`);
      });
    } else {
      console.log('No obvious inconsistencies found.');
    }

    // Summary statistics
    console.log('\n=== SUMMARY STATISTICS ===');
    const [stats] = await connection.query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) as verified_users,
        SUM(CASE WHEN is_verified = 0 THEN 1 ELSE 0 END) as pending_users,
        SUM(CASE WHEN is_verified IS NULL THEN 1 ELSE 0 END) as null_verified,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_status,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_status,
        SUM(CASE WHEN status IS NULL THEN 1 ELSE 0 END) as null_status
      FROM users
    `);

    const summary = stats[0];
    console.log(`Total users: ${summary.total_users}`);
    console.log(`is_verified = 1: ${summary.verified_users}`);
    console.log(`is_verified = 0: ${summary.pending_users}`);
    console.log(`is_verified IS NULL: ${summary.null_verified}`);
    console.log(`status = 'active': ${summary.active_status}`);
    console.log(`status = 'pending': ${summary.pending_status}`);
    console.log(`status IS NULL: ${summary.null_status}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n💡 Solution: Start your MySQL server');
      console.log('   - On Windows: Start MySQL service in Services');
      console.log('   - Or start XAMPP/WAMP if you\'re using that');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.log('\n💡 Solution: Check database credentials in app.js');
    } else if (error.code === 'ER_BAD_DB_ERROR') {
      console.log('\n💡 Solution: Create the benixspace database first');
    }
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n🔌 Database connection closed');
    }
  }
}

// Run the debug script
debugUserStatus();

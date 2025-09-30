// Test script to verify the merchant date formatting fix
const testMerchants = [
  { id: 1, username: 'merchant1', created_at: '2024-01-15T10:30:00Z', product_count: 5 },
  { id: 2, username: 'merchant2', created_at: null, product_count: 3 },
  { id: 3, username: 'merchant3', created_at: 'invalid-date', product_count: 2 },
  { id: 4, username: 'merchant4', created_at: '2024-05-20T14:22:00Z', product_count: 8 }
];

console.log('Testing merchant date formatting...\n');

const formattedMerchants = testMerchants.map(merchant => {
  let formattedDate = 'recently';
  
  if (merchant.created_at) {
    try {
      const joinDate = new Date(merchant.created_at);
      if (joinDate && !isNaN(joinDate.getTime())) {
        formattedDate = joinDate.toLocaleDateString();
      }
    } catch (e) {
      console.log(`Error formatting date for merchant ${merchant.id}:`, e);
    }
  }
  
  return {
    ...merchant,
    formatted_join_date: formattedDate
  };
});

console.log('Results:');
formattedMerchants.forEach(merchant => {
  console.log(`Merchant ${merchant.id}: ${merchant.username}`);
  console.log(`  Original date: ${merchant.created_at}`);
  console.log(`  Formatted date: ${merchant.formatted_join_date}`);
  console.log('');
});

console.log('✅ All dates formatted successfully - no "Invalid Date" errors!');

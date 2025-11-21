// Backfill script to populate total_line_items_price for Nov 1st orders
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

async function main() {
  console.log('Fetching Nov 1st orders from database...');
  
  // Get all Nov 1st orders
  const orders = await sql`
    SELECT id, order_number
    FROM orders
    WHERE created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' >= '2025-11-01 00:00:00'
      AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' < '2025-11-02 00:00:00'
    ORDER BY order_number
  `;
  
  console.log(`Found ${orders.length} orders to backfill\n`);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const order of orders) {
    try {
      // Fetch full order data from Shopify
      const url = `https://${shopDomain}/admin/api/2024-01/orders/${order.id}.json`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        console.error(`❌ Error fetching ${order.order_number}: ${response.status}`);
        errorCount++;
        continue;
      }
      
      const data = await response.json();
      const shopifyOrder = data.order;
      const totalLineItemsPrice = shopifyOrder.total_line_items_price || '0';
      
      // Update database
      await sql`
        UPDATE orders
        SET total_line_items_price = ${totalLineItemsPrice}
        WHERE id = ${order.id}
      `;
      
      console.log(`✓ ${order.order_number}: Gross Sales = $${totalLineItemsPrice}`);
      successCount++;
      
      // Rate limit: Wait 200ms between requests (5 req/sec)
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error(`❌ Error processing ${order.order_number}:`, error.message);
      errorCount++;
    }
  }
  
  console.log(`\n✅ Backfill complete: ${successCount} success, ${errorCount} errors`);
  
  // Verify aggregates
  console.log('\nVerifying aggregates...');
  const aggregates = await sql`
    SELECT 
      SUM(CAST(total_line_items_price AS DECIMAL)) as gross_sales,
      SUM(CAST(current_total_discounts AS DECIMAL)) as discounts,
      SUM(CAST(current_subtotal_price AS DECIMAL)) as net_sales
    FROM orders
    WHERE created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' >= '2025-11-01 00:00:00'
      AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' < '2025-11-02 00:00:00'
  `;
  
  const result = aggregates[0];
  console.log('Nov 1st Aggregates:');
  console.log(`  Gross Sales: $${parseFloat(result.gross_sales).toFixed(2)}`);
  console.log(`  Discounts: $${parseFloat(result.discounts).toFixed(2)}`);
  console.log(`  Net Sales (calculated): $${(parseFloat(result.gross_sales) - parseFloat(result.discounts)).toFixed(2)}`);
  console.log(`  Net Sales (current_subtotal_price): $${parseFloat(result.net_sales).toFixed(2)}`);
  console.log('\nShopify Analytics Expected:');
  console.log('  Gross Sales: $6,568.47');
  console.log('  Discounts: $600.93');
  console.log('  Net Sales: $5,967.54');
}

main().catch(console.error);

// Quick script to fetch raw Shopify order data for Nov 1st, 2025
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

async function main() {
  try {
    // Get sample orders from Nov 1st
    const orders = await sql`
      SELECT id, order_number, 
        current_total_price, current_subtotal_price, current_total_tax, 
        shipping_total, current_total_discounts
      FROM orders
      WHERE created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' >= '2025-11-01 00:00:00'
        AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago' < '2025-11-02 00:00:00'
      LIMIT 5
    `;

    console.log(`Found ${orders.length} sample orders for Nov 1st, 2025\n`);

    for (const order of orders) {
      console.log(`\n========== Order ${order.order_number} ==========`);
      console.log('Database Fields:');
      console.log(`  currentTotalPrice: ${order.current_total_price}`);
      console.log(`  currentSubtotalPrice: ${order.current_subtotal_price}`);
      console.log(`  currentTotalTax: ${order.current_total_tax}`);
      console.log(`  shippingTotal: ${order.shipping_total}`);
      console.log(`  currentTotalDiscounts: ${order.current_total_discounts}`);

      // Fetch raw Shopify data
      const url = `https://${shopDomain}/admin/api/2024-01/orders/${order.id}.json`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`Failed to fetch order ${order.id}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const shopifyOrder = data.order;

      console.log('\nShopify API Fields:');
      console.log(`  total_line_items_price: ${shopifyOrder.total_line_items_price}`);
      console.log(`  subtotal_price: ${shopifyOrder.subtotal_price}`);
      console.log(`  current_subtotal_price: ${shopifyOrder.current_subtotal_price}`);
      console.log(`  total_discounts: ${shopifyOrder.total_discounts}`);
      console.log(`  current_total_discounts: ${shopifyOrder.current_total_discounts}`);
      console.log(`  total_price: ${shopifyOrder.total_price}`);
      console.log(`  current_total_price: ${shopifyOrder.current_total_price}`);
      console.log(`  total_tax: ${shopifyOrder.total_tax}`);
      console.log(`  current_total_tax: ${shopifyOrder.current_total_tax}`);
      console.log(`\n  Calculated Gross Sales: ${parseFloat(shopifyOrder.total_line_items_price || '0').toFixed(2)}`);
      console.log(`  Calculated Net Sales: ${(parseFloat(shopifyOrder.total_line_items_price || '0') - parseFloat(shopifyOrder.current_total_discounts || '0')).toFixed(2)}`);
      
      console.log('\nShopify *_set Fields:');
      console.log(`  total_shipping_price_set:`, JSON.stringify(shopifyOrder.total_shipping_price_set, null, 2));
      console.log(`  total_tax_set:`, JSON.stringify(shopifyOrder.total_tax_set, null, 2));
      console.log(`  current_total_tax_set:`, JSON.stringify(shopifyOrder.current_total_tax_set, null, 2));
      console.log(`  total_discounts_set:`, JSON.stringify(shopifyOrder.total_discounts_set, null, 2));
      console.log(`  current_total_discounts_set:`, JSON.stringify(shopifyOrder.current_total_discounts_set, null, 2));
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

main();

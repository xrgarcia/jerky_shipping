/**
 * Backfill script for populating requiresShipping field in order_items table
 * Extracts requires_shipping from the original Shopify line_items JSONB in orders table
 */

import { db } from '../db';
import { orders, orderItems } from '@shared/schema';
import { sql, eq } from 'drizzle-orm';

async function backfillRequiresShipping() {
  console.log('========== REQUIRES SHIPPING BACKFILL STARTED ==========');
  console.log('Fetching all orders with line items...');

  // Fetch all orders that have lineItems
  const allOrders = await db
    .select()
    .from(orders)
    .where(sql`${orders.lineItems} IS NOT NULL`);

  console.log(`Found ${allOrders.length} orders with line items`);

  let updatedCount = 0;
  let skippedCount = 0;
  let batchCount = 0;
  const BATCH_SIZE = 100;

  const updatePromises: Promise<any>[] = [];

  for (const order of allOrders) {
    const lineItems = order.lineItems as any[];

    if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
      skippedCount++;
      continue;
    }

    // Fetch all order_items for this order
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    // Match order_items to line items in JSONB by shopifyLineItemId
    for (const item of items) {
      const matchingLineItem = lineItems.find(
        (li: any) => li.id?.toString() === item.shopifyLineItemId
      );

      if (!matchingLineItem) {
        console.log(`⚠️  No matching line item found for order item ${item.id} (shopifyLineItemId: ${item.shopifyLineItemId})`);
        skippedCount++;
        continue;
      }

      // Extract requires_shipping field
      const requiresShipping = matchingLineItem.requires_shipping !== undefined 
        ? matchingLineItem.requires_shipping 
        : null;

      // Only update if we have data and it's different from current value
      if (requiresShipping !== null && requiresShipping !== item.requiresShipping) {
        updatePromises.push(
          db.update(orderItems)
            .set({ requiresShipping })
            .where(eq(orderItems.id, item.id))
            .then(() => {
              updatedCount++;
            })
        );

        // Execute batch when size is reached
        if (updatePromises.length >= BATCH_SIZE) {
          await Promise.all(updatePromises);
          updatePromises.length = 0; // Clear array
          batchCount++;
          console.log(`✓ Completed batch ${batchCount} (${updatedCount} order items updated so far)`);
        }
      } else {
        skippedCount++;
      }
    }
  }

  // Execute remaining updates
  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
    batchCount++;
    console.log(`✓ Completed final batch ${batchCount}`);
  }

  console.log('\n========== BACKFILL SUMMARY ==========');
  console.log(`Total orders processed: ${allOrders.length}`);
  console.log(`Order items updated: ${updatedCount}`);
  console.log(`Order items skipped: ${skippedCount}`);
  console.log(`Batches executed: ${batchCount}`);
  console.log('========================================\n');
}

// Run the backfill
backfillRequiresShipping()
  .then(() => {
    console.log('✅ Backfill completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  });

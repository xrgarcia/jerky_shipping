/**
 * Backfill script to populate order_date column from shipmentData JSONB
 * Extracts ShipStation createDate into dedicated order_date column
 */

import { db } from '../db';
import { shipments } from '@shared/schema';
import { sql } from 'drizzle-orm';

/**
 * Extract order_date from shipmentData JSONB
 * Returns the ShipStation shipment creation timestamp
 */
function extractOrderDate(shipmentData: any): Date | null {
  const dateStr = shipmentData?.create_date || shipmentData?.createDate || shipmentData?.created_at || shipmentData?.createdAt;
  
  if (!dateStr) {
    return null;
  }
  
  try {
    const date = new Date(dateStr);
    // Validate that the date is valid
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  } catch (e) {
    return null;
  }
}

async function backfillOrderDate() {
  console.log('========== ORDER_DATE BACKFILL STARTED ==========');
  console.log('Fetching all shipments with shipmentData...');

  // Fetch all shipments that have shipmentData
  const allShipments = await db
    .select()
    .from(shipments)
    .where(sql`${shipments.shipmentData} IS NOT NULL`);

  console.log(`Found ${allShipments.length} shipments with shipmentData`);

  let updatedCount = 0;
  let skippedCount = 0;
  let batchCount = 0;
  const BATCH_SIZE = 100;

  // Process in batches
  for (let i = 0; i < allShipments.length; i += BATCH_SIZE) {
    const batch = allShipments.slice(i, i + BATCH_SIZE);
    batchCount++;
    
    console.log(`Processing batch ${batchCount} (${batch.length} shipments)...`);

    for (const shipment of batch) {
      try {
        const orderDate = extractOrderDate(shipment.shipmentData);
        
        // Only update if we extracted an order date
        if (orderDate) {
          await db
            .update(shipments)
            .set({ orderDate })
            .where(sql`${shipments.id} = ${shipment.id}`);
          
          updatedCount++;
        } else {
          skippedCount++;
        }
      } catch (error: any) {
        console.error(`Error processing shipment ${shipment.id}:`, error.message);
      }
    }

    console.log(`Batch ${batchCount} complete. Updated: ${updatedCount}, Skipped: ${skippedCount}`);
  }

  console.log('========== BACKFILL COMPLETE ==========');
  console.log(`Total shipments processed: ${allShipments.length}`);
  console.log(`Updated with order_date: ${updatedCount}`);
  console.log(`Skipped (no order_date): ${skippedCount}`);
  console.log('==========================================');
}

// Run the backfill
backfillOrderDate()
  .then(() => {
    console.log('Backfill completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });

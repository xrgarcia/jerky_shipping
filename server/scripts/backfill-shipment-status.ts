/**
 * Backfill script to populate shipmentStatus column from shipmentData JSONB
 * Extracts ShipStation shipment_status into dedicated shipmentStatus column
 */

import { db } from '../db';
import { shipments } from '@shared/schema';
import { sql } from 'drizzle-orm';
import { extractShipmentStatus } from '../shipment-sync-worker';

async function backfillShipmentStatus() {
  console.log('========== SHIPMENT_STATUS BACKFILL STARTED ==========');
  console.log('Fetching all shipments with shipmentData...');

  // Fetch all shipments that have shipmentData and NULL shipmentStatus
  const allShipments = await db
    .select()
    .from(shipments)
    .where(sql`${shipments.shipmentData} IS NOT NULL AND ${shipments.shipmentStatus} IS NULL`);

  console.log(`Found ${allShipments.length} shipments needing shipmentStatus backfill`);

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
        const shipmentStatus = extractShipmentStatus(shipment.shipmentData);
        
        // Only update if we extracted a shipment status
        if (shipmentStatus) {
          await db
            .update(shipments)
            .set({ shipmentStatus })
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
  console.log(`Updated with shipmentStatus: ${updatedCount}`);
  console.log(`Skipped (no shipmentStatus): ${skippedCount}`);
  console.log('==========================================');
}

// Run the backfill
backfillShipmentStatus()
  .then(() => {
    console.log('Backfill completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });

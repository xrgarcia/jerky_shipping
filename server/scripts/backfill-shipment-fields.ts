/**
 * Backfill script for populating new shipment fields from shipmentData JSONB
 * Populates: is_return, is_gift, notes_for_gift, notes_from_buyer, total_weight,
 * and all 26 advanced_options fields
 */

import { db } from '../db';
import { shipments } from '@shared/schema';
import { sql } from 'drizzle-orm';
import { 
  extractReturnGiftFields,
  extractTotalWeight,
  extractAdvancedOptions,
} from '../utils/shipment-extraction';

async function backfillShipmentFields() {
  console.log('========== SHIPMENT FIELDS BACKFILL STARTED ==========');
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

  const updatePromises: Promise<any>[] = [];

  for (const shipment of allShipments) {
    const shipmentData = shipment.shipmentData as any;

    if (!shipmentData) {
      skippedCount++;
      continue;
    }

    // Extract all new fields
    const returnGiftFields = extractReturnGiftFields(shipmentData);
    const totalWeight = extractTotalWeight(shipmentData);
    const advancedOptions = extractAdvancedOptions(shipmentData);

    // Check if at least one field has data to warrant an update
    const hasData = 
      returnGiftFields.isReturn !== null ||
      returnGiftFields.isGift !== null ||
      returnGiftFields.notesForGift !== null ||
      returnGiftFields.notesFromBuyer !== null ||
      totalWeight !== null ||
      Object.values(advancedOptions).some(v => v !== null);

    if (!hasData) {
      skippedCount++;
      continue;
    }

    // Build update payload
    const updatePayload = {
      ...returnGiftFields,
      totalWeight,
      ...advancedOptions,
    };

    // Add to batch
    updatePromises.push(
      db.update(shipments)
        .set(updatePayload)
        .where(sql`${shipments.id} = ${shipment.id}`)
        .then(() => {
          updatedCount++;
        })
    );

    // Execute batch when size is reached
    if (updatePromises.length >= BATCH_SIZE) {
      await Promise.all(updatePromises);
      updatePromises.length = 0; // Clear array
      batchCount++;
      console.log(`✓ Completed batch ${batchCount} (${updatedCount} shipments updated so far)`);
    }
  }

  // Execute remaining updates
  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
    batchCount++;
    console.log(`✓ Completed final batch ${batchCount}`);
  }

  console.log('\n========== BACKFILL SUMMARY ==========');
  console.log(`Total shipments processed: ${allShipments.length}`);
  console.log(`Shipments updated: ${updatedCount}`);
  console.log(`Shipments skipped (no data): ${skippedCount}`);
  console.log(`Batches executed: ${batchCount}`);
  console.log('========================================\n');
}

// Run the backfill
backfillShipmentFields()
  .then(() => {
    console.log('✅ Backfill completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  });

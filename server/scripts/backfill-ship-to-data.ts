/**
 * Backfill script to populate ship_to columns from shipmentData JSONB
 * Extracts ShipStation ship_to customer data into dedicated columns
 */

import { db } from '../db';
import { shipments } from '@shared/schema';
import { sql } from 'drizzle-orm';

/**
 * Extract ship_to fields from shipmentData JSONB
 */
function extractShipToFields(shipmentData: any): Record<string, any> {
  if (!shipmentData?.ship_to) {
    return {};
  }

  const shipTo = shipmentData.ship_to;
  
  return {
    shipToName: shipTo.name || null,
    shipToPhone: shipTo.phone || null,
    shipToEmail: shipTo.email || null,
    shipToCompany: shipTo.company_name || null,
    shipToAddressLine1: shipTo.address_line1 || null,
    shipToAddressLine2: shipTo.address_line2 || null,
    shipToAddressLine3: shipTo.address_line3 || null,
    shipToCity: shipTo.city_locality || null,
    shipToState: shipTo.state_province || null,
    shipToPostalCode: shipTo.postal_code || null,
    shipToCountry: shipTo.country_code || null,
    shipToIsResidential: shipTo.address_residential_indicator || null,
  };
}

async function backfillShipToData() {
  console.log('========== SHIP_TO DATA BACKFILL STARTED ==========');
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
        const shipToFields = extractShipToFields(shipment.shipmentData);
        
        // Only update if we actually extracted some data
        if (Object.keys(shipToFields).length > 0 && shipToFields.shipToName) {
          await db
            .update(shipments)
            .set(shipToFields)
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
  console.log(`Updated with ship_to data: ${updatedCount}`);
  console.log(`Skipped (no ship_to data): ${skippedCount}`);
  console.log('==========================================');
}

// Run the backfill
backfillShipToData()
  .then(() => {
    console.log('Backfill completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });

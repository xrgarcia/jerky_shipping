import { db } from '../db';
import { shipments } from '../../shared/schema';
import { sql } from 'drizzle-orm';

/**
 * Deduplicates shipments table by shipment_id
 * Keeps the most recent entry (highest created_at) for each shipment_id
 * Deletes all older duplicates
 */
async function deduplicateShipments() {
  console.log('Starting shipment deduplication...\n');

  // Find all duplicate shipment_ids and count them
  const duplicatesQuery = sql`
    SELECT shipment_id, COUNT(*) as count
    FROM shipments
    WHERE shipment_id IS NOT NULL
    GROUP BY shipment_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `;

  const duplicates = await db.execute(duplicatesQuery);
  console.log(`Found ${duplicates.rows.length} shipment_ids with duplicates\n`);

  if (duplicates.rows.length === 0) {
    console.log('No duplicates found. Exiting.');
    return;
  }

  // Show top duplicates
  console.log('Top 10 most duplicated shipment_ids:');
  for (let i = 0; i < Math.min(10, duplicates.rows.length); i++) {
    const row = duplicates.rows[i];
    console.log(`  ${row.shipment_id}: ${row.count} entries`);
  }
  console.log();

  // For each duplicate shipment_id, keep only the most recent entry
  let totalDeleted = 0;
  
  for (const row of duplicates.rows) {
    const shipmentId = row.shipment_id;
    
    // Find IDs to delete (all except the most recent)
    const idsToDeleteQuery = sql`
      SELECT id
      FROM shipments
      WHERE shipment_id = ${shipmentId}
      AND id NOT IN (
        SELECT id
        FROM shipments
        WHERE shipment_id = ${shipmentId}
        ORDER BY created_at DESC
        LIMIT 1
      )
    `;
    
    const idsToDelete = await db.execute(idsToDeleteQuery);
    
    if (idsToDelete.rows.length === 0) {
      continue;
    }
    
    const deleteIds = idsToDelete.rows.map(r => r.id);
    
    // Delete associated shipment_items first
    for (const id of deleteIds) {
      await db.execute(sql`
        DELETE FROM shipment_items WHERE shipment_id = ${id}
      `);
    }
    
    // Delete associated shipment_tags
    for (const id of deleteIds) {
      await db.execute(sql`
        DELETE FROM shipment_tags WHERE shipment_id = ${id}
      `);
    }
    
    // Now delete the duplicate shipments
    let deleted = 0;
    for (const id of deleteIds) {
      const result = await db.execute(sql`
        DELETE FROM shipments WHERE id = ${id}
      `);
      deleted += result.rowCount || 0;
    }
    
    totalDeleted += deleted;
    
    if (deleted > 0) {
      console.log(`Deleted ${deleted} duplicate(s) for shipment_id: ${shipmentId}`);
    }
  }

  console.log(`\nTotal duplicates deleted: ${totalDeleted}`);
  console.log('Deduplication complete!');
}

// Run the deduplication
deduplicateShipments()
  .then(() => {
    console.log('\nSuccess!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nError during deduplication:', error);
    process.exit(1);
  });

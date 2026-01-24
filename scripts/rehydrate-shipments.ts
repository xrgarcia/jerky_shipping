/**
 * One-Time Shipment Rehydration Script
 * 
 * Manually triggers QC item hydration for specific shipments, bypassing
 * the normal worker rules (on_hold + MOVE OVER tag + no session).
 * 
 * Uses the same hydrateShipment service to ensure consistent behavior.
 * 
 * Usage:
 *   npx tsx scripts/rehydrate-shipments.ts <shipmentId1> [shipmentId2] [...]
 *   npx tsx scripts/rehydrate-shipments.ts --order JK3825356972
 *   npx tsx scripts/rehydrate-shipments.ts --all-pending  (rehydrate all with 0 QC items)
 * 
 * Examples:
 *   npx tsx scripts/rehydrate-shipments.ts 4c8a26fd-8871-4853-9298-9ff58b4d8250
 *   npx tsx scripts/rehydrate-shipments.ts --order JK3825356972 JK3825356682
 */

import { db } from '../server/db';
import { shipments, shipmentQcItems } from '../shared/schema';
import { eq, sql, notExists } from 'drizzle-orm';
import { hydrateShipment } from '../server/services/qc-item-hydrator';

async function clearQcItemsForShipment(shipmentId: string): Promise<number> {
  const result = await db
    .delete(shipmentQcItems)
    .where(eq(shipmentQcItems.shipmentId, shipmentId))
    .returning({ id: shipmentQcItems.id });
  return result.length;
}

async function getShipmentByOrderNumber(orderNumber: string): Promise<{ id: string; orderNumber: string } | null> {
  const result = await db
    .select({ id: shipments.id, orderNumber: shipments.orderNumber })
    .from(shipments)
    .where(eq(shipments.orderNumber, orderNumber))
    .limit(1);
  
  return result[0] ? { id: result[0].id, orderNumber: result[0].orderNumber || orderNumber } : null;
}

async function getShipmentById(id: string): Promise<{ id: string; orderNumber: string } | null> {
  const result = await db
    .select({ id: shipments.id, orderNumber: shipments.orderNumber })
    .from(shipments)
    .where(eq(shipments.id, id))
    .limit(1);
  
  return result[0] ? { id: result[0].id, orderNumber: result[0].orderNumber || 'unknown' } : null;
}

async function getAllPendingShipments(limit: number = 100): Promise<{ id: string; orderNumber: string }[]> {
  const results = await db
    .select({ id: shipments.id, orderNumber: shipments.orderNumber })
    .from(shipments)
    .where(
      notExists(
        db.select({ one: sql`1` })
          .from(shipmentQcItems)
          .where(eq(shipmentQcItems.shipmentId, shipments.id))
      )
    )
    .limit(limit);
  
  return results.map(r => ({ id: r.id, orderNumber: r.orderNumber || 'unknown' }));
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Shipment Rehydration Script
============================
Manually triggers QC item hydration for specific shipments.

Usage:
  npx tsx scripts/rehydrate-shipments.ts <shipmentId1> [shipmentId2] [...]
  npx tsx scripts/rehydrate-shipments.ts --order <orderNumber1> [orderNumber2] [...]
  npx tsx scripts/rehydrate-shipments.ts --all-pending [--limit N]
  npx tsx scripts/rehydrate-shipments.ts --clear-first <shipmentId1> [...]

Options:
  --order         Look up shipments by order number instead of UUID
  --all-pending   Find and rehydrate all shipments with 0 QC items
  --limit N       Limit for --all-pending (default: 100)
  --clear-first   Clear existing QC items before rehydrating

Examples:
  npx tsx scripts/rehydrate-shipments.ts 4c8a26fd-8871-4853-9298-9ff58b4d8250
  npx tsx scripts/rehydrate-shipments.ts --order JK3825356972 JK3825356682
  npx tsx scripts/rehydrate-shipments.ts --clear-first --order JK3825356972
    `);
    process.exit(0);
  }

  let shipmentsToProcess: { id: string; orderNumber: string }[] = [];
  let clearFirst = false;
  
  if (args.includes('--clear-first')) {
    clearFirst = true;
    args.splice(args.indexOf('--clear-first'), 1);
  }
  
  if (args[0] === '--all-pending') {
    const limitIndex = args.indexOf('--limit');
    const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : 100;
    
    console.log(`Finding shipments with 0 QC items (limit: ${limit})...`);
    shipmentsToProcess = await getAllPendingShipments(limit);
    console.log(`Found ${shipmentsToProcess.length} shipments needing hydration\n`);
  } else if (args[0] === '--order') {
    const orderNumbers = args.slice(1).filter(a => !a.startsWith('--'));
    console.log(`Looking up ${orderNumbers.length} order number(s)...`);
    
    for (const orderNumber of orderNumbers) {
      const shipment = await getShipmentByOrderNumber(orderNumber);
      if (shipment) {
        shipmentsToProcess.push(shipment);
      } else {
        console.log(`  ⚠ Order ${orderNumber} not found`);
      }
    }
    console.log(`Found ${shipmentsToProcess.length} matching shipments\n`);
  } else {
    const shipmentIds = args.filter(a => !a.startsWith('--'));
    console.log(`Looking up ${shipmentIds.length} shipment ID(s)...`);
    
    for (const id of shipmentIds) {
      const shipment = await getShipmentById(id);
      if (shipment) {
        shipmentsToProcess.push(shipment);
      } else {
        console.log(`  ⚠ Shipment ${id} not found`);
      }
    }
    console.log(`Found ${shipmentsToProcess.length} matching shipments\n`);
  }

  if (shipmentsToProcess.length === 0) {
    console.log('No shipments to process. Exiting.');
    process.exit(0);
  }

  console.log('Starting hydration...\n');
  console.log('='.repeat(60));

  let successCount = 0;
  let errorCount = 0;
  const results: { orderNumber: string; status: string; details: string }[] = [];

  for (const shipment of shipmentsToProcess) {
    console.log(`\nProcessing: ${shipment.orderNumber} (${shipment.id})`);
    
    try {
      if (clearFirst) {
        console.log('  Clearing existing QC items...');
        await clearQcItemsForShipment(shipment.id);
      }
      
      const result = await hydrateShipment(shipment.id, shipment.orderNumber);
      
      if (result.error) {
        console.log(`  ✗ Error: ${result.error}`);
        results.push({ orderNumber: shipment.orderNumber, status: 'ERROR', details: result.error });
        errorCount++;
      } else {
        const fpStatus = result.fingerprintStatus === 'complete' 
          ? `fingerprint ${result.fingerprintIsNew ? 'NEW' : 'matched'}`
          : 'pending categorization';
        console.log(`  ✓ Created ${result.itemsCreated} QC items, ${fpStatus}`);
        results.push({ 
          orderNumber: shipment.orderNumber, 
          status: 'OK', 
          details: `${result.itemsCreated} items, ${fpStatus}` 
        });
        successCount++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Exception: ${errMsg}`);
      results.push({ orderNumber: shipment.orderNumber, status: 'EXCEPTION', details: errMsg });
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\nSummary:');
  console.log(`  Total processed: ${shipmentsToProcess.length}`);
  console.log(`  Successful: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);
  
  console.log('\nResults:');
  results.forEach(r => {
    const icon = r.status === 'OK' ? '✓' : '✗';
    console.log(`  ${icon} ${r.orderNumber}: ${r.details}`);
  });

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

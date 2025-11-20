import { db } from '../db';
import { shipments } from '@shared/schema';
import { sql } from 'drizzle-orm';

async function verifyOrderDate() {
  console.log('Verifying order_date backfill...');
  
  // Get sample shipments with order_date
  const withOrderDate = await db
    .select({
      id: shipments.id,
      orderNumber: shipments.orderNumber,
      orderDate: shipments.orderDate,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .where(sql`${shipments.orderDate} IS NOT NULL`)
    .limit(5);
  
  console.log('\nSample shipments WITH order_date populated:');
  console.log(JSON.stringify(withOrderDate, null, 2));
  
  // Get counts
  const totalCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments);
  
  const withOrderDateCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(sql`${shipments.orderDate} IS NOT NULL`);
  
  console.log(`\nTotal shipments: ${totalCount[0].count}`);
  console.log(`Shipments with order_date: ${withOrderDateCount[0].count}`);
  console.log(`Percentage: ${((Number(withOrderDateCount[0].count) / Number(totalCount[0].count)) * 100).toFixed(1)}%`);
}

verifyOrderDate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Verification failed:', error);
    process.exit(1);
  });

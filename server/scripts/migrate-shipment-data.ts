import { db } from "../db";
import { shipments, shipmentItems, shipmentTags, orderItems } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

async function migrateShipmentData() {
  console.log("Starting shipment data migration...");

  // Load all order items into memory for fast lookups
  console.log("Loading order items for linkage...");
  const allOrderItems = await db.select().from(orderItems);
  const orderItemMap = new Map(
    allOrderItems.map((oi) => [oi.shopifyLineItemId, oi.id])
  );
  console.log(`Loaded ${allOrderItems.length} order items for linkage`);

  const allShipments = await db
    .select()
    .from(shipments)
    .where(sql`shipment_data IS NOT NULL`);

  console.log(`Found ${allShipments.length} shipments with data to migrate`);

  let itemsCreated = 0;
  let tagsCreated = 0;
  let itemsWithOrderLinks = 0;
  let errors = 0;

  // Prepare batch arrays
  const itemsToInsert: any[] = [];
  const tagsToInsert: any[] = [];

  for (const shipment of allShipments) {
    try {
      const data = shipment.shipmentData as any;

      // Collect items
      if (data?.items && Array.isArray(data.items)) {
        for (const item of data.items) {
          // Try to link to order_items using in-memory map
          let orderItemId = null;
          if (item.external_order_item_id) {
            orderItemId = orderItemMap.get(item.external_order_item_id) || null;
            if (orderItemId) itemsWithOrderLinks++;
          }

          itemsToInsert.push({
            shipmentId: shipment.id,
            orderItemId,
            sku: item.sku || null,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unit_price?.toString() || null,
            externalOrderItemId: item.external_order_item_id || null,
            imageUrl: item.image_url || null,
          });

          itemsCreated++;
        }
      }

      // Collect tags
      if (data?.tags && Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          tagsToInsert.push({
            shipmentId: shipment.id,
            name: tag.name,
            color: tag.color || null,
            tagId: tag.tag_id || null,
          });

          tagsCreated++;
        }
      }
    } catch (error) {
      console.error(`Error processing shipment ${shipment.id}:`, error);
      errors++;
    }
  }

  // Batch insert items (500 at a time)
  console.log(`\nInserting ${itemsToInsert.length} items in batches...`);
  const itemBatchSize = 500;
  for (let i = 0; i < itemsToInsert.length; i += itemBatchSize) {
    const batch = itemsToInsert.slice(i, i + itemBatchSize);
    await db.insert(shipmentItems).values(batch);
    console.log(`Inserted items ${i + 1} to ${Math.min(i + itemBatchSize, itemsToInsert.length)}`);
  }

  // Batch insert tags (500 at a time)
  console.log(`\nInserting ${tagsToInsert.length} tags in batches...`);
  const tagBatchSize = 500;
  for (let i = 0; i < tagsToInsert.length; i += tagBatchSize) {
    const batch = tagsToInsert.slice(i, i + tagBatchSize);
    await db.insert(shipmentTags).values(batch);
    console.log(`Inserted tags ${i + 1} to ${Math.min(i + tagBatchSize, tagsToInsert.length)}`);
  }

  console.log("\n=== Migration Complete ===");
  console.log(`Shipments processed: ${allShipments.length}`);
  console.log(`Items created: ${itemsCreated}`);
  console.log(`Items linked to order_items: ${itemsWithOrderLinks}`);
  console.log(`Tags created: ${tagsCreated}`);
  console.log(`Errors: ${errors}`);
}

migrateShipmentData()
  .then(() => {
    console.log("Migration finished successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });

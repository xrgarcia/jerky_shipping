import { storage } from "../storage";
import { ShipStationShipmentService } from "../services/shipstation-shipment-service";
import { log } from "../vite";

// Initialize the shipment service
const shipmentService = new ShipStationShipmentService(storage);

/**
 * Bootstrap existing shipments from ShipStation
 * This runs once on server startup to populate the database with shipments
 * that were created before webhook registration
 */
export async function bootstrapShipmentsFromShipStation(): Promise<void> {
  try {
    log("Checking for existing shipments to bootstrap from ShipStation...");
    
    const orders = await storage.getAllOrders();
    
    if (orders.length === 0) {
      log("No orders found - skipping shipment bootstrap");
      return;
    }

    let createdCount = 0;
    let errorCount = 0;

    // Process first 10 orders only to avoid hanging on large datasets
    const ordersToProcess = orders.slice(0, 10);
    log(`Processing ${ordersToProcess.length} orders for shipment bootstrap...`);

    for (const order of ordersToProcess) {
      try {
        // Add timeout for syncing
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        );
        
        const result = await Promise.race([
          shipmentService.syncShipmentsForOrder(order.orderNumber),
          timeoutPromise
        ]) as any;
        
        if (result.success && result.shipments.length > 0) {
          createdCount += result.shipments.length;
        }
      } catch (orderError: any) {
        errorCount++;
        console.log(`Skipped order ${order.orderNumber}: ${orderError.message}`);
      }
    }

    if (createdCount > 0) {
      log(`Bootstrapped ${createdCount} existing shipments from ShipStation`);
    } else {
      log("No new shipments to bootstrap");
    }
    
    if (errorCount > 0) {
      log(`Skipped ${errorCount} orders due to errors`);
    }
  } catch (error) {
    console.error("Error bootstrapping shipments:", error);
    // Don't throw - let server continue even if bootstrap fails
  }
}

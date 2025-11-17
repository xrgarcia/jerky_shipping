import { storage } from "../storage";
import { getShipmentsByOrderNumber } from "./shipstation-api";
import { log } from "../vite";

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
        // Add timeout for each API call
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        );
        
        const shipStationShipments = await Promise.race([
          getShipmentsByOrderNumber(order.orderNumber),
          timeoutPromise
        ]) as any[];
        
        for (const shipmentData of shipStationShipments) {
          const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
          
          if (!existingShipment) {
            const shipmentRecord = {
              orderId: order.id,
              shipmentId: shipmentData.shipment_id?.toString(),
              trackingNumber: shipmentData.trackingNumber,
              carrierCode: shipmentData.carrierCode,
              serviceCode: shipmentData.serviceCode,
              status: shipmentData.voided ? 'cancelled' : 'shipped',
              statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
              shipDate: shipmentData.ship_date ? new Date(shipmentData.ship_date) : null,
              shipmentData: shipmentData,
            };

            await storage.createShipment(shipmentRecord);
            createdCount++;
          }
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

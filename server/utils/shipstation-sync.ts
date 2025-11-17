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

    let syncedCount = 0;
    let createdCount = 0;

    for (const order of orders) {
      try {
        const shipStationShipments = await getShipmentsByOrderNumber(order.orderNumber);
        
        for (const shipmentData of shipStationShipments) {
          const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
          
          if (!existingShipment) {
            const shipmentRecord = {
              orderId: order.id,
              shipmentId: shipmentData.shipmentId?.toString(),
              trackingNumber: shipmentData.trackingNumber,
              carrierCode: shipmentData.carrierCode,
              serviceCode: shipmentData.serviceCode,
              status: shipmentData.voided ? 'cancelled' : 'shipped',
              statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
              shipDate: shipmentData.shipDate ? new Date(shipmentData.shipDate) : null,
              shipmentData: shipmentData,
            };

            await storage.createShipment(shipmentRecord);
            createdCount++;
            syncedCount++;
          }
        }
      } catch (orderError: any) {
        // Silently skip errors for individual orders during bootstrap
      }
    }

    if (createdCount > 0) {
      log(`Bootstrapped ${createdCount} existing shipments from ShipStation`);
    } else {
      log("All shipments already synced");
    }
  } catch (error) {
    console.error("Error bootstrapping shipments:", error);
    // Don't throw - let server continue even if bootstrap fails
  }
}

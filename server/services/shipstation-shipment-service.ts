/**
 * ShipStation Shipment Service
 * Centralizes all shipment sync and label creation logic
 */

import type { IStorage } from '../storage';
import type { InsertShipment, Order } from '@shared/schema';
import { getShipmentsByOrderNumber, createLabel as createShipStationLabel } from '../utils/shipstation-api';

export class ShipStationShipmentService {
  constructor(private storage: IStorage) {}

  /**
   * Sync shipments for an order from ShipStation to our database
   * This is the ONE method to use for importing/syncing shipments
   */
  async syncShipmentsForOrder(orderNumber: string): Promise<{ success: boolean; shipments: any[]; error?: string }> {
    try {
      console.log(`[ShipmentService] Syncing shipments for order ${orderNumber}`);
      
      // Fetch from ShipStation API
      const shipStationShipments = await getShipmentsByOrderNumber(orderNumber);
      
      if (shipStationShipments.length === 0) {
        console.log(`[ShipmentService] No shipments found in ShipStation for order ${orderNumber}`);
        return { success: true, shipments: [] };
      }

      console.log(`[ShipmentService] Found ${shipStationShipments.length} shipment(s) in ShipStation`);

      // Get our order record to link shipments
      const order = await this.storage.getOrderByOrderNumber(orderNumber);
      if (!order) {
        console.error(`[ShipmentService] Order ${orderNumber} not found in database`);
        return { success: false, shipments: [], error: 'Order not found in database' };
      }

      const syncedShipments = [];

      // Process each ShipStation shipment
      for (const shipStationData of shipStationShipments) {
        try {
          // Normalize ShipStation data to our schema
          const normalizedShipment = this.normalizeShipStationShipment(shipStationData, order.id);
          
          // Check if shipment already exists
          const existing = await this.storage.getShipmentsByOrderId(order.id);
          const existingShipment = existing.find(s => s.shipmentId === normalizedShipment.shipmentId);

          let savedShipment;
          if (existingShipment) {
            console.log(`[ShipmentService] Updating existing shipment ${normalizedShipment.shipmentId}`);
            savedShipment = await this.storage.updateShipment(existingShipment.id, normalizedShipment);
          } else {
            console.log(`[ShipmentService] Creating new shipment ${normalizedShipment.shipmentId}`);
            savedShipment = await this.storage.createShipment(normalizedShipment);
          }

          syncedShipments.push(savedShipment);
        } catch (error: any) {
          console.error(`[ShipmentService] Error processing shipment:`, error);
          // Continue with other shipments even if one fails
        }
      }

      console.log(`[ShipmentService] Successfully synced ${syncedShipments.length} shipment(s)`);
      return { success: true, shipments: syncedShipments };

    } catch (error: any) {
      console.error(`[ShipmentService] Error syncing shipments for order ${orderNumber}:`, error);
      return { success: false, shipments: [], error: error.message };
    }
  }

  /**
   * Normalize ShipStation V2 API response (snake_case) to our database schema
   * Handles field mapping and type conversions in ONE place
   */
  private normalizeShipStationShipment(shipStationData: any, orderId: string): InsertShipment {
    return {
      orderId,
      shipmentId: shipStationData.shipment_id?.toString() || null,
      trackingNumber: shipStationData.tracking_number || null,
      carrierCode: shipStationData.carrier_code || shipStationData.carrierCode || null,
      serviceCode: shipStationData.service_code || shipStationData.serviceCode || null,
      status: shipStationData.voided ? 'cancelled' : (shipStationData.shipment_status || 'pending'),
      statusDescription: shipStationData.shipment_status || null,
      // Convert ISO date strings to Date objects
      shipDate: shipStationData.ship_date ? new Date(shipStationData.ship_date) : null,
      estimatedDeliveryDate: null,
      actualDeliveryDate: null,
      labelUrl: null,
      // Store the raw ShipStation data for reference
      shipmentData: shipStationData,
    };
  }

  /**
   * Create a shipping label for an order
   * Ensures shipment exists, validates it has required data, then creates label
   */
  async createLabelForOrder(orderNumber: string): Promise<{
    success: boolean;
    labelUrl?: string;
    printJob?: any;
    error?: string;
  }> {
    try {
      console.log(`[ShipmentService] Creating label for order ${orderNumber}`);

      // Get the order
      const order = await this.storage.getOrderByOrderNumber(orderNumber);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Ensure shipments are synced
      let shipments = await this.storage.getShipmentsByOrderId(order.id);
      
      if (shipments.length === 0) {
        console.log(`[ShipmentService] No shipments in DB, syncing from ShipStation...`);
        const syncResult = await this.syncShipmentsForOrder(orderNumber);
        
        if (!syncResult.success || syncResult.shipments.length === 0) {
          return { 
            success: false, 
            error: syncResult.error || 'No shipment found for this order. Please create a shipment in ShipStation first.' 
          };
        }
        
        shipments = syncResult.shipments;
      }

      const shipment = shipments[0];

      // Validate shipment has ShipStation ID
      if (!shipment.shipmentId) {
        return { 
          success: false, 
          error: 'Shipment does not have a ShipStation shipment ID. Please check ShipStation.' 
        };
      }

      console.log(`[ShipmentService] Creating label for shipment ${shipment.shipmentId}`);

      // Validate shipment has the raw ShipStation data
      if (!shipment.shipmentData) {
        return { 
          success: false, 
          error: 'Shipment does not have ShipStation data. Please sync shipment first.' 
        };
      }

      // Call ShipStation API to create label with full shipment payload
      const labelData = await createShipStationLabel(shipment.shipmentData);

      // Extract label URL from response
      const labelUrl = labelData.label_download || labelData.pdf_url || labelData.href;

      if (!labelUrl) {
        return { success: false, error: 'No label URL returned from ShipStation' };
      }

      // Update shipment with label URL
      await this.storage.updateShipment(shipment.id, { labelUrl });

      // Create print job
      const printJob = await this.storage.createPrintJob({
        orderId: order.id,
        labelUrl,
        status: 'queued',
      });

      console.log(`[ShipmentService] Successfully created label and print job`);

      return {
        success: true,
        labelUrl,
        printJob,
      };

    } catch (error: any) {
      console.error(`[ShipmentService] Error creating label for order ${orderNumber}:`, error);
      return { 
        success: false, 
        error: error.message || 'Failed to create label' 
      };
    }
  }

  /**
   * Ensure a shipment exists for an order (used by bootstrap/webhooks)
   * Returns the shipment if it exists or was successfully synced
   */
  async ensureShipmentForOrder(orderNumber: string): Promise<any | null> {
    const order = await this.storage.getOrderByOrderNumber(orderNumber);
    if (!order) return null;

    const existing = await this.storage.getShipmentsByOrderId(order.id);
    if (existing.length > 0) {
      return existing[0];
    }

    const syncResult = await this.syncShipmentsForOrder(orderNumber);
    return syncResult.shipments[0] || null;
  }
}

/**
 * ShipStation Shipment Service
 * Centralizes all shipment sync and label creation logic
 */

import type { IStorage } from '../storage';
import type { InsertShipment, Order } from '@shared/schema';
import { getShipmentsByOrderNumber, getLabelsForShipment, createLabel as createShipStationLabel, type RateLimitInfo, extractPdfLabelUrl } from '../utils/shipstation-api';

export class ShipStationShipmentService {
  constructor(private storage: IStorage) {}

  /**
   * Sync shipments for an order from ShipStation to our database
   * This is the ONE method to use for importing/syncing shipments
   * Returns shipments and rate limit info for smart backfill throttling
   */
  async syncShipmentsForOrder(orderNumber: string): Promise<{ 
    success: boolean; 
    shipments: any[]; 
    error?: string;
    rateLimit?: RateLimitInfo;
  }> {
    try {
      console.log(`[ShipmentService] Syncing shipments for order ${orderNumber}`);
      
      // Fetch from ShipStation API with rate limit info
      const { data: shipStationShipments, rateLimit } = await getShipmentsByOrderNumber(orderNumber);
      
      if (shipStationShipments.length === 0) {
        console.log(`[ShipmentService] No shipments found in ShipStation for order ${orderNumber}`);
        return { success: true, shipments: [], rateLimit };
      }

      console.log(`[ShipmentService] Found ${shipStationShipments.length} shipment(s) in ShipStation`);

      // Get our order record to link shipments
      const order = await this.storage.getOrderByOrderNumber(orderNumber);
      if (!order) {
        console.error(`[ShipmentService] Order ${orderNumber} not found in database`);
        return { success: false, shipments: [], error: 'Order not found in database', rateLimit };
      }

      const syncedShipments = [];

      // Process each ShipStation shipment
      for (const shipStationData of shipStationShipments) {
        try {
          // Normalize ShipStation data to our schema
          const normalizedShipment = this.normalizeShipStationShipment(shipStationData, order.id);
          
          // Skip shipments without a valid shipmentId to prevent duplicate inserts
          if (!normalizedShipment.shipmentId) {
            console.log(`[ShipmentService] Skipping shipment with missing ID for order ${orderNumber}`);
            continue;
          }
          
          // Check if shipment already exists by ShipStation shipment ID
          const existing = await this.storage.getShipmentsByOrderId(order.id);
          let existingShipment = existing.find(s => s.shipmentId === normalizedShipment.shipmentId);
          
          // FALLBACK: If not found by shipmentId, find a session-derived shipment (from SkuVault session sync)
          // These are shipments with closed session status but no shipmentId or trackingNumber yet
          if (!existingShipment) {
            const sessionDerivedShipment = existing.find(s => 
              !s.trackingNumber && 
              !s.shipmentId && 
              s.sessionStatus === 'closed'
            );
            if (sessionDerivedShipment) {
              console.log(`[ShipmentService] Found session-derived shipment ${sessionDerivedShipment.id} by orderNumber (sessionStatus=closed), linking to ShipStation ID ${normalizedShipment.shipmentId}`);
              existingShipment = sessionDerivedShipment;
            }
          }

          let savedShipment;
          if (existingShipment) {
            console.log(`[ShipmentService] Updating existing shipment ${existingShipment.id} with ShipStation ID ${normalizedShipment.shipmentId}`);
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
      return { success: true, shipments: syncedShipments, rateLimit };

    } catch (error: any) {
      console.error(`[ShipmentService] Error syncing shipments for order ${orderNumber}:`, error);
      return { success: false, shipments: [], error: error.message };
    }
  }

  /**
   * Helper to get the first non-empty value from multiple fields
   * Treats null, undefined, and empty strings as "empty"
   */
  private firstNonEmpty(...values: any[]): any {
    for (const val of values) {
      if (val !== null && val !== undefined && val !== '') {
        return val;
      }
    }
    return null;
  }

  /**
   * Normalize ShipStation V2 API response to our database schema
   * Handles both camelCase (V2 API) and snake_case (webhook) formats
   * Field mapping and type conversions in ONE place
   */
  private normalizeShipStationShipment(shipStationData: any, orderId: string): InsertShipment {
    // ShipStation V2 API returns camelCase, webhooks return snake_case
    // Use firstNonEmpty to handle both empty strings and null/undefined
    const shipmentId = this.firstNonEmpty(shipStationData.shipmentId, shipStationData.shipment_id);
    const trackingNumber = this.firstNonEmpty(shipStationData.trackingNumber, shipStationData.tracking_number);
    const carrierCode = this.firstNonEmpty(shipStationData.carrierCode, shipStationData.carrier_code);
    const serviceCode = this.firstNonEmpty(shipStationData.serviceCode, shipStationData.service_code);
    const voided = shipStationData.voided ?? false;
    const shipmentStatus = this.firstNonEmpty(shipStationData.shipmentStatus, shipStationData.shipment_status);
    const shipDate = this.firstNonEmpty(shipStationData.shipDate, shipStationData.ship_date);
    
    return {
      orderId,
      shipmentId: shipmentId?.toString() || null,
      trackingNumber: trackingNumber || null,
      carrierCode: carrierCode || null,
      serviceCode: serviceCode || null,
      status: voided ? 'cancelled' : (shipmentStatus || 'pending'),
      statusDescription: shipmentStatus || null,
      // Convert ISO date strings to Date objects
      shipDate: shipDate ? new Date(shipDate) : null,
      estimatedDeliveryDate: null,
      actualDeliveryDate: null,
      labelUrl: null,
      // Store the raw ShipStation data for reference
      shipmentData: shipStationData,
    };
  }

  /**
   * Create a shipping label for an order
   * WORKFLOW:
   * 1. Create print job FIRST (so user sees it immediately)
   * 2. Check if label exists (DB or fetch from ShipStation)
   * 3. If label exists → use it (reprint is normal)
   * 4. If no label → create new one
   * 5. Update print job with label URL → client auto-prints
   */
  async createLabelForOrder(orderNumber: string): Promise<{
    success: boolean;
    labelUrl?: string;
    printJob?: any;
    error?: string;
  }> {
    let printJob: any = null;
    
    try {
      console.log(`[ShipmentService] Creating label for order ${orderNumber}`);

      // Get the order
      const order = await this.storage.getOrderByOrderNumber(orderNumber);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // STEP 1: Create print job FIRST so user sees it in queue immediately
      printJob = await this.storage.createPrintJob({
        orderId: order.id,
        labelUrl: null,
        status: 'queued',
      });
      console.log(`[ShipmentService] Created print job ${printJob.id} (queued)`);

      // Ensure shipments are synced
      let shipments = await this.storage.getShipmentsByOrderId(order.id);
      
      if (shipments.length === 0) {
        console.log(`[ShipmentService] No shipments in DB, syncing from ShipStation...`);
        const syncResult = await this.syncShipmentsForOrder(orderNumber);
        
        if (!syncResult.success || syncResult.shipments.length === 0) {
          await this.storage.updatePrintJob(printJob.id, { 
            status: 'failed',
            error: syncResult.error || 'No shipment found' 
          });
          return { 
            success: false, 
            printJob,
            error: syncResult.error || 'No shipment found for this order. Please create a shipment in ShipStation first.' 
          };
        }
        
        shipments = syncResult.shipments;
      }

      const shipment = shipments[0];

      // Validate shipment has ShipStation ID
      if (!shipment.shipmentId) {
        await this.storage.updatePrintJob(printJob.id, { 
          status: 'failed',
          error: 'No ShipStation shipment ID' 
        });
        return { 
          success: false, 
          printJob,
          error: 'Shipment does not have a ShipStation shipment ID. Please check ShipStation.' 
        };
      }

      let labelUrl: string | null = null;

      // STEP 2: Check if label already exists in database
      if (shipment.labelUrl) {
        console.log(`[ShipmentService] Using existing label from database: ${shipment.labelUrl}`);
        labelUrl = shipment.labelUrl;
      } else {
        // STEP 3: Try to fetch existing label from ShipStation
        console.log(`[ShipmentService] Fetching labels from ShipStation for shipment ${shipment.shipmentId}`);
        const existingLabels = await getLabelsForShipment(shipment.shipmentId);
        
        if (existingLabels.length > 0) {
          console.log(`[ShipmentService] Found ${existingLabels.length} existing label(s) in ShipStation`);
          const label = existingLabels[0];
          // CRITICAL: Extract PDF format only - SumatraPDF requires PDF, not ZPL
          labelUrl = extractPdfLabelUrl(label.label_download);
          
          if (labelUrl) {
            // Save label URL to database for next time
            await this.storage.updateShipment(shipment.id, { labelUrl });
          }
        }
      }

      // STEP 4: If still no label, create a new one
      if (!labelUrl) {
        console.log(`[ShipmentService] No existing label found, creating new label...`);
        
        if (!shipment.shipmentData) {
          await this.storage.updatePrintJob(printJob.id, { 
            status: 'failed',
            error: 'No ShipStation data' 
          });
          return { 
            success: false, 
            printJob,
            error: 'Shipment does not have ShipStation data. Please sync shipment first.' 
          };
        }

        // VALIDATION: Check shipment_id exists in the raw shipmentData BEFORE any processing
        // Cast to any since shipmentData is stored as JSON with dynamic structure
        const rawData = shipment.shipmentData as any;
        const rawShipmentId = rawData.shipment_id || rawData.shipmentId;
        if (!rawShipmentId) {
          console.error(`[ShipmentService] CRITICAL: shipment_id is MISSING from stored shipmentData!`);
          console.error(`[ShipmentService] Shipment DB record ID: ${shipment.id}`);
          console.error(`[ShipmentService] Shipment shipmentId field: ${shipment.shipmentId}`);
          console.error(`[ShipmentService] shipmentData keys:`, Object.keys(shipment.shipmentData));
          console.error(`[ShipmentService] Full shipmentData:`, JSON.stringify(shipment.shipmentData, null, 2));
          
          await this.storage.updatePrintJob(printJob.id, { 
            status: 'failed',
            error: 'Missing shipment_id in ShipStation data' 
          });
          return { 
            success: false, 
            printJob,
            error: 'Shipment data is missing shipment_id. Cannot create label without it. Please re-sync shipment from ShipStation.' 
          };
        }

        // Strip ShipStation-managed fields from payload, but KEEP shipment_id
        // CRITICAL: Keeping shipment_id ensures the label is attached to the existing 
        // shipment rather than creating a new one (which would orphan the original)
        const cleanShipmentData: any = { ...shipment.shipmentData };
        
        // Ensure shipment_id is present in snake_case format (ShipStation V2 API format)
        if (!cleanShipmentData.shipment_id && cleanShipmentData.shipmentId) {
          cleanShipmentData.shipment_id = cleanShipmentData.shipmentId;
        }
        
        // Keep shipment_id to attach label to existing shipment
        delete cleanShipmentData.label_id;
        delete cleanShipmentData.created_at;
        delete cleanShipmentData.modified_at;
        delete cleanShipmentData.shipment_status; // Cannot be set/modified
        delete cleanShipmentData.label_status;    // Cannot be set/modified
        delete cleanShipmentData.tracking_number; // Will be set by ShipStation
        delete cleanShipmentData.label_download;  // Read-only field
        
        // If ship_from is provided, remove warehouse_id (mutually exclusive)
        if (cleanShipmentData.ship_from) {
          delete cleanShipmentData.warehouse_id;
        }

        // Final validation: ensure shipment_id survived the cleaning
        if (!cleanShipmentData.shipment_id) {
          console.error(`[ShipmentService] CRITICAL: shipment_id was lost during payload cleaning!`);
          await this.storage.updatePrintJob(printJob.id, { 
            status: 'failed',
            error: 'shipment_id lost during processing' 
          });
          return { 
            success: false, 
            printJob,
            error: 'Internal error: shipment_id was lost during payload processing.' 
          };
        }

        console.log(`[ShipmentService] Creating label for existing shipment_id: ${cleanShipmentData.shipment_id}`);
        const labelData = await createShipStationLabel(cleanShipmentData);
        // CRITICAL: Extract PDF format only - SumatraPDF requires PDF, not ZPL
        labelUrl = extractPdfLabelUrl(labelData.label_download);
        
        // Extract tracking number from label response
        const trackingNumber = labelData.tracking_number || null;

        if (labelUrl) {
          // Update both labelUrl and tracking number if available
          const updateData: any = { labelUrl };
          if (trackingNumber) {
            updateData.trackingNumber = trackingNumber;
            console.log(`[ShipmentService] Saved tracking number: ${trackingNumber}`);
          }
          await this.storage.updateShipment(shipment.id, updateData);
        }
      }

      if (!labelUrl) {
        await this.storage.updatePrintJob(printJob.id, { 
          status: 'failed',
          error: 'No label URL returned' 
        });
        return { 
          success: false, 
          printJob,
          error: 'No label URL returned from ShipStation' 
        };
      }

      // STEP 5: Update print job with label URL (keep status as 'queued' so frontend auto-prints)
      await this.storage.updatePrintJob(printJob.id, { 
        labelUrl
      });

      console.log(`[ShipmentService] Successfully got label and updated print job`);

      return {
        success: true,
        labelUrl,
        printJob,
      };

    } catch (error: any) {
      console.error(`[ShipmentService] Error creating label for order ${orderNumber}:`, error);
      
      // Update print job to failed if we created one
      if (printJob) {
        try {
          await this.storage.updatePrintJob(printJob.id, { 
            status: 'failed',
            error: error.message 
          });
        } catch (e) {
          console.error(`[ShipmentService] Failed to update print job:`, e);
        }
      }
      
      return { 
        success: false, 
        printJob,
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

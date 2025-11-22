import { storage } from './storage';
import { enqueueShipmentSync } from './utils/queue';

const log = (message: string) => console.log(`[onhold-poll] ${message}`);

/**
 * Poll ShipStation for on_hold shipments and enqueue them for processing
 * This worker supplements webhooks which don't fire for on_hold shipments
 */
export async function pollOnHoldShipments(): Promise<number> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    log('ShipStation API key not configured, skipping poll');
    return 0;
  }

  try {
    // Poll for on_hold shipments modified in the last 24 hours
    // This ensures we catch new on_hold shipments and updates to existing ones
    const modifiedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const url = `https://api.shipstation.com/v2/shipments?shipment_status=on_hold&modified_date_start=${modifiedSince}&page_size=100`;
    
    log(`Polling for on_hold shipments modified since ${modifiedSince}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`ShipStation API error: ${response.statusText}`);
    }

    const data = await response.json();
    const shipments = data.shipments || [];
    
    log(`Found ${shipments.length} on_hold shipment(s)`);
    
    let queued = 0;
    for (const shipmentData of shipments) {
      const orderNumber = shipmentData.shipment_number;
      const shipmentId = shipmentData.shipment_id;
      const trackingNumber = shipmentData.tracking_number;
      
      if (!orderNumber) {
        log(`Skipping shipment ${shipmentId} - missing shipment_number`);
        continue;
      }
      
      // Check if we already have this shipment
      const existing = await storage.getShipmentByShipmentId(String(shipmentId));
      if (existing) {
        // Only queue if modified timestamp is newer than our last update
        const shipmentModified = new Date(shipmentData.modified_at);
        const ourUpdated = existing.updatedAt ? new Date(existing.updatedAt) : new Date(existing.createdAt);
        
        if (shipmentModified <= ourUpdated) {
          continue; // Skip - we already have the latest version
        }
      }
      
      // Queue for sync with inline shipment data
      await enqueueShipmentSync({
        orderNumber,
        shipmentId,
        trackingNumber,
        reason: 'onhold_poll',
        enqueuedAt: Date.now(),
        webhookData: shipmentData, // Pass shipment data directly (no API call needed!)
      });
      
      queued++;
    }
    
    if (queued > 0) {
      log(`Queued ${queued} on_hold shipment(s) for sync`);
    }
    
    return queued;
  } catch (error: any) {
    log(`Error polling on_hold shipments: ${error.message}`);
    return 0;
  }
}

/**
 * Start the on_hold shipments polling worker
 */
export function startOnHoldPollWorker(intervalMs: number = 300000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__onHoldPollWorkerInterval) {
    log('On-hold poll worker already running, skipping duplicate start');
    return globalThis.__onHoldPollWorkerInterval;
  }

  log(`On-hold poll worker started (interval: ${intervalMs}ms = ${intervalMs / 60000} minutes)`);
  
  const pollTask = async () => {
    try {
      await pollOnHoldShipments();
    } catch (error) {
      console.error("On-hold poll worker error:", error);
    }
  };

  // Run immediately on startup, then every interval
  pollTask();
  
  const interval = setInterval(pollTask, intervalMs);
  globalThis.__onHoldPollWorkerInterval = interval;
  
  return interval;
}

/**
 * Stop the on_hold poll worker
 */
export function stopOnHoldPollWorker(): void {
  if (globalThis.__onHoldPollWorkerInterval) {
    clearInterval(globalThis.__onHoldPollWorkerInterval);
    globalThis.__onHoldPollWorkerInterval = undefined;
    log('On-hold poll worker stopped');
  }
}

// TypeScript global declarations
declare global {
  var __onHoldPollWorkerInterval: NodeJS.Timeout | undefined;
}

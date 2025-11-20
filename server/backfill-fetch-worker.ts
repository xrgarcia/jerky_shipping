/**
 * Backfill Fetch Worker
 * Processes backfill fetch tasks from Redis queue asynchronously
 * Fetches data from Shopify/ShipStation APIs and enqueues results to existing worker queues
 */

import { storage } from './storage';
import {
  dequeueBackfillFetchTaskBatch,
  removeBackfillFetchTaskFromInflight,
  enqueueShopifyOrderSync,
  enqueueShipmentSyncBatch,
  type BackfillFetchTask,
} from './utils/queue';
import { getShipmentsByDateRange } from './utils/shipstation-api';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [backfill-fetch] ${message}`);
}

/**
 * Extract actual order number from Shopify order response
 */
function extractActualOrderNumber(shopifyOrder: any): string {
  // Try Shopify's name field first (e.g. "#1234")
  if (shopifyOrder.name) {
    return shopifyOrder.name.replace(/^#/, '');
  }
  // Fallback to order_number (numeric ID)
  return shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString() || 'unknown';
}

/**
 * Fetch Shopify orders for a given date range
 * Paginates through all results and enqueues to Shopify Order Sync queue
 */
async function fetchShopifyOrders(task: BackfillFetchTask): Promise<{ success: boolean; count: number; error?: string }> {
  const { startDate, endDate, jobId } = task;
  
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  
  if (!shopDomain || !accessToken) {
    return { success: false, count: 0, error: 'Shopify credentials not configured' };
  }
  
  let enqueuedCount = 0;
  let pageInfo: string | null = null;
  let hasNextPage = true;
  let pageCount = 0;
  
  try {
    while (hasNextPage) {
      pageCount++;
      
      // Build URL with pagination or initial query
      let url: string;
      if (pageInfo) {
        url = `https://${shopDomain}/admin/api/2024-01/orders.json?page_info=${pageInfo}`;
      } else {
        url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${startDate}&created_at_max=${endDate}`;
      }
      
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, count: enqueuedCount, error: `Shopify API error: ${errorText}` };
      }
      
      const data = await response.json();
      const orders = data.orders || [];
      
      // Enqueue each order to Shopify Order Sync queue
      for (const order of orders) {
        const orderNumber = extractActualOrderNumber(order);
        await enqueueShopifyOrderSync({
          orderNumber,
          reason: 'backfill',
          enqueuedAt: Date.now(),
          jobId,
        });
        enqueuedCount++;
      }
      
      // Check for pagination
      const linkHeader = response.headers.get('Link');
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          const nextUrl = new URL(nextMatch[1]);
          pageInfo = nextUrl.searchParams.get('page_info');
        } else {
          hasNextPage = false;
        }
      } else {
        hasNextPage = false;
      }
      
      // Rate limiting: wait 500ms between requests
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      log(`Shopify: Fetched page ${pageCount}, enqueued ${orders.length} orders (total: ${enqueuedCount})`);
    }
    
    return { success: true, count: enqueuedCount };
  } catch (error: any) {
    return { success: false, count: enqueuedCount, error: error.message };
  }
}

/**
 * Fetch ShipStation shipments for a given date range
 * Uses existing V2 API service with proper rate limiting and pagination
 */
async function fetchShipStationShipments(task: BackfillFetchTask): Promise<{ success: boolean; count: number; error?: string }> {
  const { startDate, endDate, jobId } = task;
  
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Use existing V2 API service (handles all pagination and rate limiting internally)
    const response = await getShipmentsByDateRange(start, end, 100);
    const shipments = response.data;
    const { rateLimit } = response;
    
    // Filter out shipments without order numbers (shipment_number field)
    // The shipment sync worker uses orderNumber to fetch full shipment data
    const shipmentsWithOrderNumber = shipments.filter((shipment: any) => {
      const hasOrderNumber = shipment.shipment_number && shipment.shipment_number.trim() !== '';
      if (!hasOrderNumber) {
        log(`Skipping shipment ${shipment.shipment_id} - no order number`);
      }
      return hasOrderNumber;
    });
    
    // Batch enqueue shipments to Shipment Sync queue using orderNumber
    // The shipment sync worker will fetch full shipment data (including tracking) from ShipStation
    const syncMessages = shipmentsWithOrderNumber.map((shipment: any) => ({
      reason: 'backfill' as const,
      orderNumber: shipment.shipment_number, // Use shipment_number as orderNumber
      enqueuedAt: Date.now(),
      jobId,
      shipmentId: shipment.shipment_id?.toString(),
    }));
    
    const enqueued = await enqueueShipmentSyncBatch(syncMessages);
    
    log(`ShipStation: Fetched ${shipments.length} shipments (${shipmentsWithOrderNumber.length} with order numbers), enqueued ${enqueued}`);
    log(`ShipStation: Rate limit remaining: ${rateLimit.remaining}/${rateLimit.limit} (resets at ${new Date(rateLimit.reset * 1000).toISOString()})`);
    
    // If rate limit is low, pause before next task
    if (rateLimit.remaining < 5) {
      const resetEpochMs = rateLimit.reset * 1000;
      const now = Date.now();
      if (resetEpochMs > now) {
        const waitTimeMs = resetEpochMs - now + 1000; // Add 1 second buffer
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);
        log(`ShipStation: Rate limit low (${rateLimit.remaining} remaining), pausing ${waitTimeSec}s before next task...`);
        await new Promise(resolve => setTimeout(resolve, waitTimeMs));
      }
    }
    
    return { success: true, count: enqueued };
  } catch (error: any) {
    return { success: false, count: 0, error: error.message };
  }
}

/**
 * Process a batch of backfill fetch tasks
 */
export async function processBackfillFetchTasks(batchSize: number = 10): Promise<number> {
  const tasks = await dequeueBackfillFetchTaskBatch(batchSize);
  
  if (tasks.length === 0) {
    return 0;
  }
  
  log(`Processing ${tasks.length} fetch task(s)`);
  
  for (const task of tasks) {
    const { source, startDate, endDate, jobId } = task;
    
    try {
      log(`Fetching ${source} data for ${startDate} to ${endDate}`);
      
      let result: { success: boolean; count: number; error?: string };
      
      if (source === 'shopify') {
        result = await fetchShopifyOrders(task);
      } else if (source === 'shipstation') {
        result = await fetchShipStationShipments(task);
      } else {
        result = { success: false, count: 0, error: `Unknown source: ${source}` };
      }
      
      // Update backfill job progress
      if (result.success) {
        // Use per-source increment methods for dual-source tracking
        if (source === 'shopify') {
          await storage.incrementBackfillShopifyFetchCompleted(jobId);
        } else if (source === 'shipstation') {
          await storage.incrementBackfillShipstationFetchCompleted(jobId);
        }
        log(`✓ ${source} fetch completed: ${result.count} items enqueued`);
      } else {
        // Use per-source increment methods for dual-source tracking
        if (source === 'shopify') {
          await storage.incrementBackfillShopifyFetchFailed(jobId);
        } else if (source === 'shipstation') {
          await storage.incrementBackfillShipstationFetchFailed(jobId);
        }
        log(`✗ ${source} fetch failed: ${result.error}`);
        
        // Update job error log
        const job = await storage.getBackfillJob(jobId);
        if (job) {
          const errorLog = (job.errorLog as any[]) || [];
          errorLog.push({
            source,
            startDate,
            endDate,
            error: result.error,
            timestamp: new Date().toISOString(),
          });
          await storage.updateBackfillJob(jobId, { errorLog: errorLog as any });
        }
      }
    } catch (error: any) {
      log(`Error processing fetch task: ${error.message}`);
      // Use per-source increment methods for dual-source tracking
      if (source === 'shopify') {
        await storage.incrementBackfillShopifyFetchFailed(jobId);
      } else if (source === 'shipstation') {
        await storage.incrementBackfillShipstationFetchFailed(jobId);
      }
    } finally {
      // Always remove from in-flight set
      await removeBackfillFetchTaskFromInflight(task);
    }
  }
  
  return tasks.length;
}

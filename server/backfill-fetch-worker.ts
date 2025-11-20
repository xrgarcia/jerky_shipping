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
 * Paginates through all results and enqueues to Shipment Sync queue
 */
async function fetchShipStationShipments(task: BackfillFetchTask): Promise<{ success: boolean; count: number; error?: string }> {
  const { startDate, endDate, jobId } = task;
  
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    return { success: false, count: 0, error: 'ShipStation credentials not configured' };
  }
  
  const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  
  let enqueuedCount = 0;
  let page = 1;
  const pageSize = 100;
  let hasMorePages = true;
  
  try {
    while (hasMorePages) {
      const url = `https://ssapi.shipstation.com/shipments?createDateStart=${startDate}&createDateEnd=${endDate}&page=${page}&pageSize=${pageSize}`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, count: enqueuedCount, error: `ShipStation API error: ${errorText}` };
      }
      
      const data = await response.json();
      const shipments = data.shipments || [];
      
      // Batch enqueue shipments to Shipment Sync queue
      const syncMessages = shipments.map((shipment: any) => ({
        reason: 'backfill' as const,
        trackingNumber: shipment.trackingNumber,
        enqueuedAt: Date.now(),
        jobId,
        shipmentId: shipment.shipmentId?.toString(),
      }));
      
      const enqueued = await enqueueShipmentSyncBatch(syncMessages);
      enqueuedCount += enqueued;
      
      // Check if there are more pages
      hasMorePages = shipments.length === pageSize;
      page++;
      
      // Rate limiting: wait 1.5s between requests (40 calls/min = 1.5s/call)
      if (hasMorePages) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      
      log(`ShipStation: Fetched page ${page - 1}, enqueued ${enqueued} shipments (total: ${enqueuedCount})`);
    }
    
    return { success: true, count: enqueuedCount };
  } catch (error: any) {
    return { success: false, count: enqueuedCount, error: error.message };
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
        await storage.incrementBackfillFetchTaskCompleted(jobId);
        log(`✓ ${source} fetch completed: ${result.count} items enqueued`);
      } else {
        await storage.incrementBackfillFetchTaskFailed(jobId);
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
      await storage.incrementBackfillFetchTaskFailed(jobId);
    } finally {
      // Always remove from in-flight set
      await removeBackfillFetchTaskFromInflight(task);
    }
  }
  
  return tasks.length;
}

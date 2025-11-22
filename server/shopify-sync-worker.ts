import { storage } from "./storage";
import { db } from './db';
import {
  dequeueShopifyOrderSyncBatch,
  requeueShopifyOrderSyncMessages,
  getShopifyOrderSyncQueueLength,
  removeShopifyOrderSyncFromInflight,
  type ShopifyOrderSyncMessage,
} from './utils/queue';
import { extractActualOrderNumber, extractShopifyOrderPrices } from './utils/shopify-utils';
import { processOrderRefunds, processOrderLineItems } from './utils/shopify-order-processing';
import { shopifyOrderSyncFailures, type InsertShopifyOrderSyncFailure } from '@shared/schema';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shopify-sync] ${message}`);
}

const MAX_RETRY_COUNT = 3; // Maximum retries before giving up

/**
 * Log a Shopify order sync failure to the dead letter queue
 */
async function logShopifyOrderSyncFailure(failure: InsertShopifyOrderSyncFailure): Promise<void> {
  try {
    await db.insert(shopifyOrderSyncFailures).values(failure);
  } catch (error) {
    console.error('[shopify-sync] Failed to log failure to dead letter queue:', error);
  }
}

/**
 * Process a batch of Shopify order sync messages
 * Returns the number of successfully processed messages
 */
export async function processShopifyOrderSyncBatch(batchSize: number): Promise<number> {
  const messages = await dequeueShopifyOrderSyncBatch(batchSize);
  
  if (messages.length === 0) {
    return 0;
  }

  log(`Processing ${messages.length} Shopify order sync message(s)`);
  let processedCount = 0;
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const retryCount = message.retryCount || 0;
    let wasRequeued = false; // Track if message was requeued for retry
    
    try {
      const { orderNumber } = message;
      
      log(`Fetching order ${orderNumber} from Shopify (attempt ${retryCount + 1}/${MAX_RETRY_COUNT})`);
      
      // Check if order already exists in database
      const existingOrder = await storage.getOrderByOrderNumber(orderNumber);
      if (existingOrder) {
        log(`✓ Order ${orderNumber} already exists in database, skipping`);
        processedCount++;
        continue;
      }
      
      // Fetch order from Shopify API by order number
      const shopifyOrder = await fetchShopifyOrderByOrderNumber(orderNumber);
      
      if (!shopifyOrder) {
        log(`⚠️  Order ${orderNumber} not found in Shopify`);
        
        // If we've exhausted retries, log to dead letter queue and give up
        if (retryCount >= MAX_RETRY_COUNT - 1) {
          log(`❌ Max retries reached for order ${orderNumber}, logging to dead letter queue`);
          
          await logShopifyOrderSyncFailure({
            orderNumber,
            reason: message.reason || 'unknown',
            errorMessage: `Order ${orderNumber} not found in Shopify after ${MAX_RETRY_COUNT} attempts`,
            requestData: {
              queueMessage: message,
            },
            responseData: null,
            retryCount,
            failedAt: new Date(),
          });
          
          processedCount++;
          continue;
        }
        
        // Otherwise, requeue for retry
        const retryMessage: ShopifyOrderSyncMessage = {
          ...message,
          retryCount: retryCount + 1,
        };
        await requeueShopifyOrderSyncMessages([retryMessage]);
        log(`📥 Requeued order ${orderNumber} for retry (${retryCount + 1}/${MAX_RETRY_COUNT})`);
        wasRequeued = true;
        processedCount++;
        continue;
      }
      
      // Transform Shopify order to our format
      const orderData = {
        id: shopifyOrder.id.toString(),
        orderNumber: extractActualOrderNumber(shopifyOrder),
        customerName: shopifyOrder.customer
          ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
          : "Guest",
        customerEmail: shopifyOrder.customer?.email || null,
        customerPhone: shopifyOrder.customer?.phone || null,
        shippingAddress: shopifyOrder.shipping_address || {},
        lineItems: shopifyOrder.line_items || [],
        fulfillmentStatus: shopifyOrder.fulfillment_status,
        financialStatus: shopifyOrder.financial_status,
        ...extractShopifyOrderPrices(shopifyOrder),
        createdAt: new Date(shopifyOrder.created_at),
        updatedAt: new Date(shopifyOrder.updated_at),
      };
      
      // Create the order in the database
      await storage.createOrder(orderData);
      
      // Process refunds and line items using same ETL pipeline as webhooks and backfill
      await processOrderRefunds(storage, orderData.id, shopifyOrder);
      await processOrderLineItems(storage, orderData.id, shopifyOrder);
      
      log(`✓ Successfully imported order ${orderNumber} from Shopify`);
      processedCount++;
      
    } catch (error: any) {
      log(`❌ Error processing order ${message.orderNumber}: ${error.message}`);
      
      // If we've exhausted retries, log to dead letter queue and give up
      if (retryCount >= MAX_RETRY_COUNT - 1) {
        log(`❌ Max retries reached for order ${message.orderNumber}, logging to dead letter queue`);
        
        await logShopifyOrderSyncFailure({
          orderNumber: message.orderNumber,
          reason: message.reason || 'unknown',
          errorMessage: error.message || 'Unknown error',
          requestData: {
            queueMessage: message,
          },
          responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
          retryCount,
          failedAt: new Date(),
        });
        
        processedCount++;
        continue;
      }
      
      // Otherwise, requeue for retry
      const retryMessage: ShopifyOrderSyncMessage = {
        ...message,
        retryCount: retryCount + 1,
      };
      await requeueShopifyOrderSyncMessages([retryMessage]);
      log(`📥 Requeued order ${message.orderNumber} for retry due to error (${retryCount + 1}/${MAX_RETRY_COUNT})`);
      wasRequeued = true;
      processedCount++;
    } finally {
      // Always remove from in-flight set after processing completes or fails permanently
      // Skip cleanup only if message was requeued for retry
      if (!wasRequeued) {
        await removeShopifyOrderSyncFromInflight(message);
      }
    }
  }
  
  log(`Processed ${processedCount} Shopify order sync message(s)`);
  return processedCount;
}

/**
 * Fetch a single order from Shopify by order number
 * Shopify API supports filtering by name (order number)
 */
async function fetchShopifyOrderByOrderNumber(orderNumber: string): Promise<any | null> {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  
  if (!shopDomain || !accessToken) {
    throw new Error('Shopify credentials not configured');
  }
  
  // Clean order number - remove # if present
  const cleanOrderNumber = orderNumber.replace(/^#/, '');
  
  // Shopify API supports searching by order name (which is the order number)
  // The 'name' parameter searches order numbers like #1001, #1002, etc.
  const url = `https://${shopDomain}/admin/api/2024-01/orders.json?name=${encodeURIComponent(cleanOrderNumber)}&status=any&limit=1`;
  
  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const orders = data.orders || [];
  
  // Return the first matching order (should only be one)
  return orders.length > 0 ? orders[0] : null;
}

// Use globalThis to persist worker state across hot-reloads
declare global {
  var __shopifyOrderSyncWorkerInterval: NodeJS.Timeout | undefined;
  var __shopifyOrderSyncWorkerActiveRunId: number | null | undefined;
  var __shopifyOrderSyncWorkerNextRunId: number | undefined;
}

/**
 * Start the Shopify order sync worker that processes order import requests from the queue
 * Runs every intervalMs milliseconds
 * Uses singleton pattern to prevent duplicate workers on hot-reload
 * Uses activeRunId mutex (null = idle, number = active) to prevent overlapping batches
 */
export function startShopifyOrderSyncWorker(intervalMs: number = 8000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__shopifyOrderSyncWorkerInterval) {
    log('Shopify order sync worker already running, skipping duplicate start');
    return globalThis.__shopifyOrderSyncWorkerInterval;
  }

  // Initialize mutex only if undefined (don't clear in-flight batches)
  if (globalThis.__shopifyOrderSyncWorkerActiveRunId === undefined) {
    globalThis.__shopifyOrderSyncWorkerActiveRunId = null;
  }
  // Persist run ID counter so IDs never collide across stop/start cycles
  globalThis.__shopifyOrderSyncWorkerNextRunId = globalThis.__shopifyOrderSyncWorkerNextRunId ?? 0;
  
  log(`Shopify order sync worker started (interval: ${intervalMs}ms, batch size: 10)`);
  
  const processQueue = async () => {
    // Check if a batch is already running
    if (globalThis.__shopifyOrderSyncWorkerActiveRunId !== null) {
      return;
    }
    
    // Claim this run with a globally unique ID
    const myRunId = ++(globalThis.__shopifyOrderSyncWorkerNextRunId!);
    globalThis.__shopifyOrderSyncWorkerActiveRunId = myRunId;

    try {
      const startTime = Date.now();
      const queueLength = await getShopifyOrderSyncQueueLength();
      
      if (queueLength > 0) {
        const processed = await processShopifyOrderSyncBatch(10); // Smaller batch size for API calls
        const duration = Date.now() - startTime;
        
        if (processed > 0) {
          log(`Processed ${processed} Shopify order sync message(s) in ${duration}ms, ${queueLength - processed} remaining`);
        }
      }
    } catch (error) {
      console.error("Shopify order sync worker error:", error);
    } finally {
      // Only release the lock if we still own it (handles stop/start edge cases)
      if (globalThis.__shopifyOrderSyncWorkerActiveRunId === myRunId) {
        globalThis.__shopifyOrderSyncWorkerActiveRunId = null;
      }
    }
  };

  globalThis.__shopifyOrderSyncWorkerInterval = setInterval(processQueue, intervalMs);
  return globalThis.__shopifyOrderSyncWorkerInterval;
}

/**
 * Stop the Shopify order sync worker
 * Note: Does not clear activeRunId - let in-flight batches finish naturally
 */
export function stopShopifyOrderSyncWorker(): void {
  if (globalThis.__shopifyOrderSyncWorkerInterval) {
    clearInterval(globalThis.__shopifyOrderSyncWorkerInterval);
    globalThis.__shopifyOrderSyncWorkerInterval = undefined;
    // Don't clear activeRunId - let running batch finish and release the lock
    log('Shopify order sync worker stopped');
  }
}

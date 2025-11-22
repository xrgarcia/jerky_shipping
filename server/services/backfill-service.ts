/**
 * Simplified Backfill Service
 * Directly fetches and saves Shopify orders and ShipStation shipments
 * No queue hops - just fetch, transform, and save
 */

import type { IStorage } from '../storage';
import { getShipmentsByDateRange } from '../utils/shipstation-api';
import { extractActualOrderNumber, extractShopifyOrderPrices } from '../utils/shopify-utils';
import type { InsertOrder, BackfillJob } from '@shared/schema';
import { broadcastQueueStatus } from '../websocket';
import { shopifyOrderETL } from './shopify-order-etl-service';
import { shipStationShipmentETL } from './shipstation-shipment-etl-service';
import { workerCoordinator } from '../worker-coordinator';

export class BackfillService {
  constructor(private storage: IStorage) {}

  /**
   * Resume any in-progress backfill jobs that were interrupted by server restart
   * Called automatically on server startup
   */
  async resumeInProgressJobs(): Promise<void> {
    try {
      // Get all jobs with status 'running'
      const runningJobs = await this.storage.getRunningBackfillJobs();
      
      if (runningJobs.length === 0) {
        console.log('[Backfill] No in-progress jobs to resume');
        return;
      }
      
      console.log(`[Backfill] Resuming ${runningJobs.length} in-progress job(s)`);
      
      // Resume each job in the background
      for (const job of runningJobs) {
        console.log(`[Backfill] Resuming job ${job.id} (${job.startDate} to ${job.endDate})`);
        this.runBackfillJob(job.id).catch(error => {
          console.error(`[Backfill ${job.id}] Resume failed:`, error);
        });
      }
    } catch (error) {
      console.error('[Backfill] Error resuming in-progress jobs:', error);
      throw error;
    }
  }

  /**
   * Run a complete backfill job
   * Fetches and imports both Shopify orders and ShipStation shipments
   * Updates progress in real-time
   * Signals other workers to pause during execution
   */
  async runBackfillJob(jobId: string): Promise<void> {
    let coordinatorLockAcquired = false;
    
    try {
      // Get job details
      const job = await this.storage.getBackfillJob(jobId);
      if (!job) {
        throw new Error(`Backfill job ${jobId} not found`);
      }

      console.log(`[Backfill] Starting job ${jobId} (${job.startDate} to ${job.endDate})`);

      // Signal coordinator that backfill is starting
      try {
        await workerCoordinator.beginBackfill(jobId);
        coordinatorLockAcquired = true;
      } catch (error) {
        console.error(`[Backfill] Failed to acquire coordinator lock:`, error);
        // Continue anyway - coordination failure shouldn't block backfill
      }

      // Mark job as running
      await this.storage.updateBackfillJob(jobId, {
        status: 'running',
        startedAt: new Date(),
      });
      this.broadcastJobProgress(jobId);

      // Run both imports in parallel
      await Promise.all([
        this.importShopifyOrders(jobId, job.startDate, job.endDate),
        this.importShipStationShipments(jobId, job.startDate, job.endDate),
      ]);

      // Check if job was cancelled during import
      const finalJob = await this.storage.getBackfillJob(jobId);
      if (finalJob?.status === 'cancelled') {
        console.log(`[Backfill] Job ${jobId} was cancelled, not marking as completed`);
        return;
      }

      // Mark job as completed
      await this.storage.updateBackfillJob(jobId, {
        status: 'completed',
        completedAt: new Date(),
      });
      this.broadcastJobProgress(jobId);

      console.log(`[Backfill] Job ${jobId} completed successfully`);
    } catch (error: any) {
      console.error(`[Backfill] Job ${jobId} failed:`, error);
      await this.storage.updateBackfillJob(jobId, {
        status: 'failed',
        errorMessage: error.message,
        completedAt: new Date(),
      });
      this.broadcastJobProgress(jobId);
      throw error;
    } finally {
      // Only signal coordinator if we successfully acquired the lock
      if (coordinatorLockAcquired) {
        try {
          await workerCoordinator.endBackfill();
        } catch (error) {
          console.error(`[Backfill] Failed to release coordinator lock:`, error);
        }
      }
    }
  }

  /**
   * Import Shopify orders for date range
   */
  private async importShopifyOrders(jobId: string, startDate: Date, endDate: Date): Promise<void> {
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

    if (!shopDomain || !accessToken) {
      console.log(`[Backfill] Shopify credentials not configured, skipping orders`);
      return;
    }

    console.log(`[Backfill] Importing Shopify orders from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // First, count total orders
    const countUrl = `https://${shopDomain}/admin/api/2024-01/orders/count.json?status=any&created_at_min=${startDate.toISOString()}&created_at_max=${endDate.toISOString()}`;
    const countResponse = await fetch(countUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!countResponse.ok) {
      throw new Error(`Failed to count Shopify orders: ${await countResponse.text()}`);
    }

    const countData = await countResponse.json();
    const totalOrders = countData.count || 0;

    await this.storage.updateBackfillJob(jobId, {
      shopifyOrdersTotal: totalOrders,
    });
    this.broadcastJobProgress(jobId);

    console.log(`[Backfill] Total Shopify orders to import: ${totalOrders}`);

    if (totalOrders === 0) {
      return;
    }

    // Now fetch and save orders with pagination
    let imported = 0;
    let failed = 0;
    let pageInfo: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      let url: string;
      if (pageInfo) {
        url = `https://${shopDomain}/admin/api/2024-01/orders.json?page_info=${pageInfo}`;
      } else {
        url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${startDate.toISOString()}&created_at_max=${endDate.toISOString()}`;
      }

      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Shopify orders: ${await response.text()}`);
      }

      const data = await response.json();
      const orders = data.orders || [];

      // Save each order directly
      for (const shopifyOrder of orders) {
        // Check if job was cancelled
        const currentJob = await this.storage.getBackfillJob(jobId);
        if (currentJob?.status === 'cancelled') {
          console.log(`[Backfill] Job ${jobId} was cancelled, stopping Shopify import`);
          // Persist final counts before returning
          await this.storage.updateBackfillJob(jobId, {
            shopifyOrdersImported: imported,
            shopifyOrdersFailed: failed,
          });
          this.broadcastJobProgress(jobId);
          return;
        }

        try {
          await this.saveShopifyOrder(shopifyOrder);
          imported++;

          // Update progress every 10 orders
          if (imported % 10 === 0) {
            await this.storage.updateBackfillJob(jobId, {
              shopifyOrdersImported: imported,
              shopifyOrdersFailed: failed,
            });
            this.broadcastJobProgress(jobId);
          }
        } catch (error: any) {
          failed++;
          console.error(`[Backfill] Error saving Shopify order ${shopifyOrder.id}:`, error);
          // Continue with other orders
        }
      }

      // Final progress update to capture any remainder
      await this.storage.updateBackfillJob(jobId, {
        shopifyOrdersImported: imported,
        shopifyOrdersFailed: failed,
      });
      this.broadcastJobProgress(jobId);

      // Check pagination
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

      // Rate limiting: wait 500ms between pages
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log(`[Backfill] Shopify progress: ${imported}/${totalOrders}`);
    }

    // Final progress update
    await this.storage.updateBackfillJob(jobId, {
      shopifyOrdersImported: imported,
      shopifyOrdersFailed: failed,
    });
    this.broadcastJobProgress(jobId);

    console.log(`[Backfill] Shopify import complete: ${imported} orders, ${failed} failed`);
  }

  /**
   * Import ShipStation shipments for date range
   */
  private async importShipStationShipments(jobId: string, startDate: Date, endDate: Date): Promise<void> {
    console.log(`[Backfill] Importing ShipStation shipments from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    try {
      // Fetch all shipments for date range (pagination handled internally)
      const { data: shipments } = await getShipmentsByDateRange(startDate, endDate);

      // Update total after fetching all pages
      await this.storage.updateBackfillJob(jobId, {
        shipstationShipmentsTotal: shipments.length,
      });
      this.broadcastJobProgress(jobId);

      console.log(`[Backfill] Total ShipStation shipments to import: ${shipments.length}`);

      if (shipments.length === 0) {
        return;
      }

      // Save each shipment directly
      let imported = 0;
      let failed = 0;
      for (const shipmentData of shipments) {
        // Check if job was cancelled
        const currentJob = await this.storage.getBackfillJob(jobId);
        if (currentJob?.status === 'cancelled') {
          console.log(`[Backfill] Job ${jobId} was cancelled, stopping ShipStation import`);
          // Persist final counts before returning
          await this.storage.updateBackfillJob(jobId, {
            shipstationShipmentsImported: imported,
            shipstationShipmentsFailed: failed,
          });
          this.broadcastJobProgress(jobId);
          return;
        }

        try {
          await this.saveShipStationShipment(shipmentData);
          imported++;

          // Update progress every 10 shipments
          if (imported % 10 === 0) {
            await this.storage.updateBackfillJob(jobId, {
              shipstationShipmentsImported: imported,
              shipstationShipmentsFailed: failed,
            });
            this.broadcastJobProgress(jobId);
          }
        } catch (error: any) {
          failed++;
          console.error(`[Backfill] Error saving ShipStation shipment:`, error);
          // Continue with other shipments
        }
      }

      // Final progress update to capture any remainder
      await this.storage.updateBackfillJob(jobId, {
        shipstationShipmentsImported: imported,
        shipstationShipmentsFailed: failed,
      });
      this.broadcastJobProgress(jobId);

      console.log(`[Backfill] ShipStation import complete: ${imported} shipments`);
    } catch (error: any) {
      console.error(`[Backfill] ShipStation import error:`, error);
      throw error;
    }
  }

  /**
   * Save a Shopify order to database
   * Uses same transformation logic as webhook processing
   */
  private async saveShopifyOrder(shopifyOrder: any): Promise<void> {
    const orderNumber = extractActualOrderNumber(shopifyOrder);
    const prices = extractShopifyOrderPrices(shopifyOrder);

    const orderData: InsertOrder = {
      id: shopifyOrder.id.toString(),
      orderNumber,
      customerName: shopifyOrder.customer
        ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim()
        : 'Unknown',
      customerEmail: shopifyOrder.customer?.email || shopifyOrder.email || null,
      customerPhone: shopifyOrder.customer?.phone || shopifyOrder.phone || null,
      shippingAddress: shopifyOrder.shipping_address || {},
      lineItems: shopifyOrder.line_items || [],
      fulfillmentStatus: shopifyOrder.fulfillment_status || null,
      financialStatus: shopifyOrder.financial_status || null,
      ...prices,
      createdAt: new Date(shopifyOrder.created_at),
      updatedAt: new Date(shopifyOrder.updated_at || shopifyOrder.created_at),
    };

    // Upsert (create or update)
    const existing = await this.storage.getOrder(orderData.id);
    if (existing) {
      await this.storage.updateOrder(orderData.id, orderData);
    } else {
      await this.storage.createOrder(orderData);
    }

    // Process refunds and line items using centralized ETL service
    await shopifyOrderETL.processOrder(shopifyOrder);
  }

  /**
   * Save a ShipStation shipment to database using centralized ETL service
   * The ETL service automatically links shipments to orders if they exist
   */
  private async saveShipStationShipment(shipmentData: any): Promise<void> {
    try {
      // Use centralized ETL service to process the shipment
      // It will automatically link to order if order number exists in database
      await shipStationShipmentETL.processShipment(shipmentData);
    } catch (error) {
      console.error(`[Backfill] Error saving shipment:`, error);
      throw error;
    }
  }

  /**
   * Broadcast job progress to WebSocket clients
   */
  private async broadcastJobProgress(jobId: string): Promise<void> {
    try {
      const job = await this.storage.getBackfillJob(jobId);
      if (job) {
        console.log(`[Backfill] Progress update: Shopify ${job.shopifyOrdersImported}/${job.shopifyOrdersTotal}, ShipStation ${job.shipstationShipmentsImported}/${job.shipstationShipmentsTotal}`);
        
        // Broadcast via WebSocket
        broadcastQueueStatus({
          shopifyQueue: 0,
          shipmentSyncQueue: 0,
          shipmentFailureCount: 0,
          shopifyQueueOldestAt: null,
          shipmentSyncQueueOldestAt: null,
          backfillActiveJob: job,
          dataHealth: {
            ordersMissingShipments: 0,
            shipmentsWithoutOrders: 0,
            orphanedShipments: 0,
            shipmentsWithoutStatus: 0,
            shipmentSyncFailures: 0,
          },
        });
      }
    } catch (error) {
      // Don't fail the backfill if broadcast fails
      console.error('[Backfill] Error broadcasting progress:', error);
    }
  }
}

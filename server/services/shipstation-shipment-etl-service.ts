/**
 * ShipStationShipmentETLService
 * 
 * Centralized service for extracting, transforming, and loading ShipStation shipment data.
 * Follows OOP principles with dependency injection for storage.
 * Used by all acquisition paths: webhooks, backfill jobs, on-hold polling, and manual sync.
 * 
 * This is the SINGLE SOURCE OF TRUTH for ShipStation shipment ETL transformations.
 */

import { storage } from '../storage';
import type { IStorage } from '../storage';
import type { InsertShipment, InsertShipmentItem, InsertShipmentTag, InsertShipmentPackage } from '@shared/schema';
import { db } from '../db';
import { shipmentItems, shipmentTags, shipmentPackages, orderItems, shipmentQcItems, shipments } from '@shared/schema';
import { eq, inArray } from 'drizzle-orm';
import { queueLifecycleEvaluation } from './lifecycle-service';

export class ShipStationShipmentETLService {
  constructor(private readonly storage: IStorage) {}

  /**
   * Main orchestration method: Process a complete ShipStation shipment
   * Handles shipment record creation/update, items, and tags
   * Automatically links to order if orderId not provided but order number exists
   * Preserves existing orderId on updates to prevent de-linking
   * Returns a result object with the shipment ID or skip information
   */
  async processShipment(shipmentData: any, orderId: string | null = null): Promise<{ id: string; skipped?: false } | { id: null; skipped: true; reason: string }> {
    // Validate shipment ID first
    const shipmentId = this.extractShipmentId(shipmentData);
    if (!shipmentId) {
      throw new Error('Shipment data missing shipment_id field');
    }
    
    // Extract tracking number and order number for lookups
    const trackingNumber = this.extractTrackingNumber(shipmentData);
    const orderNumber = this.extractOrderNumber(shipmentData);
    
    // SMART LOOKUP: Orders can have multiple shipments, so we must be careful about matching
    // Priority 1: If incoming shipment has a tracking number, find by tracking number first
    //             (tracking numbers are unique across all shipments in our schema)
    // Priority 2: Fall back to ShipStation shipment ID
    // Priority 3: Fall back to session-derived shipment by order number
    let existing: Awaited<ReturnType<typeof this.storage.getShipmentByShipmentId>> = undefined;
    
    // Priority 1: Lookup by tracking number (most reliable for updates)
    // SAFETY: Only use tracking match if shipmentId matches OR is null (session-derived placeholder)
    // This prevents overwriting a different historical shipment that happens to share the tracking number
    if (trackingNumber) {
      const trackingMatch = await this.storage.getShipmentByTrackingNumber(trackingNumber);
      if (trackingMatch) {
        const matchingShipmentId = trackingMatch.shipmentId;
        // Accept the match if:
        // 1. The existing shipment has no shipmentId (session-derived placeholder waiting for ShipStation data)
        // 2. The existing shipment has the same ShipStation shipmentId as the incoming data
        if (!matchingShipmentId || matchingShipmentId === String(shipmentId)) {
          existing = trackingMatch;
          console.log(`[ETL] Found existing shipment ${existing.id} by tracking number ${trackingNumber} (shipmentId: ${matchingShipmentId || 'null'})`);
        } else {
          // Different shipmentIds with same tracking - likely label re-generation scenario
          // Fall through to shipmentId lookup to find the correct record
          console.log(`[ETL] Tracking match ${trackingMatch.id} has different shipmentId (${matchingShipmentId} vs ${shipmentId}), continuing to shipmentId lookup`);
        }
      }
    }
    
    // Priority 2: If not found by tracking, try ShipStation shipment ID
    if (!existing) {
      existing = await this.storage.getShipmentByShipmentId(String(shipmentId));
      if (existing) {
        console.log(`[ETL] Found existing shipment ${existing.id} by ShipStation ID ${shipmentId}`);
      }
    }
    
    // If no orderId provided, try to link to existing order using order number
    let resolvedOrderId = orderId;
    
    // Priority 3 (FALLBACK): If not found by shipmentId, try to find by orderNumber
    // This handles shipments created by SkuVault session sync (which have no shipmentId yet)
    // We look for a session-derived shipment: no tracking, no shipmentId, and session is closed (ready to pack)
    if (!existing && orderNumber) {
      const shipmentsByOrder = await this.storage.getShipmentsByOrderNumber(orderNumber);
      // Find a session-derived shipment ready for label: no tracking, no shipmentId, session closed
      const sessionDerivedShipment = shipmentsByOrder.find(s => 
        !s.trackingNumber && 
        !s.shipmentId && 
        s.sessionStatus === 'closed'
      );
      if (sessionDerivedShipment) {
        console.log(`[ETL] Found session-derived shipment ${sessionDerivedShipment.id} by orderNumber ${orderNumber} (sessionStatus=closed), linking to ShipStation ID ${shipmentId}`);
        existing = sessionDerivedShipment;
      }
    }
    
    if (!resolvedOrderId) {
      // Check if existing shipment has an orderId we should preserve
      if (existing && existing.orderId) {
        // Verify the existing link is correct by checking order_number matches
        const linkedOrder = await this.storage.getOrder(existing.orderId);
        if (linkedOrder && linkedOrder.orderNumber === orderNumber) {
          // Existing link is correct, preserve it
          resolvedOrderId = existing.orderId;
        } else {
          // Existing link is wrong or order was deleted - re-lookup
          if (linkedOrder && orderNumber) {
            console.log(`[ETL] Fixing incorrect order link: shipment ${orderNumber} was linked to order ${linkedOrder.orderNumber}, re-looking up`);
          }
          if (orderNumber) {
            const correctOrder = await this.storage.getOrderByOrderNumber(orderNumber);
            if (correctOrder) {
              resolvedOrderId = correctOrder.id;
            }
          }
        }
      } else {
        // No existing link, try to find order by order number
        if (orderNumber) {
          const order = await this.storage.getOrderByOrderNumber(orderNumber);
          if (order) {
            resolvedOrderId = order.id;
          }
        }
      }
    }
    
    // Build the normalized shipment record with resolved order ID
    const shipmentRecord = this.buildShipmentRecord(shipmentData, resolvedOrderId);
    
    // Upsert (create or update) the shipment
    let finalShipmentId: string;
    
    if (existing) {
      console.log(`[ETL] Updating existing shipment ${existing.id} (ShipStation ID: ${shipmentId})`);
      console.log(`[ETL] Fresh hold_until_date: ${shipmentData?.hold_until_date || 'null'}`);
      console.log(`[ETL] Cached hold_until_date: ${(existing.shipmentData as any)?.hold_until_date || 'null'}`);
      
      // Protect carrier tracking statuses - only webhooks can set/update these
      // Carrier statuses are 2-letter codes: AC, IT, DE, UN, EX, NY, SP
      // ShipStation statuses that can be overwritten: new, shipped, pending, cancelled, label_purchased, on_hold
      const EDITABLE_STATUSES = ['new', 'shipped', 'pending', 'cancelled', 'label_purchased', 'on_hold'];
      const existingStatus = existing.status;
      
      if (existingStatus && !EDITABLE_STATUSES.includes(existingStatus)) {
        // Existing status is a carrier code - preserve it, don't overwrite
        console.log(`[ETL] Preserving carrier status '${existingStatus}' - skipping status update`);
        delete (shipmentRecord as any).status;
        delete (shipmentRecord as any).statusDescription;
      }
      
      const updatedShipment = await this.storage.updateShipment(existing.id, shipmentRecord);
      
      if (updatedShipment) {
        const updatedHoldDate = (updatedShipment.shipmentData as any)?.hold_until_date || 'null';
        console.log(`[ETL] Update succeeded - new hold_until_date in DB: ${updatedHoldDate}`);
      } else {
        console.warn(`[ETL] WARNING: updateShipment returned undefined for ${existing.id}`);
      }
      
      finalShipmentId = existing.id;
    } else {
      // Check for null order_number before creating - dead-letter if missing
      if (!orderNumber) {
        console.log(`[ETL] Dead-lettering shipment ${shipmentId} - no order_number in ShipStation data`);
        await this.storage.upsertShipmentsDeadLetter({
          shipmentId: String(shipmentId),
          data: shipmentData,
          reason: 'null_order_number',
        });
        return { id: null, skipped: true, reason: `dead-lettered: null order_number` };
      }
      
      const created = await this.storage.createShipment(shipmentRecord);
      finalShipmentId = created.id;
    }
    
    // Process normalized items, tags, and packages
    await this.processShipmentItems(finalShipmentId, shipmentData);
    await this.processShipmentTags(finalShipmentId, shipmentData);
    await this.processShipmentPackages(finalShipmentId, shipmentData);
    
    // Queue lifecycle evaluation for async processing
    // This enables side effects (like auto rate check) to be triggered reliably
    await queueLifecycleEvaluation(finalShipmentId, 'shipment_sync', orderNumber || undefined);
    
    return { id: finalShipmentId };
  }

  /**
   * Build a normalized shipment record from raw ShipStation data
   * Handles both API responses and webhook payloads
   */
  buildShipmentRecord(shipmentData: any, orderId: string | null = null): InsertShipment {
    // Extract core identifiers
    const shipmentId = this.extractShipmentId(shipmentData);
    const trackingNumber = this.extractTrackingNumber(shipmentData);
    const orderNumber = this.extractOrderNumber(shipmentData);
    
    // Extract status information - use RAW tracking status to match production behavior
    // This preserves ShipStation status codes like 'ac', 'it', 'de' instead of normalizing them
    const status = this.extractRawTrackingStatus(shipmentData);
    const statusDescription = this.extractStatusDescription(shipmentData);
    const shipmentStatus = this.extractShipmentStatus(shipmentData);
    
    // Debug logging for shipmentStatus extraction
    if (shipmentStatus) {
      console.log(`[ETL] Extracted shipmentStatus: ${shipmentStatus} for order ${this.extractOrderNumber(shipmentData)}`);
    }
    
    // Extract carrier and service
    const carrierCode = this.extractCarrierCode(shipmentData);
    const serviceCode = this.extractServiceCode(shipmentData);
    
    // Extract dates
    const orderDate = this.extractOrderDate(shipmentData);
    const shipDate = this.extractShipDate(shipmentData);
    
    // Build complete record
    return {
      orderId,
      shipmentId: shipmentId?.toString() || null,
      orderNumber,
      orderDate,
      trackingNumber,
      carrierCode,
      serviceCode,
      status,
      statusDescription,
      shipmentStatus,
      shipDate,
      ...this.extractShipToFields(shipmentData),
      ...this.extractReturnGiftFields(shipmentData),
      totalWeight: this.extractTotalWeight(shipmentData),
      ...this.extractAdvancedOptions(shipmentData),
      shippingCost: this.extractShippingCost(shipmentData),
      shipmentData,
    };
  }

  /**
   * Build a normalized fingerprint of items for comparison
   * Returns a sorted string of "SKU:QTY" pairs to detect split/merge changes
   */
  private buildItemsFingerprint(items: { sku: string | null; quantity: number }[]): string {
    return items
      .map(item => `${item.sku || 'NO_SKU'}:${item.quantity}`)
      .sort()
      .join('|');
  }

  /**
   * Process shipment items - normalize into shipment_items table
   * Deletes existing entries and re-creates from current shipmentData
   * IMPORTANT: Detects item changes (split/merge) and invalidates QC items when items change
   */
  async processShipmentItems(shipmentId: string, shipmentData: any): Promise<void> {
    if (!shipmentData || !shipmentData.items || !Array.isArray(shipmentData.items)) {
      return;
    }

    try {
      // Get existing items to detect changes
      const existingItems = await db
        .select({ sku: shipmentItems.sku, quantity: shipmentItems.quantity })
        .from(shipmentItems)
        .where(eq(shipmentItems.shipmentId, shipmentId));

      // Build fingerprints for comparison
      const existingFingerprint = this.buildItemsFingerprint(existingItems);
      const incomingFingerprint = this.buildItemsFingerprint(
        shipmentData.items.map((item: any) => ({
          sku: item.sku || null,
          quantity: item.quantity,
        }))
      );

      // Check if items have changed (split/merge detection)
      const itemsChanged = existingItems.length > 0 && existingFingerprint !== incomingFingerprint;

      if (itemsChanged) {
        console.log(`[ShipStationShipmentETL] ITEM CHANGE DETECTED for shipment ${shipmentId}`);
        console.log(`[ShipStationShipmentETL]   Old items: ${existingFingerprint}`);
        console.log(`[ShipStationShipmentETL]   New items: ${incomingFingerprint}`);

        // Invalidate QC items - delete existing ones so hydrator will re-run
        const deletedQcItems = await db
          .delete(shipmentQcItems)
          .where(eq(shipmentQcItems.shipmentId, shipmentId))
          .returning({ id: shipmentQcItems.id });

        if (deletedQcItems.length > 0) {
          console.log(`[ShipStationShipmentETL]   Deleted ${deletedQcItems.length} QC items for re-hydration`);
        }

        // Reset fingerprint so it gets recalculated
        await db
          .update(shipments)
          .set({ fingerprintId: null })
          .where(eq(shipments.id, shipmentId));

        console.log(`[ShipStationShipmentETL]   Reset fingerprintId for re-calculation`);
      }

      // Delete existing entries for this shipment (ensure clean state)
      await db.delete(shipmentItems).where(eq(shipmentItems.shipmentId, shipmentId));

      // Batch fetch all order items to avoid N+1 queries
      const externalOrderItemIds = shipmentData.items
        .map((item: any) => item.external_order_item_id)
        .filter((id: any) => id != null)
        .map((id: any) => String(id));

      const orderItemsMap = new Map<string, string>();
      if (externalOrderItemIds.length > 0) {
        const matchingOrderItems = await db
          .select()
          .from(orderItems)
          .where(inArray(orderItems.shopifyLineItemId, externalOrderItemIds));

        for (const orderItem of matchingOrderItems) {
          orderItemsMap.set(String(orderItem.shopifyLineItemId), orderItem.id);
        }
      }

      // Build items to insert with batch-resolved order item IDs
      const itemsToInsert: InsertShipmentItem[] = shipmentData.items.map((item: any) => {
        const externalId = item.external_order_item_id ? String(item.external_order_item_id) : null;
        const orderItemId = externalId ? (orderItemsMap.get(externalId) || null) : null;

        return {
          shipmentId,
          orderItemId,
          sku: item.sku || null,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unit_price?.toString() || null,
          externalOrderItemId: externalId,
          imageUrl: item.image_url || null,
        };
      });

      if (itemsToInsert.length > 0) {
        await db.insert(shipmentItems).values(itemsToInsert);
      }
    } catch (error) {
      console.error(`[ShipStationShipmentETL] Error processing items for shipment ${shipmentId}:`, error);
    }
  }

  /**
   * Process shipment tags - normalize into shipment_tags table
   * Deletes existing entries and re-creates from current shipmentData
   * Preserves tags with tagId even if name is missing (ShipStation legacy auto-tagging)
   */
  async processShipmentTags(shipmentId: string, shipmentData: any): Promise<void> {
    if (!shipmentData || !shipmentData.tags || !Array.isArray(shipmentData.tags)) {
      return;
    }

    try {
      // Delete existing entries for this shipment (ensure clean state)
      await db.delete(shipmentTags).where(eq(shipmentTags.shipmentId, shipmentId));

      // Build tags to insert, preserving tags with tagId even if name is missing
      const tagsToInsert: InsertShipmentTag[] = shipmentData.tags
        .filter((tag: any) => {
          // Skip null/undefined tags
          if (!tag) return false;
          
          // Skip tags with both null/empty name AND null tagId
          const hasName = tag.name && tag.name.trim().length > 0;
          const hasTagId = tag.tag_id !== null && tag.tag_id !== undefined;
          
          if (!hasName && !hasTagId) {
            console.log(`[ShipStationShipmentETL] Skipping tag with null name and tagId for shipment ${shipmentId}`);
            return false;
          }
          
          return true;
        })
        .map((tag: any) => ({
          shipmentId,
          tagId: tag.tag_id?.toString() || null,
          name: tag.name && tag.name.trim() ? tag.name.trim() : `Tag ${tag.tag_id}`, // Default name for legacy tags with ID only
        }));

      if (tagsToInsert.length > 0) {
        await db.insert(shipmentTags).values(tagsToInsert);
      }
    } catch (error) {
      console.error(`[ShipStationShipmentETL] Error processing tags for shipment ${shipmentId}:`, error);
    }
  }

  /**
   * Process shipment packages - normalize into shipment_packages table
   * Deletes existing entries and re-creates from current shipmentData
   * Flattens nested weight, dimensions, insured_value, and label_messages structures
   */
  async processShipmentPackages(shipmentId: string, shipmentData: any): Promise<void> {
    if (!shipmentData || !shipmentData.packages || !Array.isArray(shipmentData.packages)) {
      return;
    }

    try {
      // Delete existing entries for this shipment (ensure clean state)
      await db.delete(shipmentPackages).where(eq(shipmentPackages.shipmentId, shipmentId));

      // Build packages to insert with flattened nested structures
      const packagesToInsert: InsertShipmentPackage[] = shipmentData.packages
        .filter((pkg: any) => pkg != null)
        .map((pkg: any) => ({
          shipmentId,
          shipmentPackageId: pkg.shipment_package_id || null,
          packageId: pkg.package_id || null,
          packageCode: pkg.package_code || null,
          packageName: pkg.package_name || null,
          externalPackageId: pkg.external_package_id || null,
          contentDescription: pkg.content_description || null,
          // Flatten weight object
          weightValue: pkg.weight?.value !== undefined ? String(pkg.weight.value) : null,
          weightUnit: pkg.weight?.unit || null,
          // Flatten dimensions object
          dimensionLength: pkg.dimensions?.length !== undefined ? String(pkg.dimensions.length) : null,
          dimensionWidth: pkg.dimensions?.width !== undefined ? String(pkg.dimensions.width) : null,
          dimensionHeight: pkg.dimensions?.height !== undefined ? String(pkg.dimensions.height) : null,
          dimensionUnit: pkg.dimensions?.unit || null,
          // Flatten insured_value object
          insuredAmount: pkg.insured_value?.amount !== undefined ? String(pkg.insured_value.amount) : null,
          insuredCurrency: pkg.insured_value?.currency || null,
          // Flatten label_messages object
          labelReference1: pkg.label_messages?.reference1 || null,
          labelReference2: pkg.label_messages?.reference2 || null,
          labelReference3: pkg.label_messages?.reference3 || null,
          // Store complex objects as JSONB
          products: pkg.products || null,
          dangerousGoodsInfo: pkg.dangerous_goods_package_info || null,
        }));

      if (packagesToInsert.length > 0) {
        await db.insert(shipmentPackages).values(packagesToInsert);
      }
    } catch (error) {
      console.error(`[ShipStationShipmentETL] Error processing packages for shipment ${shipmentId}:`, error);
    }
  }

  // =================================================================
  // PRIVATE EXTRACTION METHODS
  // All field-level extraction logic encapsulated below
  // =================================================================

  /**
   * Extract shipment ID from ShipStation data
   */
  private extractShipmentId(shipmentData: any): string | null {
    return shipmentData?.shipment_id || shipmentData?.shipmentId || null;
  }

  /**
   * Extract tracking number from ShipStation data
   * Checks root object first, then nested labels array (attached by API functions)
   */
  private extractTrackingNumber(shipmentData: any): string | null {
    // Check root object first (may have been attached by API functions)
    if (shipmentData?.tracking_number) return shipmentData.tracking_number;
    if (shipmentData?.trackingNumber) return shipmentData.trackingNumber;
    
    // Check nested labels array (attached by getShipmentsByOrderNumber/getShipmentsByDateRange)
    if (Array.isArray(shipmentData?.labels) && shipmentData.labels.length > 0) {
      const label = shipmentData.labels[0];
      if (label?.tracking_number) return label.tracking_number;
      if (label?.trackingNumber) return label.trackingNumber;
    }
    
    // Check webhook formats that might have nested shipment data
    if (shipmentData?.data?.tracking_number) return shipmentData.data.tracking_number;
    if (shipmentData?.latestTracking?.tracking_number) return shipmentData.latestTracking.tracking_number;
    
    return null;
  }

  /**
   * Extract order_number from shipmentData
   * Returns the customer-facing order number (e.g., "JK3825345229")
   * Handles multiple ShipStation API response formats
   */
  private extractOrderNumber(shipmentData: any): string | null {
    // Try shipment_number / shipmentNumber (most common in webhooks)
    if (shipmentData?.shipment_number) return shipmentData.shipment_number;
    if (shipmentData?.shipmentNumber) return shipmentData.shipmentNumber;
    
    // Try order_number (common in API responses)
    if (shipmentData?.order_number) return shipmentData.order_number;
    if (shipmentData?.orderNumber) return shipmentData.orderNumber;
    
    // Try nested shipment object (some webhook variants)
    if (shipmentData?.shipment?.shipment_number) return shipmentData.shipment.shipment_number;
    if (shipmentData?.shipment?.shipmentNumber) return shipmentData.shipment.shipmentNumber;
    if (shipmentData?.shipment?.order_number) return shipmentData.shipment.order_number;
    if (shipmentData?.shipment?.orderNumber) return shipmentData.shipment.orderNumber;
    
    return null;
  }

  /**
   * Extract order_date from shipmentData
   * Returns the ShipStation shipment creation timestamp (ISO 8601 format)
   */
  private extractOrderDate(shipmentData: any): Date | null {
    const dateStr = shipmentData?.create_date || shipmentData?.createDate || 
                    shipmentData?.created_at || shipmentData?.createdAt;
    
    if (!dateStr) {
      return null;
    }
    
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract carrier code from ShipStation data
   */
  private extractCarrierCode(shipmentData: any): string | null {
    return shipmentData?.carrier_code || shipmentData?.carrierCode || null;
  }

  /**
   * Extract service code from ShipStation data
   */
  private extractServiceCode(shipmentData: any): string | null {
    return shipmentData?.service_code || shipmentData?.serviceCode || null;
  }

  /**
   * Extract ship date from ShipStation data
   */
  private extractShipDate(shipmentData: any): Date | null {
    const dateStr = shipmentData?.ship_date || shipmentData?.shipDate;
    if (!dateStr) {
      return null;
    }
    
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract ship_to customer fields from shipmentData
   */
  private extractShipToFields(shipmentData: any) {
    const shipTo = shipmentData?.ship_to || {};
    return {
      shipToName: shipTo.name || null,
      shipToPhone: shipTo.phone || null,
      shipToEmail: shipTo.email || null,
      shipToCompany: shipTo.company || null,
      shipToAddressLine1: shipTo.address_line1 || null,
      shipToAddressLine2: shipTo.address_line2 || null,
      shipToAddressLine3: shipTo.address_line3 || null,
      shipToCity: shipTo.city_locality || null,
      shipToState: shipTo.state_province || null,
      shipToPostalCode: shipTo.postal_code || null,
      shipToCountry: shipTo.country_code || null,
      shipToIsResidential: shipTo.address_residential_indicator || null,
    };
  }

  /**
   * Extract return and gift information from shipmentData
   */
  private extractReturnGiftFields(shipmentData: any) {
    return {
      isReturn: shipmentData?.is_return ?? null,
      isGift: shipmentData?.is_gift ?? null,
      notesForGift: shipmentData?.gift_message || null,
      notesFromBuyer: shipmentData?.customer_notes || null,
    };
  }

  /**
   * Extract total_weight from shipmentData
   * Concatenates value and unit into a single string (e.g., "2.5 pounds")
   */
  private extractTotalWeight(shipmentData: any): string | null {
    const totalWeight = shipmentData?.total_weight;
    if (!totalWeight || typeof totalWeight !== 'object') {
      return null;
    }
    
    const value = totalWeight.value;
    const unit = totalWeight.unit;
    
    if (value !== null && value !== undefined && unit) {
      return `${value} ${unit}`;
    }
    
    return null;
  }

  /**
   * Extract all advanced_options fields from shipmentData
   */
  private extractAdvancedOptions(shipmentData: any) {
    const advOpts = shipmentData?.advanced_options || {};
    
    return {
      billToAccount: advOpts.bill_to_account || null,
      billToCountryCode: advOpts.bill_to_country_code || null,
      billToParty: advOpts.bill_to_party || null,
      billToPostalCode: advOpts.bill_to_postal_code || null,
      billToName: advOpts.bill_to_name || null,
      billToAddressLine1: advOpts.bill_to_address_line1 || null,
      containsAlcohol: advOpts.contains_alcohol ?? null,
      deliveredDutyPaid: advOpts.delivered_duty_paid ?? null,
      nonMachinable: advOpts.non_machinable ?? null,
      saturdayDelivery: advOpts.saturday_delivery ?? null,
      dryIce: advOpts.dry_ice ?? null,
      dryIceWeight: advOpts.dry_ice_weight || null,
      fedexFreight: advOpts.fedex_freight || null,
      thirdPartyConsignee: advOpts.third_party_consignee ?? null,
      guaranteedDutiesAndTaxes: advOpts.guaranteed_duties_and_taxes ?? null,
      ancillaryEndorsementsOption: advOpts.ancillary_endorsements_option || null,
      freightClass: advOpts.freight_class || null,
      customField1: advOpts.custom_field1 || null,
      customField2: advOpts.custom_field2 || null,
      customField3: advOpts.custom_field3 || null,
      collectOnDelivery: advOpts.collect_on_delivery || null,
      returnPickupAttempts: advOpts.return_pickup_attempts || null,
      additionalHandling: advOpts.additional_handling ?? null,
      ownDocumentUpload: advOpts.own_document_upload ?? null,
      limitedQuantity: advOpts.limited_quantity ?? null,
      eventNotification: advOpts.event_notification ?? null,
      importServices: advOpts.import_services ?? null,
      overrideHoliday: advOpts.override_holiday ?? null,
    };
  }

  /**
   * Extract shipping cost from labels array
   * The unified sync attaches labels from /v2/labels endpoint to shipmentData.labels
   * Each label has shipment_cost: { currency: "usd", amount: 18.49 }
   */
  private extractShippingCost(shipmentData: any): string | null {
    // Check if labels array exists (attached by unified sync from /v2/labels endpoint)
    if (Array.isArray(shipmentData?.labels) && shipmentData.labels.length > 0) {
      const label = shipmentData.labels[0];
      // ShipStation V2 API returns shipment_cost as { currency: "usd", amount: 18.49 }
      const cost = label?.shipment_cost?.amount;
      if (cost !== null && cost !== undefined) {
        return cost.toString();
      }
    }
    
    // Fallback: check root level (may be attached directly in some cases)
    if (shipmentData?.shipment_cost?.amount !== null && shipmentData?.shipment_cost?.amount !== undefined) {
      return shipmentData.shipment_cost.amount.toString();
    }
    
    return null;
  }

  /**
   * Extract the raw shipment lifecycle status from ShipStation
   * Searches common nesting patterns as ShipStation API varies payload structure
   */
  private extractShipmentStatus(shipmentData: any): string | null {
    if (!shipmentData) return null;
    
    // DEBUG: Log what keys are at top level for on_hold shipments
    const orderNumber = this.extractOrderNumber(shipmentData);
    const topLevelStatus = shipmentData.shipment_status || shipmentData.shipmentStatus;
    if (!topLevelStatus && orderNumber && orderNumber.startsWith('JK')) {
      console.log(`[ETL] [DEBUG] No top-level shipment_status for ${orderNumber}. Keys:`, Object.keys(shipmentData).slice(0, 20).join(', '));
    }
    
    // Check top-level fields first
    if (shipmentData.shipment_status) return shipmentData.shipment_status;
    if (shipmentData.shipmentStatus) return shipmentData.shipmentStatus;
    
    // Check top-level advancedOptions (recent API versions, both camelCase and snake_case)
    if (shipmentData.advancedOptions?.shipmentStatus) {
      return shipmentData.advancedOptions.shipmentStatus;
    }
    if (shipmentData.advancedOptions?.shipment_status) {
      return shipmentData.advancedOptions.shipment_status;
    }
    if (shipmentData.advanced_options?.shipment_status) {
      return shipmentData.advanced_options.shipment_status;
    }
    if (shipmentData.advanced_options?.shipmentStatus) {
      return shipmentData.advanced_options.shipmentStatus;
    }
    
    // Check nested shipment object (common in webhook payloads)
    if (shipmentData.shipment) {
      if (shipmentData.shipment.shipment_status) return shipmentData.shipment.shipment_status;
      if (shipmentData.shipment.shipmentStatus) return shipmentData.shipment.shipmentStatus;
      
      // Check advancedOptions within nested shipment
      if (shipmentData.shipment.advancedOptions?.shipmentStatus) {
        return shipmentData.shipment.advancedOptions.shipmentStatus;
      }
      if (shipmentData.shipment.advancedOptions?.shipment_status) {
        return shipmentData.shipment.advancedOptions.shipment_status;
      }
      if (shipmentData.shipment.advanced_options?.shipment_status) {
        return shipmentData.shipment.advanced_options.shipment_status;
      }
      if (shipmentData.shipment.advanced_options?.shipmentStatus) {
        return shipmentData.shipment.advanced_options.shipmentStatus;
      }
      
      // Check double-nested shipment.shipment (some webhook variants)
      if (shipmentData.shipment.shipment) {
        if (shipmentData.shipment.shipment.shipment_status) {
          return shipmentData.shipment.shipment.shipment_status;
        }
        if (shipmentData.shipment.shipment.shipmentStatus) {
          return shipmentData.shipment.shipment.shipmentStatus;
        }
        
        // Check advancedOptions within double-nested shipment
        if (shipmentData.shipment.shipment.advancedOptions?.shipmentStatus) {
          return shipmentData.shipment.shipment.advancedOptions.shipmentStatus;
        }
        if (shipmentData.shipment.shipment.advancedOptions?.shipment_status) {
          return shipmentData.shipment.shipment.advancedOptions.shipment_status;
        }
        if (shipmentData.shipment.shipment.advanced_options?.shipment_status) {
          return shipmentData.shipment.shipment.advanced_options.shipment_status;
        }
        if (shipmentData.shipment.shipment.advanced_options?.shipmentStatus) {
          return shipmentData.shipment.shipment.advanced_options.shipmentStatus;
        }
      }
    }
    
    return null;
  }

  /**
   * Check if shipment has a voided label
   * ShipStation stores voided status in multiple places:
   * - Top-level: shipmentData.voided
   * - Inside labels array: labels[0].voided or labels[0].status === 'voided'
   */
  private isLabelVoided(shipmentData: any): boolean {
    // Check top-level voided flag
    if (shipmentData.voided === true) {
      return true;
    }
    
    // Check labels array for voided status
    const labels = shipmentData.labels;
    if (Array.isArray(labels) && labels.length > 0) {
      const label = labels[0];
      if (label.voided === true || label.status === 'voided') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Extract raw tracking status code from ShipStation data
   * Preserves the original status codes like 'AC', 'IT', 'DE', 'UN', etc. (UPPERCASE)
   * This is used for the 'status' field to match production behavior where webhooks
   * store uppercase codes from ShipStation tracking updates.
   * 
   * Fallback hierarchy for shipments without tracking updates:
   * 1. voided → 'cancelled'
   * 2. on_hold → 'pending'
   * 3. awaiting_shipment → 'pending' (pre-label state)
   * 4. cancelled → 'cancelled'
   * 5. otherwise → 'shipped' (including label_purchased - only webhooks provide actual status codes)
   */
  private extractRawTrackingStatus(shipmentData: any): string {
    if (!shipmentData) return 'pending';
    
    // Check for voided shipments first
    if (this.isLabelVoided(shipmentData)) {
      return 'cancelled';
    }
    
    // Extract raw tracking status code (both camelCase and snake_case)
    const trackingStatus = shipmentData.status_code || shipmentData.statusCode;
    if (trackingStatus) {
      // Return the raw status code UPPERCASE to match production webhook behavior
      return String(trackingStatus).toUpperCase();
    }
    
    // For shipments without tracking updates, use lifecycle status with proper fallbacks
    const shipmentStatus = this.extractShipmentStatus(shipmentData);
    
    // on_hold → 'pending' - awaiting warehouse processing
    if (shipmentStatus === 'on_hold') {
      return 'pending';
    }
    
    // awaiting_shipment → 'pending' - pre-label state
    if (shipmentStatus === 'awaiting_shipment') {
      return 'pending';
    }
    
    // cancelled → 'cancelled'
    if (shipmentStatus === 'cancelled') {
      return 'cancelled';
    }
    
    // Default fallback for other states (including label_purchased)
    // Only webhooks provide actual tracking status codes like AC, IT, DE
    // Use 'new' as default - sync should never set carrier statuses
    return 'new';
  }

  /**
   * Extract status description from ShipStation data
   */
  private extractStatusDescription(shipmentData: any): string {
    if (!shipmentData) return 'Pending';
    
    // Check for voided
    if (this.isLabelVoided(shipmentData)) {
      return 'Label voided';
    }
    
    // Try to get carrier status description
    const description = shipmentData.carrier_status_description || 
                       shipmentData.status_description ||
                       shipmentData.statusDescription;
    if (description) {
      return description;
    }
    
    // Generate description based on status
    const shipmentStatus = this.extractShipmentStatus(shipmentData);
    if (shipmentStatus === 'label_purchased') {
      return 'Accepted - carrier awaiting pickup';
    }
    if (shipmentStatus === 'on_hold') {
      return 'On hold - awaiting warehouse processing';
    }
    
    return 'Shipment created';
  }

  /**
   * Normalize ShipStation status to our internal status values
   * Handles voided, delivered, in_transit, on_hold, etc.
   * @deprecated Use extractRawTrackingStatus instead to preserve raw status codes
   */
  private normalizeShipmentStatus(shipmentData: any): { status: string; statusDescription: string } {
    const voided = this.isLabelVoided(shipmentData);
    const shipmentStatus = this.extractShipmentStatus(shipmentData);
    
    // Handle voided shipments first
    if (voided) {
      return { status: 'cancelled', statusDescription: 'Label voided' };
    }
    
    // Handle tracking updates (tracking webhooks use different fields)
    const trackingStatus = shipmentData.status_code || shipmentData.statusCode;
    if (trackingStatus === 'DE' || trackingStatus === 'delivered') {
      return { status: 'delivered', statusDescription: 'Package delivered' };
    }
    if (trackingStatus && trackingStatus !== 'UN') {
      return { status: 'in_transit', statusDescription: shipmentData.status_description || 'Package in transit' };
    }
    
    // Handle ShipStation lifecycle statuses
    if (shipmentStatus === 'on_hold') {
      return { status: 'pending', statusDescription: 'On hold - awaiting warehouse processing' };
    }
    if (shipmentStatus === 'cancelled') {
      return { status: 'cancelled', statusDescription: 'Shipment cancelled' };
    }
    
    // Default for newly created shipments without tracking updates
    return { status: 'shipped', statusDescription: 'Shipment created' };
  }
}

// Export singleton instance for convenience
export const shipStationShipmentETL = new ShipStationShipmentETLService(storage);

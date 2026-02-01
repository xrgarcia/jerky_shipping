/**
 * Smart Carrier Rate Service
 * 
 * Analyzes shipments to find the most cost-effective shipping method
 * that still meets the customer's expected delivery timeframe.
 * 
 * Uses ShipStation's V2 Rates API to compare carriers and services.
 */

import { db } from '../db';
import { shipmentRateAnalysis, shipments } from '@shared/schema';
import type { InsertShipmentRateAnalysis, Shipment } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { updateShipmentLifecycle } from './lifecycle-service';
import { getCarriers, getRatesEstimate } from '../utils/shipstation-api';
import { RateCheckEligibility } from './rate-check-eligibility';

const FULFILLMENT_CENTER = {
  address: "4132 Will Rogers Pkwy",
  city: "Oklahoma City",
  state: "OK",
  postal_code: "73108",
  country: "US"
};

interface ShipStationRate {
  rate_id: string;
  rate_type: string;
  carrier_id: string;
  carrier_code?: string;
  carrier_friendly_name?: string;
  service_code: string;
  service_type?: string;
  shipping_amount: {
    currency: string;
    amount: number;
  };
  insurance_amount?: {
    currency: string;
    amount: number;
  };
  delivery_days?: number;
  estimated_delivery_date?: string;
  trackable?: boolean;
  validation_status?: string;
}

interface RateAnalysisResult {
  success: boolean;
  analysis?: InsertShipmentRateAnalysis;
  error?: string;
}

interface RatesResponse {
  rates: ShipStationRate[];
  invalid_rates?: any[];
  rate_request_id?: string;
}

interface ShipStationCarrier {
  carrier_id: string;
  carrier_code: string;
  account_number?: string;
  nickname?: string;
  is_primary?: boolean;
  is_disabled_by_billing_plan?: boolean;
}

interface CarriersCache {
  carriers: ShipStationCarrier[];
  fetchedAt: Date;
}

export class SmartCarrierRateService {
  private carriersCache: CarriersCache | null = null;
  
  /**
   * Fetch all carriers configured in ShipStation account.
   * Uses the centralized ShipStation API service with rate limiting.
   * Caches the result for the duration of the batch run.
   */
  async fetchCarriers(forceRefresh = false): Promise<ShipStationCarrier[]> {
    if (this.carriersCache && !forceRefresh) {
      const cacheAge = Date.now() - this.carriersCache.fetchedAt.getTime();
      const maxAge = 60 * 60 * 1000; // 1 hour
      if (cacheAge < maxAge) {
        return this.carriersCache.carriers;
      }
    }
    
    const result = await getCarriers();
    const carriers: ShipStationCarrier[] = result.data || [];
    
    this.carriersCache = {
      carriers,
      fetchedAt: new Date(),
    };
    
    console.log(`[SmartCarrierRate] Fetched ${carriers.length} carriers from ShipStation`);
    return carriers;
  }
  
  /**
   * Get carrier IDs for rate filtering
   */
  async getCarrierIds(): Promise<string[]> {
    const carriers = await this.fetchCarriers();
    return carriers
      .filter(c => !c.is_disabled_by_billing_plan)
      .map(c => c.carrier_id);
  }
  
  /**
   * Clear carriers cache (useful at start of new batch run)
   */
  clearCarriersCache(): void {
    this.carriersCache = null;
  }
  
  /**
   * Analyze a shipment and find the most cost-effective shipping method
   * that meets the customer's expected delivery timeframe.
   * 
   * Logic:
   * 1. Get package details (fingerprint's packaging first, ShipStation fallback)
   * 2. Fetch rates using package details or ShipStation shipment API
   * 3. Find customer's selected rate and its delivery days
   * 4. Filter to rates that deliver in same or fewer days
   * 5. Pick the cheapest from eligible rates
   * 6. Track whether fallback package data was used
   */
  async analyzeShipment(shipment: Shipment): Promise<RateAnalysisResult> {
    // Use centralized eligibility checker for validation
    const eligibility = await RateCheckEligibility.checkWithPackageData(shipment);
    
    if (!eligibility.eligible) {
      return { success: false, error: eligibility.reason || 'Eligibility check failed' };
    }
    
    const shipmentId = shipment.shipmentId!;
    const customerMethod = shipment.serviceCode!;
    
    try {
      console.log(`[SmartCarrierRate] Using package for ${shipmentId}: ${eligibility.weightOz?.toFixed(2)}oz, ${eligibility.packagingName}`);
      
      // Use rates estimate API with shipment_id only - ShipStation uses the existing shipment's details
      const rates = await this.fetchRatesEstimate({
        shipmentId,
      });
      const usedFallback = false;
      
      if (!rates || rates.length === 0) {
        return { success: false, error: 'No rates returned from ShipStation' };
      }
      
      // Find customer's rate to get their expected delivery days
      const customerRate = rates.find(r => r.service_code === customerMethod);
      let customerDeliveryDays = customerRate?.delivery_days || null;
      let customerCost = customerRate?.shipping_amount?.amount || null;
      
      // If customer rate not found in available rates, use conservative defaults
      // based on service code naming patterns
      if (!customerRate) {
        console.log(`[SmartCarrierRate] Customer method ${customerMethod} not found in rates, using service-based estimate`);
        
        // Estimate delivery days from service code pattern
        if (customerMethod.includes('express') || customerMethod.includes('overnight') || customerMethod.includes('next_day')) {
          customerDeliveryDays = 1;
        } else if (customerMethod.includes('priority') || customerMethod.includes('2day') || customerMethod.includes('expedited')) {
          customerDeliveryDays = 2;
        } else if (customerMethod.includes('3day')) {
          customerDeliveryDays = 3;
        } else {
          // Default to ground service timeline (5 business days)
          customerDeliveryDays = 5;
        }
      }
      
      // Filter to rates that meet delivery requirement
      // Only include rates with valid delivery_days and cost
      let eligibleRates = rates.filter(r => 
        r.shipping_amount?.amount !== undefined &&
        r.delivery_days !== undefined &&
        r.delivery_days !== null
      );
      
      // If we have a customer delivery expectation, filter by it
      if (customerDeliveryDays) {
        eligibleRates = eligibleRates.filter(r => r.delivery_days! <= customerDeliveryDays!);
      }
      
      // Sort by price (cheapest first)
      const sortedByPrice = eligibleRates.sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount);
      
      if (sortedByPrice.length === 0) {
        return { success: false, error: `No rates found that deliver within ${customerDeliveryDays} days` };
      }
      
      const smartRate = sortedByPrice[0];
      const smartCost = smartRate.shipping_amount.amount;
      const savings = customerCost ? customerCost - smartCost : 0;
      
      // Build human-readable reasoning with package source
      const packageSource = usedFallback ? '(ShipStation package data)' : '(using assigned packaging)';
      let reasoning: string;
      if (smartRate.service_code === customerMethod) {
        reasoning = `Customer's choice (${customerMethod}) is the most cost-effective option at $${smartCost.toFixed(2)} ${packageSource}`;
      } else if (!customerRate) {
        reasoning = `${smartRate.service_code} recommended at $${smartCost.toFixed(2)} (${smartRate.delivery_days} days) ${packageSource} - customer's ${customerMethod} not available for comparison`;
      } else if (savings > 0) {
        reasoning = `${smartRate.service_code} saves $${savings.toFixed(2)} vs ${customerMethod} with ${smartRate.delivery_days}-day delivery (same or faster) ${packageSource}`;
      } else {
        reasoning = `${smartRate.service_code} at $${smartCost.toFixed(2)} is the cheapest option for ${smartRate.delivery_days}-day delivery ${packageSource}`;
      }
      
      // Build allRatesChecked from the full rates array
      const allRatesChecked: Array<{
        carrier: string;
        service: string;
        cost: number;
        deliveryDays: number | null;
      }> = rates.map(r => ({
        carrier: r.carrier_code || 'unknown',
        service: r.service_code,
        cost: r.shipping_amount?.amount || 0,
        deliveryDays: r.delivery_days ?? null,
      })).sort((a, b) => a.cost - b.cost);
      
      const analysis: InsertShipmentRateAnalysis = {
        shipmentId,
        customerShippingMethod: customerMethod,
        customerShippingCost: customerCost?.toString() || null,
        customerDeliveryDays: customerDeliveryDays,
        smartShippingMethod: smartRate.service_code,
        smartShippingCost: smartCost.toString(),
        smartDeliveryDays: smartRate.delivery_days || null,
        costSavings: savings.toString(),
        reasoning,
        ratesComparedCount: rates.length,
        carrierCode: smartRate.carrier_code || null,
        serviceCode: smartRate.service_code,
        originPostalCode: FULFILLMENT_CENTER.postal_code,
        destinationPostalCode: shipment.shipToPostalCode,
        destinationState: shipment.shipToState || null,
        // Package tracking fields
        usedFallbackPackageDetails: usedFallback,
        packageWeightOz: eligibility.weightOz?.toString() || null,
        packageLengthIn: eligibility.lengthIn?.toString() || null,
        packageWidthIn: eligibility.widthIn?.toString() || null,
        packageHeightIn: eligibility.heightIn?.toString() || null,
        // All rates checked for transparency
        allRatesChecked,
      };
      
      return { success: true, analysis };
      
    } catch (error: any) {
      console.error(`[SmartCarrierRate] Error analyzing shipment ${shipmentId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Analyze and save rate analysis for a shipment
   */
  async analyzeAndSave(shipment: Shipment): Promise<RateAnalysisResult> {
    const result = await this.analyzeShipment(shipment);
    
    if (!result.success || !result.analysis) {
      console.log(`[SmartCarrierRate] Analysis failed for ${shipment.shipmentId}: ${result.error}`);
      return result;
    }
    
    try {
      await db
        .insert(shipmentRateAnalysis)
        .values(result.analysis)
        .onConflictDoUpdate({
          target: shipmentRateAnalysis.shipmentId,
          set: {
            customerShippingMethod: result.analysis.customerShippingMethod,
            customerShippingCost: result.analysis.customerShippingCost,
            customerDeliveryDays: result.analysis.customerDeliveryDays,
            smartShippingMethod: result.analysis.smartShippingMethod,
            smartShippingCost: result.analysis.smartShippingCost,
            smartDeliveryDays: result.analysis.smartDeliveryDays,
            costSavings: result.analysis.costSavings,
            reasoning: result.analysis.reasoning,
            ratesComparedCount: result.analysis.ratesComparedCount,
            carrierCode: result.analysis.carrierCode,
            serviceCode: result.analysis.serviceCode,
            destinationPostalCode: result.analysis.destinationPostalCode,
            destinationState: result.analysis.destinationState,
            allRatesChecked: result.analysis.allRatesChecked,
            updatedAt: new Date(),
          },
        });
      
      console.log(`[SmartCarrierRate] Saved analysis for shipment ${shipment.shipmentId}: ${result.analysis.reasoning}`);
      
      // Trigger lifecycle update to advance from needs_rate_check subphase
      try {
        await updateShipmentLifecycle(shipment.id, { logTransition: true });
      } catch (lifecycleError: any) {
        console.warn(`[SmartCarrierRate] Failed to update lifecycle for ${shipment.id}:`, lifecycleError.message);
      }
      
      return result;
      
    } catch (error: any) {
      console.error(`[SmartCarrierRate] Error saving analysis for ${shipment.shipmentId}:`, error);
      return { success: false, error: `Failed to save: ${error.message}` };
    }
  }
  
  /**
   * Batch analyze multiple shipments
   */
  async analyzeShipmentsBatch(shipmentIds: string[], onProgress?: (completed: number, total: number) => void): Promise<{
    success: number;
    failed: number;
    errors: string[];
  }> {
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Fetch and cache carriers at start of batch run
    try {
      this.clearCarriersCache();
      const carriers = await this.fetchCarriers();
      console.log(`[SmartCarrierRate] Batch started with ${carriers.length} carriers: ${carriers.map(c => c.carrier_code).join(', ')}`);
    } catch (error: any) {
      console.warn(`[SmartCarrierRate] Failed to fetch carriers, continuing without filter:`, error.message);
    }
    
    for (let i = 0; i < shipmentIds.length; i++) {
      const shipmentId = shipmentIds[i];
      
      try {
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.shipmentId, shipmentId))
          .limit(1);
        
        if (!shipment) {
          errors.push(`Shipment ${shipmentId} not found`);
          failed++;
          continue;
        }
        
        const result = await this.analyzeAndSave(shipment);
        
        if (result.success) {
          success++;
        } else {
          errors.push(`${shipmentId}: ${result.error}`);
          failed++;
        }
        
      } catch (error: any) {
        errors.push(`${shipmentId}: ${error.message}`);
        failed++;
      }
      
      if (onProgress) {
        onProgress(i + 1, shipmentIds.length);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return { success, failed, errors };
  }
  
  /**
   * Fetch rates using shipment details with the existing ShipStation shipment ID
   * Uses the centralized ShipStation API service with rate limiting
   */
  async fetchRatesEstimate(params: {
    shipmentId: string;  // ShipStation shipment ID (e.g., "se-950536244")
  }): Promise<ShipStationRate[]> {
    // Get enabled carrier IDs for rate options
    const carrierIds = await this.getCarrierIds();
    
    if (carrierIds.length === 0) {
      console.warn(`[SmartCarrierRate] No enabled carriers found, cannot fetch rate estimate`);
      throw new Error('No enabled carriers available for rate estimation');
    }
    
    console.log(`[SmartCarrierRate] Requesting rates for shipment ${params.shipmentId} with ${carrierIds.length} carriers`);
    
    // Use shipment_id with rate_options only - ShipStation uses the existing shipment's details
    // DO NOT include a shipment object - that creates duplicate empty orders
    const requestBody = {
      shipment_id: params.shipmentId,
      rate_options: {
        carrier_ids: carrierIds,
      },
    };
    
    const result = await getRatesEstimate(requestBody);
    return result.data;
  }
  
  /**
   * Get existing rate analysis for a shipment
   */
  async getAnalysis(shipmentId: string): Promise<InsertShipmentRateAnalysis | null> {
    const [existing] = await db
      .select()
      .from(shipmentRateAnalysis)
      .where(eq(shipmentRateAnalysis.shipmentId, shipmentId))
      .limit(1);
    
    return existing || null;
  }
}

export const smartCarrierRateService = new SmartCarrierRateService();

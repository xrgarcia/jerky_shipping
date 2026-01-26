/**
 * Smart Carrier Rate Service
 * 
 * Analyzes shipments to find the most cost-effective shipping method
 * that still meets the customer's expected delivery timeframe.
 * 
 * Uses ShipStation's V2 Rates API to compare carriers and services.
 */

import { db } from '../db';
import { shipmentRateAnalysis, shipments, fingerprints, fingerprintModels, packagingTypes } from '@shared/schema';
import type { InsertShipmentRateAnalysis, Shipment } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { updateShipmentLifecycle } from './lifecycle-service';
import { getRatesForShipment, getCarriers, getRatesEstimate } from '../utils/shipstation-api';

// Package details for rate calculation
interface PackageDetails {
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  usedFallback: boolean;
  source: string;
}

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
   * Get package details for rate calculation.
   * Priority: 1) Fingerprint's assigned packaging + weight, 2) ShipStation shipment data
   * 
   * Returns package dimensions and weight, along with whether fallback was used.
   */
  async getPackageDetails(shipment: Shipment): Promise<PackageDetails | null> {
    // Try to get package details from fingerprint's assigned packaging
    if (shipment.fingerprintId) {
      try {
        // Get the fingerprint with its weight
        const [fingerprint] = await db
          .select()
          .from(fingerprints)
          .where(eq(fingerprints.id, shipment.fingerprintId))
          .limit(1);
        
        // Get the assigned packaging model
        const [model] = await db
          .select()
          .from(fingerprintModels)
          .where(eq(fingerprintModels.fingerprintId, shipment.fingerprintId))
          .limit(1);
        
        if (fingerprint && model?.packagingTypeId) {
          // Get the packaging type dimensions
          const [packaging] = await db
            .select()
            .from(packagingTypes)
            .where(eq(packagingTypes.id, model.packagingTypeId))
            .limit(1);
          
          if (packaging && fingerprint.totalWeight) {
            // Convert weight to ounces if needed
            let weightOz = fingerprint.totalWeight;
            if (fingerprint.weightUnit === 'lb' || fingerprint.weightUnit === 'pound' || fingerprint.weightUnit === 'pounds') {
              weightOz = fingerprint.totalWeight * 16;
            }
            
            const packageDetails: PackageDetails = {
              weightOz,
              usedFallback: false,
              source: `Fingerprint packaging: ${packaging.name}`,
            };
            
            // Add dimensions if available
            if (packaging.dimensionLength && packaging.dimensionWidth && packaging.dimensionHeight) {
              packageDetails.lengthIn = parseFloat(packaging.dimensionLength);
              packageDetails.widthIn = parseFloat(packaging.dimensionWidth);
              packageDetails.heightIn = parseFloat(packaging.dimensionHeight);
            }
            
            console.log(`[SmartCarrierRate] Using fingerprint package for ${shipment.shipmentId}: ${weightOz.toFixed(2)}oz, ${packaging.name}`);
            return packageDetails;
          }
        }
      } catch (error: any) {
        console.warn(`[SmartCarrierRate] Error fetching fingerprint package for ${shipment.shipmentId}:`, error.message);
      }
    }
    
    // Fallback: Use ShipStation shipment's weight data
    if (shipment.totalWeight) {
      // Parse weight from "value unit" format (e.g., "2.5 pounds")
      const weightMatch = shipment.totalWeight.match(/^([\d.]+)\s*(\w+)?$/);
      if (weightMatch) {
        let weightValue = parseFloat(weightMatch[1]);
        const unit = (weightMatch[2] || 'oz').toLowerCase();
        
        // Convert to ounces
        let weightOz = weightValue;
        if (unit.includes('pound') || unit.includes('lb')) {
          weightOz = weightValue * 16;
        } else if (unit.includes('kg')) {
          weightOz = weightValue * 35.274;
        } else if (unit.includes('gram') || unit === 'g') {
          weightOz = weightValue * 0.03527;
        }
        
        console.log(`[SmartCarrierRate] Using ShipStation fallback weight for ${shipment.shipmentId}: ${weightOz.toFixed(2)}oz (from ${shipment.totalWeight})`);
        return {
          weightOz,
          usedFallback: true,
          source: `ShipStation shipment weight: ${shipment.totalWeight}`,
        };
      }
    }
    
    // No weight data available
    return null;
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
    const shipmentId = shipment.shipmentId;
    
    if (!shipmentId) {
      return { success: false, error: 'Shipment has no ShipStation ID' };
    }
    
    if (!shipment.shipToPostalCode) {
      return { success: false, error: 'Shipment has no destination postal code' };
    }
    
    const customerMethod = shipment.serviceCode;
    if (!customerMethod) {
      return { success: false, error: 'Shipment has no service code' };
    }
    
    try {
      // Get package details (prefer fingerprint's assigned packaging, fallback to ShipStation)
      const packageDetails = await this.getPackageDetails(shipment);
      
      let rates: ShipStationRate[];
      let usedFallback = true; // Default to true if no package details
      
      if (packageDetails && !packageDetails.usedFallback) {
        // Use rates estimate API with fingerprint's package dimensions
        rates = await this.fetchRatesEstimate({
          destinationPostalCode: shipment.shipToPostalCode,
          destinationCity: shipment.shipToCity || undefined,
          destinationState: shipment.shipToState || undefined,
          weightOunces: packageDetails.weightOz,
          lengthInches: packageDetails.lengthIn,
          widthInches: packageDetails.widthIn,
          heightInches: packageDetails.heightIn,
        });
        usedFallback = false;
      } else {
        // Use ShipStation's shipment rates API (uses their stored package data)
        rates = await this.fetchRatesForShipment(shipmentId);
      }
      
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
        packageWeightOz: packageDetails?.weightOz?.toString() || null,
        packageLengthIn: packageDetails?.lengthIn?.toString() || null,
        packageWidthIn: packageDetails?.widthIn?.toString() || null,
        packageHeightIn: packageDetails?.heightIn?.toString() || null,
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
    // Temporarily disabled - remove this return to re-enable
    return { success: false, error: 'Rate analysis temporarily disabled' };
    
    const result = await this.analyzeShipment(shipment);
    
    if (!result.success || !result.analysis) {
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
   * Fetch rates for a shipment from ShipStation using the centralized API service
   * Includes rate limiting, retry logic, and proper error handling
   */
  private async fetchRatesForShipment(shipmentId: string): Promise<ShipStationRate[]> {
    const result = await getRatesForShipment(shipmentId);
    return result.data;
  }
  
  /**
   * Fetch rates using shipment details (for shipments not yet in ShipStation)
   * Uses the centralized ShipStation API service with rate limiting
   */
  async fetchRatesEstimate(params: {
    destinationPostalCode: string;
    destinationCity?: string;
    destinationState?: string;
    weightOunces: number;
    lengthInches?: number;
    widthInches?: number;
    heightInches?: number;
  }): Promise<ShipStationRate[]> {
    // Get enabled carrier IDs for rate options
    const carrierIds = await this.getCarrierIds();
    
    if (carrierIds.length === 0) {
      console.warn(`[SmartCarrierRate] No enabled carriers found, cannot fetch rate estimate`);
      throw new Error('No enabled carriers available for rate estimation');
    }
    
    const requestBody: any = {
      shipment: {
        validate_address: 'no_validation',
        ship_from: {
          name: "Jerky.com",
          phone: "4055551212", // Required by ShipStation API
          address_line1: FULFILLMENT_CENTER.address,
          city_locality: FULFILLMENT_CENTER.city,
          state_province: FULFILLMENT_CENTER.state,
          postal_code: FULFILLMENT_CENTER.postal_code,
          country_code: FULFILLMENT_CENTER.country,
        },
        ship_to: {
          name: "Customer", // Required by ShipStation API
          phone: "0000000000", // Placeholder - required by API but not used for rating
          postal_code: params.destinationPostalCode,
          country_code: "US",
          ...(params.destinationCity && { city_locality: params.destinationCity }),
          ...(params.destinationState && { state_province: params.destinationState }),
        },
        packages: [{
          weight: {
            value: params.weightOunces,
            unit: "ounce"
          },
          ...(params.lengthInches && params.widthInches && params.heightInches && {
            dimensions: {
              unit: "inch",
              length: params.lengthInches,
              width: params.widthInches,
              height: params.heightInches,
            }
          }),
        }],
      },
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

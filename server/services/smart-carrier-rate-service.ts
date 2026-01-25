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

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

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

export class SmartCarrierRateService {
  
  /**
   * Analyze a shipment and find the most cost-effective shipping method
   * that meets the customer's expected delivery timeframe.
   * 
   * Logic:
   * 1. Find customer's selected rate and its delivery days
   * 2. Filter to rates that deliver in same or fewer days
   * 3. Pick the cheapest from eligible rates
   * 4. If customer's rate not found, use a conservative default (ground ~5 days)
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
      const rates = await this.fetchRatesForShipment(shipmentId);
      
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
      
      // Build human-readable reasoning
      let reasoning: string;
      if (smartRate.service_code === customerMethod) {
        reasoning = `Customer's choice (${customerMethod}) is the most cost-effective option at $${smartCost.toFixed(2)}`;
      } else if (!customerRate) {
        reasoning = `${smartRate.service_code} recommended at $${smartCost.toFixed(2)} (${smartRate.delivery_days} days) - customer's ${customerMethod} not available for comparison`;
      } else if (savings > 0) {
        reasoning = `${smartRate.service_code} saves $${savings.toFixed(2)} vs ${customerMethod} with ${smartRate.delivery_days}-day delivery (same or faster)`;
      } else {
        reasoning = `${smartRate.service_code} at $${smartCost.toFixed(2)} is the cheapest option for ${smartRate.delivery_days}-day delivery`;
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
   * Fetch rates for a shipment from ShipStation
   */
  private async fetchRatesForShipment(shipmentId: string): Promise<ShipStationRate[]> {
    if (!SHIPSTATION_API_KEY) {
      throw new Error('SHIPSTATION_API_KEY environment variable is not set');
    }
    
    const url = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}/rates`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'api-key': SHIPSTATION_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ShipStation rates API error: ${response.status} ${errorText}`);
    }
    
    const data: RatesResponse = await response.json();
    return data.rates || [];
  }
  
  /**
   * Fetch rates using shipment details (for shipments not yet in ShipStation)
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
    if (!SHIPSTATION_API_KEY) {
      throw new Error('SHIPSTATION_API_KEY environment variable is not set');
    }
    
    const requestBody: any = {
      shipment: {
        validate_address: 'no_validation',
        ship_from: {
          name: "Jerky.com",
          address_line1: FULFILLMENT_CENTER.address,
          city_locality: FULFILLMENT_CENTER.city,
          state_province: FULFILLMENT_CENTER.state,
          postal_code: FULFILLMENT_CENTER.postal_code,
          country_code: FULFILLMENT_CENTER.country,
        },
        ship_to: {
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
      rate_options: {},
    };
    
    const url = `${SHIPSTATION_API_BASE}/v2/rates`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': SHIPSTATION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ShipStation rates API error: ${response.status} ${errorText}`);
    }
    
    const data: RatesResponse = await response.json();
    return data.rates || [];
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

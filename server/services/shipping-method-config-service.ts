/**
 * Customer Shipping Method Config Service
 * 
 * Centralized configuration service for customer shipping method settings.
 * Single source of truth for assignment rules and weight limits.
 * 
 * Rate check candidate filtering is handled by the rate_check_shipping_methods table,
 * not by customer shipping method config.
 * 
 * Usage:
 *   const config = CustomerShippingMethodConfigService.getInstance();
 *   if (await config.canChangeCustomerMethod('ups_ground')) { ... }
 */

import { db } from '../db';
import { customerShippingMethods, rateCheckShippingMethods } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface CustomerShippingMethodConfig {
  name: string;
  allowAssignment: boolean;
  allowChange: boolean;
  minAllowedWeight: number | null;
  maxAllowedWeight: number | null;
}

export interface WeightLimits {
  minOz: number | null;
  maxOz: number | null;
}

export class CustomerShippingMethodConfigService {
  private static instance: CustomerShippingMethodConfigService;

  private constructor() {}

  static getInstance(): CustomerShippingMethodConfigService {
    if (!CustomerShippingMethodConfigService.instance) {
      CustomerShippingMethodConfigService.instance = new CustomerShippingMethodConfigService();
    }
    return CustomerShippingMethodConfigService.instance;
  }

  /**
   * Get full configuration for a customer shipping method
   * Returns null if method is not in the database (unknown methods are allowed by default)
   */
  async getCustomerMethodConfig(serviceName: string): Promise<CustomerShippingMethodConfig | null> {
    const [method] = await db
      .select()
      .from(customerShippingMethods)
      .where(eq(customerShippingMethods.name, serviceName))
      .limit(1);

    if (!method) {
      return null;
    }

    return {
      name: method.name,
      allowAssignment: method.allowAssignment,
      allowChange: method.allowChange,
      minAllowedWeight: method.minAllowedWeight ? parseFloat(method.minAllowedWeight) : null,
      maxAllowedWeight: method.maxAllowedWeight ? parseFloat(method.maxAllowedWeight) : null,
    };
  }

  /**
   * Get set of service codes that are disallowed for rate check candidates.
   * Used by the smart carrier rate service to filter out disallowed candidate methods.
   * Methods not in the table default to allowed.
   */
  async getDisallowedRateCheckMethods(): Promise<Set<string>> {
    const methods = await db
      .select({ name: rateCheckShippingMethods.name })
      .from(rateCheckShippingMethods)
      .where(eq(rateCheckShippingMethods.allowRateCheck, false));
    return new Set(methods.map(m => m.name));
  }

  /**
   * Get weight limits for all rate check shipping methods that have them configured.
   * Returns a map of method name → { minOz, maxOz }.
   * Methods without weight limits are not included in the map (meaning no filtering).
   */
  async getRateCheckMethodWeightLimits(): Promise<Map<string, WeightLimits>> {
    const methods = await db
      .select({
        name: rateCheckShippingMethods.name,
        minAllowedWeight: rateCheckShippingMethods.minAllowedWeight,
        maxAllowedWeight: rateCheckShippingMethods.maxAllowedWeight,
      })
      .from(rateCheckShippingMethods)
      .where(eq(rateCheckShippingMethods.allowRateCheck, true));

    const limitsMap = new Map<string, WeightLimits>();
    for (const m of methods) {
      const minOz = m.minAllowedWeight ? parseFloat(m.minAllowedWeight) : null;
      const maxOz = m.maxAllowedWeight ? parseFloat(m.maxAllowedWeight) : null;
      if (minOz !== null || maxOz !== null) {
        limitsMap.set(m.name, { minOz, maxOz });
      }
    }
    return limitsMap;
  }

  /**
   * Check if the rate checker is allowed to change this customer shipping method.
   * Unknown methods default to allowed.
   */
  async canChangeCustomerMethod(serviceName: string): Promise<boolean> {
    const config = await this.getCustomerMethodConfig(serviceName);
    if (!config) {
      return true;
    }
    return config.allowChange;
  }

  /**
   * Check if this customer shipping method can be assigned to shipments.
   * Unknown methods default to allowed.
   */
  async canAssignCustomerMethod(serviceName: string): Promise<boolean> {
    const config = await this.getCustomerMethodConfig(serviceName);
    if (!config) {
      return true;
    }
    return config.allowAssignment;
  }

  /**
   * Get weight limits for a customer shipping method.
   */
  async getCustomerMethodWeightLimits(serviceName: string): Promise<WeightLimits> {
    const config = await this.getCustomerMethodConfig(serviceName);
    if (!config) {
      return { minOz: null, maxOz: null };
    }
    return {
      minOz: config.minAllowedWeight,
      maxOz: config.maxAllowedWeight,
    };
  }

  /**
   * Check if a package weight is within the allowed limits for a customer shipping method.
   */
  async isWeightAllowed(serviceName: string, weightOz: number): Promise<boolean> {
    const limits = await this.getCustomerMethodWeightLimits(serviceName);
    
    if (limits.minOz !== null && weightOz < limits.minOz) {
      return false;
    }
    
    if (limits.maxOz !== null && weightOz > limits.maxOz) {
      return false;
    }
    
    return true;
  }

  /**
   * Get all configured customer shipping methods
   */
  async getAllCustomerMethods(): Promise<CustomerShippingMethodConfig[]> {
    const methods = await db.select().from(customerShippingMethods);
    return methods.map(m => ({
      name: m.name,
      allowAssignment: m.allowAssignment,
      allowChange: m.allowChange,
      minAllowedWeight: m.minAllowedWeight ? parseFloat(m.minAllowedWeight) : null,
      maxAllowedWeight: m.maxAllowedWeight ? parseFloat(m.maxAllowedWeight) : null,
    }));
  }
}

// Export singleton instance for convenience
export const customerShippingMethodConfig = CustomerShippingMethodConfigService.getInstance();

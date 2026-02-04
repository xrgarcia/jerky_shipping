/**
 * Shipping Method Config Service
 * 
 * Centralized configuration service for shipping method settings.
 * Single source of truth for rate checker behavior, assignment rules, and weight limits.
 * 
 * Usage:
 *   const config = ShippingMethodConfigService.getInstance();
 *   if (await config.canPerformRateCheck('ups_ground')) { ... }
 */

import { db } from '../db';
import { shippingMethods } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface ShippingMethodConfig {
  name: string;
  allowRateCheck: boolean;
  allowAssignment: boolean;
  allowChange: boolean;
  minAllowedWeight: number | null;
  maxAllowedWeight: number | null;
}

export interface WeightLimits {
  minOz: number | null;
  maxOz: number | null;
}

export class ShippingMethodConfigService {
  private static instance: ShippingMethodConfigService;

  private constructor() {}

  static getInstance(): ShippingMethodConfigService {
    if (!ShippingMethodConfigService.instance) {
      ShippingMethodConfigService.instance = new ShippingMethodConfigService();
    }
    return ShippingMethodConfigService.instance;
  }

  /**
   * Get full configuration for a shipping method
   * Returns null if method is not in the database (unknown methods are allowed by default)
   */
  async getMethodConfig(serviceName: string): Promise<ShippingMethodConfig | null> {
    const [method] = await db
      .select()
      .from(shippingMethods)
      .where(eq(shippingMethods.name, serviceName))
      .limit(1);

    if (!method) {
      return null;
    }

    return {
      name: method.name,
      allowRateCheck: method.allowRateCheck,
      allowAssignment: method.allowAssignment,
      allowChange: method.allowChange,
      minAllowedWeight: method.minAllowedWeight ? parseFloat(method.minAllowedWeight) : null,
      maxAllowedWeight: method.maxAllowedWeight ? parseFloat(method.maxAllowedWeight) : null,
    };
  }

  /**
   * Check if rate checking is allowed for this shipping method.
   * Unknown methods default to allowed.
   */
  async canPerformRateCheck(serviceName: string): Promise<boolean> {
    const config = await this.getMethodConfig(serviceName);
    if (!config) {
      return true;
    }
    return config.allowRateCheck;
  }

  /**
   * Check if the rate checker is allowed to change this shipping method.
   * Unknown methods default to allowed.
   */
  async canChangeMethod(serviceName: string): Promise<boolean> {
    const config = await this.getMethodConfig(serviceName);
    if (!config) {
      return true;
    }
    return config.allowChange;
  }

  /**
   * Check if this shipping method can be assigned to shipments.
   * Unknown methods default to allowed.
   */
  async canAssignMethod(serviceName: string): Promise<boolean> {
    const config = await this.getMethodConfig(serviceName);
    if (!config) {
      return true;
    }
    return config.allowAssignment;
  }

  /**
   * Get weight limits for a shipping method.
   */
  async getWeightLimits(serviceName: string): Promise<WeightLimits> {
    const config = await this.getMethodConfig(serviceName);
    if (!config) {
      return { minOz: null, maxOz: null };
    }
    return {
      minOz: config.minAllowedWeight,
      maxOz: config.maxAllowedWeight,
    };
  }

  /**
   * Check if a package weight is within the allowed limits for a shipping method.
   */
  async isWeightAllowed(serviceName: string, weightOz: number): Promise<boolean> {
    const limits = await this.getWeightLimits(serviceName);
    
    if (limits.minOz !== null && weightOz < limits.minOz) {
      return false;
    }
    
    if (limits.maxOz !== null && weightOz > limits.maxOz) {
      return false;
    }
    
    return true;
  }

  /**
   * Get all configured shipping methods
   */
  async getAllMethods(): Promise<ShippingMethodConfig[]> {
    const methods = await db.select().from(shippingMethods);
    return methods.map(m => ({
      name: m.name,
      allowRateCheck: m.allowRateCheck,
      allowAssignment: m.allowAssignment,
      allowChange: m.allowChange,
      minAllowedWeight: m.minAllowedWeight ? parseFloat(m.minAllowedWeight) : null,
      maxAllowedWeight: m.maxAllowedWeight ? parseFloat(m.maxAllowedWeight) : null,
    }));
  }
}

// Export singleton instance for convenience
export const shippingMethodConfig = ShippingMethodConfigService.getInstance();

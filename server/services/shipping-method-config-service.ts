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
  private cache: Map<string, ShippingMethodConfig> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  private constructor() {}

  static getInstance(): ShippingMethodConfigService {
    if (!ShippingMethodConfigService.instance) {
      ShippingMethodConfigService.instance = new ShippingMethodConfigService();
    }
    return ShippingMethodConfigService.instance;
  }

  /**
   * Refresh the cache from database
   */
  async refreshCache(): Promise<void> {
    try {
      const methods = await db.select().from(shippingMethods);
      
      this.cache.clear();
      for (const method of methods) {
        this.cache.set(method.name, {
          name: method.name,
          allowRateCheck: method.allowRateCheck,
          allowAssignment: method.allowAssignment,
          allowChange: method.allowChange,
          minAllowedWeight: method.minAllowedWeight ? parseFloat(method.minAllowedWeight) : null,
          maxAllowedWeight: method.maxAllowedWeight ? parseFloat(method.maxAllowedWeight) : null,
        });
      }
      this.cacheTimestamp = Date.now();
    } catch (error) {
      console.error('[ShippingMethodConfigService] Failed to refresh cache:', error);
    }
  }

  /**
   * Ensure cache is fresh
   */
  private async ensureCache(): Promise<void> {
    const now = Date.now();
    if (this.cache.size === 0 || (now - this.cacheTimestamp) > this.CACHE_TTL_MS) {
      await this.refreshCache();
    }
  }

  /**
   * Get full configuration for a shipping method
   * Returns null if method is not in the database (unknown methods are allowed by default)
   */
  async getMethodConfig(serviceName: string): Promise<ShippingMethodConfig | null> {
    await this.ensureCache();
    return this.cache.get(serviceName) || null;
  }

  /**
   * Check if rate checking is allowed for this shipping method.
   * 
   * Returns true if:
   * - Method is not in the config table (unknown methods default to allowed)
   * - Method has allow_rate_check = true
   * 
   * Returns false if:
   * - Method has allow_rate_check = false
   */
  async canPerformRateCheck(serviceName: string): Promise<boolean> {
    const config = await this.getMethodConfig(serviceName);
    
    // Unknown methods default to allowed (conservative approach)
    if (!config) {
      return true;
    }
    
    return config.allowRateCheck;
  }

  /**
   * Check if the rate checker is allowed to change this shipping method.
   * 
   * Returns true if:
   * - Method is not in the config table (unknown methods default to allowed)
   * - Method has allow_change = true
   * 
   * Returns false if:
   * - Method has allow_change = false (customer's choice is preserved)
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
   * 
   * Returns true if:
   * - Method is not in the config table (unknown methods default to allowed)
   * - Method has allow_assignment = true
   * 
   * Returns false if:
   * - Method has allow_assignment = false (deprecated or restricted)
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
   * 
   * Returns { minOz: null, maxOz: null } if:
   * - Method is not in the config table
   * - Method has no weight limits configured
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
   * 
   * Returns true if:
   * - Method has no weight limits configured
   * - Weight is within the configured limits
   * 
   * Returns false if:
   * - Weight is below minAllowedWeight (if set)
   * - Weight is above maxAllowedWeight (if set)
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
    await this.ensureCache();
    return Array.from(this.cache.values());
  }

  /**
   * Get all methods that are eligible for rate checking
   */
  async getRateCheckEligibleMethods(): Promise<ShippingMethodConfig[]> {
    await this.ensureCache();
    return Array.from(this.cache.values()).filter(m => m.allowRateCheck);
  }

  /**
   * Get all methods that can be assigned to shipments
   */
  async getAssignableMethods(): Promise<ShippingMethodConfig[]> {
    await this.ensureCache();
    return Array.from(this.cache.values()).filter(m => m.allowAssignment);
  }

  /**
   * Force cache invalidation (call after config changes)
   */
  invalidateCache(): void {
    this.cache.clear();
    this.cacheTimestamp = 0;
  }
}

// Export singleton instance for convenience
export const shippingMethodConfig = ShippingMethodConfigService.getInstance();

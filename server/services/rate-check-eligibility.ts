/**
 * Rate Check Eligibility Service
 * 
 * Centralized validation for rate check requirements.
 * Used by both the lifecycle state machine and the rate service
 * to ensure consistent eligibility checks.
 */

import { db } from '../db';
import { fingerprints, fingerprintModels, packagingTypes } from '@shared/schema';
import type { Shipment } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export interface PackageDataResult {
  eligible: boolean;
  reason?: string;
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  packagingName?: string;
  shipstationPackageId?: string;
}

/**
 * Rate Check Eligibility
 * 
 * Provides both synchronous (for state machine) and asynchronous (for full validation)
 * eligibility checks for rate checking.
 */
export class RateCheckEligibility {
  /**
   * Quick synchronous check for basic shipment data requirements.
   * Used by the lifecycle state machine to determine subphase.
   * Does NOT check package details (requires async DB lookup).
   */
  static checkBasicRequirements(shipment: {
    shipmentId?: string | null;
    shipToPostalCode?: string | null;
    serviceCode?: string | null;
    fingerprintId?: string | null;
    packagingTypeId?: string | null;
  }): EligibilityResult {
    if (!shipment.shipmentId) {
      return { eligible: false, reason: 'No ShipStation shipment ID' };
    }

    if (!shipment.shipToPostalCode) {
      return { eligible: false, reason: 'No destination postal code' };
    }

    if (!shipment.serviceCode) {
      return { eligible: false, reason: 'No shipping service code' };
    }

    if (!shipment.fingerprintId) {
      return { eligible: false, reason: 'No fingerprint assigned' };
    }

    if (!shipment.packagingTypeId) {
      return { eligible: false, reason: 'No packaging type assigned' };
    }

    return { eligible: true };
  }

  /**
   * Full async validation including package data lookup.
   * Used by the rate service before making API calls.
   * Returns package details if eligible.
   */
  static async checkWithPackageData(shipment: Shipment): Promise<PackageDataResult> {
    const basicCheck = this.checkBasicRequirements(shipment);
    if (!basicCheck.eligible) {
      return basicCheck;
    }

    try {
      const [fingerprint] = await db
        .select()
        .from(fingerprints)
        .where(eq(fingerprints.id, shipment.fingerprintId!))
        .limit(1);

      if (!fingerprint) {
        return { eligible: false, reason: 'Fingerprint not found in database' };
      }

      if (!fingerprint.totalWeight) {
        return { eligible: false, reason: 'Fingerprint has no weight data' };
      }

      const [model] = await db
        .select()
        .from(fingerprintModels)
        .where(eq(fingerprintModels.fingerprintId, shipment.fingerprintId!))
        .limit(1);

      if (!model?.packagingTypeId) {
        return { eligible: false, reason: 'Fingerprint has no packaging model assigned' };
      }

      const [packaging] = await db
        .select()
        .from(packagingTypes)
        .where(eq(packagingTypes.id, model.packagingTypeId))
        .limit(1);

      if (!packaging) {
        return { eligible: false, reason: 'Packaging type not found in database' };
      }

      let weightOz = fingerprint.totalWeight;
      if (fingerprint.weightUnit === 'lb' || fingerprint.weightUnit === 'pound' || fingerprint.weightUnit === 'pounds') {
        weightOz = fingerprint.totalWeight * 16;
      }

      const result: PackageDataResult = {
        eligible: true,
        weightOz,
        packagingName: packaging.name,
        shipstationPackageId: packaging.packageId || undefined,
      };

      if (packaging.dimensionLength && packaging.dimensionWidth && packaging.dimensionHeight) {
        result.lengthIn = parseFloat(packaging.dimensionLength);
        result.widthIn = parseFloat(packaging.dimensionWidth);
        result.heightIn = parseFloat(packaging.dimensionHeight);
      }

      return result;

    } catch (error: any) {
      return { eligible: false, reason: `Database error: ${error.message}` };
    }
  }
}

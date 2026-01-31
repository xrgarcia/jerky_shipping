/**
 * Packaging Types Sync Worker
 * 
 * Runs hourly to sync package types from ShipStation's /v2/packages endpoint.
 * 
 * Sync Logic:
 * 1. Fetch all packages from ShipStation
 * 2. For each package:
 *    - First try to match by package_id (ShipStation's unique identifier)
 *    - If no match, fall back to name matching (for initial backfill)
 *    - If match found: update fields (name, packageCode, dimensions) but preserve id, isActive, stationType
 *    - If no match: insert as new record with isActive=true
 * 3. Never delete existing records (some may be custom/local-only)
 */

import { db } from "./db";
import { packagingTypes } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getPackages, type ShipStationPackage } from "./utils/shipstation-api";

const log = (message: string) => console.log(`[packaging-types-sync] ${message}`);

let workerStatus: 'sleeping' | 'running' = 'sleeping';
let workerStats = {
  totalRunsCount: 0,
  lastRunAt: null as Date | null,
  lastSyncAt: null as Date | null,
  lastInsertedCount: 0,
  lastUpdatedCount: 0,
  lastSkippedCount: 0,
  workerStartedAt: new Date(),
};

export function getPackagingTypesSyncWorkerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

export function getPackagingTypesSyncWorkerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

async function runSync(): Promise<void> {
  if (workerStatus === 'running') {
    log('Already running, skipping this cycle');
    return;
  }
  
  workerStatus = 'running';
  workerStats.lastRunAt = new Date();
  workerStats.totalRunsCount++;
  
  try {
    log('Fetching packages from ShipStation...');
    
    const { data: packages, rateLimit } = await getPackages();
    log(`Fetched ${packages.length} packages from ShipStation (rate limit: ${rateLimit.remaining}/${rateLimit.limit})`);
    
    if (packages.length === 0) {
      log('No packages returned from ShipStation');
      return;
    }
    
    const existingTypes = await db.select().from(packagingTypes);
    log(`Found ${existingTypes.length} existing packaging types in database`);
    
    const byPackageId = new Map(existingTypes.filter(t => t.packageId).map(t => [t.packageId, t]));
    const byName = new Map(existingTypes.map(t => [t.name.toLowerCase().trim(), t]));
    
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const pkg of packages) {
      const packageId = pkg.package_id;
      const name = pkg.name?.trim();
      
      if (!name) {
        log(`Skipping package with no name: ${packageId}`);
        skippedCount++;
        continue;
      }
      
      let existingRecord = byPackageId.get(packageId);
      
      if (!existingRecord) {
        existingRecord = byName.get(name.toLowerCase());
        if (existingRecord) {
          log(`Name match found for "${name}" - will assign package_id: ${packageId}`);
        }
      }
      
      const dimensions = pkg.dimensions || {};
      const updateData = {
        packageId: packageId,
        name: name,
        packageCode: pkg.package_code || null,
        dimensionLength: dimensions.length?.toString() || null,
        dimensionWidth: dimensions.width?.toString() || null,
        dimensionHeight: dimensions.height?.toString() || null,
        dimensionUnit: dimensions.unit || 'inch',
        updatedAt: new Date(),
      };
      
      if (existingRecord) {
        await db
          .update(packagingTypes)
          .set(updateData)
          .where(eq(packagingTypes.id, existingRecord.id));
        updatedCount++;
        log(`Updated: "${name}" (id: ${existingRecord.id})`);
      } else {
        try {
          await db
            .insert(packagingTypes)
            .values({
              ...updateData,
              isActive: true,
            });
          insertedCount++;
          log(`Inserted: "${name}" (package_id: ${packageId})`);
        } catch (error: any) {
          if (error.code === '23505') {
            log(`Duplicate name conflict for "${name}" - skipping insert`);
            skippedCount++;
          } else {
            throw error;
          }
        }
      }
    }
    
    workerStats.lastSyncAt = new Date();
    workerStats.lastInsertedCount = insertedCount;
    workerStats.lastUpdatedCount = updatedCount;
    workerStats.lastSkippedCount = skippedCount;
    
    log(`Sync complete: ${insertedCount} inserted, ${updatedCount} updated, ${skippedCount} skipped`);
    
  } catch (error) {
    log(`Error during sync: ${error}`);
    console.error('[packaging-types-sync] Full error:', error);
  } finally {
    workerStatus = 'sleeping';
  }
}

export async function forcePackagingTypesSync(): Promise<{
  success: boolean;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  duration: number;
}> {
  if (workerStatus === 'running') {
    log('Worker is already running, cannot force sync');
    return {
      success: false,
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      duration: 0,
    };
  }
  
  const startTime = Date.now();
  await runSync();
  const duration = Date.now() - startTime;
  
  return {
    success: true,
    insertedCount: workerStats.lastInsertedCount,
    updatedCount: workerStats.lastUpdatedCount,
    skippedCount: workerStats.lastSkippedCount,
    duration,
  };
}

/**
 * Start the Packaging Types sync worker
 * @param intervalMs Interval in milliseconds (default: 1 hour = 3600000ms)
 */
export function startPackagingTypesSyncWorker(intervalMs: number = 3600000): void {
  log(`Worker started (interval: ${intervalMs}ms = ${intervalMs / 3600000} hours)`);
  
  setImmediate(() => runSync());
  
  setInterval(() => runSync(), intervalMs);
}

import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { purchaseOrderSnapshots, skuvaultProducts } from '@shared/schema';
import { sql, desc, eq, isNull } from 'drizzle-orm';
import logger from '../utils/logger';

interface SnapshotReadiness {
  ready: boolean;
  ifdDate: string | null;
  inventoryDate: string | null;
  localDate: string | null;
  reason: string;
}

function formatDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export async function checkSnapshotReadiness(): Promise<SnapshotReadiness> {
  try {
    const [ifdResult, iiResult] = await Promise.all([
      reportingSql`SELECT MAX(stock_check_date) as d FROM inventory_forecasts_daily`,
      reportingSql`SELECT MAX(snapshot_timestamp) as d FROM internal_inventory`,
    ]);

    const ifdDate = ifdResult[0]?.d ? formatDateStr(new Date(ifdResult[0].d)) : null;
    const inventoryDate = iiResult[0]?.d ? formatDateStr(new Date(iiResult[0].d)) : null;

    const localResult = await db.execute(sql`
      SELECT MAX(stock_check_date)::date::text AS d FROM purchase_order_snapshots
    `);
    const localDate = (localResult.rows[0]?.d as string) || null;

    if (!ifdDate || !inventoryDate) {
      return { ready: false, ifdDate, inventoryDate, localDate, reason: 'Reporting database dates not available' };
    }

    if (ifdDate !== inventoryDate) {
      return { ready: false, ifdDate, inventoryDate, localDate, reason: `Reporting dates don't match: IFD=${ifdDate}, inventory=${inventoryDate}` };
    }

    if (localDate && localDate >= ifdDate) {
      return { ready: false, ifdDate, inventoryDate, localDate, reason: `Snapshot already exists for ${localDate}` };
    }

    return { ready: true, ifdDate, inventoryDate, localDate, reason: `New snapshot available for ${ifdDate}` };
  } catch (err: any) {
    logger.error(`Snapshot readiness check failed: ${err.message}`);
    return { ready: false, ifdDate: null, inventoryDate: null, localDate: null, reason: `Error: ${err.message}` };
  }
}

export async function createSnapshot(): Promise<{ rowCount: number; stockCheckDate: string; ifdMatches: number }> {
  const readiness = await checkSnapshotReadiness();
  if (!readiness.ready) {
    throw new Error(readiness.reason);
  }

  const snapshotDate = readiness.ifdDate!;
  logger.info(`Creating purchase order snapshot for ${snapshotDate}`);

  const maxTsResult = await reportingSql`SELECT MAX(stock_check_date) as d FROM inventory_forecasts_daily`;
  const maxTimestamp = maxTsResult[0]?.d;

  const ifdRows = await reportingSql`
    SELECT sku, supplier, description, lead_time, quantity_available, quantity_incoming,
           ext_amzn_inv, ext_wlmt_inv, total_stock, quantity_in_kits, case_count, moq, moq_info,
           product_category, is_assembled_product, unit_cost
    FROM inventory_forecasts_daily
    WHERE stock_check_date = ${maxTimestamp}
  `;

  logger.info(`IFD returned ${ifdRows.length} rows for ${snapshotDate} (raw ts: ${maxTimestamp})`);

  const ifdMap = new Map<string, any>();
  for (const row of ifdRows) {
    ifdMap.set(row.sku, row);
  }

  if (ifdRows.length > 0) {
    const sampleSkus = Array.from(ifdMap.keys()).slice(0, 5);
    logger.info(`IFD sample SKUs: ${sampleSkus.join(', ')}`);
  }

  const products = await db.select().from(skuvaultProducts).where(isNull(skuvaultProducts.parentSku));
  logger.info(`Local products (excluding variants): ${products.length}, IFD SKUs: ${ifdMap.size}`);

  const BATCH_SIZE = 500;
  let batch: any[] = [];
  let totalRows = 0;
  const stockCheckDateTs = new Date(snapshotDate + 'T00:00:00.000Z');

  let ifdMatches = 0;
  for (const p of products) {
    const ifd = ifdMap.get(p.sku);
    if (ifd) ifdMatches++;

    batch.push({
      stockCheckDate: stockCheckDateTs,
      sku: p.sku,
      productTitle: p.productTitle,
      barcode: p.barcode,
      productCategory: ifd?.product_category ?? p.productCategory,
      isAssembledProduct: ifd?.is_assembled_product ?? p.isAssembledProduct,
      isKit: p.productCategory === 'kit',
      unitCost: ifd?.unit_cost?.toString() ?? p.unitCost,
      productImageUrl: p.productImageUrl,
      weightValue: p.weightValue,
      weightUnit: p.weightUnit,
      parentSku: p.parentSku || p.sku,
      quantityOnHand: p.quantityOnHand,
      availableQuantity: ifd?.quantity_available ?? p.availableQuantity,
      physicalLocation: p.physicalLocation,
      brand: p.brand,
      supplier: ifd?.supplier ?? null,
      description: ifd?.description ?? null,
      leadTime: ifd?.lead_time ?? null,
      quantityIncoming: ifd?.quantity_incoming ?? null,
      extAmznInv: ifd?.ext_amzn_inv ?? null,
      extWlmtInv: ifd?.ext_wlmt_inv ?? null,
      totalStock: ifd?.total_stock ?? null,
      quantityInKits: ifd?.quantity_in_kits ?? null,
      caseCount: ifd?.case_count ?? null,
      moq: ifd?.moq?.toString() ?? null,
      moqInfo: ifd?.moq_info ?? null,
    });

    if (batch.length >= BATCH_SIZE) {
      await db.insert(purchaseOrderSnapshots).values(batch);
      totalRows += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await db.insert(purchaseOrderSnapshots).values(batch);
    totalRows += batch.length;
  }

  logger.info(`Purchase order snapshot created: ${totalRows} rows for ${snapshotDate}, ${ifdMatches} matched IFD data`);
  return { rowCount: totalRows, stockCheckDate: snapshotDate, ifdMatches };
}

export async function projectSales(snapshotDate: string, projectionDate: string): Promise<{ updatedCount: number }> {
  logger.info(`Projecting sales for snapshot ${snapshotDate} through ${projectionDate}`);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const result = await db.execute(sql`
    WITH sales_agg AS (
      SELECT
        COALESCE(parent_sku, sku) AS rollup_sku,
        SUM(COALESCE(daily_sales_quantity::numeric, 0)) AS total_direct,
        SUM(COALESCE(kit_daily_sales_quantity::numeric, 0)) AS total_from_kits
      FROM sales_forecasting
      WHERE order_date::date >= ${todayStr}::date
        AND order_date::date <= ${projectionDate}::date
      GROUP BY COALESCE(parent_sku, sku)
    )
    UPDATE purchase_order_snapshots pos
    SET
      projected_units_sold = COALESCE(sa.total_direct, 0),
      projected_units_sold_from_kits = COALESCE(sa.total_from_kits, 0),
      sales_projection_date = ${projectionDate}::timestamp
    FROM sales_agg sa
    WHERE pos.sku = sa.rollup_sku
      AND pos.stock_check_date::date = ${snapshotDate}::date
  `);

  const zeroResult = await db.execute(sql`
    UPDATE purchase_order_snapshots
    SET
      projected_units_sold = 0,
      projected_units_sold_from_kits = 0,
      sales_projection_date = ${projectionDate}::timestamp
    WHERE stock_check_date::date = ${snapshotDate}::date
      AND projected_units_sold IS NULL
  `);

  const totalUpdated = (result.rowCount || 0) + (zeroResult.rowCount || 0);
  logger.info(`Sales projection complete: ${result.rowCount} SKUs matched sales data, ${zeroResult.rowCount} SKUs zeroed, total ${totalUpdated}`);
  return { updatedCount: totalUpdated };
}

export async function projectCurrentVelocity(
  snapshotDate: string,
  projectionDate: string,
  velocityWindowStart: string,
  velocityWindowEnd: string
): Promise<{ updatedCount: number }> {
  logger.info(`Projecting current velocity for snapshot ${snapshotDate}: window ${velocityWindowStart}→${velocityWindowEnd}, project to ${projectionDate}`);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const windowStart = new Date(velocityWindowStart + 'T00:00:00');
  const windowEnd = new Date(velocityWindowEnd + 'T00:00:00');
  const windowDays = Math.max(1, Math.round((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);

  const today = new Date(todayStr + 'T00:00:00');
  const projEnd = new Date(projectionDate + 'T00:00:00');
  const projectionDays = Math.max(1, Math.round((projEnd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

  const result = await db.execute(sql`
    WITH velocity AS (
      SELECT
        COALESCE(parent_sku, sku) AS rollup_sku,
        SUM(COALESCE(daily_sales_quantity::numeric, 0)) / ${windowDays} AS daily_direct,
        SUM(COALESCE(kit_daily_sales_quantity::numeric, 0)) / ${windowDays} AS daily_kits
      FROM sales_forecasting
      WHERE order_date::date >= ${velocityWindowStart}::date
        AND order_date::date <= ${velocityWindowEnd}::date
      GROUP BY COALESCE(parent_sku, sku)
    )
    UPDATE purchase_order_snapshots pos
    SET
      daily_velocity_individual = ROUND(v.daily_direct, 2),
      daily_velocity_kits = ROUND(v.daily_kits, 2),
      current_velocity_individual = ROUND(v.daily_direct * ${projectionDays}, 0),
      current_velocity_kits = ROUND(v.daily_kits * ${projectionDays}, 0),
      velocity_window_start = ${velocityWindowStart}::timestamp,
      velocity_window_end = ${velocityWindowEnd}::timestamp
    FROM velocity v
    WHERE pos.sku = v.rollup_sku
      AND pos.stock_check_date::date = ${snapshotDate}::date
  `);

  const zeroResult = await db.execute(sql`
    UPDATE purchase_order_snapshots
    SET
      daily_velocity_individual = 0,
      daily_velocity_kits = 0,
      current_velocity_individual = 0,
      current_velocity_kits = 0,
      velocity_window_start = ${velocityWindowStart}::timestamp,
      velocity_window_end = ${velocityWindowEnd}::timestamp
    WHERE stock_check_date::date = ${snapshotDate}::date
      AND current_velocity_individual IS NULL
  `);

  const totalUpdated = (result.rowCount || 0) + (zeroResult.rowCount || 0);
  logger.info(`Velocity projection complete: ${result.rowCount} SKUs matched, ${zeroResult.rowCount} zeroed (window=${windowDays}d, projection=${projectionDays}d)`);
  return { updatedCount: totalUpdated };
}

export async function clearProjection(snapshotDate: string): Promise<void> {
  await db.execute(sql`
    UPDATE purchase_order_snapshots
    SET projected_units_sold = NULL,
        projected_units_sold_from_kits = NULL,
        sales_projection_date = NULL,
        daily_velocity_individual = NULL,
        daily_velocity_kits = NULL,
        current_velocity_individual = NULL,
        current_velocity_kits = NULL,
        velocity_window_start = NULL,
        velocity_window_end = NULL
    WHERE stock_check_date::date = ${snapshotDate}::date
  `);
  logger.info(`Cleared sales projection for snapshot ${snapshotDate}`);
}

export async function getSnapshotDates(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT stock_check_date::date::text AS d
    FROM purchase_order_snapshots
    ORDER BY d DESC
  `);
  return rows.rows.map((r: any) => r.d);
}

export async function getSnapshot(date?: string): Promise<any[]> {
  if (date) {
    const rows = await db.execute(sql`
      SELECT * FROM purchase_order_snapshots
      WHERE stock_check_date::date = ${date}::date
      ORDER BY sku
    `);
    return rows.rows;
  }

  const rows = await db.execute(sql`
    SELECT * FROM purchase_order_snapshots
    WHERE stock_check_date = (SELECT MAX(stock_check_date) FROM purchase_order_snapshots)
    ORDER BY sku
  `);
  return rows.rows;
}

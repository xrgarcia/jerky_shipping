import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { purchaseOrderSnapshots, skuvaultProducts } from '@shared/schema';
import { sql, desc, eq } from 'drizzle-orm';
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
      return { ready: false, ifdDate, inventoryDate, localDate, reason: `Snapshot already exists for ${ifdDate}` };
    }

    return { ready: true, ifdDate, inventoryDate, localDate, reason: `New snapshot available for ${ifdDate}` };
  } catch (err: any) {
    logger.error(`Snapshot readiness check failed: ${err.message}`);
    return { ready: false, ifdDate: null, inventoryDate: null, localDate: null, reason: `Error: ${err.message}` };
  }
}

export async function createSnapshot(): Promise<{ rowCount: number; stockCheckDate: string }> {
  const readiness = await checkSnapshotReadiness();
  if (!readiness.ready) {
    throw new Error(readiness.reason);
  }

  const snapshotDate = readiness.ifdDate!;
  logger.info(`Creating purchase order snapshot for ${snapshotDate}`);

  const ifdRows = await reportingSql`
    SELECT sku, supplier, description, lead_time, quantity_available, quantity_incoming,
           ext_amzn_inv, ext_wlmt_inv, total_stock, quantity_in_kits, case_count, moq, moq_info,
           product_category, is_assembled_product, unit_cost
    FROM inventory_forecasts_daily
    WHERE stock_check_date = ${snapshotDate}::date
  `;

  const ifdMap = new Map<string, any>();
  for (const row of ifdRows) {
    ifdMap.set(row.sku, row);
  }

  const products = await db.select().from(skuvaultProducts);

  const BATCH_SIZE = 500;
  let batch: any[] = [];
  let totalRows = 0;
  const stockCheckDateTs = new Date(snapshotDate + 'T00:00:00.000Z');

  for (const p of products) {
    const ifd = ifdMap.get(p.sku);

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

  logger.info(`Purchase order snapshot created: ${totalRows} rows for ${snapshotDate}`);
  return { rowCount: totalRows, stockCheckDate: snapshotDate };
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

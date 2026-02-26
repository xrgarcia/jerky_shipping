import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { salesForecasting, skuvaultProducts, kitComponentMappings } from '@shared/schema';
import { sql } from 'drizzle-orm';
import { format, addDays, addMonths, differenceInCalendarDays, addYears, subYears } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import logger from '../utils/logger';
import { invalidateForecastingCache } from './forecasting-service';

const CST_TIMEZONE = 'America/Chicago';
const BATCH_SIZE = 500;
let isGenerationRunning = false;

interface PeakSeasonWindow {
  peakSeasonTypeId: number;
  year: number;
  startDate: Date;
  endDate: Date;
  actualPeakDate: Date;
  notes: string;
}

interface CurrentVelocityEntry {
  qty: string | null;
  rev: string | null;
  kitQty: string | null;
  kitRev: string | null;
}

function formatDateStr(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function nowCentral(): Date {
  return toZonedTime(new Date(), CST_TIMEZONE);
}

function findPeakWindow(date: Date, windows: PeakSeasonWindow[]): PeakSeasonWindow | null {
  const dateStr = formatDateStr(date);
  for (const w of windows) {
    const startStr = formatDateStr(w.startDate);
    const endStr = formatDateStr(w.endDate);
    if (dateStr >= startStr && dateStr <= endStr) {
      return w;
    }
  }
  return null;
}

function mapPeakDateToSourceYear(
  targetDate: Date,
  targetWindow: PeakSeasonWindow,
  sourceWindows: PeakSeasonWindow[]
): Date | null {
  const sourceWindow = sourceWindows.find(
    (w) => w.peakSeasonTypeId === targetWindow.peakSeasonTypeId
  );
  if (!sourceWindow) return null;

  const offsetFromPeak = differenceInCalendarDays(targetDate, targetWindow.actualPeakDate);

  const mappedDate = addDays(sourceWindow.actualPeakDate, offsetFromPeak);

  const sourceStartStr = formatDateStr(sourceWindow.startDate);
  const sourceEndStr = formatDateStr(sourceWindow.endDate);
  const mappedStr = formatDateStr(mappedDate);

  if (mappedStr < sourceStartStr) return sourceWindow.startDate;
  if (mappedStr > sourceEndStr) return sourceWindow.endDate;

  return mappedDate;
}

async function loadPeakSeasonWindows(year: number): Promise<PeakSeasonWindow[]> {
  const rows = await reportingSql`
    SELECT peak_season_type_id, year, start_date, end_date, actual_peak_date, notes
    FROM peak_season_dates
    WHERE year = ${year}
    ORDER BY peak_season_type_id
  `;
  return rows.map((r: any) => ({
    peakSeasonTypeId: r.peak_season_type_id,
    year: r.year,
    startDate: new Date(r.start_date),
    endDate: new Date(r.end_date),
    actualPeakDate: new Date(r.actual_peak_date),
    notes: r.notes,
  }));
}

async function fetchSourceData(sourceDate: string): Promise<any[]> {
  const rows = await reportingSql`
    SELECT *
    FROM sales_metrics_lookup
    WHERE order_date::date = ${sourceDate}::date
  `;
  return rows;
}

interface ProductLookup {
  isAssembledProduct: boolean;
  isKit: boolean;
  parentSku: string;
}

interface ProductLookupMaps {
  productMap: Map<string, ProductLookup>;
  kitComponentMap: Map<string, string[]>;
}

async function loadProductLookupMaps(): Promise<ProductLookupMaps> {
  const products = await db.select({
    sku: skuvaultProducts.sku,
    isAssembledProduct: skuvaultProducts.isAssembledProduct,
    productCategory: skuvaultProducts.productCategory,
    parentSku: skuvaultProducts.parentSku,
  }).from(skuvaultProducts);

  const productMap = new Map<string, ProductLookup>();
  for (const p of products) {
    productMap.set(p.sku, {
      isAssembledProduct: p.isAssembledProduct,
      isKit: p.productCategory === 'kit',
      parentSku: p.parentSku || p.sku,
    });
  }

  const components = await db.select({
    componentSku: kitComponentMappings.componentSku,
    kitSku: kitComponentMappings.kitSku,
  }).from(kitComponentMappings);

  const kitComponentMap = new Map<string, string[]>();
  for (const c of components) {
    const existing = kitComponentMap.get(c.componentSku) || [];
    existing.push(c.kitSku);
    kitComponentMap.set(c.componentSku, existing);
  }

  logger.info(`Product lookup loaded: ${productMap.size} products, ${kitComponentMap.size} component SKUs mapped to kits`);
  return { productMap, kitComponentMap };
}

async function loadCurrentVelocity(): Promise<Map<string, CurrentVelocityEntry>> {
  const rows = await reportingSql`
    SELECT
      sku,
      sales_channel,
      AVG(daily_sales_quantity)     AS curr_daily_sales_quantity,
      AVG(daily_sales_revenue)      AS curr_daily_sales_revenue,
      AVG(kit_daily_sales_quantity) AS curr_kit_daily_sales_quantity,
      AVG(kit_daily_sales_revenue)  AS curr_kit_daily_sales_revenue
    FROM sales_metrics_lookup
    WHERE order_date >= CURRENT_DATE - INTERVAL '14 days'
      AND order_date < CURRENT_DATE
    GROUP BY sku, sales_channel
  `;

  const map = new Map<string, CurrentVelocityEntry>();
  for (const r of rows) {
    const key = `${r.sku}::${r.sales_channel}`;
    map.set(key, {
      qty: r.curr_daily_sales_quantity != null ? String(r.curr_daily_sales_quantity) : null,
      rev: r.curr_daily_sales_revenue != null ? String(r.curr_daily_sales_revenue) : null,
      kitQty: r.curr_kit_daily_sales_quantity != null ? String(r.curr_kit_daily_sales_quantity) : null,
      kitRev: r.curr_kit_daily_sales_revenue != null ? String(r.curr_kit_daily_sales_revenue) : null,
    });
  }

  logger.info(`Current velocity loaded: ${map.size} sku+channel combinations from last 14 days`);
  return map;
}

async function bulkUpdateCurrentVelocity(velocityMap: Map<string, CurrentVelocityEntry>): Promise<void> {
  if (velocityMap.size === 0) {
    logger.warn('Current velocity map is empty — skipping bulk update');
    return;
  }

  const entries = Array.from(velocityMap.entries());
  const UPDATE_BATCH_SIZE = 500;
  let totalUpdated = 0;

  for (let i = 0; i < entries.length; i += UPDATE_BATCH_SIZE) {
    const batch = entries.slice(i, i + UPDATE_BATCH_SIZE);

    const values = batch.map(([key, v]) => {
      const [sku, channel] = key.split('::');
      return sql`(
        ${sku}::varchar,
        ${channel}::varchar,
        ${v.qty}::numeric,
        ${v.rev}::numeric,
        ${v.kitQty}::numeric,
        ${v.kitRev}::numeric
      )`;
    });

    const valuesSql = values.reduce((acc, cur, idx) =>
      idx === 0 ? sql`${cur}` : sql`${acc}, ${cur}`
    );

    const result = await db.execute(sql`
      UPDATE sales_forecasting sf
      SET
        curr_daily_sales_quantity     = v.qty,
        curr_daily_sales_revenue      = v.rev,
        curr_kit_daily_sales_quantity = v.kit_qty,
        curr_kit_daily_sales_revenue  = v.kit_rev
      FROM (
        VALUES ${valuesSql}
      ) AS v(sku, channel, qty, rev, kit_qty, kit_rev)
      WHERE sf.sku = v.sku
        AND sf.sales_channel = v.channel
    `);

    totalUpdated += result.rowCount ?? 0;
  }

  logger.info(`Current velocity bulk update complete: ${totalUpdated} rows updated across ${velocityMap.size} sku+channel combinations`);
}

function buildForecastRow(
  sourceRow: any,
  targetDate: Date,
  sourceDate: string,
  lookups: ProductLookupMaps,
  velocityMap: Map<string, CurrentVelocityEntry>
): any {
  const sku = sourceRow.sku;
  const salesChannel = sourceRow.sales_channel;
  const product = lookups.productMap.get(sku);
  const parentKits = lookups.kitComponentMap.get(sku) || [];
  const velocity = velocityMap.get(`${sku}::${salesChannel}`);

  return {
    sku,
    orderDate: targetDate,
    salesChannel,
    dailySalesQuantity: sourceRow.daily_sales_quantity?.toString() ?? null,
    dailySalesRevenue: sourceRow.daily_sales_revenue?.toString() ?? null,
    kitDailySalesQuantity: sourceRow.kit_daily_sales_quantity?.toString() ?? null,
    kitDailySalesRevenue: sourceRow.kit_daily_sales_revenue?.toString() ?? null,
    yoyDailySalesQuantity: sourceRow.daily_sales_quantity?.toString() ?? null,
    yoyDailySalesRevenue: sourceRow.daily_sales_revenue?.toString() ?? null,
    yoyKitDailySalesQuantity: sourceRow.kit_daily_sales_quantity?.toString() ?? null,
    yoyKitDailySalesRevenue: sourceRow.kit_daily_sales_revenue?.toString() ?? null,
    yoyGrowthFactor: '1',
    yoyKitGrowthFactor: '1',
    trendFactor: sourceRow.trend_factor?.toString() ?? null,
    confidenceLevel: sourceRow.confidence_level ?? null,
    calculatedConfidenceFactor: sourceRow.calculated_confidence_factor?.toString() ?? null,
    velocity7Day: sourceRow.velocity_7_day?.toString() ?? null,
    velocity14Day: sourceRow.velocity_14_day?.toString() ?? null,
    velocity30Day: sourceRow.velocity_30_day?.toString() ?? null,
    sales1To14Days: sourceRow.sales_1_to_14_days?.toString() ?? null,
    sales15To44Days: sourceRow.sales_15_to_44_days?.toString() ?? null,
    sales45To74Days: sourceRow.sales_45_to_74_days?.toString() ?? null,
    sales75To104Days: sourceRow.sales_75_to_104_days?.toString() ?? null,
    eventType: sourceRow.event_type ?? null,
    eventDate: sourceRow.event_date ? new Date(sourceRow.event_date) : null,
    eventWindowSales: sourceRow.event_window_sales?.toString() ?? null,
    eventLyWindowSales: sourceRow.event_ly_window_sales?.toString() ?? null,
    isPeakSeason: sourceRow.is_peak_season ?? null,
    peakSeasonName: sourceRow.peak_season_name ?? null,
    daysToPeak: sourceRow.days_to_peak ?? null,
    daysSincePeak: sourceRow.days_since_peak ?? null,
    peakVelocityRatio: sourceRow.peak_velocity_ratio?.toString() ?? null,
    velocityStabilityScore: sourceRow.velocity_stability_score?.toString() ?? null,
    growthPatternConfidence: sourceRow.growth_pattern_confidence?.toString() ?? null,
    isAssembledProduct: product?.isAssembledProduct ?? sourceRow.is_assembled_product ?? null,
    isKit: product?.isKit ?? false,
    parentSku: product?.parentSku ?? sku,
    parentKit: parentKits.length > 0 ? parentKits : null,
    category: sourceRow.category ?? null,
    yoyStartDate: sourceRow.yoy_start_date ? new Date(sourceRow.yoy_start_date) : null,
    yoyEndDate: sourceRow.yoy_end_date ? new Date(sourceRow.yoy_end_date) : null,
    yoyUnitsSold: sourceRow.yoy_units_sold?.toString() ?? null,
    yoyRevenueSold: sourceRow.yoy_revenue_sold?.toString() ?? null,
    yoyKitUnitsSold: sourceRow.yoy_kit_units_sold?.toString() ?? null,
    yoyKitRevenueSold: sourceRow.yoy_kit_revenue_sold?.toString() ?? null,
    kitSales1To14Days: sourceRow.kit_sales_1_to_14_days?.toString() ?? null,
    currDailySalesQuantity: velocity?.qty ?? null,
    currDailySalesRevenue: velocity?.rev ?? null,
    currKitDailySalesQuantity: velocity?.kitQty ?? null,
    currKitDailySalesRevenue: velocity?.kitRev ?? null,
    title: sourceRow.title ?? null,
    calculationDate: sourceRow.calculation_date ? new Date(sourceRow.calculation_date) : null,
    lastUpdated: sourceRow.last_updated ? new Date(sourceRow.last_updated) : null,
    sourceDate,
    generatedAt: new Date(),
  };
}

async function getExistingForecastDates(): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT order_date::date::text AS d FROM sales_forecasting
    WHERE order_date >= CURRENT_DATE
  `);
  const dates = new Set<string>();
  for (const r of rows.rows) {
    dates.add(r.d as string);
  }
  return dates;
}

export async function generateForecasts(): Promise<{ totalRows: number; daysProcessed: number; errors: number }> {
  if (isGenerationRunning) {
    logger.info('Sales forecast generation already in progress, skipping');
    return { totalRows: 0, daysProcessed: 0, errors: 0 };
  }

  isGenerationRunning = true;
  const jobStart = Date.now();

  try {
    logger.info('Sales forecast generation starting');

    const deleted = await db.execute(sql`DELETE FROM sales_forecasting WHERE order_date < CURRENT_DATE OR order_date > CURRENT_DATE + INTERVAL '6 months'`);
    logger.info(`Sales forecast cleanup: deleted ${deleted.rowCount ?? 0} past-dated or beyond-6-month rows`);

    // Always refresh current velocity on every run, even if generation is skipped below
    const velocityMap = await loadCurrentVelocity();
    await bulkUpdateCurrentVelocity(velocityMap);

    const today = nowCentral();
    const targetYear = today.getFullYear();
    const sourceYear = targetYear - 1;

    const forecastEndDate = addMonths(today, 6);
    const forecastEndStr = formatDateStr(forecastEndDate);

    const existingDates = await getExistingForecastDates();
    const totalDaysNeeded = differenceInCalendarDays(forecastEndDate, today) + 1;
    const existingCount = existingDates.size;

    if (existingCount >= totalDaysNeeded - 5) {
      const cleared = await invalidateForecastingCache();
      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
      logger.info(`Sales forecast already complete: ${existingCount}/${totalDaysNeeded} days covered, skipping generation (${elapsed}s, cleared ${cleared} stale cache keys)`);
      return { totalRows: 0, daysProcessed: 0, errors: 0 };
    }

    logger.info(`Sales forecast coverage: ${existingCount}/${totalDaysNeeded} days — generating missing days`);

    const [targetYearWindows, sourceYearWindows, nextYearWindows, prevYearWindows] = await Promise.all([
      loadPeakSeasonWindows(targetYear),
      loadPeakSeasonWindows(sourceYear),
      loadPeakSeasonWindows(targetYear + 1),
      loadPeakSeasonWindows(sourceYear - 1),
    ]);

    const allTargetWindows = [...targetYearWindows, ...nextYearWindows];
    const allSourceWindows = [...sourceYearWindows, ...prevYearWindows, ...targetYearWindows];

    logger.info(`Loaded peak season windows: target years ${targetYear}/${targetYear + 1} (${allTargetWindows.length} windows), source years ${sourceYear}/${sourceYear - 1}/${targetYear} (${allSourceWindows.length} windows)`);

    const productLookups = await loadProductLookupMaps();

    let totalRows = 0;
    let daysProcessed = 0;
    let daysSkipped = 0;
    let errors = 0;
    let batch: any[] = [];

    let currentDate = new Date(today);

    while (formatDateStr(currentDate) <= forecastEndStr) {
      const targetDateStr = formatDateStr(currentDate);

      if (existingDates.has(targetDateStr)) {
        daysSkipped++;
        currentDate = addDays(currentDate, 1);
        continue;
      }

      try {
        const targetPeakWindow = findPeakWindow(currentDate, allTargetWindows);

        let sourceDate: Date;
        if (targetPeakWindow) {
          const mappedDate = mapPeakDateToSourceYear(currentDate, targetPeakWindow, allSourceWindows);
          sourceDate = mappedDate ?? subYears(currentDate, 1);
        } else {
          sourceDate = subYears(currentDate, 1);
        }

        const sourceDateStr = formatDateStr(sourceDate);
        const sourceRows = await fetchSourceData(sourceDateStr);

        if (sourceRows.length === 0) {
          currentDate = addDays(currentDate, 1);
          daysProcessed++;
          continue;
        }

        for (const row of sourceRows) {
          batch.push(buildForecastRow(row, currentDate, sourceDateStr, productLookups, velocityMap));

          if (batch.length >= BATCH_SIZE) {
            await db.insert(salesForecasting).values(batch);
            totalRows += batch.length;
            batch = [];
          }
        }

        daysProcessed++;
      } catch (err: any) {
        logger.error(`Forecast generation error for ${targetDateStr}: ${err.message}`);
        errors++;
      }

      currentDate = addDays(currentDate, 1);
    }

    if (batch.length > 0) {
      await db.insert(salesForecasting).values(batch);
      totalRows += batch.length;
    }

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    logger.info(`Sales forecast generation complete: ${totalRows} new rows, ${daysProcessed} days generated, ${daysSkipped} days skipped (already existed), ${errors} errors, ${elapsed}s`);

    if (totalRows > 0) {
      const cleared = await invalidateForecastingCache();
      logger.info(`Cleared ${cleared} forecasting cache keys after generation`);
    }

    return { totalRows, daysProcessed, errors };
  } finally {
    isGenerationRunning = false;
  }
}

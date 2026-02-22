import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { salesForecasting } from '@shared/schema';
import { sql } from 'drizzle-orm';
import { format, addDays, differenceInCalendarDays, addYears, subYears } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import logger from '../utils/logger';

const CST_TIMEZONE = 'America/Chicago';
const BATCH_SIZE = 500;

interface PeakSeasonWindow {
  peakSeasonTypeId: number;
  year: number;
  startDate: Date;
  endDate: Date;
  actualPeakDate: Date;
  notes: string;
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

function buildForecastRow(sourceRow: any, targetDate: Date, sourceDate: string): any {
  return {
    sku: sourceRow.sku,
    orderDate: targetDate,
    salesChannel: sourceRow.sales_channel,
    dailySalesQuantity: sourceRow.daily_sales_quantity?.toString() ?? null,
    dailySalesRevenue: sourceRow.daily_sales_revenue?.toString() ?? null,
    kitDailySalesQuantity: sourceRow.kit_daily_sales_quantity?.toString() ?? null,
    kitDailySalesRevenue: sourceRow.kit_daily_sales_revenue?.toString() ?? null,
    yoyDailySalesQuantity: sourceRow.yoy_daily_sales_quantity?.toString() ?? null,
    yoyDailySalesRevenue: sourceRow.yoy_daily_sales_revenue?.toString() ?? null,
    yoyKitDailySalesQuantity: sourceRow.yoy_kit_daily_sales_quantity?.toString() ?? null,
    yoyKitDailySalesRevenue: sourceRow.yoy_kit_daily_sales_revenue?.toString() ?? null,
    yoyGrowthFactor: sourceRow.yoy_growth_factor?.toString() ?? null,
    yoyKitGrowthFactor: sourceRow.yoy_kit_growth_factor?.toString() ?? null,
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
    isAssembledProduct: sourceRow.is_assembled_product ?? null,
    category: sourceRow.category ?? null,
    yoyStartDate: sourceRow.yoy_start_date ? new Date(sourceRow.yoy_start_date) : null,
    yoyEndDate: sourceRow.yoy_end_date ? new Date(sourceRow.yoy_end_date) : null,
    yoyUnitsSold: sourceRow.yoy_units_sold?.toString() ?? null,
    yoyRevenueSold: sourceRow.yoy_revenue_sold?.toString() ?? null,
    yoyKitUnitsSold: sourceRow.yoy_kit_units_sold?.toString() ?? null,
    yoyKitRevenueSold: sourceRow.yoy_kit_revenue_sold?.toString() ?? null,
    kitSales1To14Days: sourceRow.kit_sales_1_to_14_days?.toString() ?? null,
    title: sourceRow.title ?? null,
    calculationDate: sourceRow.calculation_date ? new Date(sourceRow.calculation_date) : null,
    lastUpdated: sourceRow.last_updated ? new Date(sourceRow.last_updated) : null,
    sourceDate,
    generatedAt: new Date(),
  };
}

export async function generateForecasts(): Promise<{ totalRows: number; daysProcessed: number; errors: number }> {
  const jobStart = Date.now();
  logger.info('Sales forecast generation starting');

  const today = nowCentral();
  const todayStr = formatDateStr(today);
  const targetYear = today.getFullYear();
  const sourceYear = targetYear - 1;

  const forecastEndDate = addYears(today, 1);
  const forecastEndStr = formatDateStr(forecastEndDate);

  const [targetYearWindows, sourceYearWindows, nextYearWindows, prevYearWindows] = await Promise.all([
    loadPeakSeasonWindows(targetYear),
    loadPeakSeasonWindows(sourceYear),
    loadPeakSeasonWindows(targetYear + 1),
    loadPeakSeasonWindows(sourceYear - 1),
  ]);

  const allTargetWindows = [...targetYearWindows, ...nextYearWindows];
  const allSourceWindows = [...sourceYearWindows, ...prevYearWindows, ...targetYearWindows];

  logger.info(`Loaded peak season windows: target years ${targetYear}/${targetYear + 1} (${allTargetWindows.length} windows), source years ${sourceYear}/${sourceYear - 1}/${targetYear} (${allSourceWindows.length} windows)`);

  await db.delete(salesForecasting).where(
    sql`order_date >= ${todayStr}::timestamp`
  );
  logger.info('Cleared existing forecast data from today forward');

  let totalRows = 0;
  let daysProcessed = 0;
  let errors = 0;
  let batch: any[] = [];

  let currentDate = new Date(today);

  while (formatDateStr(currentDate) <= forecastEndStr) {
    const targetDateStr = formatDateStr(currentDate);

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
        batch.push(buildForecastRow(row, currentDate, sourceDateStr));

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
  logger.info(`Sales forecast generation complete: ${totalRows} rows, ${daysProcessed} days, ${errors} errors, ${elapsed}s`);

  return { totalRows, daysProcessed, errors };
}

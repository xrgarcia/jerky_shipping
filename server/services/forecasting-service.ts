import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { salesForecasting } from '@shared/schema';
import { sql as drizzleSql, and, gte, lte, eq, inArray, isNotNull, desc } from 'drizzle-orm';
import type {
  SalesDataPoint,
  ForecastingSalesParams,
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
  ForecastingProductsResponse,
  RevenueTimeSeriesPoint,
  RevenueTimeSeriesResponse,
  KitTimeSeriesPoint,
  KitTimeSeriesResponse,
  SummaryMetrics,
  SummaryMetricsResponse,
} from '@shared/forecasting-types';
import { TimeRangePreset, TIME_RANGE_DAYS } from '@shared/forecasting-types';
import { subDays, addDays, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { getRedisClient } from '../utils/queue';

const CACHE_TTL_SECONDS = 3600;
const CST_TIMEZONE = 'America/Chicago';

export async function invalidateForecastingCache(): Promise<number> {
  try {
    const redis = getRedisClient();
    const keys = await redis.keys('forecasting:*');
    if (keys.length > 0) {
      await Promise.all(keys.map(k => redis.del(k)));
    }
    return keys.length;
  } catch {
    return 0;
  }
}

function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function nowCentral(): Date {
  return toZonedTime(new Date(), CST_TIMEZONE);
}

function buildCacheKey(prefix: string, params?: ForecastingSalesParams): string {
  if (!params) return `forecasting:${prefix}`;
  const parts = [
    `forecasting:${prefix}`,
    params.preset,
    params.channels ? [...params.channels].sort().join(',') : '_',
    params.skus ? [...params.skus].sort().join(',') : '_',
    params.startDate ?? '_',
    params.endDate ?? '_',
    params.isAssembledProduct ?? '_',
    params.categories?.join(',') ?? '_',
    params.eventTypes?.join(',') ?? '_',
    params.isPeakSeason ?? '_',
  ];
  return parts.join(':');
}

async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(key);
    if (cached !== null && cached !== undefined) {
      return (typeof cached === 'string' ? JSON.parse(cached) : cached) as T;
    }
    const result = await fetcher();
    await redis.set(key, JSON.stringify(result), { ex: CACHE_TTL_SECONDS });
    return result;
  } catch (cacheError: any) {
    if (cacheError?.message?.includes('Upstash Redis credentials')) {
      throw cacheError;
    }
    console.warn('[Forecasting] Redis cache error, falling back to DB:', cacheError.message);
    return fetcher();
  }
}

interface DateSplit {
  historicalStart: Date | null;
  historicalEnd: Date | null;
  forecastStart: Date | null;
  forecastEnd: Date | null;
  hasForecast: boolean;
  hasHistorical: boolean;
}

function splitDateRange(startDate: Date, endDate: Date): DateSplit {
  const today = nowCentral();
  const todayStr = formatDate(today);
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  const entirelyFuture = startStr >= todayStr;
  const entirelyHistorical = endStr < todayStr;

  if (entirelyHistorical) {
    return {
      historicalStart: startDate,
      historicalEnd: endDate,
      forecastStart: null,
      forecastEnd: null,
      hasForecast: false,
      hasHistorical: true,
    };
  }

  if (entirelyFuture) {
    return {
      historicalStart: null,
      historicalEnd: null,
      forecastStart: startDate,
      forecastEnd: endDate,
      hasForecast: true,
      hasHistorical: false,
    };
  }

  return {
    historicalStart: startDate,
    historicalEnd: subDays(today, 1),
    forecastStart: today,
    forecastEnd: endDate,
    hasForecast: true,
    hasHistorical: true,
  };
}

function buildLocalWhereConditions(params: ForecastingSalesParams, startDate: Date, endDate: Date) {
  const conditions: any[] = [
    gte(salesForecasting.orderDate, startDate),
    lte(salesForecasting.orderDate, endDate),
  ];
  if (params.channels && params.channels.length > 0) {
    conditions.push(inArray(salesForecasting.salesChannel, params.channels));
  }
  if (params.skus && params.skus.length > 0) {
    conditions.push(inArray(salesForecasting.sku, params.skus));
  }
  if (params.isAssembledProduct && params.isAssembledProduct !== 'either') {
    conditions.push(eq(salesForecasting.isAssembledProduct, params.isAssembledProduct === 'true'));
  }
  if (params.categories && params.categories.length > 0) {
    conditions.push(inArray(salesForecasting.category, params.categories));
  }
  if (params.eventTypes && params.eventTypes.length > 0) {
    conditions.push(inArray(salesForecasting.eventType, params.eventTypes));
  }
  if (params.isPeakSeason && params.isPeakSeason !== 'either') {
    conditions.push(eq(salesForecasting.isPeakSeason, params.isPeakSeason === 'true'));
  }
  return and(...conditions);
}

export class ForecastingService {
  private buildFilters(params: ForecastingSalesParams) {
    const assembledFilter = params.isAssembledProduct && params.isAssembledProduct !== 'either'
      ? reportingSql`AND is_assembled_product = ${params.isAssembledProduct === 'true'}`
      : reportingSql``;
    const categoryFilter = params.categories && params.categories.length > 0
      ? reportingSql`AND category IN ${reportingSql(params.categories)}`
      : reportingSql``;
    const eventTypeFilter = params.eventTypes && params.eventTypes.length > 0
      ? reportingSql`AND event_type IN ${reportingSql(params.eventTypes)}`
      : reportingSql``;
    const peakSeasonFilter = params.isPeakSeason && params.isPeakSeason !== 'either'
      ? reportingSql`AND is_peak_season = ${params.isPeakSeason === 'true'}`
      : reportingSql``;
    const channelFilter = params.channels && params.channels.length > 0
      ? reportingSql`AND sales_channel IN ${reportingSql(params.channels)}`
      : reportingSql``;
    const skuFilter = params.skus && params.skus.length > 0
      ? reportingSql`AND sku IN ${reportingSql(params.skus)}`
      : reportingSql``;
    return { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter };
  }

  private computeDateRange(params: ForecastingSalesParams): { startDate: Date; endDate: Date } {
    if (params.preset === TimeRangePreset.CUSTOM && params.startDate && params.endDate) {
      return {
        startDate: new Date(params.startDate),
        endDate: new Date(params.endDate + 'T23:59:59'),
      };
    }
    const today = nowCentral();
    const yesterday = subDays(today, 1);
    if (params.preset === TimeRangePreset.LAST_YEAR) {
      const lastYear = yesterday.getFullYear() - 1;
      return {
        startDate: new Date(lastYear, 0, 1),
        endDate: new Date(lastYear, 11, 31, 23, 59, 59),
      };
    }
    if (params.preset === TimeRangePreset.YEAR_TO_DATE) {
      return {
        startDate: new Date(yesterday.getFullYear(), 0, 1),
        endDate: yesterday,
      };
    }
    if (params.preset === TimeRangePreset.CURRENT_MONTH) {
      return {
        startDate: new Date(yesterday.getFullYear(), yesterday.getMonth(), 1),
        endDate: yesterday,
      };
    }
    if (params.preset === TimeRangePreset.NEXT_30_DAYS) {
      return { startDate: today, endDate: addDays(today, 30) };
    }
    if (params.preset === TimeRangePreset.NEXT_90_DAYS) {
      return { startDate: today, endDate: addDays(today, 90) };
    }
    if (params.preset === TimeRangePreset.NEXT_12_MONTHS) {
      return { startDate: today, endDate: addDays(today, 365) };
    }
    const days = TIME_RANGE_DAYS[params.preset] ?? 30;
    return {
      startDate: subDays(yesterday, days),
      endDate: yesterday,
    };
  }

  async getUpcomingPeakSeasons(limit: number = 3): Promise<Array<{ peakSeasonTypeId: number; name: string; year: number; startDate: string; endDate: string }>> {
    const PEAK_SEASON_NAMES: Record<number, string> = {
      1: 'Christmas',
      2: "Father's Day",
      3: 'Easter',
      4: "Valentine's Day",
    };
    const today = formatDate(nowCentral());
    const rows = await reportingSql`
      SELECT peak_season_type_id, year, start_date, end_date
      FROM peak_season_dates
      WHERE end_date < ${today}
      ORDER BY end_date DESC
      LIMIT ${limit}
    `;
    return rows.map((r: any) => ({
      peakSeasonTypeId: r.peak_season_type_id,
      name: PEAK_SEASON_NAMES[r.peak_season_type_id] || `Peak Season ${r.peak_season_type_id}`,
      year: r.year,
      startDate: format(new Date(r.start_date), 'yyyy-MM-dd'),
      endDate: format(new Date(r.end_date), 'yyyy-MM-dd'),
    }));
  }

  async getDistinctChannels(): Promise<ForecastingChannelsResponse> {
    return cachedFetch(buildCacheKey('channels'), async () => {
      const rows = await reportingSql`
        SELECT DISTINCT sales_channel
        FROM sales_metrics_lookup
        ORDER BY sales_channel
      `;
      return {
        channels: rows.map((r: any) => r.sales_channel as string),
      };
    });
  }

  async getFilterOptions(): Promise<ForecastingFilterOptionsResponse> {
    return cachedFetch(buildCacheKey('filter-options'), async () => {
      const [catRows, eventRows] = await Promise.all([
        reportingSql`SELECT DISTINCT category FROM sales_metrics_lookup WHERE category IS NOT NULL ORDER BY category`,
        reportingSql`SELECT DISTINCT event_type FROM sales_metrics_lookup WHERE event_type IS NOT NULL ORDER BY event_type`,
      ]);
      return {
        categories: catRows.map((r: any) => r.category as string),
        eventTypes: eventRows.map((r: any) => r.event_type as string),
      };
    });
  }

  async getSalesData(params: ForecastingSalesParams): Promise<ForecastingSalesResponse> {
    return cachedFetch(buildCacheKey('sales', params), async () => {
      const { preset, channels } = params;
      const { startDate, endDate } = this.computeDateRange(params);
      const split = splitDateRange(startDate, endDate);

      let allRows: Array<{
        order_day: string;
        sales_channel: string;
        total_revenue: string;
        total_quantity: string;
      }> = [];

      if (split.hasHistorical && split.historicalStart && split.historicalEnd) {
        const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);
        const histRows = await reportingSql`
          SELECT
            order_date::date AS order_day,
            sales_channel,
            COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
            COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
          FROM sales_metrics_lookup
          WHERE order_date >= ${split.historicalStart}
            AND order_date <= ${split.historicalEnd}
            ${channelFilter}
            ${skuFilter}
            ${assembledFilter}
            ${categoryFilter}
            ${eventTypeFilter}
            ${peakSeasonFilter}
          GROUP BY 1, 2
          ORDER BY 1, 2
        `;
        allRows.push(...(histRows as any[]));
      }

      if (split.hasForecast && split.forecastStart && split.forecastEnd) {
        const where = buildLocalWhereConditions(params, split.forecastStart, split.forecastEnd);
        const forecastRows = await db.select({
          order_day: drizzleSql<string>`order_date::date`,
          sales_channel: salesForecasting.salesChannel,
          total_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesRevenue}), 0)`,
          total_quantity: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesQuantity}), 0)`,
        })
          .from(salesForecasting)
          .where(where!)
          .groupBy(drizzleSql`1`, salesForecasting.salesChannel)
          .orderBy(drizzleSql`1`, salesForecasting.salesChannel);
        allRows.push(...forecastRows.map(r => ({
          order_day: String(r.order_day),
          sales_channel: r.sales_channel,
          total_revenue: String(r.total_revenue),
          total_quantity: String(r.total_quantity),
        })));
      }

      const data: SalesDataPoint[] = allRows.map((row) => ({
        orderDate: typeof row.order_day === 'string'
          ? row.order_day
          : formatDate(new Date(row.order_day)),
        salesChannel: row.sales_channel,
        totalRevenue: parseFloat(row.total_revenue) || 0,
        totalQuantity: parseFloat(row.total_quantity) || 0,
      }));

      return {
        data,
        params: {
          preset,
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
          channels: channels ?? [],
        },
      };
    });
  }

  async getRevenueTimeSeries(params: ForecastingSalesParams): Promise<RevenueTimeSeriesResponse> {
    return cachedFetch(buildCacheKey('revenue-ts', params), async () => {
      const { preset } = params;
      const { startDate, endDate } = this.computeDateRange(params);
      const split = splitDateRange(startDate, endDate);

      let allRows: Array<{
        order_day: string;
        daily_revenue: string;
        yoy_revenue: string;
        daily_quantity: string;
        yoy_quantity: string;
      }> = [];

      if (split.hasHistorical && split.historicalStart && split.historicalEnd) {
        const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);
        const histRows = await reportingSql`
          SELECT
            order_date::date AS order_day,
            COALESCE(SUM(daily_sales_revenue), 0) AS daily_revenue,
            COALESCE(SUM(yoy_daily_sales_revenue), 0) AS yoy_revenue,
            COALESCE(SUM(daily_sales_quantity), 0) AS daily_quantity,
            COALESCE(SUM(yoy_daily_sales_quantity), 0) AS yoy_quantity
          FROM sales_metrics_lookup
          WHERE order_date >= ${split.historicalStart}
            AND order_date <= ${split.historicalEnd}
            ${channelFilter}
            ${skuFilter}
            ${assembledFilter}
            ${categoryFilter}
            ${eventTypeFilter}
            ${peakSeasonFilter}
          GROUP BY 1
          ORDER BY 1
        `;
        allRows.push(...(histRows as any[]));
      }

      if (split.hasForecast && split.forecastStart && split.forecastEnd) {
        const where = buildLocalWhereConditions(params, split.forecastStart, split.forecastEnd);
        const forecastRows = await db.select({
          order_day: drizzleSql<string>`order_date::date`,
          daily_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesRevenue}), 0)`,
          yoy_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyDailySalesRevenue}), 0)`,
          daily_quantity: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesQuantity}), 0)`,
          yoy_quantity: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyDailySalesQuantity}), 0)`,
        })
          .from(salesForecasting)
          .where(where!)
          .groupBy(drizzleSql`1`)
          .orderBy(drizzleSql`1`);
        allRows.push(...forecastRows.map(r => ({
          order_day: String(r.order_day),
          daily_revenue: String(r.daily_revenue),
          yoy_revenue: String(r.yoy_revenue),
          daily_quantity: String(r.daily_quantity),
          yoy_quantity: String(r.yoy_quantity),
        })));
      }

      const data: RevenueTimeSeriesPoint[] = allRows.map((row) => ({
        date: typeof row.order_day === 'string'
          ? row.order_day
          : formatDate(new Date(row.order_day)),
        dailyRevenue: parseFloat(row.daily_revenue) || 0,
        yoyRevenue: parseFloat(row.yoy_revenue) || 0,
        dailyQuantity: parseFloat(row.daily_quantity) || 0,
        yoyQuantity: parseFloat(row.yoy_quantity) || 0,
      }));

      return {
        data,
        params: {
          preset,
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
        },
      };
    });
  }

  async getKitTimeSeries(params: ForecastingSalesParams): Promise<KitTimeSeriesResponse> {
    return cachedFetch(buildCacheKey('kit-ts', params), async () => {
      const { preset } = params;
      const { startDate, endDate } = this.computeDateRange(params);
      const split = splitDateRange(startDate, endDate);

      let allRows: Array<{
        order_day: string;
        kit_revenue: string;
        yoy_kit_revenue: string;
        kit_quantity: string;
        yoy_kit_quantity: string;
      }> = [];

      if (split.hasHistorical && split.historicalStart && split.historicalEnd) {
        const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);
        const histRows = await reportingSql`
          SELECT
            order_date::date AS order_day,
            COALESCE(SUM(kit_daily_sales_revenue), 0) AS kit_revenue,
            COALESCE(SUM(yoy_kit_daily_sales_revenue), 0) AS yoy_kit_revenue,
            COALESCE(SUM(kit_daily_sales_quantity), 0) AS kit_quantity,
            COALESCE(SUM(yoy_kit_daily_sales_quantity), 0) AS yoy_kit_quantity
          FROM sales_metrics_lookup
          WHERE order_date >= ${split.historicalStart}
            AND order_date <= ${split.historicalEnd}
            ${channelFilter}
            ${skuFilter}
            ${assembledFilter}
            ${categoryFilter}
            ${eventTypeFilter}
            ${peakSeasonFilter}
          GROUP BY 1
          ORDER BY 1
        `;
        allRows.push(...(histRows as any[]));
      }

      if (split.hasForecast && split.forecastStart && split.forecastEnd) {
        const where = buildLocalWhereConditions(params, split.forecastStart, split.forecastEnd);
        const forecastRows = await db.select({
          order_day: drizzleSql<string>`order_date::date`,
          kit_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.kitDailySalesRevenue}), 0)`,
          yoy_kit_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyKitDailySalesRevenue}), 0)`,
          kit_quantity: drizzleSql<string>`COALESCE(SUM(${salesForecasting.kitDailySalesQuantity}), 0)`,
          yoy_kit_quantity: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyKitDailySalesQuantity}), 0)`,
        })
          .from(salesForecasting)
          .where(where!)
          .groupBy(drizzleSql`1`)
          .orderBy(drizzleSql`1`);
        allRows.push(...forecastRows.map(r => ({
          order_day: String(r.order_day),
          kit_revenue: String(r.kit_revenue),
          yoy_kit_revenue: String(r.yoy_kit_revenue),
          kit_quantity: String(r.kit_quantity),
          yoy_kit_quantity: String(r.yoy_kit_quantity),
        })));
      }

      const data: KitTimeSeriesPoint[] = allRows.map((row) => ({
        date: typeof row.order_day === 'string'
          ? row.order_day
          : formatDate(new Date(row.order_day)),
        kitDailyRevenue: parseFloat(row.kit_revenue) || 0,
        yoyKitDailyRevenue: parseFloat(row.yoy_kit_revenue) || 0,
        kitDailyQuantity: parseFloat(row.kit_quantity) || 0,
        yoyKitDailyQuantity: parseFloat(row.yoy_kit_quantity) || 0,
      }));

      return {
        data,
        params: {
          preset,
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
        },
      };
    });
  }

  async getSummaryMetrics(params: ForecastingSalesParams): Promise<SummaryMetricsResponse> {
    return cachedFetch(buildCacheKey('summary', params), async () => {
      const { preset } = params;
      const { startDate, endDate } = this.computeDateRange(params);
      const split = splitDateRange(startDate, endDate);

      let totalRevenue = 0, totalUnits = 0, yoyTotalRevenue = 0, yoyTotalUnits = 0;
      let channelGrowthRows: Array<{ sales_channel: string; yoy_growth_factor: string | null }> = [];
      let channelTrendRows: Array<{ sales_channel: string; trend_factor: string | null }> = [];
      let channelConfidenceRows: Array<{ sales_channel: string; confidence_level: string | null }> = [];

      if (split.hasHistorical && split.historicalStart && split.historicalEnd) {
        const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);

        const [rows, growthRows, trendRows, confRows] = await Promise.all([
          reportingSql`
            SELECT
              COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
              COALESCE(SUM(daily_sales_quantity), 0) AS total_units,
              COALESCE(SUM(yoy_daily_sales_revenue), 0) AS yoy_total_revenue,
              COALESCE(SUM(yoy_daily_sales_quantity), 0) AS yoy_total_units
            FROM sales_metrics_lookup
            WHERE order_date >= ${split.historicalStart}
              AND order_date <= ${split.historicalEnd}
              ${channelFilter}
              ${skuFilter}
              ${assembledFilter}
              ${categoryFilter}
              ${eventTypeFilter}
              ${peakSeasonFilter}
          `,
          reportingSql`
            SELECT DISTINCT ON (sales_channel)
              sales_channel,
              yoy_growth_factor
            FROM sales_metrics_lookup
            WHERE order_date >= ${split.historicalStart}
              AND order_date <= ${split.historicalEnd}
              ${channelFilter}
              ${skuFilter}
              ${assembledFilter}
              ${categoryFilter}
              ${eventTypeFilter}
              ${peakSeasonFilter}
              AND yoy_growth_factor IS NOT NULL
            ORDER BY sales_channel, order_date DESC
          `,
          reportingSql`
            SELECT DISTINCT ON (sales_channel)
              sales_channel,
              trend_factor
            FROM sales_metrics_lookup
            WHERE order_date >= ${split.historicalStart}
              AND order_date <= ${split.historicalEnd}
              ${channelFilter}
              ${skuFilter}
              ${assembledFilter}
              ${categoryFilter}
              ${eventTypeFilter}
              ${peakSeasonFilter}
              AND trend_factor IS NOT NULL
            ORDER BY sales_channel, order_date DESC
          `,
          reportingSql`
            SELECT DISTINCT ON (sales_channel)
              sales_channel,
              confidence_level
            FROM sales_metrics_lookup
            WHERE order_date >= ${split.historicalStart}
              AND order_date <= ${split.historicalEnd}
              ${channelFilter}
              ${skuFilter}
              ${assembledFilter}
              ${categoryFilter}
              ${eventTypeFilter}
              ${peakSeasonFilter}
              AND confidence_level IS NOT NULL
            ORDER BY sales_channel, order_date DESC
          `,
        ]);

        const row = rows[0];
        totalRevenue += parseFloat(row.total_revenue) || 0;
        totalUnits += parseFloat(row.total_units) || 0;
        yoyTotalRevenue += parseFloat(row.yoy_total_revenue) || 0;
        yoyTotalUnits += parseFloat(row.yoy_total_units) || 0;
        channelGrowthRows = growthRows as any[];
        channelTrendRows = trendRows as any[];
        channelConfidenceRows = confRows as any[];
      }

      if (split.hasForecast && split.forecastStart && split.forecastEnd) {
        const where = buildLocalWhereConditions(params, split.forecastStart, split.forecastEnd);
        const forecastSummary = await db.select({
          total_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesRevenue}), 0)`,
          total_units: drizzleSql<string>`COALESCE(SUM(${salesForecasting.dailySalesQuantity}), 0)`,
          yoy_total_revenue: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyDailySalesRevenue}), 0)`,
          yoy_total_units: drizzleSql<string>`COALESCE(SUM(${salesForecasting.yoyDailySalesQuantity}), 0)`,
        })
          .from(salesForecasting)
          .where(where!);

        if (forecastSummary[0]) {
          totalRevenue += parseFloat(forecastSummary[0].total_revenue) || 0;
          totalUnits += parseFloat(forecastSummary[0].total_units) || 0;
          yoyTotalRevenue += parseFloat(forecastSummary[0].yoy_total_revenue) || 0;
          yoyTotalUnits += parseFloat(forecastSummary[0].yoy_total_units) || 0;
        }

        if (channelGrowthRows.length === 0) {
          const localGrowth = await db.selectDistinctOn([salesForecasting.salesChannel], {
            sales_channel: salesForecasting.salesChannel,
            yoy_growth_factor: salesForecasting.yoyGrowthFactor,
          })
            .from(salesForecasting)
            .where(and(where!, isNotNull(salesForecasting.yoyGrowthFactor)))
            .orderBy(salesForecasting.salesChannel, desc(salesForecasting.orderDate));
          channelGrowthRows = localGrowth.map(r => ({
            sales_channel: r.sales_channel,
            yoy_growth_factor: r.yoy_growth_factor,
          }));
        }

        if (channelTrendRows.length === 0) {
          const localTrend = await db.selectDistinctOn([salesForecasting.salesChannel], {
            sales_channel: salesForecasting.salesChannel,
            trend_factor: salesForecasting.trendFactor,
          })
            .from(salesForecasting)
            .where(and(where!, isNotNull(salesForecasting.trendFactor)))
            .orderBy(salesForecasting.salesChannel, desc(salesForecasting.orderDate));
          channelTrendRows = localTrend.map(r => ({
            sales_channel: r.sales_channel,
            trend_factor: r.trend_factor,
          }));
        }

        if (channelConfidenceRows.length === 0) {
          const localConf = await db.selectDistinctOn([salesForecasting.salesChannel], {
            sales_channel: salesForecasting.salesChannel,
            confidence_level: salesForecasting.confidenceLevel,
          })
            .from(salesForecasting)
            .where(and(where!, isNotNull(salesForecasting.confidenceLevel)))
            .orderBy(salesForecasting.salesChannel, desc(salesForecasting.orderDate));
          channelConfidenceRows = localConf.map(r => ({
            sales_channel: r.sales_channel,
            confidence_level: r.confidence_level,
          }));
        }
      }

      const yoyRevenueChangePct = yoyTotalRevenue > 0
        ? ((totalRevenue - yoyTotalRevenue) / yoyTotalRevenue) * 100
        : null;
      const yoyUnitsChangePct = yoyTotalUnits > 0
        ? ((totalUnits - yoyTotalUnits) / yoyTotalUnits) * 100
        : null;

      return {
        data: {
          totalRevenue,
          totalUnits,
          yoyTotalRevenue,
          yoyTotalUnits,
          yoyRevenueChangePct,
          yoyUnitsChangePct,
          yoyGrowthByChannel: channelGrowthRows
            .filter((r) => r.yoy_growth_factor != null)
            .map((r) => ({
              channel: r.sales_channel,
              yoyGrowthFactor: parseFloat(r.yoy_growth_factor!),
            })),
          trendByChannel: channelTrendRows
            .filter((r) => r.trend_factor != null)
            .map((r) => ({
              channel: r.sales_channel,
              trendFactor: parseFloat(r.trend_factor!),
            })),
          confidenceByChannel: channelConfidenceRows
            .filter((r) => r.confidence_level != null)
            .map((r) => ({
              channel: r.sales_channel,
              confidenceLevel: r.confidence_level!.toLowerCase() as 'critical' | 'warning' | 'normal',
            })),
        },
        params: {
          preset,
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
        },
      };
    });
  }

  async getProducts(): Promise<ForecastingProductsResponse> {
    return cachedFetch(buildCacheKey('products'), async () => {
      const rows: Array<{
        sku: string;
        title: string;
        category: string | null;
      }> = await reportingSql`
        SELECT sku, MAX(title) AS title, MAX(category) AS category
        FROM sales_metrics_lookup
        WHERE sku IS NOT NULL AND sku != ''
        GROUP BY sku
        ORDER BY MAX(title) ASC, sku ASC
      `;

      return {
        products: rows.map((r) => ({
          sku: r.sku,
          title: r.title || r.sku,
          category: r.category,
        })),
      };
    });
  }
}

export const forecastingService = new ForecastingService();

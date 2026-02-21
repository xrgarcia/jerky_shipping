import { reportingSql } from '../reporting-db';
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
import { subDays, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { getRedisClient } from '../utils/queue';

const CACHE_TTL_SECONDS = 3600;
const CST_TIMEZONE = 'America/Chicago';

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
    params.category ?? '_',
    params.eventType ?? '_',
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

export class ForecastingService {
  private buildFilters(params: ForecastingSalesParams) {
    const assembledFilter = params.isAssembledProduct && params.isAssembledProduct !== 'either'
      ? reportingSql`AND is_assembled_product = ${params.isAssembledProduct === 'true'}`
      : reportingSql``;
    const categoryFilter = params.category
      ? reportingSql`AND category = ${params.category}`
      : reportingSql``;
    const eventTypeFilter = params.eventType
      ? reportingSql`AND event_type = ${params.eventType}`
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
    const now = nowCentral();
    if (params.preset === TimeRangePreset.YEAR_TO_DATE) {
      return {
        startDate: new Date(now.getFullYear(), 0, 1),
        endDate: now,
      };
    }
    if (params.preset === TimeRangePreset.CURRENT_MONTH) {
      return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1),
        endDate: now,
      };
    }
    const days = TIME_RANGE_DAYS[params.preset] ?? 30;
    return {
      startDate: subDays(now, days),
      endDate: now,
    };
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
      const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);

      const rows: Array<{
        order_day: string;
        sales_channel: string;
        total_revenue: string;
        total_quantity: string;
      }> = await reportingSql`
        SELECT
          order_date::date AS order_day,
          sales_channel,
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
        GROUP BY 1, 2
        ORDER BY 1, 2
      `;

      const data: SalesDataPoint[] = rows.map((row) => ({
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
      const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);

      const rows: Array<{
        order_day: string;
        daily_revenue: string;
        yoy_revenue: string;
        daily_quantity: string;
        yoy_quantity: string;
      }> = await reportingSql`
        SELECT
          order_date::date AS order_day,
          COALESCE(SUM(daily_sales_revenue), 0) AS daily_revenue,
          COALESCE(SUM(yoy_daily_sales_revenue), 0) AS yoy_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS daily_quantity,
          COALESCE(SUM(yoy_daily_sales_quantity), 0) AS yoy_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
        GROUP BY 1
        ORDER BY 1
      `;

      const data: RevenueTimeSeriesPoint[] = rows.map((row) => ({
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
      const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);

      const rows: Array<{
        order_day: string;
        kit_revenue: string;
        yoy_kit_revenue: string;
        kit_quantity: string;
        yoy_kit_quantity: string;
      }> = await reportingSql`
        SELECT
          order_date::date AS order_day,
          COALESCE(SUM(kit_daily_sales_revenue), 0) AS kit_revenue,
          COALESCE(SUM(yoy_kit_daily_sales_revenue), 0) AS yoy_kit_revenue,
          COALESCE(SUM(kit_daily_sales_quantity), 0) AS kit_quantity,
          COALESCE(SUM(yoy_kit_daily_sales_quantity), 0) AS yoy_kit_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
        GROUP BY 1
        ORDER BY 1
      `;

      const data: KitTimeSeriesPoint[] = rows.map((row) => ({
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
      const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter, skuFilter } = this.buildFilters(params);

      const rows: Array<{
        total_revenue: string;
        total_units: string;
        yoy_total_revenue: string;
        yoy_total_units: string;
      }> = await reportingSql`
        SELECT
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_units,
          COALESCE(SUM(yoy_daily_sales_revenue), 0) AS yoy_total_revenue,
          COALESCE(SUM(yoy_daily_sales_quantity), 0) AS yoy_total_units
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
      `;

      const channelGrowthRows: Array<{
        sales_channel: string;
        yoy_growth_factor: string | null;
      }> = await reportingSql`
        SELECT DISTINCT ON (sales_channel)
          sales_channel,
          yoy_growth_factor
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
          AND yoy_growth_factor IS NOT NULL
        ORDER BY sales_channel, order_date DESC
      `;

      const channelTrendRows: Array<{
        sales_channel: string;
        trend_factor: string | null;
      }> = await reportingSql`
        SELECT DISTINCT ON (sales_channel)
          sales_channel,
          trend_factor
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
          AND trend_factor IS NOT NULL
        ORDER BY sales_channel, order_date DESC
      `;

      const channelConfidenceRows: Array<{
        sales_channel: string;
        confidence_level: string | null;
      }> = await reportingSql`
        SELECT DISTINCT ON (sales_channel)
          sales_channel,
          confidence_level
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          ${channelFilter}
          ${skuFilter}
          ${assembledFilter}
          ${categoryFilter}
          ${eventTypeFilter}
          ${peakSeasonFilter}
          AND confidence_level IS NOT NULL
        ORDER BY sales_channel, order_date DESC
      `;

      const row = rows[0];
      const totalRevenue = parseFloat(row.total_revenue) || 0;
      const totalUnits = parseFloat(row.total_units) || 0;
      const yoyTotalRevenue = parseFloat(row.yoy_total_revenue) || 0;
      const yoyTotalUnits = parseFloat(row.yoy_total_units) || 0;

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

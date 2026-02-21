import { reportingSql } from '../reporting-db';
import type {
  SalesDataPoint,
  ForecastingSalesParams,
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
  RevenueTimeSeriesPoint,
  RevenueTimeSeriesResponse,
  SummaryMetrics,
  SummaryMetricsResponse,
} from '@shared/forecasting-types';
import { TimeRangePreset, TIME_RANGE_DAYS } from '@shared/forecasting-types';
import { formatInTimeZone } from 'date-fns-tz';
import { subDays } from 'date-fns';

const CST_TIMEZONE = 'America/Chicago';

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
    return { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter };
  }

  private computeDateRange(params: ForecastingSalesParams): { startDate: Date; endDate: Date } {
    if (params.preset === TimeRangePreset.CUSTOM && params.startDate && params.endDate) {
      return {
        startDate: new Date(params.startDate),
        endDate: new Date(params.endDate + 'T23:59:59'),
      };
    }
    const now = new Date();
    const days = TIME_RANGE_DAYS[params.preset] ?? 30;
    return {
      startDate: subDays(now, days),
      endDate: now,
    };
  }

  async getDistinctChannels(): Promise<ForecastingChannelsResponse> {
    const rows = await reportingSql`
      SELECT DISTINCT sales_channel
      FROM sales_metrics_lookup
      ORDER BY sales_channel
    `;
    return {
      channels: rows.map((r: any) => r.sales_channel as string),
    };
  }

  async getFilterOptions(): Promise<ForecastingFilterOptionsResponse> {
    const [catRows, eventRows] = await Promise.all([
      reportingSql`SELECT DISTINCT category FROM sales_metrics_lookup WHERE category IS NOT NULL ORDER BY category`,
      reportingSql`SELECT DISTINCT event_type FROM sales_metrics_lookup WHERE event_type IS NOT NULL ORDER BY event_type`,
    ]);
    return {
      categories: catRows.map((r: any) => r.category as string),
      eventTypes: eventRows.map((r: any) => r.event_type as string),
    };
  }

  async getSalesData(params: ForecastingSalesParams): Promise<ForecastingSalesResponse> {
    const { preset, channels } = params;
    const { startDate, endDate } = this.computeDateRange(params);
    const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter } = this.buildFilters(params);

    const rows: Array<{
      order_day: string;
      sales_channel: string;
      total_revenue: string;
      total_quantity: string;
    }> = await reportingSql`
      SELECT
        (order_date AT TIME ZONE ${CST_TIMEZONE})::date AS order_day,
        sales_channel,
        COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
        COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
      FROM sales_metrics_lookup
      WHERE order_date >= ${startDate}
        AND order_date <= ${endDate}
        ${channelFilter}
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
        : formatInTimeZone(new Date(row.order_day), CST_TIMEZONE, 'yyyy-MM-dd'),
      salesChannel: row.sales_channel,
      totalRevenue: parseFloat(row.total_revenue) || 0,
      totalQuantity: parseFloat(row.total_quantity) || 0,
    }));

    return {
      data,
      params: {
        preset,
        startDate: formatInTimeZone(startDate, CST_TIMEZONE, 'yyyy-MM-dd'),
        endDate: formatInTimeZone(endDate, CST_TIMEZONE, 'yyyy-MM-dd'),
        channels: channels ?? [],
      },
    };
  }
  async getRevenueTimeSeries(params: ForecastingSalesParams): Promise<RevenueTimeSeriesResponse> {
    const { preset } = params;
    const { startDate, endDate } = this.computeDateRange(params);
    const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter } = this.buildFilters(params);

    const rows: Array<{
      order_day: string;
      daily_revenue: string;
      yoy_revenue: string;
      daily_quantity: string;
      yoy_quantity: string;
    }> = await reportingSql`
      SELECT
        (order_date AT TIME ZONE ${CST_TIMEZONE})::date AS order_day,
        COALESCE(SUM(daily_sales_revenue), 0) AS daily_revenue,
        COALESCE(SUM(yoy_daily_sales_revenue), 0) AS yoy_revenue,
        COALESCE(SUM(daily_sales_quantity), 0) AS daily_quantity,
        COALESCE(SUM(yoy_daily_sales_quantity), 0) AS yoy_quantity
      FROM sales_metrics_lookup
      WHERE order_date >= ${startDate}
        AND order_date <= ${endDate}
        ${channelFilter}
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
        : formatInTimeZone(new Date(row.order_day), CST_TIMEZONE, 'yyyy-MM-dd'),
      dailyRevenue: parseFloat(row.daily_revenue) || 0,
      yoyRevenue: parseFloat(row.yoy_revenue) || 0,
      dailyQuantity: parseFloat(row.daily_quantity) || 0,
      yoyQuantity: parseFloat(row.yoy_quantity) || 0,
    }));

    return {
      data,
      params: {
        preset,
        startDate: formatInTimeZone(startDate, CST_TIMEZONE, 'yyyy-MM-dd'),
        endDate: formatInTimeZone(endDate, CST_TIMEZONE, 'yyyy-MM-dd'),
      },
    };
  }
  async getSummaryMetrics(params: ForecastingSalesParams): Promise<SummaryMetricsResponse> {
    const { preset } = params;
    const { startDate, endDate } = this.computeDateRange(params);
    const { assembledFilter, categoryFilter, eventTypeFilter, peakSeasonFilter, channelFilter } = this.buildFilters(params);

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
        ${assembledFilter}
        ${categoryFilter}
        ${eventTypeFilter}
        ${peakSeasonFilter}
    `;

    const hasExtraFilters = !!(
      (params.isAssembledProduct && params.isAssembledProduct !== 'either') ||
      params.category ||
      params.eventType ||
      (params.isPeakSeason && params.isPeakSeason !== 'either')
    );

    let totalOrders = 0;
    let ordersAvailable = true;
    if (!hasExtraFilters) {
      try {
        const orderRows: Array<{ total_orders: string }> = await reportingSql`
          SELECT COUNT(DISTINCT order_number) AS total_orders
          FROM orders
          WHERE order_date >= ${startDate}
            AND order_date <= ${endDate}
            ${channelFilter}
        `;
        totalOrders = parseInt(orderRows[0]?.total_orders) || 0;
      } catch (e) {
        console.warn("[Forecasting] Could not fetch order count from orders table:", (e as Error).message);
        ordersAvailable = false;
      }
    } else {
      ordersAvailable = false;
    }

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
        totalOrders: ordersAvailable ? totalOrders : null,
        yoyTotalRevenue,
        yoyTotalUnits,
        yoyRevenueChangePct,
        yoyUnitsChangePct,
      },
      params: {
        preset,
        startDate: formatInTimeZone(startDate, CST_TIMEZONE, 'yyyy-MM-dd'),
        endDate: formatInTimeZone(endDate, CST_TIMEZONE, 'yyyy-MM-dd'),
      },
    };
  }
}

export const forecastingService = new ForecastingService();

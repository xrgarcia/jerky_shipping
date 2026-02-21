import { reportingSql } from '../reporting-db';
import type {
  SalesDataPoint,
  ForecastingSalesParams,
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
} from '@shared/forecasting-types';
import { TimeRangePreset, TIME_RANGE_DAYS } from '@shared/forecasting-types';
import { formatInTimeZone } from 'date-fns-tz';
import { subDays } from 'date-fns';

const CST_TIMEZONE = 'America/Chicago';

export class ForecastingService {
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

    const channelFilter = channels && channels.length > 0
      ? reportingSql`AND sales_channel IN ${reportingSql(channels)}`
      : reportingSql``;

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
}

export const forecastingService = new ForecastingService();

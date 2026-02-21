import { reportingSql } from '../reporting-db';
import type {
  SalesDataPoint,
  ForecastingSalesParams,
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
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

  async getSalesData(params: ForecastingSalesParams): Promise<ForecastingSalesResponse> {
    const { preset, channels } = params;
    const { startDate, endDate } = this.computeDateRange(params);

    let rows: Array<{
      order_day: string;
      sales_channel: string;
      total_revenue: string;
      total_quantity: string;
    }>;

    if (channels && channels.length > 0) {
      rows = await reportingSql`
        SELECT
          (order_date AT TIME ZONE ${CST_TIMEZONE})::date AS order_day,
          sales_channel,
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          AND sales_channel IN ${reportingSql(channels)}
        GROUP BY 1, 2
        ORDER BY 1, 2
      `;
    } else {
      rows = await reportingSql`
        SELECT
          (order_date AT TIME ZONE ${CST_TIMEZONE})::date AS order_day,
          sales_channel,
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
        GROUP BY 1, 2
        ORDER BY 1, 2
      `;
    }

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

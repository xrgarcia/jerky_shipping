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
  private computeDateRange(preset: TimeRangePreset): { startDate: Date; endDate: Date } {
    const now = new Date();
    const days = TIME_RANGE_DAYS[preset];
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
      channels: rows.map((r: { sales_channel: string }) => r.sales_channel),
    };
  }

  async getSalesData(params: ForecastingSalesParams): Promise<ForecastingSalesResponse> {
    const { preset, channels } = params;
    const { startDate, endDate } = this.computeDateRange(preset);

    let rows: Array<{
      order_date: string;
      sales_channel: string;
      total_revenue: string;
      total_quantity: string;
    }>;

    if (channels && channels.length > 0) {
      rows = await reportingSql`
        SELECT
          DATE(order_date AT TIME ZONE ${CST_TIMEZONE}) AS order_date,
          sales_channel,
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
          AND sales_channel IN ${reportingSql(channels)}
        GROUP BY DATE(order_date AT TIME ZONE ${CST_TIMEZONE}), sales_channel
        ORDER BY order_date, sales_channel
      `;
    } else {
      rows = await reportingSql`
        SELECT
          DATE(order_date AT TIME ZONE ${CST_TIMEZONE}) AS order_date,
          sales_channel,
          COALESCE(SUM(daily_sales_revenue), 0) AS total_revenue,
          COALESCE(SUM(daily_sales_quantity), 0) AS total_quantity
        FROM sales_metrics_lookup
        WHERE order_date >= ${startDate}
          AND order_date <= ${endDate}
        GROUP BY DATE(order_date AT TIME ZONE ${CST_TIMEZONE}), sales_channel
        ORDER BY order_date, sales_channel
      `;
    }

    const data: SalesDataPoint[] = rows.map((row) => ({
      orderDate: typeof row.order_date === 'string'
        ? row.order_date
        : formatInTimeZone(new Date(row.order_date), CST_TIMEZONE, 'yyyy-MM-dd'),
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

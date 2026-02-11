import winston from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'h:mm:ss A' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level}]${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

export interface OrderContext {
  orderNumber?: string;
  shipmentId?: string;
  trackingNumber?: string;
  sessionId?: string;
  localSessionId?: string;
  sku?: string;
  fingerprintId?: string;
  workstationId?: string;
  user?: string;
  queueItemId?: string;
  lifecyclePhase?: string;
  subphase?: string;
}

export function withOrder(
  orderNumber: string | undefined | null,
  shipmentId?: string | undefined | null,
  extras?: Record<string, any>
): Record<string, any> {
  const ctx: Record<string, any> = {};
  if (orderNumber) ctx.orderNumber = orderNumber;
  if (shipmentId) ctx.shipmentId = shipmentId;
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value !== undefined && value !== null) {
        ctx[key] = value;
      }
    }
  }
  return ctx;
}

export default logger;

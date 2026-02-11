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

export default logger;

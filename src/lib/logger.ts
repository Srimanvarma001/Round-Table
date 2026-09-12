import pino from 'pino';

import { config } from './config';

/**
 * Single shared logger. Pretty in development, JSON otherwise.
 * Section 4.5.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

export type Logger = typeof logger;

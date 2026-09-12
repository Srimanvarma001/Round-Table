/**
 * Typed query helpers, one module per table group (section 5: `queries/`).
 *
 * Every module is server-only and returns RAW DRIZZLE ROWS. Serialising a row
 * into a `shared/types` DTO is the API layer's job, so a raw row never reaches
 * the client and a column rename never silently changes a response shape.
 *
 * All calls are synchronous: drizzle's better-sqlite3 driver has no async API.
 */

export * from './agents';
export * from './artifacts';
export * from './events';
export * from './messages';
export * from './pricing';
export * from './profile';
export * from './runs';
export * from './settings';

export type { Db } from '@/lib/db/client';

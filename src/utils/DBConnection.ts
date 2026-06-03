import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';
import * as schema from '@/models/Schema';

// Transient network errors seen on cold start, when the Postgres service DNS
// inside the container network is not yet resolvable. These are self-healing:
// the connection succeeds once DNS propagates, so a short retry avoids turning
// a boot-time race into a user-facing 500.
const TRANSIENT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
]);

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;

const isTransientError = (error: unknown): boolean => {
  const code = (error as { code?: string })?.code;
  return code !== undefined && TRANSIENT_ERROR_CODES.has(code);
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Need a database for production? Check out https://get.neon.com/BMFYNtx
// Tested and compatible with Next.js Boilerplate
export const createDbConnection = () => {
  const pool = new Pool({
    connectionString: Env.DATABASE_URL,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (error) => {
    logger.error(`Database pool error: ${error.message}`);
  });

  // Wrap pool.query so transient DNS/connection failures on cold start are
  // retried with backoff instead of bubbling up as request errors. drizzle
  // calls pool.query internally, so this is transparent to all consumers.
  const originalQuery = pool.query.bind(pool);
  pool.query = (async (...args: unknown[]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        lastError = error;
        if (!isTransientError(error) || attempt === MAX_RETRIES) {
          throw error;
        }
        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          `Transient database error (${(error as { code?: string }).code}); retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }) as typeof pool.query;

  return drizzle({
    client: pool,
    schema,
  });
};

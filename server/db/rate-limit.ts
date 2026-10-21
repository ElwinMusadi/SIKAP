// Fixed-window counters in D1 (`rate_limit` table).
// Complements, not replaces, the Cloudflare WAF rate-limiting rule on /api/auth/login.

export interface RateLimitRow {
  window_start: string;
  count: number;
}

/**
 * Count one hit and return the new `{ count, window_start }` (atomic UPSERT —
 * callers decide from the RETURNING value, never from a prior read). Starts a
 * fresh window when the stored one began at or before `windowFloorIso`
 * (= now - window length).
 */
export function hitRateLimit(db: D1Database, key: string, nowIso: string, windowFloorIso: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rate_limit (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count        = CASE WHEN rate_limit.window_start <= ?3 THEN 1 ELSE rate_limit.count + 1 END,
         window_start = CASE WHEN rate_limit.window_start <= ?3 THEN excluded.window_start
                             ELSE rate_limit.window_start END
       RETURNING count, window_start`,
    )
    .bind(key, nowIso, windowFloorIso);
}

/** Give back one hit (used after a successful login so legitimate use never accumulates). */
export function refundRateLimit(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`UPDATE rate_limit SET count = MAX(count - 1, 0) WHERE key = ?1`).bind(key);
}

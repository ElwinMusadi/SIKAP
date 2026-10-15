import { AUTH_POLICY } from '../../shared/enums';
import type { Bindings } from '../env';

/** SESSION_TTL_HOURS var, clamped to 1 h – 7 d; falls back to policy default. */
export function sessionTtlHours(env: Pick<Bindings, 'SESSION_TTL_HOURS'>): number {
  const n = Number(env.SESSION_TTL_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 24 * 7 ? n : AUTH_POLICY.sessionTtlHours;
}

import type { Role, StatusKepegawaian } from '../shared/enums';

/** Cloudflare bindings, vars and secrets (wrangler.toml + `.dev.vars` / Pages secrets). */
export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  /** Optional private logical-backup bucket; absence disables backup creation safely. */
  BACKUPS?: R2Bucket;
  /** Public origin of the app, e.g. https://sikap.uptdpenda-kupang.web.id */
  APP_URL: string;
  /** Sliding session lifetime in hours (string var). */
  SESSION_TTL_HOURS: string;
  /** Secret HMAC key mixed into every password hash. */
  PASSWORD_PEPPER: string;
  /** Secret AES-GCM key for encrypted settings (phase 5). */
  SETTINGS_ENC_KEY: string;
  /** Optional private UAT API boundary. Set to '1' only with valid Access config. */
  ACCESS_REQUIRED?: string;
  /** Lowercase <team>.cloudflareaccess.com (no scheme/path). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Expected Cloudflare Access application AUD tag. */
  ACCESS_AUDIENCE?: string;
}

/** Authenticated principal resolved by the session middleware. */
export interface AuthUser {
  id: number;
  nip: string;
  nama: string;
  role: Role;
  statusKepegawaian: StatusKepegawaian | null;
  jabatan: string | null;
  fotoR2Key: string | null;
  isDefaultPassword: boolean;
}

export interface AuthContext {
  user: AuthUser;
  /** SHA-256 hex of the current session token (`sesi.token_hash`). */
  tokenHash: string;
}

export interface Variables {
  /** Set by `requireSession`; absent on public routes. */
  auth?: AuthContext;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}

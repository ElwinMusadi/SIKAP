// WhatsApp sender (Phase 5). Two providers, same message semantics as the legacy
// GAS implementation (legacy-gas/src/backend/WhatsApp.gs notify* functions):
//  - Fonnte: plain text message (form-urlencoded POST).
//  - Meta Cloud API: approved templates with positional body parameters
//    (same template names as legacy); `test` sends a free-form text message.
//
// SECRECY: tokens are only ever placed in the Authorization request header; nothing
// here logs, and requests are never echoed. Provider responses are NEVER returned or
// persisted verbatim (a provider may echo the token, the phone number or other data
// back in its error text). A result `detail` is built ONLY from:
//   - the HTTP status code, and
//   - a fixed, allowlisted Indonesian phrase chosen by matching the provider's reason
//     (the matched text itself is discarded).
// Response bodies are read with a hard byte cap (successful Fonnte JSON) or cancelled
// unread (everything else), so a hostile/huge body cannot stall the worker.
import type { WaProvider, WaTemplate } from '../../shared/verifikasi';

export type WaConfig =
  | { provider: 'fonnte'; token: string; appUrl: string }
  | { provider: 'meta'; token: string; phoneId: string; appUrl: string };

export interface WaParams {
  dokumen_baru_admin: { namaPegawai: string; namaDokumen: string };
  dokumen_terverifikasi: { nama: string; namaDokumen: string };
  dokumen_ditolak: { nama: string; namaDokumen: string; alasan: string };
  test: { nama: string };
}

export interface SendResult {
  ok: boolean;
  status?: number;
  /** Generic, allowlisted text (never provider-supplied). Only set when !ok. */
  detail?: string;
}

/** Per-request provider timeout. flushOutbox() budgets its waves on this value. */
export const SEND_TIMEOUT_MS = 8000;
/** Max bytes read from a provider response body. */
export const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_DETAIL = 200;

/**
 * Defence in depth for strings that are ALREADY generic: masks digit runs of ≥ 6
 * (phone numbers, ids), collapses whitespace and truncates to 200 chars. It is NOT a
 * secret redactor: never feed raw provider text into it.
 */
export function sanitizeDetail(text: string): string {
  const masked = text.replace(/\d{6,}/g, '***').replace(/\s+/g, ' ').trim();
  return masked.length > MAX_DETAIL ? `${masked.slice(0, MAX_DETAIL - 1)}…` : masked;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Indonesian message text per template (mirrors legacy WhatsApp.gs). */
export function messageText(template: WaTemplate, params: Record<string, unknown>, appUrl: string): string {
  switch (template) {
    case 'dokumen_baru_admin':
      return (
        'Halo Administrator TU,\n\n' +
        `Pegawai *${str(params.namaPegawai)}* baru saja mengunggah/memperbarui dokumen *${str(params.namaDokumen)}*.\n\n` +
        'Mohon segera login ke SIKAP untuk melakukan verifikasi dokumen tersebut.\n\n' +
        appUrl
      );
    case 'dokumen_terverifikasi':
      return (
        `Halo *${str(params.nama)}*,\n\n` +
        `Dokumen *${str(params.namaDokumen)}* Anda telah \u2705 *diverifikasi* oleh Administrator TU.\n\n` +
        'Silakan login ke SIKAP untuk melihat status dokumen Anda.\n\n' +
        appUrl
      );
    case 'dokumen_ditolak':
      return (
        `Halo *${str(params.nama)}*,\n\n` +
        `Dokumen *${str(params.namaDokumen)}* Anda \u274c *ditolak* oleh Administrator TU.\n` +
        `Alasan: _${str(params.alasan)}_\n\n` +
        'Silakan login ke SIKAP dan unggah ulang dokumen Anda.\n\n' +
        appUrl
      );
    case 'test':
      return (
        `Halo *${str(params.nama)}*,\n\n` +
        'Ini adalah pesan uji coba notifikasi WhatsApp SIKAP. Konfigurasi WhatsApp berhasil.\n\n' +
        appUrl
      );
  }
}

/** Positional Meta template body parameters (same order as the legacy templates). */
export function metaParameters(template: WaTemplate, params: Record<string, unknown>): string[] {
  switch (template) {
    case 'dokumen_baru_admin':
      return [str(params.namaPegawai), str(params.namaDokumen)];
    case 'dokumen_terverifikasi':
      return [str(params.nama), str(params.namaDokumen)];
    case 'dokumen_ditolak':
      return [str(params.nama), str(params.namaDokumen), str(params.alasan)];
    case 'test':
      return [];
  }
}

// ---------------------------------------------------------------------------
// Response handling (bounded, never echoed)
// ---------------------------------------------------------------------------

function discard(res: Response): void {
  if (res.body && !res.bodyUsed) res.body.cancel().catch(() => undefined);
}

/** Body as text, or null when it exceeds `max` bytes / cannot be read. Always releases the body. */
async function readBounded(res: Response, max: number = MAX_RESPONSE_BYTES): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function failure(status: number | undefined, phrase: string): SendResult {
  const text = status !== undefined ? `HTTP ${status}: ${phrase}` : phrase;
  return { ok: false, status, detail: sanitizeDetail(text) };
}

const PHRASE = {
  timeout: 'Timeout menghubungi penyedia WhatsApp.',
  network: 'Gagal menghubungi penyedia WhatsApp.',
  unreadable: 'Respons penyedia WhatsApp tidak dikenali.',
} as const;

/** Generic phrase for an HTTP status (no provider text). */
function statusPhrase(provider: 'Fonnte' | 'Meta', status: number): string {
  if (status === 400) return `${provider} menolak permintaan (data/template tidak valid).`;
  if (status === 401) return `Token ${provider} tidak valid atau kedaluwarsa.`;
  if (status === 403) return `Akses ${provider} ditolak.`;
  if (status === 404) return provider === 'Meta' ? 'Phone Number ID tidak ditemukan.' : 'Endpoint Fonnte tidak ditemukan.';
  if (status === 429) return `Batas pengiriman ${provider} tercapai.`;
  if (status >= 500) return `Layanan ${provider} sedang bermasalah.`;
  return `${provider} menolak pesan.`;
}

/**
 * Fonnte answers HTTP 200 with `{ status: false, reason }` for most errors. The reason is
 * classified into a FIXED phrase; the reason text itself is never kept.
 */
function fonnteReasonPhrase(reason: string): string {
  const r = reason.toLowerCase();
  if (/token|unauthori[sz]ed|api key/.test(r)) return 'Fonnte: token tidak valid.';
  if (/disconnect|not connected|device|perangkat/.test(r)) return 'Fonnte: perangkat tidak terhubung.';
  if (/target|number|nomor|phone/.test(r)) return 'Fonnte: nomor tujuan tidak valid.';
  if (/quota|limit|credit|balance|saldo|kuota|expired|package|paket/.test(r)) return 'Fonnte: kuota/paket tidak mencukupi.';
  return 'Fonnte menolak pesan.';
}

async function sendFonnte(token: string, to: string, text: string): Promise<SendResult> {
  const body = new URLSearchParams({ target: to, message: text, countryCode: '62' });
  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    discard(res);
    return failure(res.status, statusPhrase('Fonnte', res.status));
  }
  const raw = await readBounded(res);
  if (raw === null) return failure(res.status, PHRASE.unreadable);
  let parsed: { status?: unknown; reason?: unknown } | null;
  try {
    const v: unknown = JSON.parse(raw);
    parsed = v && typeof v === 'object' ? (v as { status?: unknown; reason?: unknown }) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return failure(res.status, PHRASE.unreadable);
  if (parsed.status === true) return { ok: true, status: res.status };
  return failure(res.status, fonnteReasonPhrase(str(parsed.reason)));
}

async function sendMeta(
  token: string,
  phoneId: string,
  to: string,
  template: WaTemplate,
  params: Record<string, unknown>,
  appUrl: string,
): Promise<SendResult> {
  const payload =
    template === 'test'
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: messageText(template, params, appUrl) } }
      : {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: template,
            language: { code: 'id' },
            components: [
              { type: 'body', parameters: metaParameters(template, params).map((text) => ({ type: 'text', text })) },
            ],
          },
        };
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  // Meta: any 2xx means the message was accepted; the body (message id) is not needed.
  discard(res);
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  return failure(res.status, statusPhrase('Meta', res.status));
}

/** Send one message. Never throws: network errors / timeouts become `{ ok: false }`. */
export async function sendWhatsApp(
  cfg: WaConfig,
  to: string,
  template: WaTemplate,
  params: Record<string, unknown>,
): Promise<SendResult> {
  try {
    if (cfg.provider === 'fonnte') return await sendFonnte(cfg.token, to, messageText(template, params, cfg.appUrl));
    return await sendMeta(cfg.token, cfg.phoneId, to, template, params, cfg.appUrl);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    // Error messages are discarded on purpose (they may contain URLs/addresses).
    return failure(undefined, name === 'TimeoutError' || name === 'AbortError' ? PHRASE.timeout : PHRASE.network);
  }
}

export type { WaProvider };

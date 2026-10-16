import type { UpdateWhatsAppRequest, WaProvider } from '@shared/verifikasi';

export type SecretField = 'fonnteToken' | 'metaToken';
export type DraftField = SecretField | 'metaPhoneNumberId';
/**
 * Pending WhatsApp edits. Key semantics follow the PUT contract:
 * - absent key: keep the stored value;
 * - `''` on a secret: delete the stored token (only set via {@link clearSecret});
 * - non-empty string: replace.
 */
export type WhatsAppDraft = Partial<Pick<UpdateWhatsAppRequest, DraftField>>;

function omit(draft: WhatsAppDraft, field: DraftField): WhatsAppDraft {
  if (!(field in draft)) return draft;
  return Object.fromEntries(Object.entries(draft).filter(([key]) => key !== field)) as WhatsAppDraft;
}

/**
 * Typing into a secret input. An empty (or whitespace-only, which the schema trims to `''`)
 * value means "keep the stored token", so the key is dropped instead of sending a delete.
 * Typing a replacement after {@link clearSecret} cancels the pending delete.
 */
export function typeSecret(draft: WhatsAppDraft, field: SecretField, value: string): WhatsAppDraft {
  return value.trim() === '' ? omit(draft, field) : { ...draft, [field]: value };
}

/** Explicit "Hapus token" action: the only way a secret becomes `''` in the payload. */
export function clearSecret(draft: WhatsAppDraft, field: SecretField): WhatsAppDraft {
  return { ...draft, [field]: '' };
}

/** Undo a pending explicit delete, keeping the stored token. */
export function cancelClearSecret(draft: WhatsAppDraft, field: SecretField): WhatsAppDraft {
  return isClearingSecret(draft, field) ? omit(draft, field) : draft;
}

export function isClearingSecret(draft: WhatsAppDraft, field: SecretField): boolean {
  return draft[field] === '';
}

/** Non-secret fields are shown with their stored value, so `''` is a visible, deliberate clear. */
export function setPlainField(draft: WhatsAppDraft, field: 'metaPhoneNumberId', value: string): WhatsAppDraft {
  return { ...draft, [field]: value };
}

/** PUT body: provider is mandatory in the strict schema; untouched fields stay omitted. */
export function buildWhatsAppPayload(provider: WaProvider, draft: WhatsAppDraft): UpdateWhatsAppRequest {
  const payload: UpdateWhatsAppRequest = { provider };
  for (const [key, value] of Object.entries(draft) as [DraftField, string | undefined][]) {
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

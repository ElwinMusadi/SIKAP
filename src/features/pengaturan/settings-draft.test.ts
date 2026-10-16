import { describe, expect, it } from 'vitest';
import { updateWhatsAppSchema } from '@shared/verifikasi';
import {
  buildWhatsAppPayload,
  cancelClearSecret,
  clearSecret,
  isClearingSecret,
  setPlainField,
  typeSecret,
  type WhatsAppDraft,
} from './settings-draft';

const typeChars = (draft: WhatsAppDraft, field: 'fonnteToken' | 'metaToken', text: string) =>
  [...text].reduce((d, _, i) => typeSecret(d, field, text.slice(0, i + 1)), draft);
const eraseAll = (draft: WhatsAppDraft, field: 'fonnteToken' | 'metaToken') => {
  const text = draft[field] ?? '';
  return [...text].reduce((d, _, i) => typeSecret(d, field, text.slice(0, text.length - i - 1)), draft);
};

describe('WhatsApp settings draft', () => {
  it('omits untouched fields and always includes provider', () => {
    expect(buildWhatsAppPayload('fonnte', {})).toEqual({ provider: 'fonnte' });
    expect(buildWhatsAppPayload('meta', {})).toEqual({ provider: 'meta' });
    expect(updateWhatsAppSchema.parse(buildWhatsAppPayload('meta', {}))).toEqual({ provider: 'meta' });
  });

  it('typing then erasing a replacement preserves the stored token', () => {
    for (const field of ['fonnteToken', 'metaToken'] as const) {
      const typed = typeChars({}, field, 'abc');
      expect(typed[field]).toBe('abc');
      const erased = eraseAll(typed, field);
      expect(erased).toEqual({});
      expect(field in buildWhatsAppPayload('fonnte', erased)).toBe(false);
    }
  });

  it('treats whitespace-only input as preserve, not delete', () => {
    expect(typeSecret({}, 'fonnteToken', '   ')).toEqual({});
  });

  it('explicit clear sends an empty string', () => {
    const draft = clearSecret({}, 'fonnteToken');
    expect(isClearingSecret(draft, 'fonnteToken')).toBe(true);
    expect(buildWhatsAppPayload('fonnte', draft)).toEqual({ provider: 'fonnte', fonnteToken: '' });
    expect(updateWhatsAppSchema.parse(buildWhatsAppPayload('fonnte', draft)).fonnteToken).toBe('');
  });

  it('explicit clear then a replacement sends the new token', () => {
    const draft = typeChars(clearSecret({}, 'metaToken'), 'metaToken', 'new-token');
    expect(isClearingSecret(draft, 'metaToken')).toBe(false);
    expect(buildWhatsAppPayload('meta', draft)).toEqual({ provider: 'meta', metaToken: 'new-token' });
  });

  it('cancelling an explicit clear restores preserve semantics', () => {
    const draft = cancelClearSecret(clearSecret({}, 'fonnteToken'), 'fonnteToken');
    expect(draft).toEqual({});
    const typed = typeSecret({}, 'fonnteToken', 'x');
    expect(cancelClearSecret(typed, 'fonnteToken')).toBe(typed);
  });

  it('keeps provider alongside other fields and does not touch unrelated secrets', () => {
    let draft = clearSecret({}, 'fonnteToken');
    draft = typeSecret(draft, 'metaToken', 'tok');
    draft = setPlainField(draft, 'metaPhoneNumberId', '12345');
    expect(buildWhatsAppPayload('meta', draft)).toEqual({
      provider: 'meta',
      fonnteToken: '',
      metaToken: 'tok',
      metaPhoneNumberId: '12345',
    });
  });
});

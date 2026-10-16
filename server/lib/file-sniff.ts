// Magic-byte file type detection. Never trust the client's Content-Type or file name.

export interface SniffedType {
  mime: string;
  ext: string;
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // 'RIFF'
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // 'WEBP'

/** Detect JPEG / PNG / WEBP from the first bytes (16 are enough). Returns null otherwise. */
export function sniffImage(head: Uint8Array): SniffedType | null {
  if (startsWith(head, JPEG)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(head, PNG)) return { mime: 'image/png', ext: 'png' };
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return { mime: 'image/webp', ext: 'webp' };
  return null;
}

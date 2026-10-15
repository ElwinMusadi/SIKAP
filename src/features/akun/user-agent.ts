export interface DeviceDescription {
  /** Human-readable label, e.g. "Chrome di Windows". */
  label: string;
  isMobile: boolean;
}

const UNKNOWN_DEVICE = 'Perangkat tidak dikenal';

function detectBrowser(ua: string): string | null {
  // Order matters: Edge and Opera UAs also contain "Chrome"; Chrome contains "Safari".
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

function detectOs(ua: string): string | null {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

export function describeUserAgent(ua: string | null | undefined): DeviceDescription {
  if (!ua) return { label: UNKNOWN_DEVICE, isMobile: false };

  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/.test(ua);

  let label = UNKNOWN_DEVICE;
  if (browser && os) label = `${browser} di ${os}`;
  else if (browser) label = browser;
  else if (os) label = os;

  return { label, isMobile };
}

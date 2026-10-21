// First UAT deployment: deny every URL/method. No assets, DB, R2 or identity access.
// This is NOT Cloudflare Access and NOT the application; it keeps the unconfigured
// UAT project nonfunctional until the operator establishes edge Access policies.
export default {
  fetch(request) {
    return new Response(request.method === 'HEAD' ? null : 'SIKAP UAT terkunci. Konfigurasi akses privat belum selesai.\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-SIKAP-UAT-State': 'locked-holding',
        'Retry-After': '3600',
      },
    });
  },
};

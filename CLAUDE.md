# SIKAP — ringkasan untuk Claude Code

Ringkasan per 21 Oktober 2026. Rincian dan riwayat: [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) (keputusan, arsitektur, fase, checkpoint cutover), [`README.md`](README.md) (operasional), [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) (audit sistem lama GAS). Bila bertentangan: instruksi pemilik → `MIGRATION_PLAN.md` → berkas ini. **Repo GitHub ini publik**: jangan menulis rahasia, ID akun, token, atau data pribadi di berkas mana pun.

## Tujuan dan arsitektur

SIKAP (Sistem Informasi Kepegawaian dan Arsip Pegawai) adalah aplikasi internal UPTD Pendapatan Daerah Wilayah Kota Kupang untuk data pegawai (PNS, CPNS, PPPK), arsip dokumen kepegawaian, dan verifikasi dokumen oleh Admin TU. Peran: **Admin** dan **Pegawai**. Bahasa produk Indonesia, zona waktu WITA (`Asia/Makassar`).

Dimigrasikan dari Google Apps Script + Sheets + Drive (kini di `legacy-gas/`) ke Cloudflare. **Produksi hidup sejak 21 Oktober 2026** di `https://sikap.uptdpenda-kupang.web.id`.

| Bagian | Isi |
|---|---|
| `src/` | SPA React (`features/*` per modul, `components/ui` shadcn, `app/app-shell.tsx` + `nav.ts`) |
| `functions/api/[[route]].ts` → `server/` | API Hono di Pages Functions (`routes/`, `services/`, `db/`, `lib/`, `middleware/`) |
| `shared/` | Enum, skema zod, tipe API yang dipakai frontend dan backend |
| `server/routes/integrasi-v1.ts` + `shared/integrasi.ts` | API integrasi baca-saja `/api/v1` dengan kunci API (klien pertama: PINTU); kontrak di [`docs/API-INTEGRASI.md`](docs/API-INTEGRASI.md) |
| `migrations/` | Skema dan seed referensi D1 |
| `workers/cron/` | Worker cron (outbox WA, purge, backup) — **belum di-deploy** |
| `scripts/migrate`, `scripts/import`, `scripts/staging` | Alat migrasi offline, importer produksi, alat UAT |
| `legacy-gas/` | Sistem lama, **dibekukan** (rollback selama masa pemantauan) |

Produksi: Pages project **`sikap-v2`** (branch `main` = production; *Direct Upload* dari GitHub Actions, sengaja tanpa integrasi Git Cloudflare), D1 `sikap-import-prod-20261020`, R2 `sikap-import-prod-20261020-files` (privat; file hanya lewat API terotorisasi). Host `*.sikap-v2.pages.dev` dilindungi Cloudflare Access (OTP pemilik); domain kustom publik.

## Stack dan perintah

- **Frontend:** React 19.3, TypeScript 6.0, Vite 8.3, Tailwind CSS 4.3 (`@tailwindcss/vite`), shadcn 4 (style `radix-nova`, `radix-ui`), lucide-react, TanStack Query 5, react-router 8, React Hook Form 7 + Zod 4, sonner, date-fns 4, Inter Variable (`@fontsource-variable`).
- **Backend:** Hono 4 di Cloudflare Pages Functions, D1 (SQLite), R2, `jose` (JWT Access). Wrangler 4.
- **Tes:** Vitest 4 + `@cloudflare/vitest-pool-workers` (API), Vitest web, `node --test` (migrate/staging/import), ESLint 10.
- **Mesin pemilik:** Windows 11, PowerShell 7 + Git Bash, Node ≥ 20.19.

| Perintah | Kegunaan |
|---|---|
| `npm run dev:api` | Pages Functions + D1/R2 lokal + Vite di `http://localhost:8788` (butuh `.dev.vars`, `db:migrate:local`, `db:seed:dev`) |
| `npm run build` | `tsc -b && vite build` ke `dist/` |
| `npm run typecheck` / `npm run lint` | Kualitas kode (CI menjalankan keduanya) |
| `npm test` | api + web + migrate + staging + import + deploy |
| `npm run test:import` | Suite importer (208 tes, 24 dilewati karena importer historis; `--test-concurrency=1`) |
| `npm run db:migrate:local` / `npm run db:seed:dev` | Skema dan akun contoh lokal (password = 6 digit terakhir NIP, DEV ONLY) |

CI (`.github/workflows/ci.yml`): job `verify` (typecheck, lint, test api/web/migrate/import/staging/deploy, `vite build`, di Ubuntu) pada setiap PR dan push ke `main`; job `deploy` sesudahnya hanya untuk `main`. Tes harus lulus di Linux, bukan hanya Windows.

## Deploy produksi (penting)

- **Hanya ada branch `main`; setiap push/merge ke `main` = deploy produksi** lewat GitHub Actions (job `deploy`, environment GitHub `production`). Sejak 22 Okt 2026 (instruksi pemilik) semua perubahan dikerjakan **langsung di `main`**, tanpa branch atau PR; jalankan typecheck, lint, tes, dan build lokal sebelum push karena tidak ada PR yang menyaring. Panduan lengkap, penyiapan secret, dan rollback: [`docs/DEPLOY.md`](docs/DEPLOY.md).
- `sikap-v2` proyek *Direct Upload*; deploy memakai `wrangler pages deploy` dari Actions. Dashboard menawarkan *Connect to a repository*, tetapi **jangan dipakai**: build Git Cloudflare menjadikan `wrangler.toml` root (punya `pages_build_output_dir`) sumber konfigurasi sehingga produksi pindah ke binding historis, tidak menunggu tes CI, dan bersama Actions men-deploy dobel. Secret GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PROD_D1_DATABASE_ID`. Tanpa ketiganya job deploy dilewati dengan peringatan.
- **Jangan** deploy dari root repo atau memakai `wrangler.toml` root `--env production` / `db:migrate:production`: binding `env.production` di root dan `workers/cron` adalah **historis**, dan deploy berkonfigurasi menulis ulang binding proyek. `scripts/deploy/pages-release.mjs` menyusun paket rilis **di luar checkout** dengan `wrangler.toml` yang mencerminkan pengaturan live (D1 `sikap-import-prod-20261020`, R2 `sikap-import-prod-20261020-files`, `APP_URL` domain kustom; preview tetap di binding preview).
- Migrasi D1 **tidak** dijalankan oleh deploy; migrasi baru butuh keputusan + backup terpisah.
- D1 produksi **tidak punya `d1_migrations`**, karena skemanya dibangun importer (dicek 22 Okt 2026).
  - Jangan pernah `wrangler d1 migrations apply` ke produksi.
  - Terapkan per berkas dengan `wrangler d1 execute DB --remote --file`, dari direktori terisolasi, setelah bookmark Time Travel.
  - Terapkan sebelum push kode yang memakainya. Prosedur: `docs/DEPLOY.md`.
- Secret `PASSWORD_PEPPER` dan `SETTINGS_ENC_KEY` dipasang dengan `wrangler pages secret put` dari berkas privat milik pemilik (di luar repo); nilainya tidak pernah dicetak. Kehilangan pepper = semua password tidak valid.
- `ACCESS_REQUIRED=1` hanya untuk host di belakang Access; di domain kustom harus tidak diset (Access hanya mencakup `*.pages.dev`).

## Konvensi dan keputusan desain

- Teks UI, pesan galat, dokumentasi, dan pesan commit berbahasa Indonesia (gaya commit: `Migrasi Fase N: …` / `Dokumentasi: …` / `Perbaiki …`, diakhiri trailer `Co-Authored-By`).
- Kontrak API di `shared/` (zod) dipakai dua sisi; API selalu `Cache-Control: no-store` + `nosniff`; CSP ketat di `public/_headers`.
- Password PBKDF2-SHA256 + pepper; hash lama GAS dibungkus `legacy-wrap` saat migrasi (pepper + salt rahasia). Sesi cookie HttpOnly 12 jam sliding; kunci 15 menit setelah 5 gagal.
- API integrasi `/api/v1` ([`docs/API-INTEGRASI.md`](docs/API-INTEGRASI.md)):
  - autentikasi `Authorization: Bearer skp_…` (`server/middleware/api-key.ts`), dengan prefix sendiri sehingga tidak memakai guard sesi;
  - hanya hash SHA-256 kunci yang disimpan (`kunci_api`, tidak ikut backup);
  - masa berlaku wajib; hapus = langsung tidak berlaku;
  - proyeksi field berupa whitelist (email/no HP hanya di detail, dan setiap pembacaan detail dicatat sebagai `API_PEGAWAI_READ`);
  - v1 hanya boleh berubah aditif; perubahan yang mematahkan klien → `/api/v2`.
- Dokumen: admin memverifikasi versi yang ditampilkan; dokumen milik admin sendiri diverifikasi admin lain. Notifikasi WA lewat outbox (at-least-once), bukan sumber kebenaran.
- Referensi (pangkat, unit, jenis dokumen) dinonaktifkan, tidak dihapus. Purge memakai antrean exact-key, bukan prefix.
- Design system v2 (`docs/RENCANA-REDESIGN-UIUX.md` §5) ada di `src/index.css`: kertas `#F7F6F2`, tinta, satu aksen navy `#1E3A8A`, `status-*`, utilitas `text-display/h2/h3/eyebrow/metric`, `shadow-card/pop/dialog`, terang bawaan + gelap hanya lewat switch manual, tema OS diabaikan (`src/app/theme.tsx` + `public/theme-init.js`). **Impor `cn` dari `@/lib/utils`, bukan dari paket `cn`**; perbaiki impor setelah `shadcn add`. Uji kontras di `/_design` (khusus dev). Status selalu lewat registri `src/lib/status.ts` + `StatusBadge`; callout memakai varian `Alert`; tabel memakai `DataTable`; aturan lengkap (tabs `forceMount`, lebar sheet ponsel, target sentuh, chunk vendor) di [`docs/POLA-UI.md`](docs/POLA-UI.md).
- Importer produksi **fail-closed**: target hanya `sikap-import-*`, pin modul + fakta plan wajib, kredensial dari `credentials.env` privat dengan kedaluwarsa UTC ketat ≤ 12 jam. **Jangan pernah menjalankan ulang import produksi**; pemulihan = target baru + pin baru + review.
- Sejak 22 Okt 2026 importer adalah **alat historis** (keputusan pemilik): dipin ke skema impor 0001–0008 dan menolak skema yang lebih baru (`MIGRATION_SET_MISMATCH`). Kode importer yang dipin (`prod-import-pins.mjs`) **tidak diubah** untuk mengikuti migrasi baru. Tes yang butuh skema 0001–0008 dilewati lewat `IMPORT_SCHEMA_SKIP` (`scripts/import/historical-schema.mjs`). `historical-schema.test.mjs` menjaga tiga hal: byte migrasi 0001–0008 tidak boleh berubah, migrasi baru hanya ditambahkan berurutan, dan importer pasti menolak skema baru.

## Batasan kerja dengan pemilik

- Komunikasi dalam Bahasa Indonesia. Kerjakan langsung di `main`; commit/push hanya bila diminta, karena setiap push ke `main` = deploy produksi.
- Jangan menempel atau membaca nilai rahasia (pepper, salt, token, `credentials.env`, Script Properties produksi). Jangan meng-commit snapshot, plan, ekspor, atau berkas apa pun dengan PII (`.gitignore` sudah menolak pola `*.sikap-*`, `/snapshot-*/`).
- Aksi di produksi (D1/R2 remote, deploy, DNS, Access, Drive, GAS) butuh persetujuan per aksi. Data asli yang dipakai pemilik tidak boleh disimpan/diubah saat menguji.
- Pengaman auto-mode bisa menolak aksi (mis. editor Script Properties produksi, penghapusan massal di Drive): hormati, jangan dicari jalan pintasnya; minta pemilik melakukannya.

## Masalah yang sudah diselesaikan

| Masalah | Solusi |
|---|---|
| GAS lambat, Sheets sebagai DB, celah keamanan S-01..S-05 | Migrasi ke Cloudflare; hotfix keamanan GAS sebelum cutover |
| Penulisan ke GAS selama ekspor | Penjaga `assertCutoverOpen_` di 43 entry; freeze lewat Script Property `SIKAP_CUTOVER_STATE=frozen` |
| Jendela import melebihi umur token OAuth wrangler | Token D1/R2 khusus berumur pendek, timeout request 15 s, budget request dan jendela dihitung sebelum run |
| Wrangler memakai `wrangler.toml` root saat deploy | Direktori rilis terisolasi di luar repo, kini otomatis di GitHub Actions (`scripts/deploy/pages-release.mjs`); deploy pertama 22 Okt 2026 menayangkan redesign v2 |
| Copier menolak folder induk berisi | Folder induk baru yang kosong per salinan |
| Disk C: penuh saat ekstraksi | Hapus salinan dry-run lama atas izin pemilik |
| Token tanpa kedaluwarsa (`forever`) | Driver menolak (`CREDENTIAL_INVALID`) sebelum request; pemilik membuat ulang dengan TTL |
| Administrator PINTU mengetik ulang NIP/nama pegawai | API integrasi `/api/v1` + kunci API dikelola di SIKAP; PINTU memilih pegawai dari SIKAP (PINTU `adfd5c1`, D-075 opsi A: hanya NIP + Nama). Migrasi `0009` diterapkan per berkas, kode SIKAP `7a7ba84`, uji ujung-ke-ujung berhasil 22 Okt 2026 |
| CI: lint (literal BOM, variabel tak terpakai) dan tes path gaya Windows di Linux | `﻿`; cek prefix terlarang sebelum `path.isAbsolute` |

## TODO / pekerjaan terbuka

- **Rotasi kunci API "PINTU (produksi)"** sebelum kedaluwarsa (bawaan 365 hari sejak 22 Okt 2026; tanggalnya di Pengaturan Sistem → Integrasi API). Langkahnya: buat kunci baru → ganti `SIKAP_API_KEY` di Laravel Cloud → hapus kunci lama (`docs/API-INTEGRASI.md` §1). Rotasi belum pernah diuji.
- **Backup otomatis belum ada**: binding `BACKUPS` + bucket privat + Worker cron (`workers/cron`) + kebijakan retensi ≥ 30 hari; D1 Time Travel sebagai pemulihan konsisten.
- WAF Rate Limiting untuk `/api/auth/login`.
- WhatsApp tetap nonaktif sampai diminta pemilik.
- Ganti `CLOUDFLARE_API_TOKEN` di environment GitHub `production` sebelum kedaluwarsa (`docs/DEPLOY.md`).
- Pemantauan 30 hari; setelahnya keputusan dekomisi GAS (proyek, deployment, Sheets, folder Drive `SIKAP_Backups`/`SIKAP_Dokumen_Kepegawaian`).
- Bersih-bersih oleh pemilik: folder Drive "SIKAP — Salinan Migrasi Privat", proyek GAS "Project tak berjudul" dan "Copy of SIKAP — Copy Sumber Nyata", sampah Drive; deployment preview lama di `sikap-v2`.
- Tandai binding historis di `wrangler.toml` setelah konfigurasi produksi dipindah ke repo dengan aman.

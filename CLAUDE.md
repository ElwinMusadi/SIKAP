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
| `migrations/` | Skema dan seed referensi D1 |
| `workers/cron/` | Worker cron (outbox WA, purge, backup) — **belum di-deploy** |
| `scripts/migrate`, `scripts/import`, `scripts/staging` | Alat migrasi offline, importer produksi, alat UAT |
| `legacy-gas/` | Sistem lama, **dibekukan** (rollback selama masa pemantauan) |

Produksi: Pages project **`sikap-v2`** (branch `main` = production, upload langsung, bukan Git-integrated), D1 `sikap-import-prod-20261020`, R2 `sikap-import-prod-20261020-files` (privat; file hanya lewat API terotorisasi). Host `*.sikap-v2.pages.dev` dilindungi Cloudflare Access (OTP pemilik); domain kustom publik.

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
| `npm test` | api + web + migrate + staging + import |
| `npm run test:import` | Suite importer (205 tes, `--test-concurrency=1`) |
| `npm run db:migrate:local` / `npm run db:seed:dev` | Skema dan akun contoh lokal (password = 6 digit terakhir NIP, DEV ONLY) |

CI (`.github/workflows/ci.yml`, job `verify`): typecheck, lint, test api/web/migrate/import/staging, lalu `vite build`, di Ubuntu. Tes harus lulus di Linux, bukan hanya Windows.

## Deploy produksi (penting)

- **Jangan** memakai `wrangler.toml` root `--env production` atau `npm run deploy:preview` untuk produksi: binding `env.production` di root dan `workers/cron` adalah **historis**.
- Deploy produksi memakai **direktori rilis terisolasi di luar repo** (Wrangler 4 menelusuri `wrangler.toml` induk dan memuat `.env` dari cwd): salin `dist/` → `public/`, `functions/`, `server/`, `shared/`, `package.json`, `tsconfig*.json`, junction `node_modules`, dan `wrangler.toml` minimal (D1 + R2 produksi, `APP_URL`), lalu `wrangler pages deploy public --project-name sikap-v2 --branch main`. Lepas junction dengan `(Get-Item …).Delete()` sebelum menghapus direktori.
- Secret `PASSWORD_PEPPER` dan `SETTINGS_ENC_KEY` dipasang dengan `wrangler pages secret put` dari berkas privat milik pemilik (di luar repo); nilainya tidak pernah dicetak. Kehilangan pepper = semua password tidak valid.
- `ACCESS_REQUIRED=1` hanya untuk host di belakang Access; di domain kustom harus tidak diset (Access hanya mencakup `*.pages.dev`).

## Konvensi dan keputusan desain

- Teks UI, pesan galat, dokumentasi, dan pesan commit berbahasa Indonesia (gaya commit: `Migrasi Fase N: …` / `Dokumentasi: …` / `Perbaiki …`, diakhiri trailer `Co-Authored-By`).
- Kontrak API di `shared/` (zod) dipakai dua sisi; API selalu `Cache-Control: no-store` + `nosniff`; CSP ketat di `public/_headers`.
- Password PBKDF2-SHA256 + pepper; hash lama GAS dibungkus `legacy-wrap` saat migrasi (pepper + salt rahasia). Sesi cookie HttpOnly 12 jam sliding; kunci 15 menit setelah 5 gagal.
- Dokumen: admin memverifikasi versi yang ditampilkan; dokumen milik admin sendiri diverifikasi admin lain. Notifikasi WA lewat outbox (at-least-once), bukan sumber kebenaran.
- Referensi (pangkat, unit, jenis dokumen) dinonaktifkan, tidak dihapus. Purge memakai antrean exact-key, bukan prefix.
- Design system v2 (`docs/RENCANA-REDESIGN-UIUX.md` §5) ada di `src/index.css`: kertas `#F7F6F2`, tinta, satu aksen navy `#1E3A8A`, `status-*`, utilitas `text-display/h2/h3/eyebrow/metric`, `shadow-card/pop/dialog`, terang + gelap (`src/app/theme.tsx` + `public/theme-init.js`). **Impor `cn` dari `@/lib/utils`, bukan dari paket `cn`**; perbaiki impor setelah `shadcn add`. Uji kontras di `/_design` (khusus dev).
- Importer produksi **fail-closed**: target hanya `sikap-import-*`, pin modul + fakta plan wajib, kredensial dari `credentials.env` privat dengan kedaluwarsa UTC ketat ≤ 12 jam. **Jangan pernah menjalankan ulang import produksi**; pemulihan = target baru + pin baru + review.

## Batasan kerja dengan pemilik

- Komunikasi dalam Bahasa Indonesia. Commit/push hanya bila diminta; merge ke `main` hanya atas persetujuan eksplisit.
- Jangan menempel atau membaca nilai rahasia (pepper, salt, token, `credentials.env`, Script Properties produksi). Jangan meng-commit snapshot, plan, ekspor, atau berkas apa pun dengan PII (`.gitignore` sudah menolak pola `*.sikap-*`, `/snapshot-*/`).
- Aksi di produksi (D1/R2 remote, deploy, DNS, Access, Drive, GAS) butuh persetujuan per aksi. Data asli yang dipakai pemilik tidak boleh disimpan/diubah saat menguji.
- Pengaman auto-mode bisa menolak aksi (mis. editor Script Properties produksi, penghapusan massal di Drive): hormati, jangan dicari jalan pintasnya; minta pemilik melakukannya.

## Masalah yang sudah diselesaikan

| Masalah | Solusi |
|---|---|
| GAS lambat, Sheets sebagai DB, celah keamanan S-01..S-05 | Migrasi ke Cloudflare; hotfix keamanan GAS sebelum cutover |
| Penulisan ke GAS selama ekspor | Penjaga `assertCutoverOpen_` di 43 entry; freeze lewat Script Property `SIKAP_CUTOVER_STATE=frozen` |
| Jendela import melebihi umur token OAuth wrangler | Token D1/R2 khusus berumur pendek, timeout request 15 s, budget request dan jendela dihitung sebelum run |
| Wrangler memakai `wrangler.toml` root saat deploy | Direktori rilis terisolasi di luar repo |
| Copier menolak folder induk berisi | Folder induk baru yang kosong per salinan |
| Disk C: penuh saat ekstraksi | Hapus salinan dry-run lama atas izin pemilik |
| Token tanpa kedaluwarsa (`forever`) | Driver menolak (`CREDENTIAL_INVALID`) sebelum request; pemilik membuat ulang dengan TTL |
| CI: lint (literal BOM, variabel tak terpakai) dan tes path gaya Windows di Linux | `﻿`; cek prefix terlarang sebelum `path.isAbsolute` |

## TODO / pekerjaan terbuka

- **Redesign UI/UX** frontend — rencana di [`docs/RENCANA-REDESIGN-UIUX.md`](docs/RENCANA-REDESIGN-UIUX.md) (design system, pustaka pola, fase 0–6). §11 disetujui; fase 0–5 selesai di branch `feat/redesign-uiux` (belum dirilis), fase 6 (polish: QA per layar, aksesibilitas, komponen mati) belum.
- **Backup otomatis belum ada**: binding `BACKUPS` + bucket privat + Worker cron (`workers/cron`) + kebijakan retensi ≥ 30 hari; D1 Time Travel sebagai pemulihan konsisten.
- WAF Rate Limiting untuk `/api/auth/login`.
- WhatsApp tetap nonaktif sampai diminta pemilik.
- PR #2 (`feat/cloudflare-migration` → `main`) menunggu keputusan merge pemilik.
- Pemantauan 30 hari; setelahnya keputusan dekomisi GAS (proyek, deployment, Sheets, folder Drive `SIKAP_Backups`/`SIKAP_Dokumen_Kepegawaian`).
- Bersih-bersih oleh pemilik: folder Drive "SIKAP — Salinan Migrasi Privat", proyek GAS "Project tak berjudul" dan "Copy of SIKAP — Copy Sumber Nyata", sampah Drive; deployment preview lama di `sikap-v2`.
- Perbarui status di `README.md` (masih menyebut sebelum cutover) dan tandai binding historis di `wrangler.toml` setelah konfigurasi produksi dipindah ke repo dengan aman.

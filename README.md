# SIKAP — Sistem Informasi Kepegawaian dan Arsip Pegawai

Aplikasi internal UPTD Pendapatan Daerah Wilayah Kota Kupang untuk mengelola data pegawai (PNS, CPNS, PPPK), arsip dokumen kepegawaian, dan verifikasi dokumen oleh Admin TU.

> **Status:** migrasi dari Google Apps Script ke Cloudflare sedang berjalan di branch `feat/cloudflare-migration`.
> Kode lama (GAS + Google Sheets + Drive) dipindahkan ke [`legacy-gas/`](legacy-gas/) dan tetap menjadi sistem produksi sampai cutover.

| Dokumen | Isi |
|---|---|
| [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) | Analisa, review, dan audit sistem lama |
| [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) | Keputusan pemilik produk, arsitektur target, skema D1, API, redesign UI, fase, dan rencana cutover |

## Stack

- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4, shadcn/ui (Radix), TanStack Query, React Router
- **Backend:** Cloudflare Pages Functions (`functions/api/[[route]].ts`) dengan Hono (`server/`)
- **Database:** Cloudflare D1 (SQLite) — `migrations/`
- **File:** Cloudflare R2 (privat; disajikan hanya lewat API terotorisasi)
- **Kontrak bersama:** `shared/` (enum, schema zod, tipe API) dipakai frontend dan backend

## Struktur

```text
src/            React app (features/, components/, lib/)
server/         Hono API (routes/, services/, db/, lib/, middleware/)
functions/      Entry Pages Functions → server/
shared/         Enum, validator, kontrak API
migrations/     Skema & seed referensi D1
test/           Test API (Vitest + Workers runtime)
legacy-gas/     Sistem lama (referensi, tidak dideploy dari branch ini)
```

## Menjalankan secara lokal

Prasyarat: Node.js ≥ 20.19.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # isi PASSWORD_PEPPER & SETTINGS_ENC_KEY (acak, ≥ 32 byte)
npm run db:migrate:local                # buat skema D1 lokal
npm run db:seed:dev                     # akun contoh (DEV ONLY)
npm run dev:api                         # Pages Functions + Vite di http://localhost:8788
```

Akun contoh hanya untuk pengembangan lokal; password = 6 digit terakhir NIP (lihat `scripts/dev-seed.mjs`).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Vite saja (proxy `/api` ke :8788) |
| `npm run dev:api` | Pages Functions + D1/R2 lokal + Vite |
| `npm run build` | Typecheck + build produksi ke `dist/` |
| `npm run typecheck` / `npm run lint` / `npm test` | Kualitas kode |
| `npm run db:migrate:local` | Terapkan migrasi D1 lokal |
| `npm run db:migrate:preview` | Terapkan migrasi ke D1 preview (remote) |
| `npm run deploy:preview` | Build + deploy ke preview `sikap-v2` |

## Deployment (Cloudflare Pages)

Project Pages: **`sikap-v2`** (bukan `sikap` — project `sikap` masih melayani sistem GAS produksi sampai cutover).

| Environment | URL | D1 | R2 |
|---|---|---|---|
| Preview (branch `feat/cloudflare-migration`) | https://feat-cloudflare-migration.sikap-v2.pages.dev | `sikap-db-preview` | `sikap-files-preview` |
| Production (branch `main`, setelah cutover) | https://sikap.uptdpenda-kupang.web.id | `sikap-db` | `sikap-files` |

Backup: bucket R2 `sikap-backup`. Semua bucket privat (akses publik `r2.dev` nonaktif).

Langkah deploy preview:

1. `npm run db:migrate:preview` bila ada migrasi baru.
2. `npm run deploy:preview`.

Secrets per environment (`PASSWORD_PEPPER`, `SETTINGS_ENC_KEY`) diatur dengan
`wrangler pages secret bulk <file.json> --project-name sikap-v2 --env preview|production`.
Simpan nilai `PASSWORD_PEPPER` produksi di tempat aman — kehilangan nilai ini membuat semua password tidak valid.
`SETTINGS_ENC_KEY` harus berupa base64 dari **32 byte acak** untuk AES-GCM-256.
Kunci ini mengenkripsi token WhatsApp. Simpan cadangannya dengan aman; menggantinya tanpa
migrasi ulang membuat token tersimpan tidak dapat dibaca. Worker cron pengirim notifikasi
harus menggunakan nilai `SETTINGS_ENC_KEY` yang sama dengan Pages pada environment tersebut.
Jangan menyalin kunci produksi ke preview atau menaruhnya di repo.

## Verifikasi dokumen dan WhatsApp

- Admin memverifikasi versi dokumen yang ditampilkan; keputusan ditolak jika versi atau status berubah.
- Dokumen milik admin sendiri harus diverifikasi admin lain.
- Penyedia WhatsApp diatur melalui **Pengaturan Sistem → WhatsApp**. Token tidak dikembalikan
  ke browser; isian kosong yang tidak diubah mempertahankan token, sedangkan aksi hapus
  menghapus token tersimpan. Penyedia tanpa konfigurasi lengkap tidak mengirim pesan.
- Template Meta berbahasa Indonesia harus sudah disetujui: `dokumen_baru_admin`,
  `dokumen_terverifikasi`, `dokumen_ditolak`. Pesan uji dikirim ke nomor HP admin yang meminta.
- Notifikasi memakai outbox persisten dan diproses setelah respons, bukan menunggu penyedia
  saat menyetujui/menolak dokumen. Pengiriman bersifat **at-least-once**: jika penyedia sudah
  menerima pesan tetapi proses berhenti sebelum status terkirim disimpan, retry dapat
  menghasilkan duplikasi. Jangan gunakan notifikasi sebagai sumber kebenaran status dokumen.

### Worker cron pendamping

`workers/cron/wrangler.toml` memisahkan database preview dan produksi. Semua trigger masih
**nonaktif** dan Worker belum di-deploy. Tidak ada endpoint HTTP publik.

- `npm run cron:check`: validasi bundle preview dengan `--dry-run` (tanpa deploy).
- `npm run cron:dev`: simulasi lokal `--test-scheduled`. Gunakan database lokal terisolasi;
  terapkan migrasi pada konfigurasi tersebut sebelum menguji.
- Saat siap diaktifkan: `*/10 * * * *` untuk retry outbox, `0 18 * * *` untuk pembersihan
  sesi/counter kedaluwarsa (02:00 WITA), maksimal 500 baris per tabel per invocation.
- Sebelum deploy, pasang `SETTINGS_ENC_KEY` yang sama dengan Pages pada environment yang
  sama, cek kuota 5 Cron Triggers/account pada Free plan, lalu aktifkan trigger secara sadar.
- Pembersihan versi dokumen, retensi pegawai, dan backup **belum** termasuk Worker ini;
  implementasinya mengikuti Fase 6–7.

Sebelum produksi: tambahkan aturan WAF Rate Limiting untuk `/api/auth/login`.

### Batas validasi Fase 5

Uji browser lokal memakai Chromium dengan respons API terkontrol; test API memakai
runtime Workers lokal dengan D1/R2 terisolasi dan penyedia WhatsApp yang dimock.
Uji ini tidak membuktikan template Meta telah disetujui, koneksi perangkat Fonnte aktif,
atau pesan benar-benar diterima. Uji pengiriman nyata tetap dilakukan melalui
**Kirim Pesan Uji** setelah token dan nomor admin dipasang di environment yang dituju.
Jangan menempelkan token ke chat atau memasukkan token nyata ke fixture test.

## Kebijakan akun

- Password default = 6 digit terakhir NIP. Pengguna **tidak dipaksa** mengganti, tetapi aplikasi menampilkan banner rekomendasi.
- Password disimpan sebagai PBKDF2-SHA256 (10.000 iterasi) + pepper rahasia; akun terkunci 15 menit setelah 5 kali gagal login.
- Sesi memakai cookie HttpOnly, berlaku 12 jam (sliding).

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

## Deployment (Cloudflare Pages)

1. Buat resource: `wrangler d1 create sikap-db`, `wrangler r2 bucket create sikap-files` (ulangi dengan sufiks `-preview`), lalu isi `database_id` di `wrangler.toml`.
2. Secrets per environment: `wrangler pages secret put PASSWORD_PEPPER` dan `SETTINGS_ENC_KEY`.
3. Hubungkan repo ke Cloudflare Pages: build command `npm run build`, output `dist`.
4. Terapkan migrasi ke remote: `wrangler d1 migrations apply sikap-db --remote`.
5. Tambahkan aturan WAF Rate Limiting untuk `/api/auth/login`.

## Kebijakan akun

- Password default = 6 digit terakhir NIP. Pengguna **tidak dipaksa** mengganti, tetapi aplikasi menampilkan banner rekomendasi.
- Password disimpan sebagai PBKDF2-SHA256 (10.000 iterasi) + pepper rahasia; akun terkunci 15 menit setelah 5 kali gagal login.
- Sesi memakai cookie HttpOnly, berlaku 12 jam (sliding).

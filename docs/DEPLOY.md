# Deploy produksi (GitHub Actions → Cloudflare Pages)

Mulai 21 Oktober 2026, setiap commit baru di branch **`main`** otomatis di-deploy ke produksi
`https://sikap.uptdpenda-kupang.web.id` (Pages project **`sikap-v2`**). Tidak ada branch lain dan
tidak ada deploy preview.

## Cara kerjanya

Workflow `.github/workflows/ci.yml`:

1. **`verify`** (setiap PR dan setiap push ke `main`): typecheck, lint, seluruh tes (API, web,
   migrasi, importer, staging, deploy), lalu build. Kalau ada yang gagal, deploy tidak jalan.
2. **`deploy`** (hanya push ke `main` atau *Run workflow* manual di `main`, environment GitHub `production`):
   - build ulang, lalu `scripts/deploy/pages-release.mjs` menyusun paket rilis **di luar checkout**.
     Isinya `public/` = `dist/`, sumber Pages Functions (`functions/`, `server/`, `shared/`), tautan
     `node_modules`, dan `wrangler.toml` yang dibuat ulang setiap kali;
   - `wrangler pages deploy public --project-name sikap-v2 --branch main`;
   - health check ke `/api/health` produksi (harus `"db":"ok"`).

Kenapa paket rilis terpisah: `wrangler.toml` di root masih memuat binding produksi **historis**
(`sikap-db`/`sikap-files`), dan deploy berkonfigurasi ikut menulis ulang pengaturan binding proyek.
`wrangler.toml` yang dibuat skrip identik dengan pengaturan proyek yang aktif (dibaca dengan
`wrangler pages download config sikap-v2` pada 21 Okt 2026):

| Environment | APP_URL | D1 `DB` | R2 `FILES` |
|---|---|---|---|
| production (`main`) | `https://sikap.uptdpenda-kupang.web.id` | `sikap-import-prod-20261020` (ID dari secret) | `sikap-import-prod-20261020-files` |
| preview (tidak dipakai) | `https://feat-cloudflare-migration.sikap-v2.pages.dev` | `sikap-db-preview` | `sikap-files-preview` |

Skrip menolak ID historis, ID preview, variabel `ACCESS_*`, binding `BACKUPS`, dan direktori rilis
di dalam checkout (tes `npm run test:deploy`).

Tidak berubah oleh deploy:
- **secret** Pages (`PASSWORD_PEPPER`, `SETTINGS_ENC_KEY`), yang disimpan di proyek;
- **migrasi D1**, yang tidak dijalankan otomatis (redesign tidak mengubah skema; migrasi baru perlu keputusan dan backup terpisah);
- domain dan Cloudflare Access.

## Perubahan dengan migrasi D1

Karena setiap push ke `main` langsung di-deploy, kode yang memakai tabel atau kolom baru akan galat
di produksi bila migrasinya belum ada. Urutannya:

1. Pastikan migrasinya **aditif** (tabel/kolom baru, tanpa mengubah atau menghapus yang lama), sehingga
   kode lama tetap berjalan setelah migrasi diterapkan.
2. Siapkan **direktori terisolasi** di luar repo yang tidak punya `wrangler.toml` atau `.env` di folder
   induknya. Isinya `wrangler.toml` minimal dengan satu binding `DB` ke database `sikap-import-prod-20261020`
   (ID dari pemilik, tidak ditulis ke repo) dan salinan berkas migrasi. Cocokkan SHA-256 salinan itu dengan
   berkas di repo.
3. Catat bookmark D1 Time Travel sebagai titik pulih: `wrangler d1 time-travel info DB`.
4. Terapkan **hanya berkas migrasi baru**: `wrangler d1 execute DB --remote --file <berkas>.sql`.
5. Verifikasi read-only bahwa tabel/kolomnya ada.
6. Baru setelah itu push kode ke `main`.

**Jangan pernah** memakai `wrangler d1 migrations apply` atau `db:migrate:production` ke produksi. Skema
produksi dibangun oleh importer, jadi D1 produksi tidak punya tabel `d1_migrations` (dicek 22 Okt 2026).
`migrations apply` akan menganggap 0001 dan seterusnya belum diterapkan dan menjalankan ulang semuanya.
Setiap migrasi produksi diterapkan per berkas lewat langkah di atas, dan dicatat (nama berkas, SHA-256,
bookmark, waktu) di `MIGRATION_PLAN.md` atau catatan rilis.

Pemulihan bila migrasi bermasalah: `wrangler d1 time-travel restore DB --bookmark <bookmark>` dari direktori
terisolasi yang sama. Perintah ini juga mengembalikan semua data yang berubah setelah bookmark, jadi hanya
dipakai atas keputusan pemilik.

Setiap langkah produksi di atas butuh persetujuan pemilik. Migrasi 0001–0008 adalah skema impor dan
tidak boleh diubah (dijaga `scripts/import/historical-schema.test.mjs`); migrasi baru selalu berupa
berkas bernomor berikutnya. Contoh pertama: `0009_kunci_api.sql` untuk API integrasi
([`RENCANA-API-INTEGRASI.md`](RENCANA-API-INTEGRASI.md) §10).

## Jangan memakai integrasi Git Cloudflare

Dashboard `sikap-v2` → *Settings* → *Build* menawarkan *Connect to a repository*. **Jangan dipakai**
selama alur GitHub Actions ini aktif:

- `wrangler.toml` root memuat `pages_build_output_dir`, jadi build Git Cloudflare memakainya sebagai
  sumber konfigurasi, bukan binding di dashboard. `[env.production]`-nya berisi binding historis
  (`sikap-db`, `sikap-files`, `sikap-backup`), sehingga produksi akan membaca dan menulis ke database yang salah.
- Build Cloudflare tidak menunggu job `verify`; commit yang gagal tes tetap tayang.
- Bersama job `deploy` di Actions, setiap commit akan di-deploy dua kali.

Pindah ke integrasi Git hanya setelah commit di `main` yang lebih dulu mengganti `[env.production]` ke binding
aktif (ID D1 produksi jadi tercatat di repo publik), menghapus `BACKUPS`, dan mematikan job `deploy`.

## Penyiapan satu kali (pemilik)

Status: secret sudah dipasang dan deploy pertama berhasil pada 22 Okt 2026. Langkah di bawah dipakai
lagi saat token diganti (sebelum kedaluwarsa) atau saat environment dibuat ulang. Tanpa ketiga secret,
job deploy dilewati dengan peringatan "Deploy dilewati" di Actions.

1. **Token API Cloudflare** (dashboard Cloudflare → *My Profile* → *API Tokens* → *Create Token* → *Custom token*):
   - Permissions: **Account → Cloudflare Pages → Edit**.
   - Account Resources: *Include* → akun SIKAP saja.
   - TTL: beri tanggal kedaluwarsa (mis. 1 tahun) dan catat kapan harus diganti.
   - Jika langkah *Deploy* nanti gagal dengan galat izin yang menyebut D1 atau R2, tambahkan
     *Account → D1 → Read* dan *Account → Workers R2 Storage → Read*, lalu jalankan ulang.
2. **Environment GitHub** (repo → *Settings* → *Environments* → *New environment* → `production`):
   - *Deployment branches and tags*: *Selected branches* → `main`.
   - Opsional: *Required reviewers* bila setiap deploy ingin disetujui dulu.
3. **Secret** di environment `production` (*Add environment secret*):

   | Nama | Isi |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Token dari langkah 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | Account ID (dashboard → *Workers & Pages* → panel kanan *Account ID*) |
   | `PROD_D1_DATABASE_ID` | Database ID D1 `sikap-import-prod-20261020` (dashboard → *Storage & Databases* → *D1*) |

4. Jalankan deploy pertama: repo → *Actions* → *CI* → *Run workflow* → branch `main`. Selanjutnya
   setiap merge/push ke `main` men-deploy sendiri.

Nilai-nilai ini tidak pernah ditulis ke repo (repo publik) dan tidak dicetak di log.

## Sesudah deploy

- Periksa run di tab *Actions*: job `deploy` hijau dan health check menampilkan `"db":"ok"`.
- Coba masuk di `https://sikap.uptdpenda-kupang.web.id` dan buka satu dokumen.

## Rollback

Dashboard Cloudflare → *Workers & Pages* → `sikap-v2` → *Deployments* → pilih deployment
produksi sebelumnya → **Rollback to this deployment**. Rollback hanya mengganti kode/aset; data
D1/R2 tidak berubah. Setelah itu perbaiki langsung di `main`; push berikutnya men-deploy perbaikan.

## Deploy manual (cadangan, bila GitHub Actions tidak tersedia)

Dari repo yang sudah `npm ci`:

```bash
npm run build
```

```bash
PROD_D1_DATABASE_ID=<id> node scripts/deploy/pages-release.mjs /tmp/sikap-release
```

```bash
cd /tmp/sikap-release && npx wrangler pages deploy public --project-name sikap-v2 --branch main
```

Direktori rilis harus kosong dan di luar repo. Di Windows, lepas tautan `node_modules` (junction)
sebelum menghapus direktori rilis agar `node_modules` repo tidak ikut terhapus.

**Jangan** deploy dari root repo (`wrangler pages deploy` dengan `wrangler.toml` root), dan
jangan menjalankan `db:migrate:production` (binding historis).

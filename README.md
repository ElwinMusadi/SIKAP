# SIKAP — Sistem Informasi Kepegawaian dan Arsip Pegawai

Aplikasi internal UPTD Pendapatan Daerah Wilayah Kota Kupang untuk mengelola data pegawai (PNS, CPNS, PPPK), arsip dokumen kepegawaian, dan verifikasi dokumen oleh Admin TU.

> **Status:** produksi berjalan di Cloudflare sejak cutover 21 Oktober 2026 di
> **https://sikap.uptdpenda-kupang.web.id** (Pages project `sikap-v2`, D1 + R2). Repo hanya memakai
> branch `main`; setiap commit ke `main` di-deploy otomatis lewat GitHub Actions ([`docs/DEPLOY.md`](docs/DEPLOY.md)).
> Redesign UI/UX v2 (fase 0–6) tayang di produksi sejak 22 Oktober 2026 lewat deploy otomatis pertama.
> Sistem lama (GAS + Google Sheets + Drive) ada di [`legacy-gas/`](legacy-gas/), dibekukan, dan disimpan untuk
> rollback selama masa pemantauan 30 hari. Riwayat fase, checkpoint, dan batas bukti ada di `MIGRATION_PLAN.md`.

| Dokumen | Isi |
|---|---|
| [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) | Analisa, review, dan audit sistem lama |
| [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) | Keputusan pemilik produk, arsitektur target, skema D1, API, redesign UI, fase, dan rencana cutover |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Deploy otomatis dari `main`, penyiapan secret, dan rollback |
| [`docs/RENCANA-REDESIGN-UIUX.md`](docs/RENCANA-REDESIGN-UIUX.md) / [`docs/POLA-UI.md`](docs/POLA-UI.md) | Design system v2 dan pola komponen UI |

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
legacy-gas/     Sistem lama GAS (dibekukan, tidak ikut deploy Cloudflare)
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
| `npm run test:deploy` | Tes paket rilis produksi (ID fiktif, tanpa jaringan) |

## Deployment (Cloudflare Pages)

Project Pages: **`sikap-v2`**, produksi sejak cutover 21 Oktober 2026. **Setiap push/merge ke
`main` otomatis di-deploy** oleh GitHub Actions (`.github/workflows/ci.yml`, job `deploy`) setelah
seluruh tes lulus. Penyiapan secret, cara kerja, dan rollback: [`docs/DEPLOY.md`](docs/DEPLOY.md).

| Environment | URL | D1 | R2 |
|---|---|---|---|
| Production (branch `main`) | https://sikap.uptdpenda-kupang.web.id | `sikap-import-prod-20261020` | `sikap-import-prod-20261020-files` |
| Preview (tidak dipakai) | https://feat-cloudflare-migration.sikap-v2.pages.dev | `sikap-db-preview` | `sikap-files-preview` |

Binding produksi `sikap-db`/`sikap-files`/`sikap-backup` dalam konfigurasi root dan cron adalah
konfigurasi **historis**. Jangan deploy dari root repo dan jangan jalankan migrasi
`--env production` dengan binding lama; paket rilis produksi disusun oleh
`scripts/deploy/pages-release.mjs` di luar checkout. Migrasi D1 tidak dijalankan otomatis.

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
- Fase 7 menambahkan antrean purge exact-key: jadwal harian menyeleksi versi/dokumen/pegawai
  yang kedaluwarsa secara terbatas; jadwal retry juga menguras antrean file yang sudah
  tidak direferensikan. Jadwal tetap nonaktif sebelum migrasi dan verifikasi deployment.
- Jika `BACKUPS` tersedia, jadwal harian membuat/melanjutkan satu job backup; setiap
  invocation retry melanjutkan maksimal satu chunk. Pembersihan backup kedaluwarsa juga
  memakai antrean exact-key. Tanpa binding backup, pekerjaan ini dilewati dengan aman.

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

## Backup dan retensi (Fase 7, terimplementasi lokal; belum di-deploy, cron nonaktif)

- Referensi pangkat/unit dan jenis dokumen dinonaktifkan, bukan dihapus. Arsip dari jenis
  nonaktif tetap dapat dilihat tetapi tidak dapat diunggah ulang dan tidak dihitung wajib.
  Perubahan matriks wajib langsung memengaruhi kelengkapan pegawai yang sudah ada.
- Purge retensi memakai antrean exact-key: pencatatan key dan penghapusan baris database
  dijalankan dalam transaksi yang sama, kemudian R2 dihapus hanya setelah key dipastikan
  tidak direferensikan lagi. Jangan menjalankan penghapusan berdasarkan prefix ID pegawai.
- Backup berupa **ekspor logis NDJSON bertahap**, bukan snapshot konsisten pada satu waktu.
  Manifest menandai `consistent:false` dan `includesFileBytes:false`: daftar key/checksum
  file adalah inventaris, **bukan salinan byte dokumen/foto**.
- Ekspor memuat data pribadi, hash password, dan token pengaturan yang terenkripsi;
  pengunduhan hanya untuk admin. Simpan hasilnya dengan kontrol akses yang setara produksi.
  Sesi, counter login, antrean notifikasi, lease, serta nilai secret environment tidak diekspor.
- Recovery password/token memerlukan `PASSWORD_PEPPER` dan `SETTINGS_ENC_KEY` asli yang
  dicadangkan terpisah. Ekspor tidak menyediakan endpoint restore otomatis.
- Gunakan D1 Time Travel atau ekspor SQL D1 untuk pemulihan konsisten, serta backup file
  tersendiri untuk pemulihan dokumen. Jangan menganggap tombol Backup sebagai pengganti
  kedua prosedur tersebut.
- `BACKUPS` bersifat opsional. Lokal menggunakan simulasi `sikap-backup-preview`; binding
  preview remote sengaja belum dipasang sampai bucket privat terpisah disediakan.
  Produksi menunjuk `sikap-backup`, tetapi tidak ada deploy/aktivasi cron otomatis.

Sebelum mengaktifkan cron Fase 7, ukur CPU pada environment preview dengan fixture sebesar
pemakaian nyata. Batas jumlah baris/part mengendalikan pekerjaan tetapi bukan bukti bahwa
gabungan retry, purge, dan serialisasi backup selalu memenuhi batas CPU 10 ms Free plan.
Jangan menerapkan lifecycle yang menghapus seluruh prefix backup hanya berdasarkan usia
objek tanpa menyamakan kebijakan dengan job/part yang masih direferensikan.

## Alat migrasi offline (Fase 8)

Kode ada di `scripts/migrate/`. **Jalur apply hanya lokal**, pada persistence simulator
khusus; tidak membaca konfigurasi produksi, tidak menerima `--remote`, dan tidak membuka
endpoint import HTTP di aplikasi. Fase ini belum memindahkan data pegawai nyata.

1. Buat fixture sintetis di direktori baru di luar repo:
   `npm run migrate:fixture -- --out <private-source-dir>`.
2. Transformasi: `npm run migrate:transform -- --input <snapshot.sikap-export.json>
   --out <private-plan-dir> --pepper-file <target-pepper-file> --salt-file <private-salt-file>`.
   Pepper harus cocok dengan environment target; salt privat terpisah membuat hasil wrapping
   deterministik. Jangan menaruh nilai kedua secret itu dalam argumen atau chat.
3. Validasi tanpa menulis: `npm run migrate:apply:local -- --plan <plan.sikap-plan.json>
   --files <source-files-dir> --persist-to <absolute-isolated-dir>`.
4. Impor lokal memerlukan flag eksplisit `--apply` pada perintah yang sama.
5. Rekonsiliasi: `npm run migrate:reconcile:local -- --plan <plan.sikap-plan.json>
   --files <source-files-dir> --persist-to <absolute-isolated-dir>`.

Importer menggunakan namespace Miniflare tersendiri, **bukan** database dev/preview bawaan
Wrangler. Jangan berasumsi hasil dry-run muncul pada `npm run preview` atau di Cloudflare.
`npm run test:migrate` menjalankan test Node terpisah dari test aplikasi.

Ekspor GAS adalah alat manual privat `scripts/migrate/gas/ExportForMigration.gs`, bukan file
untuk `clasp push` aplikasi. Baca instruksi di dalamnya sebelum memasang di editor; jangan
menjalankannya terhadap produksi sebelum salinan sumber, izin folder, dan source freeze
untuk cutover diverifikasi. Script tidak mengekspor sesi login atau token WhatsApp. Exporter GAS membatasi manifest
awal UTF-8 hingga 7 MiB dan checkpoint hingga 8 MiB agar `File.setContent()` tetap di bawah
batas GAS; maksimum 100.000 baris total. Batas pembacaan offline 50 MiB tidak berarti exporter GAS mendukung
manifest sebesar itu.

**Artefak sensitif:** ekspor, plan, SQL, hash password, berkas pegawai, pepper/salt, dan
checkpoint wajib disimpan privat serta tidak di-commit. Gunakan `migration-data/`,
`.migration-private/`, atau direktori di luar repo; suffix `.sikap-*` sensitif juga diabaikan git.
Mode file POSIX tidak menggantikan ACL Windows. Importer memeriksa izin persistence dan
menolak `PERSIST_PERMISSIONS` bila aksesnya tidak dapat dibuktikan privat. Pada Windows,
siapkan folder khusus yang dimiliki akun operator dan hanya dapat diakses operator,
SYSTEM, serta Administrators; jangan melemahkan ACL folder pengguna/kerja yang sudah ada.
Laporan hanya menyertakan kode kesalahan dan koordinat baris, bukan nilai NIP/NIK/nomor HP.

NIP/NIK numerik, referensi tak dikenal, arsip yatim, file hilang/rusak, dan konflik sumber
membuat plan tidak siap. Perbaiki sumber atau mapping eksplisit, lalu buat ekspor/plan baru;
jangan mengedit `ready` menjadi `true`. Ekspor berlabel `consistent:false` karena pembacaan
beberapa sheet dan file tidak transaksional; cutover tetap membutuhkan sumber read-only,
rekonsiliasi, dry-run kedua, serta UAT sebelum import remote terpisah.

### Tahap operator berikutnya: rehearsal di Apps Script nyata tanpa data pegawai asli

Gunakan **project Apps Script baru yang berdiri sendiri**, bukan editor/project GAS produksi.
Ini menguji otorisasi Google, format sel Sheets, salinan byte Drive dan checkpoint pada
runtime GAS nyata tanpa membaca spreadsheet produksi.

1. Buat folder kosong di **My Drive** milik akun operator, bukan Shared Drive dan bukan
   di dalam folder yang dibagikan. General access harus **Restricted**, tanpa editor/viewer
   tambahan. **Seluruh folder induknya juga harus privat**; pemeriksaan tidak hanya pada
   folder keluaran. Jangan mengaktifkan sharing publik.
2. Buat project baru di https://script.google.com, misalnya `SIKAP Migration Rehearsal`.
   Tempel kode dari `scripts/migrate/gas/ExportForMigration.gs` dan
   `scripts/migrate/gas/CreateSyntheticSandbox.gs` sebagai dua file editor.
   **Jangan Deploy**, jangan `clasp push`, dan jangan memasang trigger.
3. Di **Project Settings → Script Properties**, isi hanya
   `MIGRATION_SANDBOX_PARENT_ID` dengan ID folder kosong pada langkah 1.
   Jangan mengisi ID produksi. Pembuat sandbox menolak project yang sudah memiliki
   konfigurasi ekspor/checkpoint agar tidak menimpa pemilihan sumber sebelumnya.
4. Tambah wrapper sementara di file editor terpisah:
   ```js
   function runSyntheticSetup() { createMigrationSandbox_(); }
   function runSyntheticExport() { exportForMigration_(); }
   ```
   Jalankan `runSyntheticSetup`, setujui izin Sheets/Drive menggunakan akun pemilik,
   lalu periksa folder baru yang dibuat. Isinya spreadsheet dan file **SINTETIS** serta
   folder keluaran privat; tool tidak mengganti data atau izin sumber lama.
5. Jalankan `runSyntheticExport` berulang sampai execution log menunjukkan:
   `isComplete:true`, `pendingCount:0`, `missingCount:0`, `invalidCount:0`.
   Jika salah satu gagal, berhenti dan periksa penyebabnya; jangan mengubah JSON agar
   terlihat selesai. `consistent:false` tetap benar walaupun sumber sintetis tidak berubah.
6. Unduh folder `snapshot-<UUID>` melalui Drive, ekstrak ke direktori lokal privat.
   Temukan `snapshot.sikap-export.json` dan direktori `files/` yang berada di dalamnya;
   browser mungkin menambahkan satu tingkat folder saat mengekstrak ZIP.
7. Hapus kedua wrapper sementara setelah selesai; jangan pernah memublikasikan project ini.
   Pertahankan checkpoint jika ingin memeriksa hasil yang sama. Checkpoint terikat ke ID
   spreadsheet dan folder; mengganti properti atau memakai checkpoint lama tanpa ikatan
   akan ditolak. Jangan mengosongkan nilainya untuk melewati pemeriksaan. Untuk latihan
   kedua, gunakan project/folder sintetis baru, bukan menghapus checkpoint yang belum dipahami.
   Rerun pembuat sandbox tidak menggantikan verifikasi isi; ikuti flag `contentVerified`
   dan tetap validasi JSON/file unduhan dengan transformer serta rekonsiliasi.

**Setelah unduhan tersedia:** gunakan perintah transformasi/validasi/import lokal di atas.
Untuk membuat secret latihan dengan pemeriksaan izin folder, jalankan:

```powershell
npm run migrate:prepare:rehearsal -- --out "<private-parent>\rehearsal-secrets" --purpose synthetic-rehearsal
```

Parent harus sudah privat dan output harus direktori baru di luar repo. Helper menolak
menimpa output, tidak mengubah ACL folder yang sudah ada, dan hanya mencetak status/jumlah.
Hasilnya `rehearsal.sikap-pepper` dan `rehearsal.sikap-salt`; gunakan kedua path tersebut pada
perintah transformasi. Secret ini **hanya untuk rehearsal**, bukan environment produksi.

Alternatif manual: buat pepper dan salt sebagai file privat di luar repo, dengan nilai
base64 dari 32 byte acak masing-masing (jangan memakai secret produksi untuk latihan).
Gunakan Node agar encoding tetap UTF-8; jangan memakai redirect `>` PowerShell 5.1 yang dapat
menghasilkan UTF-16. Contoh berikut menolak menimpa file yang sudah ada dan tidak mencetak
nilai secret:

```powershell
node -e "require('fs').writeFileSync(process.argv[1],require('crypto').randomBytes(32).toString('base64'),{encoding:'utf8',flag:'wx',mode:0o600})" "<private-parent>\rehearsal.sikap-pepper"
node -e "require('fs').writeFileSync(process.argv[1],require('crypto').randomBytes(32).toString('base64'),{encoding:'utf8',flag:'wx',mode:0o600})" "<private-parent>\rehearsal.sikap-salt"
```

Jangan mencetak nilainya di terminal atau mengirimkannya ke chat. Simpan direktori target
simulator pada ACL privat seperti dijelaskan di atas. `--persist-to` wajib direktori baru
khusus atau target resume yang tepat; jangan gunakan `.wrangler` aplikasi.

Contoh rangkaian lokal setelah file hasil GAS diekstrak (ganti semua placeholder path,
jalankan dari root repo, dan pilih direktori `plan-gas`/`target-gas` baru):

```powershell
npm run migrate:transform -- --input "<private-parent>\snapshot-UUID\snapshot.sikap-export.json" --out "<private-parent>\plan-gas" --pepper-file "<private-parent>\rehearsal-secrets\rehearsal.sikap-pepper" --salt-file "<private-parent>\rehearsal-secrets\rehearsal.sikap-salt"
npm run migrate:apply:local -- --plan "<private-parent>\plan-gas\plan.sikap-plan.json" --files "<private-parent>\snapshot-UUID\files" --persist-to "<private-parent>\target-gas"
npm run migrate:apply:local -- --apply --plan "<private-parent>\plan-gas\plan.sikap-plan.json" --files "<private-parent>\snapshot-UUID\files" --persist-to "<private-parent>\target-gas"
npm run migrate:reconcile:local -- --plan "<private-parent>\plan-gas\plan.sikap-plan.json" --files "<private-parent>\snapshot-UUID\files" --persist-to "<private-parent>\target-gas"
```

Jika pemeriksaan My Drive root atau folder induk ditolak, **jangan melonggarkan guard**
agar bisa meneruskan ekspor. Periksa akun pemilik, Share/akses domain dan letak folder;
perilaku API Google ini baru terbukti setelah rehearsal nyata. Pemeriksaan manual Drive
Share tetap wajib karena API tidak selalu menampilkan seluruh akses tingkat domain.

Kriteria rehearsal selesai: `ready:true`, nol error transformasi, apply dan reconcile
`ok:true`, seluruh checksum/ukuran file cocok, serta resume tidak mengubah jumlah baris.
Warning normalisasi harus ditinjau, bukan dianggap otomatis aman.

### Setelah rehearsal: sumber nyata yang disalin secara aman

Salinan spreadsheet **tidak otomatis menyalin file Drive**: kolom `File_Drive_ID` dan
`Foto_Drive_ID` masih menunjuk file asli. Jangan menjalankan exporter pada salinan sheet
saja lalu menganggapnya sandbox. Siapkan salinan privat file-file yang dirujuk dan ubah
ID pada salinan spreadsheet, atau rencanakan ekspor read-only terhadap sumber asli dengan
persetujuan dan kontrol akses yang sesuai. Jangan mengubah ID pada spreadsheet produksi.

### Penyalinan per-file otomatis, dijalankan manual oleh operator

Script `scripts/migrate/gas/CopyPrivateSource.gs` ditujukan untuk menyiapkan salinan sumber.
**Pembaruan konflik versi:** penulisan subagent yang terlambat sempat mengganti script dan
suite test. Versi pemulihan menggunakan protokol checkpoint **v2**, mengembalikan pengaman
chunking, presisi identitas, hash manifest, dan retry. Review independen v2 kini
**PASS WITH NOTES**, tanpa High/Medium terbuka; kode aktual memiliki 20 test copier yang lulus. **Jangan gunakan salinan script v1
atau checkpoint v1 untuk melanjutkan job v2.**
**Selalu jalankan dulu pada sumber sintetis latihan.** (Historis: v2 kemudian diuji operator
pada Google nyata dengan sumber sintetis, lalu pada salinan privat sumber nyata 17 Oktober
2026; lihat `MIGRATION_PLAN.md` Fase 8.) Selalu buat
**project Apps Script standalone baru**; jangan pakai project produksi atau project
rehearsal apa pun. Tempel dua file:

- `scripts/migrate/gas/ExportForMigration.gs` (helper privasi dan exporter).
- `scripts/migrate/gas/CopyPrivateSource.gs` (penyalin).

**Script dirancang hanya membaca spreadsheet dan file sumber, tanpa menulis, memindahkan,
menghapus, atau mengubah sharing sumber; jalur ini sudah diuji dengan mock yang menolak
setiap mutasi sumber. Perilaku API Google tetap perlu diuji pada sumber sintetis.** Target dibuat oleh script sendiri, bukan ID target yang
Anda masukkan. Ini salinan data empat tab untuk migrasi, bukan pengganti spreadsheet
operasional lengkap: spreadsheet baru dibuat dari nilai empat tab, **bukan** `Make a copy`
seluruh container. Bound script, formula aktif, trigger, dan deployment aplikasi tidak
ikut disalin. Kolom `File_URL` dan `Folder_Drive_ID` pada target dikosongkan agar salinan
latihan tidak menyisakan pintasan ke dokumen/folder produksi; sumber tidak diubah.

1. Buat folder My Drive baru yang **kosong**, milik akun operator, Restricted, tanpa pengguna
   tambahan dan dengan seluruh induk privat. Jangan gunakan Shared Drive.
2. Di Script Properties project baru, isi:

   | Property | Nilai |
   |---|---|
   | `MIGRATION_COPY_SOURCE_ID` | ID spreadsheet SIKAP yang ingin dibaca |
   | `MIGRATION_COPY_PARENT_ID` | ID folder privat kosong tadi |
   | `MIGRATION_COPY_CONFIRM` | `COPY_SOURCE_READ_ONLY` persis, tanpa spasi tambahan |

   Ambil ID spreadsheet dari bagian antara `/d/` dan `/edit` pada URL. Nilai konfirmasi
   adalah persetujuan penyalinan read-only, **bukan** bukti bahwa sumber sudah dibekukan.
   Membaca data produksi tetap memerlukan persetujuan pemilik data dan akun yang berhak;
   kesiapan script bukan izin akses otomatis. Script ini belum dijalankan terhadap Google
   oleh sesi pengembangan. Jangan mengisi properti ekspor lama atau menyalin checkpoint
   dari project sebelumnya.
3. Tambahkan wrapper sementara:

   ```js
   function runPrivateCopy() {
     copyPrivateMigrationSource_();
   }
   ```

   Jalankan manual, setujui akses menggunakan akun yang bisa membaca seluruh dokumen,
   lalu ulangi fungsi yang sama sampai log menunjukkan **`isComplete:true`, `pendingCount:0`,
   dan `errorCount:0`**. `copiedFileCount` menyatakan jumlah file baru; `updatedReferenceCount`
   menyatakan jumlah sel ID yang sudah dialihkan. Jika fase verifikasi masih berjalan,
   jalankan ulang—jangan mulai ekspor sebelum `isComplete:true`. Saat job selesai dijalankan
   ulang, dua properti hasil dicabut sampai pemeriksaan ulang lengkap; jangan memakai ID
   yang dicatat sebelumnya bila pemeriksaan ulang gagal.
   **Jangan Deploy atau memasang trigger.** Proses dibatasi per invocation dan dapat
   dilanjutkan; satu panggilan Google yang lambat tetap dapat melewati batas waktu lunak.
   Penulisan spreadsheet dibatasi 5 kelompok × 200 baris per sekali jalan dan checkpoint
   disimpan sebelum penulisan data. Batas penyalinan berikutnya 10 file per sekali jalan;
   verifikasi checksum akhir juga dibagi menjadi kelompok terbatas. Fase `initializing`
   berarti penulisan tab belum selesai; lanjutkan Run yang sama, bukan membuat job baru.
4. Periksa folder `sikap-private-copy-<UUID>` yang dibuat. Spreadsheet target, salinan file,
   serta manifest pemetaan dirancang bersifat privat. Target dapat ditemukan lewat folder
   job tersebut atau Script Properties hasil. Log dirancang hanya menampilkan status/jumlah,
   bukan ID sumber/file; manifest mengandung pemetaan sensitif dan tidak boleh dibagikan
   atau di-commit. Simpan unduhan di luar repo, bukan subfolder repo yang mungkin tidak
   tercakup pola ignore root.
5. Hanya jika penyalinan selesai tanpa kegagalan, gunakan Script Properties hasil
   yang **diisi otomatis oleh script**; jangan mengubah ID hasil ini secara manual:
   - `MIGRATION_COPY_TARGET_ID`: spreadsheet target yang dibuat tool.
   - `MIGRATION_COPY_EXPORT_FOLDER_ID`: folder kosong yang disiapkan untuk hasil ekspor.

   Salin nilainya ke `MIGRATION_SPREADSHEET_ID` dan `MIGRATION_EXPORT_FOLDER_ID` dalam project
   manual yang sama. Tetapkan `MIGRATION_SOURCE_READONLY=true` **hanya setelah** salinan
   target/file tidak lagi diubah oleh siapa pun. Jangan memakai ID sumber pada properti ekspor.
   **Setelah properti ekspor diisi, jangan jalankan penyalinan lagi dalam project ini.**
   Jangan mulai ekspor sebelum penyalinan selesai. Untuk salinan baru, buat project baru
   dan folder kosong baru; jangan mencampur atau mengosongkan checkpoint.
6. Hapus fungsi sementara penyalinan. Tambahkan fungsi ekspor sementara seperti pada tahap
   rehearsal, jalankan sampai lengkap, unduh snapshot ke folder lokal privat di luar repo,
   kemudian hapus fungsi ekspor. Jangan tempel manifest, ekspor, atau laporan berisi data
   pegawai ke chat.

Jika ada file hilang, ID tidak valid, izin ditolak, atau target berubah di tengah proses,
berhenti dan tinjau hasil privat. `COPY_SOURCE_UNAVAILABLE_RETRY` berarti akses file belum
berhasil—termasuk kemungkinan gangguan sementara, kuota, file hilang, atau izin—dan entri
masih pending. Periksa akses/kuota lalu ulangi fungsi yang sama; script tidak otomatis
menetapkan gangguan tersebut sebagai file hilang permanen. `COPY_SOURCE_TIMEZONE` berarti
sumber bukan `Asia/Makassar`; jangan mengubah timezone produksi sembarangan untuk melewatinya.
Kode `COPY_MANIFEST_INVALID`/`COPY_TARGET_CHANGED` berarti hentikan proses dan periksa artefak,
bukan mengedit checkpoint agar diterima. Jangan mengosongkan ID agar log tampak berhasil dan
jangan menghapus checkpoint yang belum dipahami. Script tidak menghapus artefak parsial otomatis;
inspeksi hanya item baru pada folder job. Jika pembuatan spreadsheet terputus sebelum
pemindahan, spreadsheet baru dapat tertinggal di My Drive root—jangan hapus file lain.

Salinan ini **tidak menjamin konsistensi point-in-time** karena sheet dan file dibaca pada
waktu berbeda. Nilai NIP/NIK yang sudah bertipe angka ditolak agar digit yang mungkin hilang
presisinya tidak tersamarkan menjadi string valid. File Google Docs/shortcut serta format
selain PDF/JPEG/PNG/WEBP juga tidak dipromosikan menjadi salinan yang siap diekspor.
Untuk cutover final, bekukan seluruh penulis sumber dan perubahan file, pertahankan freeze
selama copy/ekspor, dan lakukan rekonsiliasi sebelum membuka sistem baru.

Migrasi nyata memerlukan inventaris sumber, snapshot/salinan privat, review mapping dan
warning, pemilihan environment beserta pepper target yang benar, dry-run kedua, UAT dan
prosedur cutover/rollback. Langkah tersebut **belum dijalankan oleh alat lokal atau otomatis
dengan rehearsal ini**. Jangan unggah ekspor, hash, file pegawai, maupun secret ke chat/repo.

## Gerbang UAT privat (Fase 9 — parsial: app kosong + fixture sintetis, belum siap import)

> Status 17 Oktober 2026: `readyForImport` belum pernah `true`. Preflight remote read-only
> berakhir `TARGET_NOT_EMPTY` (sesuai harapan karena fixture). Importer remote belum
> diimplementasikan. Tiga run policy lama berhenti gagal-aman (exit 2); run keempat dengan
> policy v2 lulus seluruh 11 langkah (exit 0), `observedTransportRollback:true`. Bukti terbatas
> pada transport query Wrangler 4.151.0 dan policy tersebut, bukan kesiapan impor atau jaminan global.
> Pada status historis 17 Oktober tersebut data nyata belum diimpor. Subbagian berikut kronologis;
> checkpoint recovery final (`UAT_IMPORT_VERIFIED`) mencatat PII pegawai di D1 dan bucket UAT
> privat (66/66 file); lihat checkpoint final di bawah.

Preview `feat-cloudflare-migration.sikap-v2.pages.dev` masih dapat menampilkan halaman login
secara anonim pada pemeriksaan HEAD 17 Oktober 2026; API langsung menjawab 401 aplikasi.
Ini **bukan bukti kebocoran data**, tetapi bukan staging privat. Jangan mengimpor PII ke
`sikap-db-preview`/`sikap-files-preview`: deployment lama tetap punya URL hash yang dapat
mengakses binding environment yang sama.

Pilihan staging: project Pages **baru dan terisolasi** `sikap-uat` (atau suffix terkontrol),
D1 dan R2 baru bernama `sikap-uat-*`, secret UAT terpisah, tanpa custom domain dahulu.
Resource UAT dibuat 17 Oktober 2026: Pages `sikap-uat` (branch Pages production `uat`),
D1 `sikap-uat-db` (`9d6ca598-057e-4297-9b8c-3ce789c5ab14`), R2 `sikap-uat-files` dan
`sikap-uat-backup` (Standard APAC, r2.dev disabled, tanpa custom domain).
Migrasi 0001–0008 sudah diterapkan, **tanpa** pegawai/akun/arsip/sesi/outbox; hanya seed
referensi/jenis. Project produksi `sikap` dan preview lama `sikap-v2` tidak disentuh.

Deployment pertama `90a41e14-7ac4-48ac-b5ad-c6fd9d6767d3` di
`https://sikap-uat.pages.dev` / `https://90a41e14.sikap-uat.pages.dev` adalah **holding worker**,
bukan aplikasi: semua method/path mengembalikan 503, `Cache-Control:no-store`, dan
`X-SIKAP-UAT-State:locked-holding`. Tidak ada aset/login yang diterbitkan; worker tidak
mengakses D1/R2/ASSETS. 13 pemeriksaan remote root+hash termasuk POST login lulus.
**503 ini disengaja dan bukan bukti Access sudah aktif.** Alias `uat.sikap-uat.pages.dev`
saat diperiksa 404 (branch production Pages belum membuat alias preview).

Operator mengonfirmasi Access terpasang pada 17 Oktober 2026: satu aplikasi **SIKAP UAT
Private**, root `sikap-uat.pages.dev` dan wildcard `*.sikap-uat.pages.dev`, path kosong,
Allow hanya satu email penguji yang ditetapkan, tanpa Everyone/Bypass. OTP saja, instant
authentication nonaktif, sesi 6 jam. Dibuat langsung di Zero Trust, bukan melalui Pages;
ini sesuai desain dan menghindari aplikasi wildcard terpisah.

Konfigurasi publik yang dikonfirmasi operator dan sudah disetel pada deployment aplikasi UAT:
- Team domain: `shy-thunder-ffc9.cloudflareaccess.com`
- AUD: `50b2c68c92474c0232581b9641f9107836ca66939e439e2314f37384f4f2b3e9`

Operator juga mengonfirmasi login email diizinkan berhasil menuju holding dan email di luar
allowlist ditolak. Setelah izin tahap berikutnya, aplikasi **kosong** diterbitkan sebagai
`0adc7584-3f21-4318-bea7-3e68a33987a1` pada root dan
`https://0adc7584.sikap-uat.pages.dev`. Secret `PASSWORD_PEPPER` dan `SETTINGS_ENC_KEY`
khusus UAT dipasang; nilainya tidak dicetak, salinan pemulihannya ada di folder privat
operator `C:\Users\elwin\sikap-private\uat-keys-20261017` (owner/SYSTEM/Administrators
saja, diverifikasi tanpa mencetak secret). Salinan awal Temp juga masih ada; file upload
sementara telah dihapus. Jangan menimpa/rotasi pepper sembarangan setelah hash mulai diimpor.

Konfigurasi aktif aplikasi: `ops/uat-app/wrangler.toml`. Holding lama tetap tersedia pada
URL hash historis sebagai rollback terkunci. Jangan memakai konfigurasi `ops/uat` untuk
app penuh atau menjalankan Pages deploy dari root dengan flag project saja. Uji aktual
menemukan Wrangler dapat memilih config root meskipun cwd subfolder; karena itu script
`staging:app:deploy` membuat rilis sementara **di luar repo**, mematok account/proyek/branch,
memverifikasi config fingerprint, daftar file dan SHA-256, lalu membersihkannya.
Hardening 17 Oktober 2026: Wrangler 4.151.0 juga dapat membaca `.env`/config dari cwd,
sehingga seluruh eksekusi alat staging diisolasi di luar repo. Deploy holding dan app memakai
config rilis ter-render yang dipatok beserta allowlist environment; preflight memakai path
absolut config sumber yang dipatok dan cwd terisolasi yang kosong. Pada checkpoint historis
17 Oktober ini belum ada deploy sesudah hardening dan deployment saat itu `0adc7584`.
Status tersebut telah digantikan deployment UAT privat `08ccdbc2` pada checkpoint akhir.

Build app: `npm run staging:app:build` (output baru `dist-uat-app`, menolak overwrite).
Deploy app: set `CLOUDFLARE_ACCOUNT_ID` yang benar lalu `npm run staging:app:deploy`.
Deployment entry hanya export default dan memvalidasi Access JWT untuk **semua path**, termasuk
static/SPA/asset, sebelum ASSETS; API juga tetap memerlukan sesi SIKAP. `_routes.json`
dipaksa include `/*`, exclude kosong. Jika mode tidak tepat `1`, entry UAT menolak503.

Verifikasi pascadeploy: 13 probe anonim pada root+hash baru+hash holding dan header palsu
semuanya mendapat challenge302 team/AUD tepat. Konfigurasi remote diunduh dan dikonfirmasi
DB `9d6ca598...`, bucket UAT, serta mode/team/AUD tepat. Saat deployment awal seluruh tabel
aplikasi kosong. Operator kemudian mengonfirmasi login page/health200/auth-me401 setelah
OTP lulus. Tahap fixture berikutnya dijelaskan di bawah; jangan memakai password produksi.

### Uji login berlapis dengan akun sintetis (17 Oktober 2026)

Atas izin operator, D1 UAT diisi **3 pegawai/akun sintetis** saja: satu Admin dan dua Pegawai
(PNS/PPPK). Nama diawali `SINTETIS UAT`; NIP sengaja identitas uji, password acak independen
bukan enam digit NIP, `is_default_password=0`. Semua NIK/email/no_hp/foto NULL, tanpa dokumen
atau pesan WA. Ada satu audit `FIXTURE_UAT_CREATE`. Sumber snapshot nyata tidak digunakan.
Generator `scripts/staging/uat-fixture.mjs` hanya membuat berkas offline; provisioning
menggunakan account/config fingerprint UAT eksplisit setelah semua tabel aplikasi diperiksa
kosong. SQL INSERT-only, guard abort, tidak overwrite/reset/delete, tidak resumable bila
terputus. Jangan jalankan lagi pada target yang sudah berisi data/fixture.

Kredensial untuk operator, bukan untuk repo/chat:
`C:\Users\elwin\sikap-private\uat-fixtures-20261017\credentials.sikap-fixture.json`.
SQL, hasil runtime dan hasil pemeriksaan hash berada pada folder privat yang sama.
Ketiga hash remote diperiksa cocok dengan password dan pepper UAT tanpa mencetak nilainya.
Pemeriksaan setelah provision: pegawai3/Admin1/akun3/defaultPassword0/PII0/arsip0/sesi0/
outbox0/auditfixture1; guard kosong menolak dan perimeter anonim13/13 masih challenge302.

Operator membuka file kredensial lokal, lalu di `https://sikap-uat.pages.dev`:
1. Lolos OTP Access; login fixture `label:admin` memakai NIP/password dari file.
2. Login SIKAP sukses harus menuju Beranda; `/api/auth/me`200 roleAdmin, dashboard total3
   aktif3 (PNS2/PPPK1), antrean dokumen0. Header response memuat `X-SIKAP-UAT-Guard`.
3. Logout:204; auth/me401 meskipun sesi Access masih sah, dan kembali ke halaman login.
4. Login fixture `pns`/`pppk`; halaman normal boleh diakses, `/admin/pegawai` menampilkan
   Akses ditolak dan GET `/api/admin/dashboard`403 karena role—bukan karena Access.
5. Setelah logout/back/pergantian akun, informasi Admin tidak boleh tertinggal di UI.
   Jangan mencoba password salah berulang; lima kali akan mengunci akun.

Login remote berlapis ini belum dijalankan oleh sesi otomatis karena OTP/cookie pribadi
operator tidak diambil atau diminta. Catat status dan perilaku tanpa membagikan password,
assertion JWT, cookie, response hash, atau file credential. Operator kemudian mengonfirmasi
login berlapis admin/pegawai, logout dan pembatasan role lulus. Ini **laporan operator**, bukan
bukti yang diverifikasi independen oleh sesi pengembangan; kebijakan Access di control plane
(Allow/Deny, inventaris host/deployment) juga belum diaudit independen. Konfirmasi ini tidak
berarti alur upload/revisi/rollback maupun import remote sudah diuji. Data nyata tetap ditahan.

### UAT dokumen sintetis — tahap berikutnya

Gunakan akun fixture yang sudah ada; jangan menghapus atau menimpa database UAT agar tampak
kosong. Target berisi fixture secara sengaja, jadi preflight import harus menolak
`TARGET_NOT_EMPTY`. Import migrasi kelak membutuhkan target kosong terpisah atau prosedur
pembersihan yang disetujui, bukan menjalankan ulang seed/import secara paksa.

1. Sebagai Admin fixture, **Pengaturan Sistem → Notifikasi**: nonaktifkan ketiga toggle.
   Provider WhatsApp tetap tanpa token. Jangan menambahkan nomor HP/email pegawai nyata.
2. Sebagai Pegawai PNS fixture, lengkapi profil dengan nilai sintetis pada kit (email
   `example.invalid`, nomor dummy nasional tidak valid `0000000000`, NIK sintetis digit16),
   bukan data operator/pegawai asli. Ini khusus akun `SINTETIS UAT`, tidak untuk sumber nyata.
3. Upload PDF versi1 pada satu jenis wajib, misalnya KTP; harapan Menunggu. Upload file kedua
   langsung saat Menunggu harus diblokir UI; bila request langsung diuji, server menolak409.
   Preview dan unduh harus sama dengan file kit.
4. Admin menolak dengan catatan uji; Pegawai melihat catatan, upload versi2, lalu Admin
   menyetujui. Dashboard kelengkapan berubah, riwayat mencatat kedua keputusan dan versi.
5. Uji rollback dengan jenis lain: PDF V1 disetujui → Pegawai unggah PDF V2 → Admin membuka
   review V2 tetapi jangan memutuskan/refetch → Pegawai pulihkan versi arsip sebelumnya.
   Status Terverifikasi dan isi PDF V1 kembali, tetapi nomor versi arsip naik menjadi3.
   Keputusan Admin pada tampilan V2 yang masih usang harus ditolak409; jika UI sudah memuat
   ulang otomatis, catat skenario stale tidak teruji, jangan menganggapnya lulus.
6. Uji file salah saat Menunggu: hapus → unggah ulang; file sebelumnya tetap tersedia dalam
   masa retensi. Uji hapus biasa dan restore sebelum3hari. Jangan mengubah waktu server
   atau menunggu purge produksi; cron tetap nonaktif selama UAT awal.
7. Admin menghapus dokumen Terverifikasi: Pegawai tidak mendapat tombol restore (request
   langsung403). Untuk menguji rollback versi yang dihapus Admin, Pegawai harus mengunggah
   file baru dahulu; versi DELETE/Terverifikasi tidak boleh dipulihkan Pegawai (API403),
   tetapi Admin boleh rollback kepadanya. Rollback pada arsip yang masih soft-deleted
   sendiri mengembalikan409 restore-first, bukan403 (**API-only**, karena UI tidak menampilkan
   daftar versi pada arsip terhapus). Uji restore Admin pada penghapusan
   terpisah sebelum re-upload. Akun Pegawai fixture lain tidak dapat mengunduh file (404),
   walau sesi Access+SIKAP sah. Jangan membagikan sesi/URL ber-token.
8. SVG dan file lebih dari5MiB ditolak client-side tanpa request HTTP (pilih All files untuk
   mencoba SVG). HTML bernama `.pdf` harus mencapai server dan ditolak400 VALIDATION_ERROR.
   Setelah penolakan, file valid sebelumnya tetap utuh. Uji ini sintetis, bukan migrasi nyata.
9. Catat PASS/FAIL, status HTTP, versi dan jumlah dokumen; jangan membagikan sesi/token.
   Jangan menghapus data fixture tanpa rencana pemulihan dan persetujuan operator.

Kit sudah dibuat dan diverifikasi lokal di
`C:\Users\elwin\sikap-private\uat-document-kit-20261017`:
`version-1.pdf`, `version-2.pdf`, `image.png`, `fake-pdf.pdf`, `oversize.pdf`,
`disallowed.svg`, `manifest.json`. Manifest memuat contoh profil sintetis PNS/PPPK,
ukuran, SHA-256 dan hasil yang diharapkan. Hanya tiga file pertama boleh diterima; sisanya
sengaja ditolak. Generator offline:
`npm run staging:documents:prepare -- --out <direktori-privat-baru> --purpose synthetic-document-uat`.
Tidak ada file kit yang diunggah otomatis. Uji UI dilakukan operator setelah Access OTP,
karena sesi ini tidak mengambil cookie/OTP operator. Preview privat yang bisa login belum
membuktikan checkpoint import, transaksi remote atau izin token cloud sudah aman.

### Dua lapis perlindungan

1. **Cloudflare Access di edge:** konfigurasi self-hosted application/policy yang mencakup
   `sikap-uat.pages.dev` **dan** `*.sikap-uat.pages.dev` untuk URL hash dan alias branch.
   Allow hanya akun/grup UAT yang ditunjuk; jangan membuat aturan Bypass/Everyone.
   Pengaturan Pages "Enable access policy" saja tidak melindungi apex Pages/custom domain.
   Inventaris semua deployment/alias/domain harus diperiksa dari control plane.
2. **Validasi JWT di worker UAT untuk semua rute:** middleware memeriksa signature RS256,
   `iss`, `aud`, `exp`, `iat` dan `nbf` bila ada pada `Cf-Access-Jwt-Assertion` sebelum API
   maupun static/SPA/asset. JWT tidak menggantikan sesi SIKAP. Edge Access tetap diperlukan
   untuk autentikasi pengguna, cakupan hostname, dan perlindungan deployment historis.

Konfigurasi API untuk deployment UAT pertama (bukan perubahan pada produksi saat ini):

| Variable | Nilai |
|---|---|
| `ACCESS_REQUIRED` | `1` |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`, tanpa scheme/path |
| `ACCESS_AUDIENCE` | AUD aplikasi Access yang benar |

Mode `1` dengan konfigurasi hilang/salah menolak akses. Mode tidak dikenal juga ditolak.
Entry aplikasi normal mempertahankan perilaku lama bila mode absent/`0`; entry khusus UAT
menolak503 pada kondisi tersebut. Tetap verifikasi konfigurasi deployment aktual sebelum data dimasukkan. Header JWT palsu tanpa signature yang
sah tidak cukup. Kunci publik diambil dari `/cdn-cgi/access/certs` pada team domain yang
sudah divalidasi; token/principal tidak dicetak atau disimpan global.

### Alat pemeriksaan, bukan izin import

- `npm run staging:target:check -- --descriptor <target.sikap-uat-target.json> --policy <policy.sikap-uat-policy.json>`
  memvalidasi descriptor offline, denylist resource produksi/preview, allowlist account,
  root+wildcard host dan fingerprint schema/pepper. Hasil valid hanya `accessDeclared`,
  **bukan** `accessVerified`; `readyForImport` selalu `false`.
- `npm run staging:access:audit -- --inventory <hosts.sikap-access-inventory.json> --out <new.sikap-access-report.json>`
  melakukan HEAD anonim hanya pada host Pages yang didaftarkan, tanpa cookie/header auth,
  tidak mengikuti redirect, dan tidak membaca body. Challenge tepat ke team Access dapat
  lulus untuk host yang diperiksa; 200/401 aplikasi atau 403 yang tidak membuktikan challenge
  ditandai belum terlindungi/terbukti. Ini tidak membuktikan kebijakan Allow/Deny, seluruh
  deployment historis, custom domain, binding data, atau cakupan token operator.
- `npm run staging:remote:preflight -- --inspect-uat` membaca D1 UAT secara **read-only**
  (daftar migrasi, jumlah tabel aplikasi dan referensi). Dijalankan 17 Oktober 2026: exit 2,
  kode tunggal `TARGET_NOT_EMPTY` (fixture sintetis); `migrationsMatch:true`,
  `referenceCountsMatch:true`; `schemaCompared`, `accessVerified`, `pepperVerified` dan
  `transactionAtomicityVerified` `false`; `readyForImport:false`. Preflight tidak membandingkan
  skema terhadap skema yang diharapkan dan tidak memvalidasi isi referensi.
- `npm run test:staging` menguji alat staging dengan fixture sintetis dan fetch/CLI mock.

Resource ID, audience, fingerprint atau domain UAT harus diambil dari konfigurasi yang
benar; jangan mengarang nilai agar validator lulus. Descriptor tidak boleh berisi token,
password atau nilai pepper. `pepperFingerprint` adalah identitas turunan, bukan nilai pepper:
protokol UAT yang akan diimplementasikan harus menggunakan
`HMAC-SHA256(pepper, "sikap-uat:pepper-fingerprint:v1")` dalam hex lowercase. Validator saat
ini hanya memeriksa formatnya, bukan mencocokkan terhadap secret/deployment aktual.
`schemaSha256` juga harus berasal dari skema target yang benar, bukan angka contoh.
Simpan file operator di luar repo atau gunakan suffix ignore
`.sikap-uat-target.json`, `.sikap-uat-policy.json`, `.sikap-access-inventory.json`.

### Tindakan operator: aktifkan Access saat holding tetap terkunci

1. Dashboard **Workers & Pages → sikap-uat → Settings → Enable access policy**.
   Fitur ini mula-mula melindungi preview, **bukan** root `sikap-uat.pages.dev`.
2. Buka **Manage** pada policy/aplikasi Access yang dibuat. Pada konfigurasi hostname,
   tambahkan root `sikap-uat.pages.dev` dan wildcard `*.sikap-uat.pages.dev` dalam **satu
   aplikasi Access bila UI mendukung**, path kosong untuk semua rute. Gunakan custom input
   hostname bila dropdown hanya menampilkan domain zone.
3. Jika UI Pages hanya membuat aplikasi wildcard: ikuti prosedur resmi Known issues,
   ubah aplikasi itu menjadi root (hapus `*` di Subdomain), simpan, lalu Enable access policy
   lagi agar wildcard juga terlindungi. Jangan hilangkan salah satunya. Bila hasilnya dua
   aplikasi dengan AUD berbeda, hentikan sebelum deploy aplikasi penuh: guard API saat ini
   menerima satu AUD dan perlu diselaraskan dengan desain tersebut.
4. Buat Allow policy untuk email/grup UAT yang Anda tetapkan. Default deny untuk yang lain;
   jangan gunakan Everyone atau Bypass. Pilih IdP/OTP yang sudah tersedia dan tentukan
   session duration. Jangan menganggap email akun Wrangler otomatis merupakan allowlist.
5. Catat **team domain** (`<team>.cloudflareaccess.com`) dan **Application Audience (AUD)**
   dari aplikasi Access. Keduanya konfigurasi publik, bukan token atau secret. Jangan
   menyalin `CF_Authorization`, assertion JWT, API token, atau secret ke chat/repo.
6. Pada incognito, periksa root serta URL hash deployment: `/login`, `/api/auth/me`, dan
   `/api/health` harus melewati challenge Access. Pada holding historis, sesudah autentikasi
   tetap503. Pada app aktif, `/login` seharusnya tampil, health200, auth/me401 sebelum login
   SIKAP; response worker menyertakan `X-SIKAP-UAT-Guard: SIKAP_UAT_ALL_ROUTES_V1`.
   Pengguna yang tidak diizinkan tetap ditolak. Pengujian app setelah OTP dilakukan operator,
   tanpa mengirim token/cookie ke chat (operator kemudian melaporkan lulus; lihat di atas).
7. Team/AUD dan secret UAT sudah dipasang pada app kosong. Jangan mengimpor data hanya karena
   tampilan login berhasil; penulisan/import remote masih memerlukan implementasi dan uji
   sintetis terpisah pada target kosong, termasuk rekonsiliasi target yang eksplisit.

Referensi root/wildcard Pages:
https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain

### Sebelum import remote/UAT data nyata

- Buktikan seluruh URL menolak anonim serta pengguna yang tidak diizinkan, dan pengguna
  UAT yang diizinkan dapat melewati Access lalu login SIKAP. Cookie SIKAP saja tidak boleh
  melewati gate Access.
- Periksa D1/R2 privat/terpisah, bucket publik nonaktif, cron purge nonaktif, pengiriman
  WhatsApp nyata nonaktif, dan konfigurasi server `ACCESS_REQUIRED=1` pada deployment pertama.
- Buat plan baru memakai pepper UAT yang sama dengan aplikasi target; plan ber-pepper latihan
  lokal tidak dapat dipakai begitu saja. Salt dan secret disimpan privat, bukan di chat.
- Importer data remote **belum diimplementasikan**. Selain preflight read-only, kit dan
  eksekutor probe transaksi sintetis tersedia dan telah dijalankan remote **empat kali**, masing-masing
  dengan persetujuan operator terpisah. Pada run awal policy lama, kontrol positif serta guard-abort lulus; constraint-abort berhenti dengan
  `UNEXPECTED_FAILURE`, exit `2`, tanpa retry/cleanup. Inspect independen read-only menemukan
  tepat 2 tabel kit dan 3 baris positif, tanpa baris fase gagal atau objek asing. Error constraint
  tidak terklasifikasi, sehingga **atomicity keseluruhan belum terbukti**. Residu awalnya
  dibiarkan. Cleanup dua tabel kemudian disetujui terpisah dan selesai setelah verifikasi
  identitas/kepemilikan ulang: data dihapus dahulu, inspeksi independen, lalu marker dihapus.
  SELECT setelah cleanup pertama menemukan **0 objek pengguna dan 0 residu probe**. Run kedua
  yang kemudian disetujui berhenti lagi pada constraint (`MESSAGE_MISMATCH`): respons API cocok
  endpoint, kode `7500`, tetapi note tidak cocok pola SQL ketat. Ini bukan bukti UNIQUE atau
  non-atomic. Inspect read-only nonce kedua menemukan kembali **2 tabel kit dan 3 baris positif**,
  tanpa baris gagal/asing; database **saat itu tidak kosong** dan residu dibiarkan selama analisis.
  Akun D1 Free tetap **10/10 slot**. Detail UUID, nonce sintetis, pin config, dan bukti dicatat di
  `MIGRATION_PLAN.md`. Jangan mengulang run identik atau memperlonggar classifier berdasarkan
  tebakan. Analisis lokal menambahkan diagnostik schema v2: label bentuk pesan/suffix/wrapper
  berasal dari 20 literal penuh yang diizinkan, bukan pesan mentah; classifier tetap identik.
  Variasi prefix dan extended code masih hipotesis, bukan penyebab remote terkonfirmasi.
  Percobaan reproduksi ad hoc awal gagal sebelum SQL. Harness berikutnya
  (`node scripts/staging/d1-tx-probe-local.mjs --local-only`) memakai adapter opsi Miniflare
  yang benar dan menjalankan seluruh fase di database in-memory. Batch constraint ditolak dan
  state lokal tetap 3 baris positif. Bentuk lokal primary code + extended PRIMARYKEY kemudian
  cocok whitelist literal penuh **khusus lokal** pada message/cause, sehingga hasil lokal
  `LOCAL_ROLLBACK_OBSERVED`. Classifier dan 20 literal remote tidak diubah; ini bukan bukti
  pesan atau atomicity remote. Diagnostik schema v3 sekarang dapat melabeli bentuk extended
  lewat 4 literal terpisah di konteks APIError bersih/terikat target, tetapi tetap menghasilkan
  `MESSAGE_MISMATCH` dan tidak mengubah penerimaan bukti. Tahap diagnostik tidak mengakses remote.
  Tooling kemudian di-commit lokal pada `c9eed3e`. Cleanup kedua disetujui terpisah dan selesai
  setelah verifikasi ulang nonce/kepemilikan sebelum tiap DROP, data dahulu lalu marker dengan
  inspeksi independen di antaranya. SELECT final: **0 objek pengguna/0 residu**; database tetap
  ada dan kuota **10/10** tidak berubah. Pada tahap cleanup itu belum ada run ketiga.
  Run ketiga kemudian disetujui baru, memakai schema v3 dari commit yang sama. Kontrol positif
  dan guard-abort lulus; fase constraint exit 1 menghentikan eksekutor dengan exit 2,
  tetapi diagnostik kali ini mengenali bentuk
  pesan tabel/id kit dengan primary `SQLITE_CONSTRAINT`, extended `SQLITE_CONSTRAINT_PRIMARYKEY`,
  tanpa wrapper, pada APIError target cocok/kode 7500. Ini observasi run ketiga saja, bukan
  pemulihan pesan run sebelumnya. Classifier lama tetap `MESSAGE_MISMATCH` dan menolak PASS.
  Inspect independen nonce ketiga menemukan tepat **2 tabel kit/3 baris positif**, tanpa baris
  fase gagal atau objek asing; database saat itu kembali **tidak kosong**, residu dibiarkan.
  Pada akhir run ketiga belum ada cleanup. Policy classifier v2 kemudian
  ditambahkan **lokal saja**: tepat satu literal extended tanpa wrapper, dengan tag 7500, diterima
  hanya untuk APIError bersih endpoint dipatok dengan own code angka 7500. Regex lama tetap;
  full run tetap membutuhkan semua 11 langkah dan post-read state yang cocok. Fixture literal
  direkonstruksi dari diagnostik run ketiga + renderer, bukan pesan mentah yang disimpan.
  Tiga receipt lama tidak diubah; policy v2 di-commit lokal pada `8511abc` (saat commit belum diuji remote).
  Cleanup ketiga kemudian disetujui terpisah dan selesai: verifikasi nonce/skema/data sebelum
  DROP data, inspeksi independen, lalu verifikasi ulang sebelum DROP marker. SELECT final
  **0 objek pengguna/0 residu**, database tetap ada; saat cleanup itu belum ada run keempat.
  Inventaris akun pada akhir cleanup berisi **11 database**, berbeda dari 10 sebelumnya; perubahan di luar
  scope belum diinvestigasi, dan plan/kuota terkini tidak disimpulkan dari angka historis.
  Tidak ada database lain yang dibuat/dihapus, retry, push, deploy, atau import dalam cleanup.
  Run keempat kemudian disetujui terpisah dan **lulus exit 0**, seluruh 11 langkah, kedua error
  terikat target dan post-read cocok: `observedTransportRollback:true`, policy v2, Wrangler
  `4.151.0` transport remote `--command` query. Inspect independen nonce keempat mengonfirmasi
  2 tabel kit, marker owned step 1, 3 baris positif, tanpa baris fase gagal/asing atau objek asing.
  Database kini kembali **tidak kosong** dan residu dibiarkan. Hasil hanya untuk satu run/
  transport/versi/policy tersebut; tidak mencakup Worker batch, `--file`, payload besar atau
  konkurensi. `transactionAtomicityVerified:false` dan `readyForImport:false` tetap berlaku.
  Tidak ada retry, cleanup keempat, push, deploy, import atau commit tambahan; inventaris tidak
  dibaca ulang. Langkah berikutnya desain importer lokal yang selaras transport bukti ini;
  cleanup atau operasi remote baru tetap perlu persetujuan terpisah.
  Jangan mengubah alat local-only menjadi remote, menjalankan SQL ekspor
  sembarangan, atau menambahkan endpoint import publik. Jalur penulisan remote perlu receipt
  terikat account/project/database/bucket/schema/pepper, pemeriksaan target kosong dan
  referensi aktual, transaksi checkpoint yang dibuktikan dengan uji sintetis rollback di
  target kosong, serta GET/checksum ulang file R2.
- Desain importer lokal dicatat pada bagian **Desain importer remote** di `MIGRATION_PLAN.md`.
  PII tidak boleh dikirim sebagai SQL/argv Wrangler; kandidat adapter langsung D1 REST `/query`
  memakai template statis dan params dalam body, sehingga membutuhkan bukti sintetis baru untuk
  request shape yang persis sama. Run keempat bukan bukti otomatis parameterized REST.
  Urutannya: pure contract/chunk compiler/ledger state machine lokal, mock HTTP/R2, baru
  rehearsal remote sintetis dengan persetujuan terpisah. Checkpoint, journal dan data chunk
  harus satu request atomik yang terbukti; timeout menghentikan writer dan memerlukan
  pemeriksaan receipt/prefix sebelum keputusan resume, tanpa blind retry. R2 create-only diikuti
  GET SHA-256 sebelum referensi D1, tanpa cleanup otomatis. Tahap desain tidak membuat kode/resource.
  Pure core kini diimplementasikan pada `scripts/import/core.mjs`: validasi descriptor syntax/
  denylist, compiler chunk statis-params dengan caps dan target binding, simulasi state serta
  klasifikasi resume yang tidak pernah mengizinkan retry. Pada tahap core/mock, `test:import`
  menjalankan 32 tes (18 core + 14 mock), dan full `npm test` 999 tes lulus (riwayat sebelum ledger). Artifact params bersifat privat; hanya `summarize`
  boleh ditampilkan. Business validation, raw plan hash, target proof dan semantic validation
  masih wajib terpisah; core tidak memberi izin apply. Expiry wajib dicek ulang oleh adapter
  sebelum setiap send/resume; DDL journal kelak wajib unique `(run_nonce, ordinal)`.
  Core kini menolak key dengan tipe salah dan epoch journal mundur. Mock adapter in-memory
  (`scripts/import/mock-adapter.mjs`) mensimulasikan commit/rollback, timeout/pending/late commit
  tanpa jaringan atau SQL engine; hasil selalu simulated dan tidak mengizinkan retry. Inspect
  mock privat, summary hanya counts/flags; expiry dicek ulang setiap simulated send. Mock hanya
  memodelkan konflik primary key, bukan seluruh FK/UNIQUE/CHECK. Review core dan mock
  PASS WITH NOTES tanpa blocker. Paket core/mock di-commit lokal pada `72f947f`; kandidat
  ledger DDL terpisah dan kontrak hash kini tersedia, dengan 14 tes SQL Miniflare lokal lulus.
  Total seluruh suite menjadi 1.013 tes; importer 46 (18 core + 14 mock + 14 integrasi ledger).
  Pengujian mencakup full-row roundtrip/seed, CAS stale, UNIQUE/FK/CHECK, journal/checkpoint
  rollback dan resume read-only. Ini bukti binding lokal, bukan REST parameterized remote.
  Adapter request D1 REST dan R2 S3 synthetic-only kini tersedia, diuji hanya lewat injected
  fetch (D1 13 tes, R2 15 tes). D1 sekali-kirim selalu membutuhkan read-back; R2 create-only
  PUT + GET SHA-256/MIME/size tidak memberi bukti ownership atau izin apply. Client tidak
  mengambil credential/global fetch sendiri; real-data profile ditolak. Rehearsal gabungan
  Miniflare/object store tiruan lulus 5/5 sesudah koreksi gate alur: helper tes memblokir D1
  pada R2 conflict/row mismatch, dan GET mendeteksi file tamper. Gate hanya di tes, belum
  orchestrator produksi. Paket final 1.046 tes lulus (importer 79), lint/typecheck/build lulus.
  Reader `d1-readback.mjs` kemudian tersedia dengan 9 tes fetch stub lulus; full-row output
  bersifat privat, dibatasi 8 MiB dan tidak memberi bukti identity/transport. Runner sintetis
  `synthetic-runner.mjs` kemudian memindahkan gate helper ke modul runner kandidat lokal, bukan
  enforcement produksi (baseline/bootstrap,
  object coverage, R2 sebelum D1, read-back per chunk, stop tanpa resend, final GET). Penguatan
  berikutnya menambah guard `READBACK_CAPACITY` sebelum request (budget JSON lokal 6 MiB dari
  cap reader 8 MiB), tes foto, urutan exact per chunk pada happy path, serta final GET oversize/redirect/URL/MIME/
  body pendek/status gagal. **15 tes runner** lulus pada Miniflare + fetch stub; total seluruh
  suite **1.070 tes** (rerun final importer **103/103**), lint/typecheck/build lulus. Review PASS WITH NOTES,
  tanpa Medium/High tersisa; kapasitas remote tetap bukan jaminan. Runner hanya menerima
  profile `synthetic` dan seluruh flag
  otoritas tetap false. Audit referensi publik berikutnya menemukan tipe `params` resmi hanya
  string, sementara compiler v1 masih mengirim angka/null; REST batch juga tidak memiliki jaminan
  rollback tertulis seperti Worker `DB.batch()`. Kandidat v1 belum sesuai kontrak tipe publik;
  penerimaan aktual belum diuji. Desain transport string JSON versi baru dicatat di plan, belum
   diimplementasikan pada saat audit. Compiler/mock/adapter **v2 kemudian selesai secara lokal**:
   satu string JSON kanonik per statement, SQL `json_extract` memulihkan tipe, guard params kosong,
   dan metadata `changes` bukan bukti commit. **107 tes importer lulus**; bersama grup aplikasi
   yang tidak berubah total validasi **1.074 tes**, dijalankan per grup (bukan satu `npm test`
   final). Lint/typecheck/build lulus; review PASS WITH NOTES tanpa Medium/High. SQLite lokal
   mempertahankan null, safe integer, NIP leading-zero dan seluruh row; fault rollback tetap lulus.
   Belum ada eksekusi client pada layanan nyata, penerapan ledger remote,
  credential nyata, CLI importer atau operasi remote baru. `readyForImport:false` tetap.
   Harness `d1-v2-proof.mjs` kemudian tersedia untuk target sintetis yang diasumsikan disiapkan
   terpisah (schema/seed/ledger bootstrap state 0; target remote belum disiapkan atau diverifikasi).
   **7 tes harness lulus**, paket importer **114/114**, full `npm test` final **1.081 tes lulus**.
   Di Miniflare + REST stub, jalur normal memakai 11 send + 12 read lewat adapter/reader yang sama,
   tanpa membuat database/schema, menyentuh R2 atau cleanup. Review runtime **PASS WITH NOTES**,
   tanpa temuan material. Perbandingan state mencakup ledger + tujuh tabel import, bukan seluruh
   database; penyebab error provider tidak terverifikasi. Status observasi sintetis lokal tidak
   memberi izin dan bukan bukti remote.
   Alur dipadatkan kemudian disetujui: target proof remote baru `sikap-import-proof-20261018`
   dibuat di account yang sama tanpa perubahan binding aplikasi. UAT lama diinspeksi read-only
   dan masih berisi fixture/sesi, sehingga tidak dipakai untuk menimpa data. Gate request baca
   adapter sebelum setup kemudian lulus pada layanan nyata. **Proof remote lulus**: 94 request,
   67 setup statement, 11 langkah send + 12 read, fault state tidak berubah dan lost response
   committed teramati tanpa resend. Database proof beserta row sintetisnya dipertahankan, tidak
   dipakai ulang untuk data nyata. Kompatibilitas key document/photo dan WEBP kemudian selesai
   lokal, memakai satu adapter upload; runner 19/19 dan R2 17/17 lulus, review PASS. Full suite
   final **1.094 tes** (importer **127**) lulus. Gate otorisasi real-data UAT belum diimplementasikan.
   Target baru `sikap-import-uat-20261018` dan bucket `sikap-import-uat-20261018-files` dibuat tanpa
   binding app. Plan privat ditransform ulang dengan pepper UAT: 46 pegawai/akun, 63 arsip,
   66 file, nol error; snapshot tetap non-atomic dan hanya untuk UAT. Credential S3 bucket-scoped
   belum tersedia, sehingga upload/import belum dijalankan. Belum ada import PII, cleanup,
   perubahan binding atau deployment.
   Pada checkpoint sebelum import file, GAS tetap operasional dan Cloudflare masih pilot privat sintetis.
   Proof D1 remote sudah lulus; import UAT, pepper/access dan rekonsiliasi masih terbuka.
- Gerbang pada checkpoint sebelum percobaan import: proof remote dan persetujuan alur UAT sudah tersedia. Import masih menunggu
  credential S3 bucket-scoped, gate real-data terikat plan/target, setup serta pemeriksaan
  schema/reference/empty target UAT baru. Pepper/access dan rekonsiliasi wajib lulus sebelum
  UAT dibuka; export final dari sumber beku dengan pemeriksaan awal/akhir, smoke test dan
  keputusan cutover tetap terpisah.

**Checkpoint sebelum pemulihan:** credential R2 pada `.dev.vars` sudah terbaca; GET signed read-only
diterima. Gate real-data, adapter permit dan runner UAT sudah diimplementasikan lokal; driver
memvalidasi plan serta 66 file pada `--check-only` tanpa HTTP. Import **ditahan** karena tes
operator yang tidak terisolasi sempat menggunakan dependency nyata: target UAT baru kini
memiliki 10 tabel/11 index parsial, semua tabel yang ditemukan nol row. Bug fallback argumen
`null` telah diperbaiki; exported API kini mewajibkan seluruh dependency tanpa default I/O nyata.
Review isolasi PASS dan tujuh tes tiruan final lulus. Read-only GET pada seluruh
66 key file tujuan menghasilkan 404, sehingga belum ada file manifest terunggah. Tidak ada
cleanup/retry/pelanjutan setup otomatis, binding atau deployment. Detail insiden/pemulihan
dicatat pada `MIGRATION_PLAN.md`.

**Setelah persetujuan pemulihan:** reset target UAT baru berhasil diverifikasi (0 user object,
UUID tetap; R2 tidak disentuh). Setup lengkap 67 statement kemudian lulus, tetapi import
berhenti pada upload R2 ke-55 dengan hasil ambigu. Observasi independen read-only menemukan
55/66 file cocok SHA/MIME/ukuran, 11 belum ada, tanpa mismatch; file ke-55 ternyata tersimpan.
D1 pegawai/akun/arsip/riwayat/log/journal masih nol dan receipt ordinal 0. Tidak ada D1 chunk
dikirim. Driver fresh tidak boleh diulang; tidak ada retry, cleanup atau overwrite. State parsial
ini memerlukan pemulihan terkontrol yang mempertahankan 55 file benar dan hanya mengirim 11 file
yang terbukti belum ada. Import belum selesai dan app belum diarahkan ke target ini.
**55 file dokumen/foto pegawai nyata (PII) kini tersimpan di bucket privat
`sikap-import-uat-20261018-files`; row aplikasi D1 belum diimpor.** Pernyataan sebelumnya bahwa
belum ada upload PII/hanya pilot sintetis adalah status historis sebelum percobaan ini.
Implementasi pemulihan terkontrol belum tersedia. Persetujuan reset 12:37 sudah dilaksanakan
dan bukan izin reset/cleanup berikutnya; jangan ulang driver fresh atau menghapus file yang cocok.
Verifier independen yang direview PASS kemudian menghasilkan `UAT_IMPORT_INCOMPLETE`: schema,
reference dan seluruh row sesuai prefix ledger ordinal 0/157, tanpa FK violation/query mismatch;
55 file verified dan 11 `OBJECT_MISSING`, seluruh 67 request read-only. Ini bukan import selesai.

**Kelanjutan disetujui 13:09 UTC:** recovery terpisah sedang diimplementasikan untuk receipt
ordinal 0. Seluruh 66 object harus diperiksa terlebih dahulu; hanya 404 yang boleh mendapat PUT
create-only, sedangkan 55 file cocok dipakai ulang. Tidak ada reset schema, cleanup, overwrite
atau advanced D1 resume. Eksekusi menunggu tes dan review recovery lulus.

**Checkpoint final recovery:** tes/review lulus, kemudian recovery menghasilkan
`COMPLETE_UAT_RECONCILED`: 55 file dipakai ulang, 11 diunggah create-only, seluruh 157 chunk
D1 committed tanpa resend. Verifier independen read-only menghasilkan **`UAT_IMPORT_VERIFIED`**:
46 pegawai, 46 akun, 63 arsip, 125 riwayat, 414 log, journal 157; **66/66 file nyata cocok
SHA/MIME/size**, nol FK violation/query mismatch. Data nyata (PII) kini berada di D1/bucket UAT
privat, bukan hanya file. Pada akhir recovery ini aplikasi belum dibinding/deploy; lihat
checkpoint aplikasi UAT berikutnya untuk deployment yang sudah selesai. GAS tetap
operasional. Snapshot ini UAT-only/non-atomic, bukan izin cutover produksi. Jangan menjalankan
driver fresh/reset/recovery ordinal-zero lagi pada target yang sudah ordinal 157. Detail pin,
request count dan batas bukti tercatat pada `MIGRATION_PLAN.md`.
Regresi pasca-recovery: 161 tes library/recovery lulus melalui daftar eksplisit, ditambah grup
API/web/migrasi offline/staging yang tidak berubah; lint, typecheck dan build lulus. Ini bukan
klaim full `npm test` pada operator historis yang pin snapshot lamanya sengaja dipertahankan.

**Checkpoint aplikasi UAT:** aplikasi sekarang sudah dideploy ke
**https://sikap-uat.pages.dev**, memakai D1 `sikap-import-uat-20261018` dan bucket file import.
Deployment `08ccdbc2-7ab3-4533-8bb2-90eded79b485` berhasil; BACKUPS lama dilepas, Access tetap
required, dan secret encrypted tetap tersedia tanpa diganti. **39/39 probe anonim** pada
root/branch/hash deployment tetap challenge Access. Verifier sesudah deploy tetap
`UAT_IMPORT_VERIFIED` dengan **66/66 file** serta seluruh row cocok.

Full suite final **1.143 tes lulus** (400 API, 152 web, 196 migrasi, 224 staging, 171 importer),
lint/typecheck/build lulus; review binding PASS WITH NOTES tanpa temuan material. Driver import
dan recovery kini retired/fail-closed sebelum credential atau HTTP karena app sudah dibinding.
Tidak ada reset, migrations apply atau import ulang pada DB yang kini dipakai app.

**Smoke operator lulus — konfirmasi 18 Oktober 2026, 20:42 UTC:** login, dashboard, dokumen
dan logout berhasil. Bukti ini dilaporkan langsung operator, bukan dijalankan ulang oleh agen.
Login berhasil mendukung kesesuaian pepper runtime dan sesi untuk akun yang diuji; peran akun,
angka dashboard, status HTTP health, rincian file dan isolasi antar-role tidak disebutkan,
sehingga tidak diklaim teruji. Tidak ada password atau token yang diminta/dicatat.

Login/logout dapat mengubah sesi, log, rate limit dan metadata akun. Hasil rekonsiliasi exact
sebelumnya adalah baseline **sebelum smoke**, bukan klaim database tetap byte-identik sesudah
pemakaian aplikasi. Tidak menjalankan ulang import/reset untuk menghilangkan perubahan normal.
Ini UAT privat, **bukan cutover produksi**; GAS tetap operasional. Langkah berikutnya persiapan
cutover dengan export final dari sumber beku dan pemeriksaan awal/akhir, backup/rollback,
serta keputusan produksi yang eksplisit; bukan mengubah flag exporter menjadi konsisten.

**Persiapan cutover 21:01 UTC:** audit menemukan freeze GAS belum tersedia pada source lama.
Pengaman maintenance berbasis `SIKAP_CUTOVER_STATE` selesai lokal: 122 deklarasi fungsi diberi
guard, 20 tes VM/AST lulus, review PASS WITH NOTES. Full suite terbaru **1.163 tes lulus**;
lint/typecheck/build lulus. Guard belum deployed atau diaktifkan. Seluruh jalur GAS ditolak
selama freeze, termasuk direct RPC,
login/logout, preview self-heal dan trigger/helper yang menulis; writer eksternal dan eksekusi
lama tetap perlu dihentikan/drain oleh operator. Exporter selalu `consistent:false`; deklarasi
read-only bukan pengganti bukti sumber stabil. Jalur import UAT tidak boleh di-retarget ke
produksi. Belum ada freeze, resource/deployment/import produksi atau perubahan domain.

Rollback domain saja aman hanya sebelum target menerima write baru. Sesudah ada write di
Cloudflare, bekukan kedua sisi dan rekonsiliasi perubahan sebelum mengizinkan GAS menulis
kembali; jangan mengaktifkan dua writer. Jadwal freeze, backup/retention, target produksi dan
persetujuan go/no-go perlu ditetapkan sebelum operasi live.
Guard membaca property setiap function call; formatter berulang bisa menghabiskan quota
PropertiesService dan membuat state open gagal tertutup. Jenis account/quota aktual dan beban
property-read harus diukur pada sandbox sebelum deployment. Source/deployment live juga belum
dibandingkan dengan repo pada checkpoint persiapan tersebut. UAT tetap lulus; tidak ada freeze
atau perubahan produksi tahap ini.

**Audit read-only source live (21:35 UTC): jangan push `legacy-gas/src` saat ini.** Versi GAS
140/HEAD berbeda dari repo dan memuat hotfix keamanan yang belum ada pada tree lokal: helper
private, whitelist 40 action, lockout dan validasi upload. Live juga memiliki `Maintenance`
yang tidak ada di repo; file itu bukan guard freeze. HEAD berbeda dari v140 pada file tersebut.
Deployment versi 76 masih terdaftar dan tidak membaca flag cutover. Tidak ada push, deployment,
pemanggilan fungsi GAS atau perubahan property dilakukan pada audit ini.

Guard lokal 122 deklarasi beserta tesnya kini berstatus **prototipe pada baseline usang**, bukan
paket deploy. Port harus memakai baseline v140 serta mempertahankan hotfix, bukan menimpa live
dengan repo lama. Source clone disimpan privat pada TEMP di luar repo. Lihat hasil perbandingan
dan batas bukti deployment lama pada `MIGRATION_PLAN.md`; reachability versi lama dan trigger/
writer eksternal masih perlu verifikasi sebelum freeze.

VM pada prototipe lokal mengukur 22 property read per row (46 row = 1.012); admin-list 46 row
dengan authorization tiruan menghasilkan 1.022 read sebagai lower bound komponen. Ini bukan
benchmark quota/latency Google dan bukan pengukuran v140 live. Tes freeze/prototipe 23/23 lulus;
full suite lokal terbaru **1.166 tes lulus**, lint bersih. Hasil source audit dan pengukuran
menguatkan keputusan untuk tidak deploy tree lokal usang; langkah berikutnya port terisolasi
ke baseline v140, review, baru uji sandbox dengan jadwal/operator yang disetujui.

**Kandidat v140 — persiapan 22:03 UTC:** builder/verifier lokal sedang disiapkan untuk membuat
kandidat baru dari clone v140 privat, mempertahankan seluruh 41 file/hotfix dan menambahkan
guard hanya pada 43 entry point publik. Helper private tidak diberi pembacaan property per row.
Output tetap di luar repo, tanpa konfigurasi clasp/push, dan perubahan dapat dibalik menjadi
bytes baseline untuk pemeriksaan preservasi.

**Hasil kandidat:** builder dan verifier telah selesai, review **PASS/PASS WITH NOTES** tanpa
temuan material terbuka. Kandidat privat menghasilkan **`CANDIDATE_LOCAL_VERIFIED`**, 8 file
berubah hanya untuk 43 guard, 33 file raw-identik, 70 private asli tetap utuh. **130/130 cek VM**
lulus pada kandidat sebenarnya; 16 unit test tooling dan full suite **1.182 tes lulus**, lint
bersih. Ini hanya verifikasi lokal, bukan tes open-state semua fitur, quota Google atau freeze
live. Belum ada push/deployment/aktivasi property. Langkah berikutnya sandbox Apps Script
terisolasi yang disetujui, inventaris writer/trigger dan penanganan versi 76 sebelum window.

### Sandbox guard cutover sintetis — riwayat persiapan dan hasil operator

Paket sandbox selesai diimplementasikan dan diuji lokal untuk menguji helper guard yang sama
pada project Apps Script standalone baru. **30/30 tes baru lulus** (19 harness, 11 generator),
termasuk ACL Windows/penulisan eksklusif/receipt-last dan fault ownership property. Regresi
per grup persiapan **1.212 tes lulus**; lint/typecheck/build/whitespace lulus. Setelah permintaan
lanjutan, paket operator aktual berhasil dibuat lokal pada checkpoint berikutnya; eksekusi
Google belum dilakukan pada checkpoint pembuatan tersebut; hasil operator berikutnya dicatat
di bawah. Review source generator/harness **PASS WITH NOTES**, tanpa
Critical/High/Medium; ini bukan review integritas paket operator aktual. Paket ini **bukan salinan aplikasi v140**: 43 direct stand-in dan 40 handler
sintetis hanya merepresentasikan bentuk pemanggilan. Tidak ada akses spreadsheet/Drive, data
pegawai, deployment web app, trigger atau konfigurasi clasp.

**Sebelum eksekusi Google:** pastikan project baru khusus sintetis, account yang dipilih dan
identitas project sudah ditetapkan. Jangan menjalankan di project operasional, project bound
spreadsheet, salinan source v140 atau project yang punya property/data lain. Jangan menjalankan
dua rehearsal bersamaan atau mengedit properties saat run berlangsung.

Prosedur ini tidak memberi izin freeze/deploy produksi. Eksekusi Google memerlukan keputusan
operator pada project/account sandbox yang telah dipastikan, bukan memakai identitas project
operasional. Pada checkpoint persiapan belum ada eksekusi Google; jangan menganggap prosedur
berikut sebagai instruksi mengulang run yang kini sudah dilaporkan selesai.

**Paket operator 19 Oktober:** generator menghasilkan `SANDBOX_HARNESS_READY_LOCAL`, tepat
3 file di folder privat lokal yang lokasinya diberikan kepada operator, di luar repo. Hash
rendered harness `539f0c04fb0216c63f887ab147386f03eb0aa836125920f471c50b133e3f5ca1`, receipt
`cf263193ef264c970562e8961791279e3f714836e708d59c6b489b1f3d709813`. Tidak ada nonce atau script
ID dicatat di sini. Verifikasi independen paket aktual **PASS**: ACL parent/paket privat,
tepat tiga regular file, helper/hash/receipt dan manifest rendered cocok byte-identik;
30/30 tes target lulus ulang. Ini bukan bukti runtime Google. Jangan generate ulang folder
paket ini atau memindahkannya ke repo.

Prosedur operator historis (run dilaporkan selesai; **jangan ulang otomatis**):

0. **Paket operator sudah dibuat; lewati langkah generate ini untuk paket tersebut.** Untuk
   pembuatan paket baru yang memang diputuskan terpisah, parent harus privat/sudah ada di luar
   repo dan output harus baru:


   ```powershell
   node scripts/migrate/prepare-gas-cutover-sandbox.mjs --out "<path absolut folder baru>"
   ```

   Output tidak ditimpa dan kegagalan meninggalkan artefak parsial, tanpa cleanup otomatis.
   Jika gagal, hentikan; jangan melonggarkan ACL. Receipt dibaca lokal saja untuk memperoleh
   nonce konfirmasi, bukan diunggah ke Apps Script/chat/repo. Stdout hanya kode/hash/counts.
1. Buat project standalone baru bernama `SIKAP Cutover Guard Sandbox SYNTHETIC` di Apps Script.
   Jangan membuat version/test deployment/deployment, memasang trigger/library/Advanced Service,
   menghubungkan Sheets/Drive atau memakai clasp. Jangan mengedit `appsscript.json`.
2. Buat file editor manual dan tempel hanya `Cutover.gs` dan `CutoverSandboxHarness.gs` dari
   output privat generator secara verbatim. Jangan menyalin receipt/source aplikasi lain,
   memformat otomatis, mengubah manifest/hash atau mengganti runtime V8. Hapus `myFunction`.
   Jika pemeriksaan helper hash gagal, hentikan dan catat kode saja; jangan melewati pin.
3. Pasang satu Script Property `SIKAP_CUTOVER_SANDBOX_CONFIRM` bernilai
   `NEW-SYNTHETIC-SANDBOX:<nonce dari receipt>`. `SIKAP_CUTOVER_STATE` harus tidak ada.
4. Untuk menjalankan entry privat dari editor, tambahkan file sementara `TmpRun.gs` **hanya di
   sandbox** berisi wrapper berikut. Ini satu-satunya tambahan sementara selain dua file paket.
   Pilih dan jalankan `tmpCutoverSandbox`, lalu hapus `TmpRun.gs` setelah run. Jangan membuat
   wrapper di project operasional atau menerbitkannya.

   ```javascript
   function tmpCutoverSandbox() {
     runCutoverSandboxRehearsal_();
   }
   ```

5. Catat prompt yang benar-benar muncul; jangan mengasumsikan tidak ada authorization.
   Batalkan permintaan scope tambahan seperti `script.scriptapp` (trigger), `script.send_mail`,
   `script.external_request`, Drive/Sheets/Gmail atau email pengguna. Paket hanya memakai Script
   Properties, `ScriptApp.getScriptId()`, digest dan log; jangan menambah izin agar check lulus.
6. Simpan hanya ringkasan JSON teredaksi dari execution log pada folder privat. Jangan menyimpan
   screenshot/editor URL yang memuat account atau script ID. Hanya `CUTOVER_SANDBOX_PASSED`
   dengan restore berhasil yang merupakan pass. Kode lain berarti berhenti, bukan retry otomatis.
   Periksa di Project Settings bahwa `SIKAP_CUTOVER_STATE` kembali tidak ada. Bila restore gagal,
   jangan reset properties; inspeksi privat dahulu. Hapus key state secara manual **hanya pada
   sandbox yang dipastikan milik run ini**, bukan nilai yang berubah di luar run.
7. Biarkan project, konfirmasi, pin dan output privat tetap ada untuk audit. Penghapusan bukan
   bagian run. Repeat run mengharuskan hanya key konfirmasi+pin dan state tetap tidak ada.
   Jangan membaca/mengatur state pada project produksi/v140 sebagai bagian tahap ini.

Pembacaan property yang gagal/non-string dan jumlah read tepat tetap bukti VM lokal, bukan
fault yang sengaja disuntikkan ke layanan Google. Hasil Google tidak membuktikan quota
produksi, HTTP/RPC web app, deployment v76, private editor/writer atau drain eksekusi.

**Konfirmasi operator — 19 Oktober 2026, 04:34 UTC:** rehearsal pada project standalone baru
`SIKAP Cutover Guard Sandbox SYNTHETIC` dilaporkan lulus di Google nyata:
`CUTOVER_SANDBOX_PASSED`, `stateAbsentAfterVerified:true`, **1.162/1.162 checks**, termasuk
**996 penolakan tanpa efek samping**, **14/14 state**, **7/7 no-cache**. Ini laporan operator,
bukan verifikasi remote independen; ringkasan JSON privat belum dibaca agen. Angka rehearsal
bukan jumlah suite regresi lokal 1.212 tes.

Operator melaporkan hash kedua file cocok sebelum run/setelah reload, tanpa izin tambahan,
receipt upload/deployment/trigger/clasp. `TmpRun.gs` sudah dihapus, state absent, konfirmasi+pin
dipertahankan. Deviasi tercatat: harness bernonce melewati konteks operator setelah jalur
localhost ditolak dan server dilaporkan dimatikan; helper sempat kosong lalu dipulihkan dan
hash final dilaporkan cocok. Ini bukan bukti integritas kontinu atau bahwa nonce hanya di disk.
Jangan kirim nonce/script ID/account atau menyalin ringkasan privat ke repo. Detail audit ada
di MIGRATION_PLAN. Tidak ada rotasi/reset/cleanup otomatis dari laporan ini.

**Berhenti pada checkpoint ini.** Jangan ulang run/generate paket, mengubah sandbox atau
membekukan GAS produksi. Gate rehearsal helper lulus menurut operator; fitur v140, quota,
UNAVAILABLE/non-string/read-count, deployment lama dan drain tetap di luar buktinya.
Operasional tetap GAS; inventaris writer/deployment, backup/rollback dan window memerlukan
keputusan terpisah sebelum tindakan produksi.

### Inventaris writer/deployment sebelum window

**Kelanjutan 19 Oktober, 05:29 UTC:** tahap berikutnya disiapkan sebagai checklist read-only
W01–W15 dan keputusan D01–D11 di `MIGRATION_PLAN.md` pada bagian **Inventaris deployment/writer
dan rencana window**. Pada checkpoint persiapan seluruh bukti live masih **UNKNOWN**;
pembaruan W07 di bawah merupakan pengecualian metadata saja, gerbang tetap **NO-GO**. Tidak ada
freeze/deploy/penutupan v76 atau shutdown trigger yang boleh dilakukan dari checklist ini.
Tidak ada script baru: UI serta attestation lintas account diperlukan, bukan helper produksi.

**Observasi metadata API 19 Oktober, 06:00:31 UTC (14:00:31 WITA):** satu panggilan read-only
clasp 3.3.0 menemukan tiga entri: **HEAD tanpa nomor**, **v140**, **v76**. W07 terverifikasi
hanya untuk daftar metadata pada waktu tersebut. Belum memeriksa source, execute-as/access,
route produksi, penggunaan URL lama atau trigger. Tidak memanggil handler GAS. v76 masih
terdaftar; ini bukan bukti URL tersebut aktif ataupun sudah ditutup. Detail suffix/batas bukti
di MIGRATION_PLAN. Bukti W08/W09 dan writer lain tetap UNKNOWN; tidak ada perubahan deployment.

Urutan operator paling dekat, hanya melihat tanpa Save/Deploy/Archive atau perubahan izin:
Jangan membaca nilai Script Properties, menjalankan fungsi editor/handler, menambah helper
inspeksi produksi atau mengunggah screenshot mentah. Membuka Sheet/Form dapat menjalankan
onOpen/installable open trigger; lihat Share/Details dari Drive tanpa membuka container dan
metadata project dari daftar Apps Script. Jika tidak cukup, tandai PARTIAL. Pembukaan container
memerlukan review risiko/persetujuan operasi terpisah, bukan asumsi read-only.

1. Lengkapi enum execute-as/access per deployment dari Manage deployments; daftar versi API
   06:00:31 UTC saja belum mencakupnya. Audit 18 Oktober hanya pembanding historis. Jangan memanggil
   URL handler lama untuk menguji reachability; request dapat menulis.
2. Petakan seluruh owner/editor script, sheet, folder/parent/shared-drive dan writer eksternal.
   Laporkan count/role dengan label account anonim; daftar identitas lengkap tetap privat.
3. Minta setiap account pembuat trigger memeriksa Triggers/My Triggers. Account yang hilang
   dari cakupan membuat hasil PARTIAL, bukan nol trigger global. Sertakan simple/bound trigger,
   Forms/AppSheet/script lain, job dan penggunaan editor/private helper.
4. Periksa jenis/status/fungsi di Executions untuk periode yang disebutkan dan batas visibilitas.
   Tampilan kosong tidak membuktikan drain dan tidak mengatribusi trafik ke v76.
5. Pastikan route domain/Pages/proxy GAS melalui control plane, termasuk URL lama dan pipeline
   CI/clasp/Git integration/hook. Workflow migrasi lokal hanya test/build; remote main dan
   automasi di luar repo belum diperiksa. Jangan kirim nilai secret/Script Properties.

Format ringkasan aman:
```text
Wxx | UNKNOWN/PARTIAL/ATTESTED/VERIFIED/N/A(alasan) | waktu UTC/WITA |
label account/role | counts/enum | cakupan/batas | disposition direncanakan
```

Keputusan berikutnya: window WITA/UTC dan pemilik go/no-go, disposition v76/trigger/editor,
backup **byte dokumen/foto + sheet** dengan restore-test, target/capability produksi baru,
custodian pepper/key, notifikasi WhatsApp, serta rollback sebelum/sesudah write pertama target.
Jangan menganggap login/smoke tidak menulis; sesi/audit dapat menjadi write target pertama.
Rencana freeze/drain bukan bukti drain selesai, dan checklist lengkap bukan izin operasi.
Persetujuan dipisah: A operasi persiapan/deploy, B mulai maintenance, E export/import setelah
bukti drain+backup sumber beku, C go-live. W12-plan/W13-ready harus direview sebelum B;
W12-drain/W13-final dibuktikan aktual sesudah B untuk E, bukan ditandai selesai sebelum freeze.
Creator trigger yang tak terjangkau tetap gap; penutupan lewat mitigasi resource-level memerlukan
review/tindakan disetujui dan bukti cakupan, bukan sekadar menghapus editor/guard public. Jika
tidak dapat dibuktikan, tetap NO-GO. D11 dapat diisi HOLD privat eksplisit, bukan dibiarkan
UNKNOWN atau digunakan untuk melewati gate lain.
Tidak ada inspeksi remote atau perubahan live dilakukan pada persiapan checklist ini.

### Serah-terima setelah gerbang A — 20 Oktober pagi WITA

Pemilik melaporkan deployment guarded **v141**, URL utama tetap, v76 diarsipkan, sharing
link-editor sheet/Form ditutup, CI/clasp grant/auto-deploy dihentikan. Resource produksi baru
`sikap-import-prod-20261020` dan Access
`sikap-v2` dilaporkan disiapkan; kode driver/gate tersedia dengan pin PENDING gagal-tertutup.
Status live tersebut adalah laporan serah-terima, tidak diperiksa ulang dari sesi ini;
pembuatan resource/Access merupakan operasi remote, bukan penulisan data aplikasi oleh importer.

**B/E/C belum diberikan, NO-GO tetap.** Pada checkpoint serah-terima belum ada izin membaca
runbook privat (read-only berikutnya dicatat pada bagian review di bawah). Jangan menjalankan
driver, mengisi pin dari snapshot lama, membaca secret atau mencoba clasp setelah grant dicabut. Review lokal
independen driver/gate belum menyatakan siap. Tes target lokal **16/16 lulus** (driver 10,
gate 6) membuktikan PENDING berhenti sebelum credential/HTTP, bukan happy path produksi.
Rehearsal driver/pepper proof/app
binding serta W12-plan/W15 belum selesai. Kegagalan staging yang dilaporkan perlu diagnosis,
bukan diasumsikan unrelated. Runtime pin review/rehearsal diselesaikan sebelum B; pin plan
final baru setelah freeze/export final untuk E, tanpa membuka PENDING demi tes.

Maintenance HEAD dengan `tmpRevoke`/`tmpCheck` ikut v141 menurut laporan. Nama public tanpa
suffix `_` tidak boleh dianggap editor-only; coverage/jalur pemanggilan perlu review source
terikat versi tanpa probe live. Memilih v140 untuk rollback juga melepas guard: jangan lakukan
ketika freeze bergantung padanya tanpa isolasi writer dan keputusan rollback yang sesuai.
Review driver independen **CHANGES REQUIRED**: budget request dapat habis setelah write,
scan binding tidak lengkap, dependency pin kurang, lifetime credential belum cocok run,
CLI bare menjadi write setelah unpin dan happy path orchestrator belum diuji. Pin PENDING
masih menahan write sekarang; **jangan diisi/dilewati** sampai koreksi+tes+review selesai.
Retirement UAT juga perlu stop permanen, bukan bergantung config/pin yang dapat diperbarui.
Lihat checkpoint serah-terima/hasil review di MIGRATION_PLAN; tidak ada operasi lanjutan
produksi otomatis atau kode runtime diperbaiki dalam sesi audit ini.

### Koreksi lokal importer — checkpoint selesai 20 Oktober

Temuan driver pada checkpoint sebelumnya kini ditangani lokal: lima driver UAT lama termasuk
reset/verifier selalu STOPPED_RETIRED sebelum options/I/O, CLI produksi memerlukan flag write
`--import-production` eksplisit (no-args exit 2), pin transitif/inventory config bounded/budget
request dan lease preflight ditambahkan. Credential dibaca sebagai snapshot data-only frozen;
getters dan reference mutation tidak dapat mengubah header/window setelah validasi.

**Validasi:** importer **204/204 lulus**, termasuk 30 unit driver/orchestrator/gate dan 4
rehearsal orchestration dengan Miniflare D1 + fake R2. Happy path sintetis **93 request** tepat
budget (3 file/3 chunk); check-only nol credential/HTTP, R2 conflict sebelum DDL, fault setup
pre-commit tanpa resend. Bukan rehearsal remote atau bukti commit-then-loss setup. API400,
web152, migrasi265 dan staging224 lulus per grup; lint/typecheck/build/whitespace lulus. API
run awal hang; rerun bounded 400 lulus tanpa pembuktian akar hang. Review final **PASS WITH
NOTES**, tanpa Critical/High/Medium; 4 Low gap pengujian tetap tercatat di MIGRATION_PLAN.

**Jangan menjalankan driver atau mengisi pin dari checkpoint ini.** Semua runtime/plan pin
produksi masih PENDING dan NO-GO B/E/C tetap. **Lease adalah blocker live:** contoh estimasi
historis 807 request ditolak cap 4 jam pada timeout 30 detik, bukan hasil plan final. Credential
berumur pendek juga gagal; perlu keputusan desain/review, bukan override agar lolos. Inventory
lokal tidak membuktikan binding dashboard/absence writer. Profile rehearsal hanya fixed target
sintetis/fake I/O terinjeksi, tidak tersedia lewat CLI dan tidak memberi authority produksi.

Langkah berikutnya: review snapshot source v141/wrapper dan runbook privat yang diizinkan,
W12/W15/backup-secret custody, desain credential/lease dan runtime pepper proof terisolasi.
Deploy/secret install/rehearsal remote memerlukan scope persetujuan tersendiri. Tidak ada
remote/private data/secret diakses, resource diubah atau commit/push pada koreksi lokal ini.

### Review source historis dan runbook privat — 20 Oktober, 05:28 UTC

Read-only review selesai, **CHANGES REQUIRED** sebelum usulan B. Runbook privat masih draft
sebelum A: status deployment/target usang; writer register, guard proof, drain/queue/fingerprint,
backup sumber beku, UTC/WITA window/abort/notifikasi dan rollback/custody belum operasional.
Runbook asli tidak diubah dan tidak boleh dipakai sebagai izin maintenance. Tiga backup owner
sebelum freeze tidak membuktikan W13-final setelah drain. Smoke privat pun dapat menjadi first
write target sebelum C; domain move bukan otomatis titik write pertama.

AST/hash source audit historis mengonfirmasi:
- HEAD: **45 public, 0 guarded**; v140: **43 public, 0 guarded**.
- Kandidat v140: **43 public, 43 first-guard**, 12 file, parse bersih.
- `tmpRevoke`/`tmpCheck` hanya ada sebagai public wrapper pada HEAD, tanpa guard. Yang pertama
  mengubah sharing Drive/Script Properties; yang kedua membaca+log metadata, bukan write Drive.
- Hapus tepat kedua wrapper + satu blank line dari Maintenance HEAD menghasilkan byte-identik
  kandidat. Ini bukti patch potensial kecil, **bukan perubahan yang telah dilakukan**.

**Snapshot exact v141 belum tersedia** pada lokasi yang ditemukan. Jika Maintenance HEAD ikut
v141 sesuai laporan owner, coverage conditional hanya 43/45; belum boleh menyatakan jumlah
tersebut terverifikasi remote. Dua nama tanpa suffix `_` tidak terbukti editor-only meski tidak
ada di whitelist doPost; HtmlService/RPC perlu diperhitungkan. Tidak ada probe live dijalankan.
Private maintenance helpers tetap writer yang harus diisolasi/prosedur owner selama freeze.

Langkah berikutnya: snapshot source+manifest terikat versi 141 melalui jalur privat/read-only
yang disetujui owner; lalu review pilihan scope A tambahan (hapus wrapper permanen atau perluas
guard+tes). Revisi runbook diperlukan, tetapi tidak dibuat/diedit di scope read-only ini.
Referensi runtime Google umum 6 menit/execution bukan bukti drain cukup 6 menit; queue/writer
lain harus tercakup. Keputusan lease/credential importer juga tetap blocker live.
**NO-GO B/E/C, pin PENDING tetap.** Tidak ada secret/data pegawai/API account/control plane
diakses atau perubahan GAS/deploy/freeze/import/cleanup/commit/push pada review ini. Hanya
dokumentasi Google resmi publik diambil melalui web; yang dibaca privat hanya catatan
operasi dan source backend historis yang diizinkan.

### Revisi runbook privat — 20 Oktober, 06:32 UTC

Catatan sebelumnya "runbook tidak diubah/belum diedit" adalah riwayat review sebelumnya;
revisi ini menggantikannya. Runbook existing kini direvisi lokal: bagian awal riwayat, bagian 4–12 memuat
register writer, guard/drain/fingerprint/backup/rollback dan kartu approval. Nilai window,
abort, N/interval observasi, metode proof dan custody yang belum diputuskan tetap UNKNOWN.
E-export dipisah dari subapproval E-import atas artefak final; tidak ada import otomatis.
Pemisahan ini menggantikan penyebutan kartu E tunggal pada checkpoint historis di atas.
Snapshot v141 tidak ditemukan pada pemeriksaan filename terbatas folder inventaris;
blocker lease/credential tetap. **Draft bukan
izin B; NO-GO B/E/C dan semua pin PENDING tetap.** Review kualitas runbook final
**PASS WITH NOTES**, tanpa Critical/High/Medium; owner decisions tetap UNKNOWN. Runbook
mewajibkan source tetap frozen tanpa interupsi export→import serta fingerprint pre-import
cocok post-export; reopen menginvalidasi backup/export/transform/plan/pins untuk run baru,
tanpa cleanup otomatis. Hash raw final tercatat di MIGRATION_PLAN; tes runtime tidak diulang.

Langkah operator berikutnya, scope read-only saja:
1. Pastikan project operasional secara privat. Coba periksa riwayat/project history **bila**
   UI menyediakan content source yang eksplisit berlabel versi **141**, bukan HEAD editor.
   UI dapat menulis: gunakan hanya untuk melihat, jangan Restore/copy-to-HEAD atau tindakan
   lain yang mengubah project. Ketersediaan tampilan exact-version belum dipastikan.
2. Bila UI tidak menyediakan content exact-version, **berhenti dan laporkan gap**. Jangan
   login ulang clasp, membuat token/scope/API baru atau mengambil HEAD sebagai pengganti.
3. Jika tersedia, catat privat waktu, alias project, deployment suffix+versi dan asal source;
   salin semua source+manifest versi itu secara verbatim ke lokasi baru ber-ACL privat di luar
   repo. Jangan menimpa audit lama. Catat cara copy/encoding/line endings dan provenance;
   version binding copy UI tetap ATTESTED sampai bukti independen tersedia. Hash/AST lokal
   tidak otomatis membuktikan bytes Google. Rekonstruksi kandidat+HEAD bukan snapshot v141.
   Source bisa memuat ID/token hardcoded: jangan tempel ke chat/repo. Jika hanya satu file
   tersedia, laporkan cakupan parsial.
4. Jangan Save/Run/Deploy/Archive, membuka URL handler, Sheet/Form atau Script Properties.
   Kirim hanya lokasi privat artefak dan ringkasan asal/version/cakupan; hash/AST diverifikasi
   lokal sesudah artefak tersedia. Persetujuan snapshot tidak mencakup patch/deploy berikutnya.

Tidak ada pengambilan source UI/remote pada revisi ini. Yang diubah hanya runbook privat
existing dan checkpoint repo; tidak ada secret/credential/source GAS/resource/pin diubah.

### Bukti operator source v141 tersimpan — laporan 20 Oktober, 11:47 UTC

Laporan terbaru menggantikan status awal hash-only/artefak belum tersimpan: operator menyatakan
source+manifest versi 141 sudah disimpan privat, 42 file (41 source + manifest), hash42/42 cocok
serta ACL privat/read-only. Provenance UI version141 dan Maintenance dengan tmpRevoke/tmpCheck
adalah **ATTESTED**; review agent belum membuka source, bundle, evidence hash atau provenance
sesuai larangan operator. Tidak ada verifikasi independen ACL/hash/version-binding baru.

Salinan teks editor dapat menormalkan EOL; hash lokal tidak membuktikan byte server Google.
Manifest ada menurut laporan, tetapi belum dianalisis; access/execute-as, properties, trigger
dan data tetap di luar bukti. Coverage45/43 memperkuat laporan operator, bukan full W11 VERIFIED.
Pengambilan source oleh operator telah dilaporkan selesai; prosedur UI di atas kini historis,
**jangan ulang otomatis**. Tidak ada raw source/manifest diunggah ke chat/repo.

Scope berikutnya memerlukan izin eksplisit validasi lokal non-disclosing pada artefak privat
jika hendak dibuka untuk AST/hash; lokasinya tidak dianggap izin mengabaikan larangan akses.
Sesudah validasi tepat 45/43 dan review, patch lokal minimum+tes tetap memerlukan penugasan/
izin eksplisit terpisah, bukan otomatis. Perubahan/deploy GAS masih
scope A terpisah, belum diizinkan. Lease/custody/runtime pepper/W12/W15 juga tetap blocker.
**NO-GO B/E/C dan pin produksi PENDING**. Penerimaan ini hanya checkpoint repo; tidak ada
private artifact/secret/remote/patch/deploy/freeze/export/import/cleanup/commit/push dijalankan.

### Validasi lokal non-disclosing — permintaan 20 Oktober 12:21/12:24 UTC

Kelanjutan dibatasi pada pemrosesan byte artefak privat oleh alat untuk ACL/hash/AST, tanpa
menampilkan raw source/bundle atau menyalinnya ke repo/chat. Ini scope validasi berikutnya,
bukan pemberian izin patch/deploy. Catatan sebelumnya belum membaca artefak adalah riwayat
penerimaan, bukan klaim bahwa tool tidak memproses bytes pada validasi ini. Hasil artifact
lokal **LOCAL_VERIFIED dengan catatan**: 42 file bundle↔disk byte-match serta evidence raw/LF
42/42, AST seluruh12 `.gs` **45 public/43 first-guard**, unguarded tmpRevoke/tmpCheck, handler40.
Provenance UI dan binding deployment ke Google tetap ATTESTED.45/43 mengonfirmasi gap
coverage dua fungsi tanpa guard: **full freeze coverage tetap CHANGES REQUIRED**. Tidak mengeksekusi GAS atau memakai clasp/credential/probe handler.
Normalisasi LF tidak boleh disamakan raw bytes; inverse-wrapper di memory bukan patch saved.
Tooling v140 16/16 dan driver/gate produksi 16/16 tes sintetis lulus terpisah; tidak memverifikasi
source v141. Suite migrasi penuh 265/265, lint/typecheck/build juga lulus; 16 tooling termasuk
265, bukan tambahan. Hash pin/tooling tidak berubah. Menyiapkan output patch lokal
memerlukan penugasan eksplisit baru setelah hasil actual tepat 45/43; deploy tetap A terpisah.
**Catatan digest:** bundle lokal751.809 byte dihitung SHA-256
`358df0721272e9529d2fbb825e0560bb272bcb171092f8777f0044573348a527`.
Prefix laporan chat cocok, tetapi suffix laporan chat `27a527` tidak cocok hasil `48a527`: tetap
PARTIAL_MISMATCH, jangan diasumsikan typo/korupsi atau diabaikan. 11 backend raw-match kandidat
(termasuk8 CRLF dengan baselineCRLF sama); MaintenanceLF berbeda karena dua wrapper, remove
span98ASCII di memory menghasilkan raw/LF match kandidat. Tidak ada patch disimpan.42/42
source+manifest readonly, provenance metadata writable; ACL/nlink/reparse check dilaporkan
lulus. Follow-up final: capnode10.000/45file, collision0, ADS tetap UNVERIFIED dan numeric
depthcap belum dirinci. Full digest bundle cocok record PROVENANCE (bukan signature Google);
evidence84hash hanya per-file, bukan bundle. Literal short digest laporan chat tetap beda,
tidak diasumsikan typo. Span98ASCII hanya dua wrapper+whitespace; inverse remove/insert di
memory mengembalikan raworiginal byte-exact. Bukan patch saved. NO-GO B/E/C dan semua pin
PENDING tetap; review hasil integritas lokal tidak menutup gap coverage atau blocker lain.

### Patch lokal minimum — permintaan 20 Oktober 13:36 UTC

Penugasan berikutnya kini mencakup kandidat patch lokal privat, bukan deploy. Builder khusus
mengikat input bundle+files terverifikasi, menghapus tepat dua wrapper Maintenance dan menyalin
41 file lain tanpa perubahan raw bytes. Komentar nama wrapper dipertahankan; pemeriksaan
menolak executable reference, bukan seluruh kata. Rincian trust/preservasi di plan.
Source original tidak disentuh; output baru write-once
privat di luar repo, receipt terakhir, tanpa `.clasp*` atau push config. Builder/tes direview
sebelum output aktual dibuat, lalu validator independen memeriksa inverse raw dan AST43/43.
Checkpoint awal implementasi/paket belum ada adalah riwayat. Builder+14 tes sintetis kini
tersimpan; parent rerun14/14 dan migrasi final279/279 lulus, eslint0. Source review aktual
**PASS WITH NOTES**, tanpa Critical/High/Medium (Proxy options ditutup).

Builder kemudian dijalankan sekali ke child privat baru, status **LOCAL_WRAPPER_REMOVAL_PREPARED**:
43 file total (42source+receipt),41source raw-identik, Maintenance98byte removal, postAST43/43
serta private71/handler40/EOL37CRLF5LF tetap menurut builder. Aggregate output
`c57e2ba8ba8af790a9a4bccbaa6fbcec9fa96baba5fe71a5d7c0bae171589be9`, receipt
`b5ac258658a7d66fbf92bd9194b08411827567a0cd6e1f6f8f9c2aba1f888374`.
Verifikasi independen kandidat actual kemudian **PASS lokal**: input bundle+42source tetap
cocok pin, output aggregate/receipt cocok hitung ulang,41raw-identik dan inverse delta98byte
raw-byte-exact, AST43/43/private71/handler40 serta EOL tetap. Paket **LOCAL_VERIFIED** untuk
transform lokal; receipt status bukan izin upload/deploy. ACL parent/output private, nlink1/
reparse0; ADS tetap UNVERIFIED. Google version/binding tetap ATTESTED dan W11 live belum tutup.
Original input cocok pin saat verifikasi, tidak mengklaim immutability kontinu.
Satu invocation `npm test` final **1.259 tes lulus** (400/152/279/224/204), 14 tes baru termasuk
migrasi279. Lint final, typecheck/build/whitespace lulus; warning API tetap tercatat di plan.
Tidak overwrite/retry/cleanup atau copy raw source ke repo/chat.

A perubahan HEAD/version/deploy Google tetap terpisah dan belum diizinkan; B/E/C NO-GO, semua
pin produksi PENDING. Patch wrapper tidak menutup private-editor writer, drain/backup/window,
lease/credential atau runtime pepper. Jangan menempel source/manifest ke chat/repo atau
menjalankan deployment dari paket lokal ini.

### Kartu release A tambahan — 20 Oktober 14:54 UTC, belum izin live

Kartu lengkap di MIGRATION_PLAN membedakan **A-read → A-save → A-version → A-repoint**.
Hanya bukti operator read-only yang menjadi langkah terdekat; tidak menjalankan Save/version/
repoint dari kata “lanjut”. Tidak ada remote atau private source baru dibaca pada penyusunan.

Operator mengumpulkan snapshot **HEAD terkini** (bukan Histori141) ke folder privat baru,
metadata Manage deployments (suffix/versi/execute-as/access) dan disposition caller/trigger
ke tmpRevoke/tmpCheck pada cakupan account yang diketahui. Tidak Save/Restore/copy-to-HEAD/
Run/Deploy/Archive, handler probe, Sheet/Form/properties, clasp atau scope/credential baru.
Jika UI/capture tidak cukup, STOP/PARTIAL. Raw source tidak dikirim chat/repo.
Bila salah Save/Restore/Run, efek live tak terduga, prompt izin baru atau HEAD/deployment
berubah saat capture: STOP, batalkan prompt, jangan resave/restore/undo atau memperbaiki
sendiri. Catat waktu UTC+state terlihat privat; status UNKNOWN sampai owner memutuskan
recovery. Tidak mengedit trigger/sharing atau melakukan rollback otomatis.

Hasil capture berikutnya diklasifikasikan setelah validasi lokal:
- MATCH_INPUT: seluruh42file raw cocok input terpin; baru dapat diajukan A-save, belum izin.
- MATCH_OUTPUT: HEAD sudah cocok kandidat; STOP/rekonsiliasi, jangan menambah ulang wrapper.
- OTHER_DRIFT: source atau metadata versi aktif/access/execute-as menyimpang; STOP, tidak overwrite.
- CAPTURE_INCOMPLETE/EOL ambiguity: PARTIAL, review diff/basis LF terpisah; jangan klaim raw match.

Sebelum A-write, owner menetapkan caller disposition, penanggung jawab, start/end+abort UTC/
WITA, transfer privat, recovery tiap tahap dan notifikasi atau keputusan dampak eksplisit.
Approval menyebut Save Maintenance saja, create version, dan repoint deployment sebagai write
terpisah bersyarat hasil checkpoint. 41file lain (termasuk manifest), property/akses/trigger/runtime/scopes/
URL tetap. Rollback v141 hanya dapat menjadi keputusan owner di luar freeze dengan menerima
gap wrapper; tidak memenuhi full coverage dan tidak diizinkan dari kartu ini. v140 tidak
guarded; jangan mengembalikan unguarded writer saat freeze diandalkan. Tidak membuat version
Google baru atau mengubah pin produksi dari kartu ini. B/E/C NO-GO tetap.

### Fresh HEAD dilaporkan — 20 Oktober 15:56 UTC, validasi belum selesai

Operator melaporkan snapshot HEAD kini privat (42 file termasuk manifest) dan metadata satu
deployment aktif141 pada waktu observasi terpisah. File tidak dipindahkan/ditimpa lagi karena
laporan menyatakan sudah dipindah dan unduhan lama dihapus operator. Koordinat tombol yang
tercantum bukan izin klik atau A-write. Tidak ada tindakan browser/remote di sesi ini.

Validator memproses bundle/files/evidence read-only non-disclosing untuk klasifikasi raw input;
provenance UI/deployment tetap ATTESTED. Bundle hash baru boleh berbeda dari v141 bila metadata
berbeda; kesamaan source hanya boleh dinyatakan setelah semua42 raw bytes/aggregate cocok.
Caller kode ABSENT berarti referensi caller di luar declaration tidak ditemukan, bukan dua
wrapper hilang. Dua editor run16Okt adalah historyPRESENT; trigger0 hanyaACC-A, sisanyaUNKNOWN.
Tidak menjalankan wrapper atau mengubah trigger. Capture source dan metadata terpisah84detik,
bukan bukti continuity/freshness sampai write; pre-write checkpoint tetap diperlukan.

Pada checkpoint penerimaan hasil belum dinyatakan; penutupan berikut menggantikannya.
MATCH_INPUT hanya mendukung proposal A-save, bukan approval Save/version/repoint. Owner perlu
window/abort/caller/recovery/transfer/notifikasi. B/E/C NO-GO, production pins PENDING; tidak
ada source/property/deploy/freeze/import/cleanup/commit/push dijalankan.

### Fresh HEAD lokal MATCH_INPUT — penutupan 20 Oktober 16:06 UTC

Validator memulihkan hasil task kosong dan menyelesaikan laporan: **PASS lokal/MATCH_INPUT**,
42/42bundle-payload↔disk raw-match,42raw+42LF evidence cocok,42file raw-identik v141/input
aggregate df1dbf9c…258c5c6. Bundle751.847byte SHA-256
`5b11204abbe9f0aab8427a5a4db41d8bceb98093160d089bff3b99d228797e7b`, prefix/suffix laporan
cocok; full64bundle record tidak ada di metadata, jadi jangan mengklaim fullrecord parity.
EOL37CRLF/5LF,712.335byte. AST45public43guard71private40handler, dua wrapper tetap tanpa guard.
Zero executable caller refs scopedsource/frontend, bukan global caller absence. Satu private
name duplicate `_formatDate_` dilaporkan; tidak ada public duplicate, kandidat tidak memperbaikinya.

ACL/tree/read-only diperiksa; source ADS0, bundle ADS `Zone.Identifier:$DATA`26byte ada dan
**tidak dihapus**. Hash bundle ialah main stream, bukan seluruh NTFS streams. Provenance UI,
metadata version/access/deployment tetap ATTESTED dan capture tidak membuktikan state live
saat release. Tidak ada move/overwrite atau raw source masuk chat/repo, no private-GASexecution.
Owner masih harus memutuskan A-write/window/abort/caller/recovery/transfer/notifikasi. Tidak
ada Save/version/repoint atau B/E/C disetujui; NO-GO, production pins PENDING tetap.

### Serah-terima Claude — HEAD sudah Save menurut operator, deployment belum release

Laporan20Okt±17:05UTC /21Okt±01:05WITA: hanya Maintenance HEAD diubah98byte, Save/reload
berhasil menurut operator. HEAD aggregatec57e2ba8…1589be9, Maintenance1d46eadf…eb21bec,
43public/43guard/71private;42file712237byte dan manifest/41filelainunchanged. Snapshotprivat
pasca-Save dilaporkan tersedia, belum dibaca/divalidasi independen pada update ini. Klasifikasi
HEADsaved tetap **ATTESTED**, bukan LOCAL_VERIFIED dari snapshotbaru.

**Active deployment tetap141**, no newversion/repoint. Dua wrapper tetap pada source version141;
klaim operator “tidak dapat dijangkau dari web” tidak dibuktikan. HtmlService/RPC surface bukan
ditiadakan oleh whitelistdoPost. HEAD Save dapat memengaruhi editor/dev/trigger HEAD terkait,
meski versionedwebapp masih141. B/E/C NO-GO, W11live belum tertutup, importpinsPENDING.

Panduan penerus lengkap ada di MIGRATION_PLAN “Serah-terima ke Claude” dan checkpoint terbaru
PROJECT_CONTEXT. Mulai dengan validasi snapshot pasca-Save **non-disclosing bila scope izin
dipastikan**, lalu A-version explicitlyapproved +verifikasi contentversion, baru A-repoint
explicitlyapproved dengan URL/access/execute-as tetap. Jangan membuat versi/repoint dari
handoff atau menamai versi baru142 sebelum Google menetapkannya. No rawsource chat/repo,
clasp credential baru, handlerprobe atau property mutation. Recovery/windowabort/caller
UNKNOWN harus diputuskan owner; tidak menganggap report meratifikasi approval lama.

Setelah release penghapusan wrapper (belum terjadi), tutup W12/W15/backupcustody/source-route-writer/leasecredential dan
appreadiness/runtimepepper. Contoh807request×30s melebihi lease4h; jangan membukaPENDING atau
menurunkan guardrail agar lolos. B maintenance/drain/backupfinal terpisah dari E-export dan
E-import terikatplanfinal; smoke privat dapat firstwrite sebelum C. WhatsApp D10/cleanup
retensi bukan tindakan otomatis. Tidak re-enable toolUATretired atau mengaktifkanCI/auto-deploy.

Repo dilaporkan PUBLIC: jangan commit/push source/ID/secret atau perubahan lain tanpa
penugasan; bundle privat bukan izin publikasi. Update hanya tiga dokumen existing;
tidak membuka private artefakbaru/secret/runbook, tidak
menjalankan Save/version/deploy/freeze/import/resource/cleanup/commit/push. Full1259tests
historis lokal ada di checkpoint patch; tidak diklaim rerun untuk currentcapture. User dapat
melanjutkan dengan Claude; tidak dibuat session/model override/worktree baru di sini.

Referensi: [Pages preview access](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
dan [validasi Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

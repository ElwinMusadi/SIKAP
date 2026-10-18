# SIKAP — Sistem Informasi Kepegawaian dan Arsip Pegawai

Aplikasi internal UPTD Pendapatan Daerah Wilayah Kota Kupang untuk mengelola data pegawai (PNS, CPNS, PPPK), arsip dokumen kepegawaian, dan verifikasi dokumen oleh Admin TU.

> **Status:** migrasi dari Google Apps Script ke Cloudflare sedang berjalan di branch `feat/cloudflare-migration`.
> Kode lama (GAS + Google Sheets + Drive) dipindahkan ke [`legacy-gas/`](legacy-gas/) dan tetap menjadi sistem produksi sampai cutover.
> Checkpoint lokal 17 Oktober 2026: `cb4fae7` (Fase 7), `3a1f795` (tooling Fase 8–9), `c9eed3e` (probe D1), dan `8511abc` (classifier policy v2). Belum di-push; Fase 9 tetap parsial dan `readyForImport:false`. Verifikasi rollback query policy v2 lulus satu run; bukan bukti kesiapan impor. Tidak ada deploy sejak hardening alat staging.

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
> Data nyata belum diimpor ke remote. Subbagian di bawah disusun kronologis.

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
absolut config sumber yang dipatok dan cwd terisolasi yang kosong. Belum ada deploy sejak
hardening ini; deployment aktif tetap `0adc7584`.

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
  klasifikasi resume yang tidak pernah mengizinkan retry. `npm run test:import` menjalankan
  32 tes (18 core + 14 mock); full `npm test` 999 tes lulus. Artifact params bersifat privat; hanya `summarize`
  boleh ditampilkan. Business validation, raw plan hash, target proof dan semantic validation
  masih wajib terpisah; core tidak memberi izin apply. Expiry wajib dicek ulang oleh adapter
  sebelum setiap send/resume; DDL journal kelak wajib unique `(run_nonce, ordinal)`.
  Core kini menolak key dengan tipe salah dan epoch journal mundur. Mock adapter in-memory
  (`scripts/import/mock-adapter.mjs`) mensimulasikan commit/rollback, timeout/pending/late commit
  tanpa jaringan atau SQL engine; hasil selalu simulated dan tidak mengizinkan retry. Inspect
  mock privat, summary hanya counts/flags; expiry dicek ulang setiap simulated send. Mock hanya
  memodelkan konflik primary key, bukan seluruh FK/UNIQUE/CHECK. Review core dan mock
  PASS WITH NOTES tanpa blocker. Belum ada client HTTP/R2 nyata, ledger DDL,
  credential, CLI importer atau operasi remote baru. `readyForImport:false` tetap.
- Gerbang tersisa: (1) target UAT terpisah yang kosong; (2) persetujuan operator untuk bukti
  batch/rollback remote sintetis; (3) bukti pepper, perbandingan skema terhadap skema yang
  diharapkan, dan validasi isi referensi; (4) persetujuan eksplisit pemilik data untuk import
  data nyata.

Referensi: [Pages preview access](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
dan [validasi Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

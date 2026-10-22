# Rencana API integrasi SIKAP → PINTU

Disusun 22 Oktober 2026. Status: **keputusan §9 disetujui pemilik (22 Okt 2026)**, dengan satu perubahan: email dan no HP ikut dibagikan, tetapi hanya lewat endpoint detail yang tercatat di log. Siap mulai Fase 1; belum ada kode yang ditulis.

Tujuan: saat Administrator PINTU (`portal-uptdkotakupang`) menambah akun petugas, ia bisa **memilih pegawai yang sudah ada di SIKAP**, bukan mengetik ulang NIP dan nama. SIKAP menjadi sumber data pegawai. Akses API (membuat dan menghapus kunci) **dikelola Admin di SIKAP**.

## 1. Ruang lingkup

Termasuk:
- API baca-saja versi 1 di SIKAP (`/api/v1`), diautentikasi dengan **kunci API** milik aplikasi klien.
- Layar **Pengaturan Sistem → Integrasi API** di SIKAP: daftar kunci, buat kunci (ditampilkan sekali), hapus kunci.
- Catatan di Log Aktivitas SIKAP untuk pembuatan/penghapusan kunci dan pembacaan data pegawai.
- Sisi PINTU: klien HTTP, endpoint proxy khusus Administrator, dan pemilih pegawai di form "Tambah akun".
- Dokumentasi kontrak (`docs/API-INTEGRASI.md`) untuk PINTU dan klien berikutnya.

Tidak termasuk (bisa menyusul sebagai v1.1):
- Menulis/mengubah data SIKAP dari luar. API ini **hanya membaca**.
- Sinkronisasi otomatis atau webhook. PINTU mengambil data saat dibutuhkan.
- Data pejabat struktural untuk portal PINTU (keputusan D-065 di PINTU), endpoint `pejabat` menyusul.
- Login tunggal (SSO) antar-aplikasi.

## 2. Temuan

**SIKAP** (Hono di Pages Functions, D1):
- Semua `/api/*` sudah memberi `Cache-Control: no-store` dan `nosniff` (`server/app.ts:27-33`). Belum ada autentikasi selain cookie sesi. Tidak ada CORS (tidak dibutuhkan untuk panggilan server-ke-server).
- `csrfProtection` menolak metode selain GET tanpa `Origin` (`server/middleware/csrf.ts`). API v1 hanya GET, jadi aman tanpa perubahan.
- Tiga sub-app berbagi prefix `/admin` sehingga guard sesi berjalan berlapis. API v1 harus dipasang di prefix sendiri (`/v1`), dan rute pengelolaan kunci ditambahkan ke sub-app yang sudah ada (`server/routes/administrasi.ts`), bukan sub-app baru.
- Tabel `pegawai` memuat banyak data pribadi (NIK, tempat/tanggal lahir, agama, golongan darah, status pernikahan, no HP, email, alamat, foto). `pegawai.id` **bisa dipakai ulang** setelah purge (`0004_riwayat_integrity.sql`), jadi **NIP** yang menjadi kunci integrasi.
- Pola yang bisa dipakai ulang:
  - token acak + simpan SHA-256 saja (`generateSessionToken`/`hashSessionToken`, `constantTimeEqual` di `server/lib/crypto.ts`);
  - pembatas laju fixed-window atomik `hitRateLimit` (`server/db/rate-limit.ts`, tabel `rate_limit` dengan `key` sebagai primary key: satu baris per kunci);
  - `auditStatement` dalam `db.batch()` yang sama (`server/lib/audit.ts`);
  - pencarian nama/NIP dengan `likePattern` (`server/db/pegawai.ts`);
  - tab Pengaturan Sistem (`SECTIONS` di `pengaturan-page.tsx`) dan pola daftar + dialog dari `referensi-panel.tsx`.
- Migrasi berikutnya: `0009_*`. Migrasi D1 **tidak** dijalankan oleh deploy.

**PINTU** (Laravel 13, SPA React, Laravel Cloud):
- Hanya ada peran `administrator` dan `pegawai`. "Petugas" adalah akun pegawai yang diberi modul (mis. `antrean`) atau ditugaskan ke kegiatan lapangan. Jadi integrasi ini masuk ke form **Tambah akun** (`resources/js/dashboard/pages/akun.tsx`, `POST /api/akun`).
- Form saat ini: NIP (18 digit, unik), Nama, Surel dinas (opsional), Peran, Modul. Password diatur pegawai sendiri lewat tautan aktivasi, dan alur ini tidak berubah.
- D-027: jabatan dan unit diisi pegawai sendiri di PINTU. D-065 sudah mencatat rencana mengambil data dari "API SIKAP".
- Sudah ada pola klien HTTP keluar yang matang (`app/Actions/LookUpVehicle.php`): wajib `https://`, timeout, retry terbatas, menghormati `Retry-After`, tidak mengikuti redirect, log tanpa data pribadi. Tesnya memakai `Http::fake`.
- Laravel Cloud tidak punya IP keluar tetap, jadi **pembatasan IP tidak praktis**. Pengamannya kunci rahasia di header.

## 3. Arsitektur

```text
Admin PINTU (browser)
   │  cookie sesi PINTU (kunci SIKAP TIDAK pernah ke browser)
   ▼
PINTU backend (Laravel Cloud)  ── GET /api/akun/pegawai-sikap?q=…   (khusus Administrator)
   │  Authorization: Bearer skp_…        (kunci di env Laravel Cloud)
   ▼
SIKAP /api/v1/* (Pages Functions)  ── requireApiKey('pegawai:baca') ─▶ D1 (pegawai, ref_*)
                                     └─ rate_limit, kunci_api, log_aktivitas
```

## 4. Kontrak API v1 (SIKAP)

Basis: `https://sikap.uptdpenda-kupang.web.id/api/v1`. Semua respons JSON, `Cache-Control: no-store`. Kontrak zod di `shared/integrasi.ts` dan dokumentasi publik di `docs/API-INTEGRASI.md`.

**Autentikasi:** header `Authorization: Bearer skp_<idPublik>_<rahasia>`. Kunci di query string ditolak (diabaikan) agar tidak masuk log akses.

| Metode & path | Izin | Fungsi |
|---|---|---|
| `GET /v1/ping` | (kunci valid) | Tes koneksi: nama klien, izin, tanggal kedaluwarsa. Untuk tombol "Tes koneksi" |
| `GET /v1/pegawai` | `pegawai:baca` | Cari/daftar pegawai **aktif**. Query: `q` (2–100 karakter, nama atau NIP), `statusKepegawaian` (PNS/CPNS/PPPK), `unitId`, `page` (bawaan 1), `pageSize` (10/20/50, bawaan 20). Urut nama |
| `GET /v1/pegawai/{nip}` | `pegawai:baca` | Detail satu pegawai aktif berdasarkan NIP 18 digit: field daftar **ditambah email dan no HP**. Setiap panggilan dicatat di Log Aktivitas |

Hasil pencarian sengaja **tidak** memuat email dan no HP. Data kontak hanya keluar untuk pegawai yang benar-benar dipilih (detail per NIP), dan setiap pembacaan itu tercatat.

Contoh respons `GET /v1/pegawai?q=contoh` (data fiktif):

```json
{
  "items": [
    {
      "nip": "199001012020011001",
      "nama": "Contoh Pegawai",
      "statusKepegawaian": "PNS",
      "pangkat": { "kode": "III/a", "nama": "Penata Muda" },
      "jabatan": "Pengelola Kepegawaian",
      "jenisJabatan": "Pelaksana",
      "unit": { "id": 2, "nama": "Subbagian Tata Usaha" },
      "diperbarui": "2026-10-21T08:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

Contoh respons `GET /v1/pegawai/199001012020011001` (data fiktif): sama seperti satu item di atas, ditambah

```json
{
  "email": "contoh.pegawai@example.com",
  "noHp": "6281234567890"
}
```

`email` dan `noHp` bernilai `null` bila kosong di SIKAP. `noHp` memakai format SIKAP (`62…`, tanpa `+`).

"Aktif" berarti `deleted_at IS NULL` dan `status_akun = 'Aktif'`. Pegawai nonaktif atau terhapus tidak muncul dan memberi 404 di detail.

**Galat** (format SIKAP yang sudah ada: `{"error":{"code","message"}}`):

| HTTP | Kode | Kapan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Query tidak valid (mis. `q` 1 karakter, `pageSize` tak didukung) |
| 401 | `API_KEY_INVALID` | Header hilang, format salah, kunci tidak dikenal, dihapus, atau kedaluwarsa. Satu pesan umum, dan alasan rincinya hanya di Log Aktivitas |
| 403 | `API_SCOPE_DENIED` | Kunci valid tetapi tidak punya izin endpoint tersebut |
| 404 | `NOT_FOUND` ("Pegawai tidak ditemukan.") | NIP tidak ada / nonaktif / terhapus, atau path tidak dikenal |
| 429 | kode pembatas laju yang sudah ada | Melewati batas; ada header `Retry-After` |

**Batas laju:** 60 permintaan per menit per kunci (`rate_limit` key `api:<id>`), ditambah 20 kegagalan autentikasi per 15 menit per IP (`api-auth-ip:<ip>`).

## 5. Pengelolaan kunci API di SIKAP

**Format kunci:** `skp_<idPublik 12 karakter>_<rahasia 43 karakter base64url, 32 byte acak>`. Awalan `skp_` memudahkan pemindaian rahasia dan pengenalan kunci di konfigurasi.

**Penyimpanan** (migrasi `0009_kunci_api.sql`):

| Kolom | Isi |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT (tidak dipakai ulang) |
| `id_publik` | 12 karakter, UNIQUE; ditampilkan di UI (`skp_ab12cd34ef56…`) |
| `token_hash` | SHA-256 hex dari kunci utuh. **Kunci asli tidak pernah disimpan** |
| `nama`, `keterangan` | mis. "PINTU (produksi)" |
| `izin` | JSON array, v1 hanya `["pegawai:baca"]` |
| `created_at`, `created_by`, `created_by_nama` | pembuat (snapshot nama, seperti log) |
| `expires_at` | wajib; bawaan 365 hari |
| `last_used_at`, `last_used_ip` | diperbarui paling sering tiap 5 menit agar tidak menulis D1 di setiap permintaan |

- Verifikasi: cari baris lewat `id_publik`, lalu bandingkan SHA-256 dengan `constantTimeEqual`, cek `expires_at` dan izin. Tidak ada cache, jadi penghapusan berlaku seketika.
- `kunci_api` **tidak** masuk `BACKUP_TABLES`, supaya pemulihan backup tidak menghidupkan lagi kunci yang sudah dihapus. Kunci bisa diterbitkan ulang.
- Tidak butuh secret Pages baru.

**API pengelolaan** (sesi + Admin, di `server/routes/administrasi.ts`, terlindung CSRF):
- `GET /api/admin/kunci-api`: daftar tanpa hash/rahasia.
- `POST /api/admin/kunci-api` `{nama, keterangan?, izin[], masaBerlakuHari: 90|180|365}`. Respons berisi `kunci` **satu kali saja**.
- `DELETE /api/admin/kunci-api/{id}`: hapus permanen, kunci langsung tidak berlaku.

**UI: Pengaturan Sistem → tab "Integrasi API"** (pola `referensi-panel`):
- Tabel (desktop) / kartu (ponsel) berisi Nama, ID kunci, Izin, Dibuat (oleh, kapan), Terakhir dipakai, Kedaluwarsa, Status. Status lewat registri `src/lib/status.ts`, domain baru `kunciApi`: Aktif / Segera kedaluwarsa (≤ 30 hari) / Kedaluwarsa.
- **Buat kunci API**: dialog nama, keterangan, izin (checkbox "Baca data pegawai"), masa berlaku.
- **Tampil sekali**: dialog berisi kunci, tombol Salin, peringatan "Simpan sekarang, kunci tidak bisa ditampilkan lagi".
- **Hapus**: AlertDialog konfirmasi yang menyebut nama klien dan akibatnya ("PINTU tidak bisa lagi mengambil data pegawai").
- Kotak "Cara pakai": URL basis, header, tautan ke `docs/API-INTEGRASI.md`.
- **Rotasi tanpa putus**: buat kunci baru → ganti env di PINTU → hapus kunci lama.

**Log Aktivitas:** kategori baru **Integrasi** (prefix `API`). Aksinya:
- `APIKEY_CREATE` dan `APIKEY_DELETE` (aktor Admin);
- `API_PEGAWAI_READ` (detail per NIP, aktor = klien, target = pegawai);
- `API_AUTH_FAILED` (maksimal sekali per IP per jendela);
- `API_RATE_LIMITED`.

Deskripsi log hanya memuat nama klien dan ID kunci, **tidak pernah** kunci atau data pribadi.

## 6. Data yang dibagikan (minimal)

| Endpoint | Dibagikan |
|---|---|
| Daftar/cari (`/v1/pegawai`) | NIP, nama, status kepegawaian, pangkat/golongan (kode + nama), jabatan, jenis jabatan, unit (id + nama), waktu diperbarui |
| Detail (`/v1/pegawai/{nip}`) | Semua di atas + **email** + **no HP** (keputusan pemilik no. 1) |

**Tidak pernah dibagikan:**
- data pribadi: NIK, tempat/tanggal lahir, jenis kelamin, agama, golongan darah, pendidikan, status pernikahan, alamat, foto;
- data akun: password, kunci akun, sesi;
- kelengkapan dokumen dan arsip.

Kedua daftar ini dikunci di fungsi proyeksi (`rowToIntegrasiPegawai` dan `rowToIntegrasiPegawaiDetail`), bukan `SELECT *`. Ada tes yang gagal bila kunci JSON lain ikut keluar, termasuk bila email/no HP muncul di hasil pencarian.

## 7. Keamanan (daftar periksa)

- Kunci hanya di env server PINTU (Laravel Cloud), tidak pernah di browser, repo, log, atau tangkapan layar.
- HTTPS saja (domain kustom), header Bearer, kunci di query diabaikan.
- Hanya hash yang disimpan; kunci ditampilkan sekali; masa berlaku wajib (pelajaran token `forever`).
- Izin per endpoint; data minimal (§6); email dan no HP hanya lewat detail yang tercatat; hanya pegawai aktif; kunci integrasi = NIP.
- PINTU tidak boleh menulis email/no HP dari SIKAP ke log aplikasinya (aturan PINTU: data pribadi tidak masuk log).
- Batas laju per kunci + per IP untuk kegagalan; 401 seragam.
- Hapus = tidak berlaku seketika (tanpa cache).
- Jejak audit: siapa membuat/menghapus kunci, NIP mana yang dibaca klien.
- Tidak ada CORS, karena browser pihak lain memang tidak boleh memanggil API ini.
- Opsional nanti: aturan WAF rate limiting Cloudflare untuk `/api/v1/*` (sejalan dengan TODO `/api/auth/login`).

## 8. Rencana implementasi bertahap

Semua perubahan SIKAP dikerjakan langsung di `main` (aturan pemilik). Push hanya setelah typecheck, lint, seluruh tes, dan build lulus di lokal, karena **push = deploy produksi**. Urutan rilis penting: **migrasi D1 produksi dulu, baru push kode** (§10).

| Fase | Isi | Berkas utama | Estimasi |
|---|---|---|---|
| **0. Keputusan** | Selesai 22 Okt 2026 (§9) | `docs/RENCANA-API-INTEGRASI.md` | – |
| **1. Backend SIKAP** (selesai 22 Okt 2026, belum di-commit) | Migrasi `0009_kunci_api.sql`; helper `generateApiKey`/`parseApiKey`; `server/db/kunci-api.ts`; middleware `requireApiKey(izin)` + `c.var.apiClient` (`server/env.ts`); rute `server/routes/integrasi-v1.ts` di `/v1`; rute pengelolaan di `administrasi.ts`; kontrak `shared/integrasi.ts`; kategori log `integrasi`; `BACKUP_TABLES` tetap tanpa `kunci_api`; namespace `api-auth-ip:` di pembersihan cron | `migrations/`, `server/`, `shared/`, `workers/cron/index.ts` | 1–1,5 hari |
| **Tes backend** | `test/integrasi-v1.test.ts`: matriks 401 (tanpa header, format salah, tak dikenal, kedaluwarsa, dihapus), 403 izin, hanya pegawai aktif, **kunci JSON persis sesuai whitelist (email/no HP hanya di detail, tidak pernah di pencarian)**, cari nama/NIP + escape LIKE, paginasi, detail NIP & 404, 429 + `Retry-After`, `last_used_at`, log `API_PEGAWAI_READ`, kunci di query diabaikan, `no-store`. `test/kunci-api-admin.test.ts`: Pegawai 403, kunci hanya keluar sekali, daftar tanpa hash, validasi, CSRF, hapus → 401 seketika, log `APIKEY_*` | `test/` | (termasuk di atas) |
| **2. UI SIKAP** (selesai 22 Okt 2026, belum di-commit) | Tab "Integrasi API" di Pengaturan Sistem; dialog buat, dialog tampil-sekali, konfirmasi hapus; domain status `kunciApi`; kategori "Integrasi" di Log Aktivitas; util + tes web; QA desktop/ponsel/gelap | `src/features/integrasi/*`, `pengaturan-page.tsx`, `src/lib/status.ts`, `src/features/log/*` | 1 hari |
| **3. Dokumentasi** (selesai 22 Okt 2026, belum di-commit) | `docs/API-INTEGRASI.md` (kontrak, contoh `curl` dengan kunci fiktif, galat, batas laju, rotasi); `CLAUDE.md`, `README.md`, `POLA-UI.md` bila perlu | `docs/` | 0,5 hari |
| **4. Rilis SIKAP** | Migrasi produksi + push + verifikasi (§10), lalu pemilik membuat kunci "PINTU (produksi)" | – | 0,5 hari |
| **5. PINTU** (repo PINTU, aturannya sendiri: FormRequest/Actions/Policy, PHPUnit, `KONTEKS-PROYEK.md`, keputusan D-075) | `config/services.php` `sikap` + env `SIKAP_API_BASE_URL`, `SIKAP_API_KEY`, `SIKAP_API_TIMEOUT_SECONDS`; `app/Actions/CariPegawaiSikap.php` & `AmbilPegawaiSikap.php` meniru `LookUpVehicle`; proxy `GET /api/akun/pegawai-sikap` (+`/{nip}`) dengan `can('create', User::class)` + throttle, menandai `sudahPunyaAkun`; saat simpan dengan sumber SIKAP, server PINTU **mengambil ulang detail NIP** dan memakai nama dari SIKAP; combobox "Cari pegawai SIKAP" di sheet Tambah akun (NIP & Nama terisi dan terkunci, tombol "Isi manual"); tes `Http::fake` (header terkirim, 401/429/5xx, timeout, non-admin 403) | repo PINTU | 1–1,5 hari |
| **6. Uji ujung-ke-ujung** | Admin PINTU memilih pegawai → akun dibuat → tautan aktivasi; cek Log Aktivitas SIKAP; uji rotasi kunci | – | 0,5 hari |

Fase 5 sebaiknya dikerjakan di sesi terpisah yang dibuka di repo PINTU, dengan kontrak `docs/API-INTEGRASI.md` sebagai acuan.

## 9. Keputusan pemilik

| # | Keputusan | Rekomendasi awal | Alternatif |
|---|---|---|---|
| 1 | Data yang dibagikan | Set minimal §6, **tanpa email dan no HP** | Tambah email (mengisi "Surel dinas" PINTU, tetapi email SIKAP bisa email pribadi) |
| 2 | Pegawai yang muncul | Hanya aktif dan tidak terhapus | Ikut sertakan Nonaktif dengan penanda |
| 3 | Isian PINTU dari SIKAP | NIP + Nama (terkunci); jabatan/unit hanya ditampilkan di pemilih, D-027 tetap | Isi jabatan/unit juga (mengubah D-027) |
| 4 | Input manual di PINTU | Tetap boleh (petugas non-UPTD seperti polisi/bank, D-051) | Wajib dari SIKAP |
| 5 | Masa berlaku kunci | Wajib: 90 / 180 / 365 hari, bawaan 365 | Boleh tanpa batas (tidak disarankan) |
| 6 | Arti "hapus" kunci | Hapus permanen, berlaku seketika; jejak tetap di Log Aktivitas | Status "dicabut" yang tetap terlihat di daftar |
| 7 | Catat pembacaan detail pegawai | Ya, satu entri per detail NIP (pencarian tidak dicatat) | Tidak dicatat |
| 8 | Batas laju | 60/menit per kunci | Angka lain |
| 9 | Data pejabat struktural (D-065) | Di luar v1, endpoint `pejabat` menyusul | Masuk v1 |

**Hasil keputusan (22 Okt 2026):**
- **No. 1 diubah pemilik:** email dan no HP ikut dibagikan, hanya lewat endpoint detail (§4, §6).
- **No. 2–9 disetujui sesuai rekomendasi**, termasuk masa berlaku bawaan 365 hari.
- **Catatan untuk Fase 5:** keputusan no. 3 tetap, jadi PINTU v1 hanya mengisi NIP dan Nama. Pemanfaatan email dan no HP di PINTU diputuskan sebelum Fase 5 dimulai (sebagai keputusan D-075 di PINTU). Contohnya: email mengisi "Surel dinas" dan tetap bisa diubah; no HP butuh kolom baru karena `users` PINTU belum punya kolom telepon.

## 10. Rilis dan rollback

Urutan (setiap langkah produksi dengan persetujuan pemilik):
1. **Cek read-only** daftar tabel D1 produksi. Hasil 22 Okt 2026: 21 tabel (skema 0001–0008 + dua tabel catatan importer), `kunci_api` belum ada, dan **`d1_migrations` tidak ada** karena skema dibangun oleh importer. Jadi `wrangler d1 migrations apply` tidak boleh dipakai.
2. **Catat bookmark D1 Time Travel** produksi sebagai titik pulih. Hasil 22 Okt 2026 06:47 UTC: bookmark `00000015-00000000-0000510c-3e561ba66ad2bb17f766cf868914f5da`.
3. **Terapkan hanya `0009_kunci_api.sql`** (keputusan pemilik: opsi per berkas) dengan `wrangler d1 execute DB --remote --file`, dari direktori terisolasi yang `wrangler.toml`-nya hanya menunjuk D1 `sikap-import-prod-20261020`. Migrasi ini hanya menambah tabel, sehingga aman dijalankan sebelum kode baru dan kode lama tidak terpengaruh. SHA-256 berkas: `7cbb18acc704745a7d7241176998e2aa8b9b3b684a57ac09b37e1c9aee4a9f70`. Prosedur umumnya ada di `docs/DEPLOY.md` (Perubahan dengan migrasi D1).
   - **Diterapkan 22 Okt 2026 sekitar 06:50 UTC** atas izin pemilik.
     - Percobaan pertama gagal karena koneksi sebelum SQL dijalankan; database tidak berubah (dicek: 21 tabel, tanpa `kunci_api`).
     - Percobaan kedua berhasil.
   - Verifikasi read-only: 22 tabel, `kunci_api` dengan 12 kolom sesuai migrasi, 0 baris, data pegawai utuh, dan `/api/health` produksi `"db":"ok"`.
4. Commit + push ke `main`. Deploy otomatis berjalan, lalu health check.
5. **Uji asap tanpa data pribadi**:
   - buat kunci sementara, cek `GET /v1/ping`, lalu cek 401 tanpa kunci dan 403/400 pada kasus salah;
   - hapus kunci, lalu pastikan kunci itu langsung mendapat 401.
6. Pemilik membuat kunci "PINTU (produksi)" dan memasangnya sebagai env di Laravel Cloud. Kunci tidak ditempel ke chat.

Rollback:
- Kode SIKAP: rollback deployment Pages di dashboard. Tabel `kunci_api` boleh tetap ada.
- Akses PINTU: hapus kuncinya di SIKAP, dan akses terputus seketika.
- PINTU: tetap bisa input manual (keputusan 4).

## 11. Risiko

| Risiko | Penanganan |
|---|---|
| Kunci bocor | Hapus kunci (seketika), terbitkan baru; jejak di log. Karena jumlah pegawai kecil (±50), batas laju **tidak** mencegah pengambilan seluruh data kontak dalam beberapa menit. Pertahanan utamanya kunci yang hanya ada di server PINTU, masa berlaku, dan Log Aktivitas yang menunjukkan lonjakan `API_PEGAWAI_READ` |
| SIKAP tidak tersedia | PINTU menampilkan pesan dan tetap mengizinkan input manual |
| Nama di PINTU basi setelah berubah di SIKAP | v1: PINTU menyimpan salinan saat akun dibuat. v1.1: endpoint `diperbaruiSejak` untuk sinkron berkala |
| `pegawai.id` dipakai ulang setelah purge | Integrasi memakai NIP |
| Migrasi produksi dijalankan dengan binding salah | Konfigurasi terisolasi + cek nama/ID database sebelum apply (pola `pages-release.mjs`), bookmark Time Travel |
| Log penuh oleh pencarian | Hanya detail NIP yang dicatat; kegagalan autentikasi dibatasi per IP |
| Importer produksi berjalan dengan skema baru | Dengan adanya `0009`, `staticCheck` importer berhenti dengan `MIGRATION_SET_MISMATCH`. Ini disengaja: import produksi tidak boleh dijalankan ulang, dan pin importer tetap 0001–0008. Keputusan pemilik 22 Okt 2026: importer menjadi alat historis. 24 tes yang butuh skema 0001–0008 dilewati dengan alasan tertulis (`scripts/import/historical-schema.mjs`), dan `historical-schema.test.mjs` membuktikan importer menolak skema baru serta mengunci byte 0001–0008 |

# API integrasi SIKAP v1

Kontrak API baca-saja untuk aplikasi lain yang perlu data pegawai SIKAP. Klien pertama adalah PINTU
(`portal-uptdkotakupang`): saat Administrator PINTU menambah akun petugas, ia memilih pegawai dari SIKAP.
Latar belakang dan keputusan pemilik ada di [`RENCANA-API-INTEGRASI.md`](RENCANA-API-INTEGRASI.md).
Kontrak kode ada di `shared/integrasi.ts`, implementasinya di `server/routes/integrasi-v1.ts` dan
`server/services/integrasi.ts`.

| | |
|---|---|
| URL dasar produksi | `https://sikap.uptdpenda-kupang.web.id/api/v1` |
| Metode | `GET` saja |
| Autentikasi | `Authorization: Bearer <kunci>` |
| Format | JSON (UTF-8), selalu `Cache-Control: no-store` |
| Batas laju | 60 permintaan per menit per kunci |

## 1. Kunci API

- Kunci dibuat dan dihapus oleh Admin SIKAP di **Pengaturan Sistem → Integrasi API**. Gunakan satu kunci
  untuk satu aplikasi.
- Format kunci: `skp_<id publik 12 karakter>_<rahasia 43 karakter>`. Bagian `skp_<id publik>` boleh
  muncul di log dan di layar. Bagian rahasianya tidak boleh muncul di mana pun.
- Kunci hanya **ditampilkan sekali**, saat dibuat. SIKAP hanya menyimpan sidik SHA-256-nya, jadi kunci yang
  hilang tidak bisa dipulihkan. Hapus kunci itu, lalu buat kunci baru.
- Kunci selalu punya **masa berlaku**: 90, 180, atau 365 hari (bawaan 365). Layar Integrasi API menandai
  kunci yang akan kedaluwarsa dalam 30 hari ke depan.
- Kunci yang **dihapus langsung tidak berlaku** pada permintaan berikutnya, karena SIKAP tidak menyimpan
  cache kunci.
- Simpan kunci **hanya di server aplikasi klien**, misalnya sebagai variabel lingkungan. Jangan simpan di
  browser, repo, tangkapan layar, atau chat. API ini tidak mengirim header CORS, sehingga browser milik
  aplikasi lain memang tidak bisa memanggilnya langsung.
- Kunci di query string (`?api_key=`, `?key=`) **diabaikan**. Hanya header `Authorization` yang dibaca.

**Rotasi tanpa jeda layanan:**
1. Buat kunci baru.
2. Pasang kunci baru di aplikasi klien.
3. Pastikan `GET /ping` dengan kunci baru menjawab 200.
4. Hapus kunci lama.

## 2. Endpoint

### `GET /ping`

Tes koneksi. Endpoint ini cukup memakai kunci yang valid, tanpa izin tambahan.

```json
{
  "klien": "PINTU (produksi)",
  "idKunci": "skp_ab12cd34ef56",
  "izin": ["pegawai:baca"],
  "kedaluwarsa": "2027-10-22T00:00:00.000Z"
}
```

### `GET /pegawai`

Izin: `pegawai:baca`. Mencari pegawai **aktif**, yaitu yang tidak terhapus dan status akun SIKAP-nya
`Aktif`. Hasilnya diurutkan berdasarkan nama.

| Parameter | Isi |
|---|---|
| `q` | Opsional, 2–100 karakter. Dicocokkan dengan sebagian nama (tanpa membedakan huruf besar/kecil) atau sebagian NIP. `%` dan `_` dibaca sebagai huruf biasa |
| `statusKepegawaian` | Opsional: `PNS`, `CPNS`, atau `PPPK` |
| `unitId` | Opsional, ID unit organisasi |
| `page` | Bawaan `1` |
| `pageSize` | `10`, `20` (bawaan), atau `50` |

Parameter lain diabaikan.

Contoh respons (data fiktif):

```json
{
  "items": [
    {
      "nip": "199001012020011001",
      "nama": "Contoh Pegawai",
      "statusKepegawaian": "PNS",
      "pangkat": { "kode": "III/a", "nama": "Penata Muda (III/a)" },
      "jabatan": "Pengelola Kepegawaian",
      "jenisJabatan": "Pelaksana",
      "unit": { "id": 1, "nama": "Subbagian Tata Usaha" },
      "diperbarui": "2026-10-21T08:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

Hasil pencarian **tidak pernah** memuat email, no HP, atau data pribadi lain.

### `GET /pegawai/{nip}`

Izin: `pegawai:baca`. Mengembalikan satu pegawai aktif berdasarkan NIP 18 digit. Isinya semua field hasil
pencarian ditambah `email` dan `noHp`.

```json
{
  "nip": "199001012020011001",
  "nama": "Contoh Pegawai",
  "statusKepegawaian": "PNS",
  "pangkat": { "kode": "III/a", "nama": "Penata Muda (III/a)" },
  "jabatan": "Pengelola Kepegawaian",
  "jenisJabatan": "Pelaksana",
  "unit": { "id": 1, "nama": "Subbagian Tata Usaha" },
  "diperbarui": "2026-10-21T08:00:00.000Z",
  "email": "contoh.pegawai@example.com",
  "noHp": "6281234567890"
}
```

Setiap panggilan yang berhasil **dicatat di Log Aktivitas SIKAP**, kategori Integrasi, dengan aksi
`API_PEGAWAI_READ`. Catatan itu memuat nama klien, ID publik kunci, dan NIP pegawai yang dibaca. Karena
itu, panggil detail hanya ketika pegawai benar-benar dipilih, jangan untuk setiap hasil pencarian.

### Arti field

| Field | Tipe | Keterangan |
|---|---|---|
| `nip` | string | 18 digit; kunci penghubung antar-aplikasi (ID internal SIKAP bisa dipakai ulang, jangan disimpan) |
| `nama` | string | Nama lengkap sesuai SIKAP |
| `statusKepegawaian` | `"PNS" \| "CPNS" \| "PPPK" \| null` | |
| `pangkat` | `{kode, nama} \| null` | Pangkat/golongan |
| `jabatan` | `string \| null` | Teks bebas |
| `jenisJabatan` | `"Fungsional" \| "Pelaksana" \| "Struktural" \| null` | |
| `unit` | `{id, nama} \| null` | Unit organisasi |
| `diperbarui` | string ISO 8601 UTC | Waktu data pegawai terakhir diubah di SIKAP |
| `email` | `string \| null` | Hanya di detail; bisa berupa email pribadi |
| `noHp` | `string \| null` | Hanya di detail; format `62…` tanpa `+` |

Data yang **tidak pernah** dibagikan:
- data pribadi: NIK, tempat/tanggal lahir, jenis kelamin, agama, golongan darah, pendidikan, status
  pernikahan, alamat, foto;
- data akun, dokumen, dan arsip.

## 3. Galat

Semua galat memakai amplop yang sama:

```json
{ "error": { "code": "API_KEY_INVALID", "message": "Kunci API tidak valid atau sudah tidak berlaku." } }
```

| HTTP | `code` | Kapan | Yang dilakukan klien |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Parameter tidak valid (mis. `q` 1 karakter, `pageSize` 15, NIP bukan 18 digit). `fields` berisi pesan per parameter | Perbaiki permintaan; jangan diulang apa adanya |
| 401 | `API_KEY_INVALID` | Header tidak ada, format salah, kunci tidak dikenal, dihapus, atau kedaluwarsa. Pesannya sengaja seragam, dan alasannya hanya tercatat di Log Aktivitas SIKAP. Ada header `WWW-Authenticate: Bearer` | Tampilkan "kunci API SIKAP tidak valid" ke Administrator; jangan diulang |
| 403 | `API_SCOPE_DENIED` | Kunci valid tetapi tidak punya izin endpoint itu | Minta Admin SIKAP membuat kunci dengan izin yang benar |
| 403 | `CSRF_REJECTED` | Metode selain `GET` dari server (tanpa header `Origin`) | API ini baca-saja; pakai `GET` |
| 404 | `NOT_FOUND` | NIP tidak ada, nonaktif, atau terhapus; atau path tidak dikenal | Anggap pegawai tidak tersedia di SIKAP |
| 429 | `RATE_LIMITED` | Lebih dari 60 permintaan per menit untuk kunci ini, atau terlalu banyak kunci salah dari satu IP. Ada header `Retry-After` (detik) dan field `retryAfterSeconds` | Tunggu sesuai `Retry-After` |
| 500 | `INTERNAL_ERROR` | Galat server | Boleh diulang terbatas dengan jeda |

## 4. Panduan klien (Laravel, untuk PINTU)

Konfigurasi `config/services.php`:

```php
'sikap' => [
    'base_url' => env('SIKAP_API_BASE_URL'),          // https://sikap.uptdpenda-kupang.web.id/api/v1
    'key' => env('SIKAP_API_KEY'),                    // hanya di env server (Laravel Cloud), tidak pernah di repo
    'timeout' => (int) env('SIKAP_API_TIMEOUT_SECONDS', 8),
],
```

Contoh pemanggilan dari server PINTU:

```php
$response = Http::withToken(config('services.sikap.key'))
    ->acceptJson()
    ->connectTimeout(3)
    ->timeout(config('services.sikap.timeout'))
    ->withOptions(['allow_redirects' => false])
    ->get(rtrim(config('services.sikap.base_url'), '/').'/pegawai', ['q' => $q, 'pageSize' => 20]);
```

Aturan yang disarankan, mengikuti pola klien NJKB yang sudah ada di PINTU (`app/Actions/LookUpVehicle.php`):

- **Konfigurasi:** tolak `base_url` yang bukan `https://`, kecuali saat pengujian lokal. Jangan mengikuti
  redirect.
- **Pengulangan:** ulangi paling banyak 2 kali, dan hanya untuk galat jaringan serta HTTP 502/503/504.
  Untuk 429, hormati `Retry-After`.
- **Log:** catat hanya status dan kode galat. Jangan pernah mencatat kunci, email, atau no HP.
- **Kunci tetap di server:** browser Administrator memanggil endpoint proxy PINTU yang khusus
  Administrator (mis. `GET /api/akun/pegawai-sikap?q=`). Server PINTU-lah yang memanggil SIKAP. Kunci
  SIKAP tidak pernah dikirim ke browser.
- **Simpan akun:** saat akun dibuat dari data SIKAP, ambil ulang detail per NIP di server sebelum
  menyimpan. Jangan percaya nama yang dikirim dari browser.
- **Saat SIKAP tidak bisa dihubungi:** tampilkan pesan, dan izinkan input manual. Petugas dari luar UPTD
  tidak ada di SIKAP.

## 5. Versi

- `v1` hanya berubah secara **aditif**: field atau endpoint baru boleh muncul, jadi klien wajib
  mengabaikan field yang tidak dikenal.
- Perubahan yang mematahkan klien lama (mengganti nama atau menghapus field, mengubah arti field) harus
  dibuat di `/api/v2`, dan `v1` tetap tersedia sampai semua klien pindah.

## 6. Uji lokal

1. Jalankan SIKAP lokal (`npm run dev:api`), terapkan migrasi lokal (`npm run db:migrate:local`), lalu
   masuk sebagai Admin akun contoh.
2. Buat kunci di **Pengaturan Sistem → Integrasi API**. Kunci lokal hanya berlaku di database lokal.
3. Panggil API dengan kunci itu:

```bash
curl -s -H "Authorization: Bearer $SIKAP_API_KEY" "http://localhost:8788/api/v1/pegawai?q=dev"
```

Tes otomatis kontrak ini ada di `test/integrasi-v1.test.ts` dan `test/kunci-api-admin.test.ts`.

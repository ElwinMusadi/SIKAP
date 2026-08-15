# SIKAP — Sistem Informasi Kepegawaian

SIKAP adalah aplikasi Sistem Informasi Kepegawaian berskala _enterprise_ tingkat lanjut yang menerapkan **Unified Architecture**. Sistem ini mengintegrasikan pengiriman Frontend modern super cepat (Cloudflare Pages) dengan keandalan Backend tanpa peladen (Google Apps Script).

---

## 1. Project Overview
Aplikasi ini dikembangkan untuk UPTD Pendapatan Daerah Wilayah Kota Kupang. SIKAP mengelola data master pegawai, pengarsipan dokumen elektronik, validasi persetujuan berjenjang, dan tata kelola sesi pengguna yang sangat aman.

## 2. Architecture
Proyek ini mengadopsi pemisahan lapisan (Decoupled Layers):
- **Frontend Layer**: Cloudflare Pages (Menyajikan HTML, Tailwind CSS v4, JavaScript Statis).
- **Gateway Layer**: Cloudflare Pages Functions (`/api/gas`) sebagai _reverse proxy_ untuk menghindari pemblokiran CORS.
- **Backend Layer**: Google Apps Script (GAS) bertindak sebagai prosesor JSON murni (`doPost`).
- **Database Layer**: Google Sheets (Relasional CRUD) dan Google Drive (Binary Blob Storage).

*(Lihat [ARCHITECTURE.md](ARCHITECTURE.md) untuk diagram sistem visual).*

## 3. Directory Structure
```text
SIKAP/
├── .github/workflows/    # Konfigurasi CI/CD otomatis (gas-deploy.yml)
├── functions/api/        # Cloudflare Pages Functions (Gateway backend)
├── scripts/              # Skrip pendukung build (build-cloudflare.js)
├── src/
│   ├── backend/          # Google Apps Script (.gs) source code
│   └── frontend/         # Frontend UI (.html) source code (komponen terpisah)
├── wrangler.toml         # Konfigurasi identitas & variabel Cloudflare
├── package.json          # Manajemen dependensi Node.js & build scripts
└── .clasp.json           # Konfigurasi integrasi Google Apps Script
```

## 4. Development Workflow
SIKAP memiliki repositori tunggal (Single Source of Truth). Seluruh pengembangan Frontend maupun Backend dilakukan terpusat pada *branch* `main`. Proses *build* akan mengekstrak kode yang relevan ke tujuan masing-masing secara otomatis.

## 5. Frontend Development
Frontend ditulis menggunakan Vanilla JS dan disuntikkan (*inject*) ke dalam satu file HTML (`Index.html`) pada saat *build time*. 
- Lokasi: `src/frontend/*.html`
- Gaya Visual: Tailwind CSS v4 CDN
- Templating: Memanfaatkan tag `<?!= include('File'); ?>` yang diproses oleh *regex* saat *build*.

## 6. GAS Development
Kode Google Apps Script menggunakan pola V8 standar.
- Lokasi: `src/backend/*.gs`
- Fungsi sentral `API.gs` bertindak sebagai pengontrol (Controller) yang menerima lalu lintas JSON dan memetakannya ke modul fungsi lainnya (`Auth.gs`, `Dokumen.gs`, dll).

## 7. Cloudflare Development
Cloudflare bertugas melayani seluruh antarmuka web dan menjembatani panggilan API. File `functions/api/gas.js` bekerja sebagai fungsi tanpa peladen (Serverless Edge Function) yang meneruskan Payload secara utuh ke GAS.

## 8. Build Commands
Repositori ini memanfaatkan `npm` scripts:
- `npm run build:gas` : Mengekstrak `src/` ke dalam folder `gas-dist/` untuk dipublikasikan ke Google Apps Script.
- `npm run build:cloudflare` : Menggabungkan (flatten) kode `src/frontend/` menjadi satu `dist/index.html` statis yang dapat diluncurkan ke Cloudflare.
- `npm run dev` : Membuka server lokal (*Live Preview*) Cloudflare Pages via Wrangler di `http://127.0.0.1:8788`.

## 9. GAS Deployment
Deployment GAS diotomatisasi melalui **GitHub Actions**. 
Setiap ada *push* ke cabang `main`, GitHub akan menjalankan `npm run build:gas` lalu mengeksekusi `clasp push` untuk mengunggah versi *Development/HEAD* terbaru.
*(Catatan: Anda masih perlu melakukan versi rilis manual `clasp deploy` jika ingin memublikasikan Web App `.../exec` untuk digunakan publik).*

## 10. Cloudflare Deployment
Deployment Cloudflare diotomatisasi secara bawaan oleh **Cloudflare Pages GitHub Integration**.
Begitu mendeteksi *push* ke `main`, mesin Cloudflare akan menjalankan `npm run build:cloudflare` dan merilis hasilnya secara global seketika.

## 11. Environment Variables
- `GAS_WEB_APP_URL` : Didefinisikan dalam `wrangler.toml` agar _Gateway_ Cloudflare mengetahui ke mana harus meneruskan (*proxy*) _request_. (URL Publik).
- `CLASPRC_JSON` : Token OAuth Rahasia yang disimpan di dalam **GitHub Secrets**. Digunakan oleh GitHub Actions untuk mendapatkan hak akses melakukan `clasp push`.

## 12. Git Workflow
Sistem ini mematuhi standar *Git Branching*:
- **Sumber Utama**: `main`
- **Fitur Baru**: `feature/nama-fitur`
- **Perbaikan**: `fix/nama-bug`
Pengembang harus bekerja pada _branch_ terpisah, mengujinya secara lokal (`npm run dev`), lalu mengajukan *Pull Request* (PR) atau menggabungkannya ke `main`.

## 13. API Architecture
API SIKAP adalah antarmuka JSON murni. Setiap *request* yang masuk ke `POST /api/gas` harus memiliki _body_ JSON yang mendefinisikan parameter `action` (misalnya `"action": "login"`). Argumen fungsi dipetakan dengan rapi di dalam `API_HANDLERS` (*Whitelist*), sehingga injeksi fungsi jahat menjadi mustahil.

## 14. Authentication Architecture
Sistem tidak menggunakan Cookie, melainkan menggunakan pola **Stateless Token-Based Authentication**.
Token dibuat menggunakan UUID, disimpan di Google Sheets, dan memiliki kedaluwarsa 12 jam. Token ini wajib diselipkan di dalam setiap _payload request_ (misal: `"token": "123-abc-..."`).

## 15. Google Sheets Architecture
Digunakan sebagai basis data relasional primitif dengan performa sangat andal. Pengambilan data dioptimalkan menggunakan Array 2D (`getValues()`), kemudian diubah ke dalam struktur Objek/JSON menggunakan Indeks Kolom (`Database.gs`) agar kodenya tidak rentan terhadap pergeseran kolom di Sheets.

## 16. Google Drive Architecture
Digunakan semata-mata sebagai penyimpanan Biner (*Binary Blob Storage*). Fungsi unggah (*upload*) menerima _string_ Base64 (dibatasi 5 MB), lalu disandikan (*decode*) menjadi _blob_ PDF/JPG/PNG. ID Berkas (File ID) yang dihasilkan oleh Google Drive kemudian ditautkan kembali ke tabel `Arsip_Dokumen` di Google Sheets.

## 17. Troubleshooting
- **Layar Kosong saat Lokal**: Pastikan `wrangler` bekerja dengan baik (beberapa versi Windows membuat `npm run dev` hang). Jika iya, lakukan *deploy* sementara ke *Preview Branch* Cloudflare.
- **Error 500 saat Login**: Periksa `wrangler.toml` dan pastikan `GAS_WEB_APP_URL` berisi tautan publik `/exec` GAS Anda yang valid.
- **Dokumen Ditolak**: Pastikan tipe file adalah PDF, JPG, atau PNG dan berukuran di bawah 5 MB.

## 18. Security Notes
Aplikasi SIKAP telah lulus *Final Security Review*.
- Dilindungi dari serangan *Insecure Direct Object Reference* (IDOR) karena pemeriksaan Kepemilikan NIP dan `Role` (Admin) dilakukan secara ketat (*Server-Side*).
- Anti *Cross-Site Request Forgery* (CSRF) berkat kewajiban penyertaan Token.
- Aman dari *Formula Injection* berkat _filter_ sanitasi `escapeFormula()` di `Utils.gs`. 
- **Saran:** Opsional, enkripsi kata sandi dapat diperkuat dengan *Salting* jika dirasa perlu di masa mendatang.

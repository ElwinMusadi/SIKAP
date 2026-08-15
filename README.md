# SIKAP — Sistem Informasi Kepegawaian

SIKAP adalah aplikasi Sistem Informasi Kepegawaian berskala enterprise dengan arsitektur **Unified Architecture**, yang memisahkan frontend (Cloudflare Pages) dan backend (Google Apps Script).

## Arsitektur Proyek
- **Frontend**: Cloudflare Pages (Single Page Application SPA, Tailwind CSS)
- **Backend API**: Google Apps Script (GAS) dengan koneksi basis data ke Google Sheets & Google Drive
- **API Gateway**: Cloudflare Pages Functions (sebagai jembatan aman ke backend GAS)

## Alur Kerja Pengembangan (Git Workflow)

Cabang utama (`main`) pada repositori ini bertindak sebagai **Single Source of Truth** (Sumber Kebenaran Tunggal). **DILARANG** melakukan pengembangan secara independen pada cabang migrasi lama. Semua perubahan harus terpusat.

### Strategi Pencabangan (Branching)
Jika Anda ingin menambahkan fitur atau memperbaiki *bug*, gunakan penamaan cabang berikut:
- `feature/*` : Untuk penambahan fitur baru (contoh: `feature/export-pdf`)
- `fix/*` : Untuk perbaikan *bug* atau _error_ (contoh: `fix/login-timeout`)
- `redesign/*` : Untuk perombakan UI/UX (contoh: `redesign/dashboard-layout`)
- `refactor/*` : Untuk pengoptimalan kode tanpa mengubah fungsi (contoh: `refactor/api-calls`)

### Alur Rilis (Deployment)

```text
Feature Branch (feature/*, dll)
       ↓
Local Development (npm run dev)
       ↓
Local Testing & Verification
       ↓
Pull Request / Merge ke 'main'
       ↓
[ OTOMATIS OLEH CI/CD ]
GAS Deployment (clasp push) + Cloudflare Deployment (Pages Build)
```

**Perhatian**: Alur kerja CI/CD otomatis hanya melakukan pembaruan ke versi *Development (HEAD)* pada Google Apps Script. Untuk merilis pembaruan ke URL *Production* (`/exec`), Anda harus menjalankan `clasp deploy` secara manual.

## Perintah Pengembangan Lokal
- **Jalankan Frontend Lokal**: `npm run dev`
- **Build Frontend (Cloudflare)**: `npm run build:cloudflare`
- **Build Backend (GAS)**: `npm run build:gas`

# SIKAP Architecture

Sistem SIKAP (*Sistem Informasi Kepegawaian*) menggunakan **Unified Architecture** yang dirancang untuk menggabungkan skalabilitas dan keamanan Cloudflare Pages (sebagai lapisan statis dan Gateway) dengan fleksibilitas Google Apps Script (sebagai *Serverless Backend* & integrasi Database).

## Architecture Diagram

```mermaid
graph TD
    %% Entitas Eksternal
    User((Pengguna SIKAP))
    
    %% Lapisan Cloudflare (Frontend & Gateway)
    subgraph Cloudflare["Cloudflare Global Network (Edge)"]
        Pages[Cloudflare Pages\n(Frontend SPA)]
        Worker[Cloudflare Pages Functions\n/api/gas (API Gateway)]
    end
    
    %% Lapisan Google (Backend & Database)
    subgraph Google["Google Cloud ecosystem"]
        GAS[Google Apps Script\n(Serverless Backend /exec)]
        Sheets[(Google Sheets\nDatabase Utama)]
        Drive[(Google Drive\nPenyimpanan Dokumen)]
    end
    
    %% Alur Interaksi
    User -- "Akses Web (HTTPS)\nMengambil UI Statis (HTML/CSS/JS)" --> Pages
    User -- "Interaksi Data (AJAX POST)\nJSON Payload + Session Token" --> Worker
    
    Worker -- "Secure Proxy (text/plain)\nMeneruskan Request ke GAS" --> GAS
    
    GAS -- "CRUD Operasi (Aman)" --> Sheets
    GAS -- "Unggah/Pratinjau File" --> Drive
    
    %% Styling
    classDef cf fill:#f48120,stroke:#fff,stroke-width:2px,color:#fff;
    classDef google fill:#4285f4,stroke:#fff,stroke-width:2px,color:#fff;
    classDef db fill:#0f9d58,stroke:#fff,stroke-width:2px,color:#fff;
    
    class Pages,Worker cf;
    class GAS google;
    class Sheets,Drive db;
```

## Komponen Sistem

### 1. Frontend (Cloudflare Pages)
- **Tanggung Jawab**: Merender UI/UX menggunakan HTML5, Tailwind CSS v4, dan Vanilla JavaScript.
- **Keunggulan**: TTR (*Time to Render*) sangat cepat (~50ms) karena disajikan statis dari server CDN global Cloudflare. Tidak ada ketergantungan *runtime* pada Google Apps Script untuk merender halaman.

### 2. API Gateway (Cloudflare Pages Functions)
- **Tanggung Jawab**: Bertindak sebagai _Reverse Proxy_ untuk rute `/api/gas`. Menerima JSON dari _Frontend_, memvalidasinya, dan meneruskannya (CORS-safe) ke Google Apps Script Web App.
- **Keamanan**: Menyembunyikan URL asli GAS dari publik. Hanya memroses metode `POST`.

### 3. Backend API (Google Apps Script)
- **Tanggung Jawab**: Pusat logika bisnis (Business Logic). Menerima instruksi (berbasis `action` parameter), memverifikasi Token (Sesi) dan _Role_ (Otorisasi), lalu mengeksekusi fungsi yang sesuai melalui pola _Whitelist_.
- **Desain**: `doPost(e)` merespons semua _request_ eksternal. Semua kembalian (*return value*) dienkapsulasi ke dalam objek JSON yang terstruktur.

### 4. Database & Penyimpanan (Google Sheets & Drive)
- **Google Sheets**: Digunakan sebagai Basis Data Relasional sederhana (tabel `Data_Pegawai`, `Arsip_Dokumen`, `Sesi_Login`, `Log_Aktivitas`).
- **Google Drive**: Digunakan untuk menyimpan _blob_ dokumen biner (PDF, JPG, PNG). Diarahkan oleh ID unik yang dicatat pada *Google Sheets*.

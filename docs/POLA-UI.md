# Pola UI SIKAP (design system v2)

Panduan singkat memakai komponen dan aturan tampilan SIKAP setelah redesign (21 Oktober 2026). Latar belakang dan keputusan ada di [`RENCANA-REDESIGN-UIUX.md`](RENCANA-REDESIGN-UIUX.md). Semua pola dapat dilihat dengan data fiktif di `/_design` (hanya build dev).

## Aturan dasar

- **Warna hanya dari token** di `src/index.css`: `background`/`foreground`, `card`, `muted`, `primary` (navy), `accent-soft`, `status-*` beserta `*-muted`, dan `ink`. Jangan menulis warna mentah (`bg-[#…]`) di komponen.
- **Merah hanya untuk gagal/ditolak.** "Belum diunggah", nonaktif, dan dibatalkan tampil netral. Amber dipakai untuk menunggu atau perlu perhatian, hijau untuk berhasil atau terverifikasi.
- **Status selalu lewat registri** `src/lib/status.ts` (domain `dokumen`, `pengajuan`, `akun`, `kelengkapan`, `hasil`, `aktif`, `backup`, `log`). Tampilkan dengan `<StatusBadge domain status />`. Satu kata selalu punya satu warna dan satu ikon di semua layar; tes registri menjaga aturan ini.
- **Tipografi:** `text-display` (judul halaman), `text-h2`, `text-h3`, `text-eyebrow` (label kecil kapital), `text-metric` (angka KPI). **Impor `cn` dari `@/lib/utils`**, karena paket `cn` bawaan membuang kelas tipografi ini.
- **Elevasi:** `shadow-card` (kartu), `shadow-pop` (popover, sheet, bar melayang), `shadow-dialog`.
- **Mode gelap:** terang adalah bawaan dan tema sistem operasi diabaikan. Mode gelap hanya menyala lewat switch *Mode gelap* (menu pengguna, ⌘K, dan Akun → Tampilan), disimpan per perangkat (`src/app/theme.tsx`, `public/theme-init.js`). Setiap pasangan token lolos AA. Jangan menulis `dark:` dengan warna mentah; kalau perlu warna baru, tambahkan tokennya.

## Kerangka halaman

| Pola | Kapan dipakai |
|---|---|
| `PageHeader` (`eyebrow`, `title`, `description`, `meta`, `actions`, `back`) | Satu kali per halaman: satu `h1`, maksimal satu tombol utama dan dua tombol sekunder. Aksi lain masuk menu "…" |
| `PageBackLink` | Tautan "← Bagian" di atas judul halaman detail |
| `SectionCard` (`title`, `description`, `action`, `footer`, `flush`, `wideAction`, `headingLevel`) | Bagian berjudul di dalam halaman. Pakai `flush` bila isinya tabel atau daftar ber-padding sendiri, `wideAction` bila aksinya tombol berlabel (di ponsel aksi turun ke bawah deskripsi), dan `headingLevel="h3"` bila kartu berada di bawah `h2` lain |
| Kolom ringkasan + konten | Detail dan profil: kolom kiri `lg:sticky lg:top-20` (identitas, ringkasan, navigasi seksi), kolom kanan berisi `SectionCard` |
| Navigasi seksi | Halaman pengaturan: `Tabs` vertikal di ≥1024 px (orientasi diatur lewat `matchMedia`) dan gulir horizontal di ponsel; seksi ditautkan dengan `?bagian=` |

## Status, keadaan, dan pesan

| Pola | Kapan dipakai |
|---|---|
| `Alert` (`default` info, `pending`, `destructive`, `success`) | Callout di dalam halaman, sheet, atau dialog. Tidak punya `role` bawaan: tambahkan `role="alert"` untuk galat yang muncul setelah aksi dan `role="status"` untuk catatan yang berubah |
| `EmptyState` (`size`: `page`, `card`, `inline`) | Data kosong; sertakan satu aksi bila ada langkah berikutnya |
| `ErrorState` | Galat memuat data; selalu dengan tombol "Coba lagi" bila bisa diulang |
| `StatusPage` | 404, 403, dan galat rute. Pakai `fullScreen` di luar shell; komponen ini sekaligus menjadi `<main>` |
| `StatusBadge` / `StatusDot` | Status dari registri. `iconOnly` untuk sel yang padat (label tetap dibaca pembaca layar) |
| Toast (`sonner`) | Konfirmasi singkat setelah aksi berhasil, bukan untuk galat validasi |

## Data dan daftar

| Pola | Kapan dipakai |
|---|---|
| `DataTable` (`src/components/data-table/`) | Semua tabel. Mode klien (sort dan filter di browser) atau server (`manualSorting`, `manualPagination`). Pakai `mobileCard` untuk tampilan kartu di bawah 768 px, `density="compact"` untuk log dan referensi. Keadaan loading, kosong, tidak cocok, dan galat sudah bawaan |
| `FilterBar` | Cari + facet (chip popover di desktop, drawer di ponsel) + `extra` (mis. `DateRangePicker`) + "Atur ulang". Simpan filter di URL bila halamannya bisa ditautkan |
| `DataTablePagination` | Paginasi server (daftar pegawai). Daftar kursor memakai "Muat lebih banyak" |
| `DateRangePicker` | Rentang tanggal dengan preset; nilai diterapkan lewat tombol "Terapkan" |
| `ProgressMeter` (`full`, `compact`) | Satu-satunya visual kelengkapan dokumen; hitungannya dari `wajibCounts()` atau `countsFromSummary()` |
| `KpiCard` | Angka ringkasan; `tone="highlight"` untuk antrean yang perlu dikerjakan. `link` membuat seluruh kartu bisa diklik |
| `Timeline` | Riwayat dan aktivitas (dokumen, beranda) |

## Formulir dan overlay

| Pola | Kapan dipakai |
|---|---|
| `FormSection` + `Field*` | Kelompok field berjudul, grid 1 atau 2 kolom |
| `LockedHint` / ikon gembok | Field yang hanya bisa diubah lewat pengajuan |
| `StickySaveBar` | Simpan/batalkan di akhir formulir panjang. Bar hanya menempel di bawah layar saat ada perubahan |
| `EntitySheet` (576 px) | Buat/ubah entitas dengan lebih dari 6 field |
| `FormDialog` (512 px) | ≤ 6 field dan keputusan fokus (tolak dengan alasan) |
| `AlertDialog` | Konfirmasi tindakan yang tidak mudah dibatalkan; aksi utama memakai varian yang sesuai (`success`, `destructive`) |
| Sheet di ponsel | Selalu tambahkan `data-[side=right]:w-full` (bawaan shadcn `w-3/4` menang tanpa varian `data-[side]` yang sama) |

Tombol keputusan seragam di seluruh aplikasi: **Tolak** = outline merah, **Setujui** = `variant="success"` (hijau), dengan pintasan keyboard bila layar mendukung (Verifikasi: `A`/`R`/`J`/`K`).

## Tabs

- Tab yang mengganti isi halaman memakai `TabsContent` dengan **`forceMount`** dan `className="data-[state=inactive]:hidden"`, lalu isinya hanya dirender untuk tab aktif. Dengan begitu `aria-controls` setiap tab menunjuk ke panel yang ada, tanpa memuat data tab lain.
- Wrapper `Tabs` meneruskan `orientation` ke Radix; jangan mengatur arah hanya lewat kelas.

## Aksesibilitas (diperiksa di fase 6)

- Satu `h1` per halaman, urutan heading tanpa loncatan, dan landmark `<main>` (shell atau `StatusPage`).
- Setiap kontrol punya nama aksesibel. Tombol ikon memakai `aria-label`, input memakai `FieldLabel htmlFor`, dan placeholder bukan label. ID harus unik, termasuk ID turunan `useId()` (mis. `${id}-fonnte-token`, bukan ID yang sama dengan radio).
- Target sentuh minimal 24 px. Checkbox, radio, dan switch shadcn sudah punya perluasan area (`after:-inset-*`); tautan berdiri sendiri diberi `min-h-6`/`py-0.5`.
- Teks status di samping ikon selalu punya label teks (`sr-only` bila hanya ikon).

## Performa

- Library besar dimuat *lazy* oleh halaman yang memakainya: grafik (recharts) hanya di dashboard admin, dan `@tanstack/react-table` di chunk `tanstack-table` (hanya halaman berisi tabel).
- Chunk vendor di `vite.config.ts`: `react`, `query`, `radix`, `forms`, `tanstack-table`. Jangan menambah dependensi berat ke chunk yang dipramuat di setiap halaman.

# Rencana Redesign UI/UX — SIKAP v2

Disusun 21 Oktober 2026 dari tiga sumber: (1) penelusuran visual aplikasi lokal dengan data fiktif (`scripts/dev-seed.mjs`) di desktop 1440 px dan ponsel 375 px, (2) audit kode `src/` (±15 ribu baris, 13 fitur), (3) perbandingan dengan proyek lain pemilik (PINTU `portal-uptdkotakupang`, `laravel-finance-tracker`, `SIP-IKP`, `kalkulator-pajak`) serta mockup `UIUX Stitch/` dan `Blueprint Product/Step 06`.

Status: semua keputusan §11 disetujui pemilik (21 Okt 2026). **Fase 0–6 selesai dan di-merge ke `main`** (PR #3, 21 Okt 2026); tayang di produksi sejak 22 Okt 2026 lewat deploy otomatis pertama ([`DEPLOY.md`](DEPLOY.md)). Panduan pemakaian komponen: [`POLA-UI.md`](POLA-UI.md). Produksi hidup, jadi redesign hanya menyentuh frontend (`src/`), tanpa perubahan API, skema D1, atau perilaku bisnis.

Catatan implementasi fase 0–1:

- Token v2 ada di `src/index.css` (terang + gelap). Utilitas tipografi tersedia: `text-display`, `text-h2`, `text-h3`, `text-eyebrow`, `text-metric`. Bayangan: `shadow-card`, `shadow-pop`, `shadow-dialog`.
- **`cn` wajib diimpor dari `@/lib/utils`.** Instance di sana mengenal token-token di atas. Paket `cn` bawaan menganggap `text-eyebrow` sebagai warna, sehingga membuangnya bila digabung dengan `text-muted-foreground`. Setelah `shadcn add`, ganti impor `from "cn"`.
- Tema: `src/app/theme.tsx` (terang/gelap/sistem per perangkat) dan `public/theme-init.js` (dimuat sebelum render; CSP melarang skrip inline).
- Shell: sidebar terang dengan lockup `INSTANSI` (`src/lib/instansi.ts`) dan menu pengguna di footer yang berisi pilihan tema. Header berisi breadcrumb, palet ⌘K (`src/app/command-menu.tsx`, termasuk cari pegawai untuk Admin) dan menu tugas (`src/app/tasks-menu.tsx`). Di ponsel ada bottom nav (`src/app/mobile-nav.tsx`). Banner password default diganti pengingat ringkas di Beranda saja.
- Ukuran kontrol naik satu tingkat (+ `pointer-coarse` ≥ 40 px). `CardTitle` dirender sebagai `h2` (pakai `as="h3"` bila bersarang). Header tabel kini eyebrow berwarna lembut.
- `/_design` hanya ada di build dev. Halaman ini menghitung kontras token secara langsung; semua lolos di terang dan gelap.

Catatan implementasi fase 2 (pustaka pola, diperagakan di `/_design` dengan data fiktif):

| Pola | Berkas |
|---|---|
| Registri status | `src/lib/status.ts`, plus `StatusBadge`/`StatusDot` di `src/components/status-badge.tsx`. `PengajuanStatusBadge`, `StatusAkunBadge`, dan `KELENGKAPAN_STYLE` kini membaca registri |
| Header halaman | `PageHeader` v2 (`back`, `eyebrow`, `meta`, `actions`) |
| Kartu dan keadaan | `SectionCard`, `EmptyState`/`ErrorState` (`src/components/states.tsx`) |
| Ringkasan dan aktivitas | `KpiCard`, `ProgressMeter` + `src/lib/progress.ts`, `Timeline` |
| Tabel | `src/components/data-table/`: `DataTable` (TanStack Table v9, mode klien/server, kartu ponsel, keadaan bawaan), `SortableHeader`, `DataTablePagination`, `FilterBar` (chip facet di desktop, drawer di ponsel) |
| Formulir | `src/components/form-patterns.tsx`: `FormSection`, `LockedHint`, `StickySaveBar`, `EntitySheet` (576 px), `FormDialog` (512 px) |

Tes baru: registri status (4), progres (3), dan util tabel (6). Halaman fitur belum dipindah ke pola ini; pemindahan dilakukan di fase 3–5.

Catatan implementasi fase 3 (layar Admin utama, tanpa perubahan API):

| Layar | Isi |
|---|---|
| Beranda Admin | `src/features/beranda/admin-dashboard.tsx`: KPI (pegawai aktif, menunggu verifikasi, pengajuan, kelengkapan instansi), grafik batang kelengkapan dan donat komposisi pegawai, antrean 5 teratas, aksi cepat, kartu password default, linimasa aktivitas. Admin melihat tab **Instansi** / **Data saya**. Dashboard dimuat *lazy* agar recharts (±360 kB) tidak ikut terunduh oleh pegawai; chunk Beranda kini ±14 kB |
| Master Data Pegawai | `DataTable` mode server (sort + paginasi di URL), `FilterBar` (status, akun, kelengkapan, belum unggah) + tombol "Password default", kartu di ponsel, menu "…" per baris. `?tambah=1` membuka sheet tambah pegawai |
| Detail Pegawai | Header dengan avatar, badge meta, menu "…" untuk aksi akun, tab Profil/Dokumen/Pengajuan memakai `SectionCard`, `ProgressMeter`, `EmptyState`/`ErrorState` |
| Verifikasi Dokumen | Workspace 3 panel di ≥1280 px (antrean · pratinjau · keputusan); 1024–1279 px: pratinjau + kolom kanan; ponsel: daftar + sheet penuh. Penanda lama menunggu (amber ≥ 3 hari), filter jenis di panel antrean, toolbar pratinjau ringkas, tombol **Setujui** hijau (varian `success` baru di `Button`) / **Tolak** merah, label "Setujui & lanjutkan", pintasan `A`/`R`/`J`/`K` (+ `Kbd` di tombol). Tautan `?arsip=<id>` dari Beranda dan detail pegawai langsung memilih dokumen |

Ditunda karena butuh data baru dari API (fase berikutnya, bila disetujui): grafik kelengkapan **per unit**, tren unggahan, dan riwayat dokumen sejenis di panel keputusan Verifikasi. Tes baru: deep link, lama menunggu, dan label waktu ringkas di `verifikasi-utils` (3).

Catatan implementasi fase 4 (layar pegawai, tanpa perubahan API):

| Layar | Isi |
|---|---|
| Beranda Pegawai | `ProgressMeter` kelengkapan wajib (dihitung dari `/me/documents`), **daftar tugas berurutan** (`src/features/beranda/pegawai-tasks.ts`: lengkapi data diri → status kepegawaian → perbaiki ditolak → unggah wajib → menunggu, sisa di luar 5 prioritas diringkas), kartu data diri, dokumen terbaru, dan status pengajuan perubahan. Admin melihat hal yang sama di tab "Data saya" |
| Arsip Dokumen | Menu **"Unggah dokumen"** di header (yang perlu diunggah lebih dulu, lalu "Ganti file"), `ProgressMeter`, satu callout profil belum lengkap, tab Wajib/Opsional, **grid kartu per jenis** (ikon bertone status, versi, file, catatan penolakan, aksi utama + menu "…"); tampilan tabel tersedia di desktop dan diingat per perangkat. Sheet pratinjau: riwayat memakai `Timeline`, keadaan kosong/galat standar |
| Profil Pegawai | Kolom kiri menempel (foto + crop, NIP, chip, data diri terisi, pangkat/jabatan/unit, navigasi seksi); kanan: Identitas → Kepegawaian (baca saja + gembok + "Ajukan perubahan") → Kontak → Riwayat pengajuan, `StickySaveBar`. `/profil#kepegawaian` langsung ke seksinya |
| Pengaturan Akun | Navigasi seksi; Keamanan (indikator kekuatan bersegmen + daftar syarat), Sesi aktif ("Keluarkan semua"), **Tampilan** (Terang/Gelap/Ikuti perangkat), Informasi akun |
| Login | Foto kantor dengan overlay tinta (token tetap `ink`, tidak ikut mode gelap), "SIKAP" display, kartu `shadow-pop` dengan `h1`, input 40 px, petunjuk lupa password. Di ponsel lambang di atas |

Perbaikan pola: `StickySaveBar` hanya menempel saat ada perubahan dan teks statusnya tidak lagi menimpa tombol di layar sempit; `SectionCard` punya `wideAction` (aksi berlabel pindah ke bawah deskripsi di ponsel); `SelectControl` meneruskan `ref` agar select yang tidak valid mendapat fokus; sheet pratinjau dokumen dan form pegawai kini selebar layar di ponsel. QA: tanpa overflow horizontal di 375 px, tata letak 1440 px diukur, dan pemindaian kontras otomatis seluruh teks keempat layar lolos AA di terang dan gelap. Tes baru: `pegawai-tasks` (3) dan ringkasan dokumen di `dokumen-utils` (3).

Catatan implementasi fase 5 (layar admin sekunder, tanpa perubahan API):

| Layar | Isi |
|---|---|
| Pengajuan Perubahan | Tab status dengan hitungan, `DataTable` (pegawai, data yang diubah sebagai chip, diajukan, status + tanda "Data berubah"), kartu di ponsel. **Sheet tinjauan**: alasan pegawai, diff berdampingan lama → diajukan (`PerubahanDiff`), riwayat tinjauan, tautan ke data pegawai, tombol **Tolak** merah / **Setujui** hijau seragam dengan Verifikasi; tolak memakai `FormDialog` |
| Log Aktivitas | `FilterBar` (cari, Kategori, Hasil) + **`DateRangePicker`** baru (preset Hari ini/7/30 hari, Terapkan/Hapus), `DataTable` rapat dengan ikon kategori dan `StatusBadge` domain `log`, kartu di ponsel, "Muat lebih banyak" tetap. Kode aksi server kini dipetakan ke kategori dan diberi nama yang terbaca ("Setujui pengajuan"); kode mentah tetap di tooltip |
| Jenis Dokumen | `FilterBar` sisi klien (cari nama/ID, Kategori, Wajib untuk, Status), `DataTable` dengan urutan, **matriks wajib** berupa chip bertanda centang per status kepegawaian; di dialog, pilihan wajib berupa kartu. Logika simpan/409/konfirmasi tidak berubah |
| Pengaturan Sistem | Navigasi seksi di kiri (vertikal ≥1024 px, gulir horizontal di ponsel), seksi bisa ditautkan dengan `?bagian=whatsapp|referensi|backup`. Referensi: tiga `DataTable` + kartu ponsel. Backup: status dari registri (domain `backup`), riwayat berupa tabel di desktop dan kartu di ponsel, callout menggantikan Alert |
| 404 / 403 / galat | `StatusPage` (`src/components/status-page.tsx`): ilustrasi garis tipis, kode kecil, tombol Kembali/Ke Beranda; dipakai `NotFound`, `RequireRole`, dan galat rute |

Catatan implementasi fase 6 (poles, tanpa perubahan API):

- **Callout seragam:** `Alert` kini punya varian `default` (info), `pending`, `destructive`, dan `success` sesuai registri status, tanpa `role="alert"` bawaan (role dipasang hanya untuk galat setelah aksi). Callout buatan sendiri dari fase 3–5 diganti `Alert`.
- **Kode mati dihapus:** `coming-soon.tsx`, serta komponen shadcn yang tak terpakai `empty`, `item`, `hover-card`, `scroll-area`. Sisa `bg-primary/5` diganti `bg-accent-soft`.
- **Audit aksesibilitas otomatis** di semua layar (ponsel dan desktop, termasuk dialog/sheet terbuka): nama aksesibel, label form, alt gambar, ID ganda, referensi ARIA, urutan heading, satu `h1`, landmark, interaktif bersarang, `tabindex` positif, dan ukuran target. Temuan yang diperbaiki: `aria-controls` tab yang menunjuk panel tidak ada (pola `forceMount`), ID ganda radio/token di Pengaturan WhatsApp (label token menempel ke radio), 404 tanpa `<main>`, serta tinggi `PageBackLink` dan tautan nama di kartu pegawai (kini ≥ 24 px). Pengecualian yang disengaja: elemen latar dalam `aria-hidden` saat dialog Radix terbuka (fokus terkunci di dialog), dan kontrol 16 px yang sudah punya area sentuh `after:-inset-*`. Pemeriksaan ini mengikuti aturan utama axe, tetapi bukan axe/Lighthouse lengkap.
- **QA ponsel dan mode gelap:** tanpa overflow horizontal di 375 px dan kontras teks lolos AA di terang maupun gelap pada semua layar pegawai dan admin, termasuk login, 403, dan 404.
- **Performa:** `@tanstack/react-table` dipisah dari chunk `query` yang dipramuat di setiap halaman, sehingga muatan awal turun ±41 kB (12,7 kB gzip). Grafik tetap *lazy* (hanya dashboard admin).
- **Dokumentasi pola:** [`POLA-UI.md`](POLA-UI.md).
- Tidak dikerjakan (opsional di §9): tab *Tampilan* tingkat instansi di Pengaturan Sistem. Preferensi tema per perangkat sudah ada di Pengaturan Akun.

Perbaikan pola fase 5: wrapper shadcn `Tabs` kini meneruskan `orientation` ke Radix (sebelumnya hanya atribut data, sehingga tombol panah dan `aria-orientation` selalu horizontal). Registri status bertambah domain `log` dan `backup`. QA: alur setujui pengajuan diuji ujung ke ujung dengan data fiktif lokal, filter rentang tanggal tersimpan di URL, pemindaian kontras otomatis semua layar fase 5 lolos AA di terang dan gelap. Tes baru: registri (2 domain), `filterJenis` (2), nama/kategori aksi log (1).

---

## 1. Ringkasan

SIKAP sebenarnya sudah memakai stack yang sama dengan proyek-proyek Anda: React 19, Vite 8, Tailwind 4, shadcn/Radix, TanStack Query, RHF + Zod, dan sonner. Warnanya juga sudah memakai token, tanpa warna hardcode di kode fitur. Tampilannya terasa tidak rapi karena **±12 layar menyelesaikan masalah yang sama dengan cara masing-masing**:

- 3 model paginasi, 4 gaya hitungan tab, dan 7 peta warna status.
- 5 cara menggambar "kelengkapan", 56 Alert, dan peringatan password default yang muncul 3 kali.

Tampilan terasa kurang *high-end* karena tiga hal:

- Permukaannya datar: kartu hanya memakai `ring-1` tanpa elevasi di atas latar `#f8f9ff`.
- Kontrolnya kecil: tombol 32 px, `sm` 28 px, dan `size="sm"` dipakai 82 kali.
- Hierarki huruf rata: judul halaman 24/600, judul kartu 16/500, dan `text-xs` dipakai 79 kali.

**Rekomendasi utama:**

1. **Tidak ganti stack.** Lengkapi dengan pustaka yang sudah Anda pakai di PINTU dan finance-tracker:
   - `@tanstack/react-table` untuk tabel;
   - `recharts` lewat shadcn `chart` untuk grafik;
   - `cmdk` lewat shadcn `command` untuk palet perintah ⌘K;
   - opsional `vaul` untuk drawer di ponsel.
2. **Design system baru yang sekeluarga dengan PINTU**: sidebar terang berwarna "kertas", tinta gelap untuk teks, **satu aksen navy SIKAP**, garis rambut, elevasi lembut, dan angka tabular. Dengan begitu SIKAP dan PINTU terasa satu keluarga produk UPTD.
3. **Satu pustaka pola**: `PageHeader`, `DataTable`, `FilterBar`, `KpiCard`, `ProgressMeter`, satu registri status, `EmptyState`, `SectionCard`, dan aturan Sheet/Dialog. Setiap halaman lalu disusun ulang memakai pola ini.
4. **Dashboard sungguhan**: KPI dengan grafik kelengkapan per unit dan status dokumen, antrean verifikasi, dan linimasa aktivitas. Kartu pintasan yang menduplikasi sidebar dibuang.
5. **Mode gelap** dan skala kontrol satu tingkat lebih besar. Setelah itu, opsional, pengaturan **Tampilan** untuk Admin seperti D-057 di PINTU.

---

## 2. Stack frontend saat ini vs proyek lain

| Aspek | SIKAP sekarang | PINTU (dashboard) | finance-tracker | Rekomendasi SIKAP |
|---|---|---|---|---|
| Framework | React 19.3 + Vite 8.3 SPA | React 19.3 + Vite 8.3 (di Laravel) | React 19 + Inertia | Tetap |
| CSS | Tailwind 4.3, `tw-animate-css` | sama | sama | Tetap |
| Komponen | shadcn 4 style `radix-nova`, `radix-ui` | shadcn new-york (`radix-ui`) | shadcn `radix-vega`, baseColor stone | Tetap `radix-ui`; ukuran kontrol dinaikkan lewat token, tanpa ganti style |
| Ikon | lucide | lucide + tabler | tabler + lucide | **Tetap lucide**, sudah konsisten di 13 fitur |
| Tabel | `Table` shadcn + logika manual per halaman | **TanStack Table 9** | TanStack Table 9 | **Tambah TanStack Table** |
| Grafik | tidak ada; token `--chart-*` tidak dipakai | **recharts 3** | recharts 3 | **Tambah recharts** lewat shadcn `chart` |
| Palet perintah | tidak ada | **cmdk** (`command-menu.tsx`) | — | **Tambah** |
| Tema | terang saja; `.dark` ada tapi "Not used"; sonner dikunci `light` | `theme-provider` + mode gelap + tema Admin (D-057) | `next-themes` | **Theme provider sendiri** (tanpa next-themes) + mode gelap |
| Huruf | Inter Variable | SF Pro (font sistem) | Inter, Manrope, IBM Plex | Inter Variable (lihat §5.2) |
| Data | TanStack Query 5, RHF 7 + Zod 4 | sama | — | Tetap |

---

## 3. Temuan utama (bukti visual + audit kode)

Diurutkan menurut dampak visual. Path relatif ke `src/`.

| # | Masalah | Bukti |
|---|---|---|
| 1 | Permukaan datar, tanpa elevasi; kartu menyatu dengan latar | `components/ui/card.tsx:14` hanya `ring-1 ring-foreground/10` |
| 2 | Kontrol kecil (28–32 px), teks banyak 12 px | `ui/button.tsx:24,26`; `size="sm"` dipakai 82 kali; `text-xs` 79 kali |
| 3 | Sidebar navy padat: status aktif sama dengan hover, badge navy di atas navy | `ui/sidebar.tsx:469`, `app/app-shell.tsx:127` |
| 4 | Hierarki tipografi rata; ada 5 ukuran "angka besar" | `page-header.tsx:13` (24/600); `CardTitle` 16/500 dan berupa `div`, bukan heading; `text-lg`…`text-4xl` untuk angka |
| 5 | Banner kuning "password default" di **setiap** halaman, ditambah 2 kali lagi di beranda/akun; memakan lipatan pertama, terutama di ponsel | `app-shell.tsx:255`, `akun-page.tsx:199`, `beranda-page.tsx:279` |
| 6 | Beranda Admin: 4 kartu pintasan menduplikasi sidebar dan KPI; tidak ada grafik; dashboard pegawai diulang di bawahnya | `beranda-page.tsx:86`, `62-65` |
| 7 | "Kelengkapan" digambar 5 cara (cincin SVG, bar, persen besar, chip); label sama "Belum diunggah" dengan hitungan berbeda | `beranda:464,224`, `dokumen-page:191`, `pegawai-detail:383`, `pegawai-ui:89`; `beranda:383` vs `dokumen-page:225` |
| 8 | Pola list/filter/paginasi terpecah: tabel + kartu ponsel, daftar tombol, satu kartu per item, `Item`; 3 model paginasi; filter berlabel vs tanpa label; sort hanya di daftar pegawai | `pegawai-list-page:611`, `log-page:113`, `admin-pengajuan-page:113`, `verifikasi-page:449` |
| 9 | Warna/ikon status berubah-ubah: 7 peta tone, 9 helper badge; "Nonaktif" merah di satu tempat dan abu di tempat lain; "Ditolak" memakai dua ikon berbeda | `status-badge.tsx:8`, `pengajuan-ui.tsx:17-21`, `pegawai-ui.tsx:35`, `jenis-dokumen-page.tsx:131`, `backup-panel.tsx:335` |
| 10 | Permukaan edit campur aduk: Sheet/Dialog/inline, 3 lebar dialog, 3 lebar sheet; tombol utama kadang kanan, kadang kiri; huruf kapital tidak seragam | `akun-page:240` vs `pengaturan-page:318`; "Simpan Perubahan" vs "Simpan perubahan" |
| 11 | Chip ringkasan terpotong ("Terve…", "Menu…", "Belu…") di Arsip Dokumen | tangkapan layar `/dokumen` 1440 px |
| 12 | Header atas tipis: tanpa logo/nama aplikasi (diminta Blueprint), tanpa pencarian; nama instansi berbeda antara sidebar dan login | `app-shell.tsx:100` vs `login-page.tsx:21` |
| 13 | Ponsel: tanpa bottom nav (diminta Blueprint); tabel referensi/backup tanpa layout ponsel; target sentuh 24–28 px | `referensi-panel.tsx:201`, `backup-panel.tsx:348` |
| 14 | Mode gelap belum tersambung | `index.css:118-161`, `ui/sonner.tsx:8` |

Hal yang **sudah baik** dan dipertahankan: semua warna lewat token, Skeleton untuk loading, Alert + "Coba lagi" untuk galat, AlertDialog untuk aksi destruktif, tombol ikon berlabel, *skip link*, dan validasi berbasis Zod.

---

## 4. Arah desain: "Arsip Institusional yang Tenang"

Prinsip, dipakai sebagai alat uji setiap layar:

1. **Satu aksen.** Navy SIKAP hanya untuk aksi utama, fokus, status aktif, tautan, dan seri grafik pertama. Sisanya netral.
2. **Hierarki lewat tipografi dan ruang, bukan warna.** Judul tegas, label kecil huruf besar, angka tabular.
3. **Permukaan berlapis.** Latar kertas, kartu putih dengan garis rambut dan bayangan sangat tipis, popover/dialog sedikit lebih tinggi.
4. **Status selalu ikon + label + warna**, dari satu registri.
5. **Satu tugas utama per layar.** Peringatan non-blokir menjadi indikator kecil, bukan banner.
6. **Padat tapi lega.** Tabel cukup rapat untuk 46+ pegawai, tetapi kontrol nyaman disentuh (≥ 36 px desktop, ≥ 40 px ponsel).
7. **Sekeluarga dengan PINTU**: kertas hangat, tinta, garis rambut, dan lambang NTT. SIKAP tetap punya warna aksen sendiri (navy) supaya pegawai langsung mengenalinya.

Referensi rasa: dashboard shadcn "dashboard-01", Linear, Stripe Dashboard, dan dashboard PINTU. Tenang, rapi, dan tidak ramai gradasi.

---

## 5. Design system baru

Satu sumber kebenaran: `src/index.css`, berisi token `:root` dan `.dark`. Halaman panduan hidup `/_design` hanya ada di build dev, berisi semua token dan komponen. Halaman ini dipakai untuk QA visual dan tidak di-deploy.

### 5.1 Warna (terang)

| Token | Nilai | Fungsi |
|---|---|---|
| `--background` | `#F7F6F2` | Latar aplikasi (kertas hangat, sama dengan sidebar PINTU) |
| `--card` / `--popover` | `#FFFFFF` | Kartu, tabel, dialog |
| `--foreground` | `#0F1319` | Teks utama (tinta) |
| `--muted-foreground` | `#5E646C` | Teks pendukung (5,52:1 di kertas, 5,97:1 di putih) |
| `--border` | `#E7E4DC` | Garis rambut |
| `--input` | `#868B94` | Batas input (3,42:1 di putih, lolos kontras non-teks 3:1) |
| `--primary` | `#1E3A8A` | **Aksen navy SIKAP**: tombol utama, status aktif, fokus |
| `--primary-hover` | `#1A3178` | Hover tombol utama |
| `--accent-soft` | `#EEF2FB` | Latar item aktif sidebar, baris terpilih, chip filter aktif |
| `--ring` | `#3B5BDB` | Cincin fokus (2 px + offset 2 px) |
| `--sidebar` | `#F2F0EA` | Sidebar terang (bukan navy lagi) |
| `--chart-1…5` | `#1E3A8A`, `#4C6EF5`, `#6E85DA`, `#A87C12`, `#5E646C` | Seri grafik (navy dulu, emas untuk sorotan); semua ≥ 3:1 di kartu putih dan kertas |

Warna status, satu registri (`src/lib/status.ts`) dengan ikon tetap:

| Status | Teks / latar lembut | Ikon | Catatan |
|---|---|---|---|
| Terverifikasi / Aktif / Berhasil | `#1A7349` / `#E3F2EA` | `CircleCheck` | |
| Menunggu / Diproses | `#8C5900` / `#F8EED9` | `Clock` | |
| Ditolak / Gagal / Dibatalkan | `#B93A28` / `#F9E4DF` | `CircleX` | Merah hanya untuk keadaan gagal/ditolak |
| Belum diunggah / Nonaktif / Draft | `#5E646C` / `#EFEDE6` | `CircleDashed` | **Netral**, bukan merah. Pegawai baru tidak lagi melihat layar penuh merah |
| Perlu revisi | `#8C5900` / `#F8EED9` | `RotateCcw` | |

Mode gelap: latar `#0D0E11`, kartu `#141519`, garis `#26272C`, teks `#F4F4F3`, aksen `#8FA8FF`, dan status versi terang yang dicek ulang kontrasnya. Semua pasangan diuji ≥ WCAG AA.

### 5.2 Tipografi

- **Inter Variable** tetap dipakai: sudah terpasang, tampil sama di Windows, Android, dan Apple, dan angka tabularnya bagus untuk NIP dan tabel. *Alternatif*: tumpukan font sistem SF Pro seperti PINTU (lihat §11).
- Skala (rem, dasar 16 px):

| Peran | Ukuran / tinggi baris / bobot | Pemakaian |
|---|---|---|
| Display | 30/36, 600, tracking −0.02em | Judul halaman (`h1`) |
| H2 | 20/28, 600 | Judul seksi/kartu (`h2`; `CardTitle` dirender sebagai heading) |
| H3 | 16/24, 600 | Subjudul dalam kartu, judul sheet/dialog |
| Body | 14/22, 400 | Teks dan isi tabel |
| Small | 13/20, 400 | Keterangan, meta |
| Eyebrow | 11/16, 600, UPPERCASE, tracking 0.08em | Label seksi, header tabel |
| Metric | 28–32/1.1, 600, `tabular-nums` | Angka KPI |

- NIP dan angka di tabel memakai `tabular-nums`, **bukan monospace**, supaya NIP tidak terlihat seperti kode.
- Teks kecil minimal 12 px. Hanya badge dan eyebrow yang boleh 11–12 px.

### 5.3 Ruang, sudut, elevasi, gerak

- Basis 4 px. Jarak antarseksi halaman 32 px, dalam kartu 20–24 px, dan header halaman ke konten 24 px.
- Radius: `--radius: 0.625rem` (10 px): kartu 12, input/tombol 8, badge pil 999.
- Elevasi:
  - `e0`: garis rambut;
  - `e1` (kartu): `0 1px 2px rgb(15 19 25 / 0.04), 0 1px 3px rgb(15 19 25 / 0.06)`;
  - `e2` (popover/sheet): `0 8px 24px rgb(15 19 25 / 0.10)`;
  - `e3` (dialog): `0 16px 48px rgb(15 19 25 / 0.14)`.
- Ukuran kontrol:
  - desktop: `default` 36 px, `sm` 32 px, `lg` 40 px, ikon 36 px;
  - ponsel: semua ≥ 40 px.
- Gerak: 150 ms untuk hover/tekan, 200 ms untuk popover/akordeon, 250 ms untuk sheet. Easing `cubic-bezier(.2,.7,.2,1)`. Semua dimatikan pada `prefers-reduced-motion`.

---

## 6. Kerangka aplikasi (shell) baru

```text
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ [Lambang]    │ Beranda › Master Data Pegawai          [⌘K Cari…] [🔔 3] (AS▾) │
│ SIKAP        ├───────────────────────────────────────────────────────────────┤
│ UPTD …Kupang │ EYEBROW                                                       │
│              │ Judul Halaman                                [Aksi sekunder] [Aksi utama] │
│ MENU UTAMA   │ Deskripsi singkat satu baris.                                 │
│ ● Beranda    │ ───────────────────────────────────────────────────────────── │
│   Profil     │  konten (max-w-screen-2xl untuk data, max-w-3xl untuk formulir) │
│   Arsip      │                                                               │
│ ADMINISTRASI │                                                               │
│   Pegawai    │                                                               │
│   Verifikasi 4│                                                              │
│   …          │                                                               │
│ ───────────  │                                                               │
│ (AS) Admin ▾ │                                                               │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- **Sidebar terang** (`--sidebar` kertas) dengan lockup lambang NTT + "SIKAP" + nama instansi yang **seragam** ("UPTD Pendapatan Daerah Wilayah Kota Kupang", disimpan di satu konstanta).
  - Item aktif berupa pil `--accent-soft` + teks dan ikon navy + garis indikator 2 px. Hover cukup latar tipis, sehingga jelas berbeda dari aktif.
  - Badge hitungan (verifikasi, pengajuan) berupa pil amber kecil.
  - Bisa diciutkan ke mode ikon (shadcn `collapsible="icon"`) dengan tooltip.
- **Header atas:**
  - breadcrumb;
  - **palet perintah ⌘K** (lompat ke halaman, cari pegawai by nama/NIP, aksi cepat "Tambah pegawai", "Unggah dokumen");
  - **ikon tugas/notifikasi** berisi antrean verifikasi, pengajuan, dan pengingat password default;
  - menu pengguna (Profil, Pengaturan akun, Tema terang/gelap/sistem, Keluar).
- **Peringatan password default**: dihapus dari semua halaman. Diganti satu titik amber di avatar + item di menu tugas + satu kartu di Beranda. Banner penuh hanya bila suatu aksi benar-benar diblokir.
- **Ponsel:**
  - header ringkas dengan lambang;
  - **bottom navigation** 4–5 item: Beranda, Dokumen, Profil, (Admin: Verifikasi, Pegawai), Lainnya. Item "Lainnya" membuka sheet berisi menu lengkap;
  - filter dalam drawer;
  - aksi utama menjadi tombol mengambang hanya pada daftar.
- **Template halaman** (wajib, tidak ada lagi pola sendiri-sendiri):
  1. **Dashboard**: grid KPI → grafik → daftar kerja.
  2. **Daftar**: `PageHeader` → `FilterBar` → `DataTable` → paginasi seragam.
  3. **Detail**: header entitas (avatar, nama, NIP, status, aksi utama + menu "…") → tab → kartu seksi.
  4. **Formulir/Pengaturan**: navigasi seksi kiri (desktop) / tab (ponsel) → `SectionCard` → bilah simpan menempel.

---

## 7. Pustaka pola (dibangun sekali, dipakai semua fitur)

| Komponen | Isi | Menggantikan |
|---|---|---|
| `PageHeader` v2 | eyebrow/breadcrumb, `h1`, deskripsi, slot aksi (maks. 1 utama + 2 sekunder + menu "…") | 4 pola header; header detail pegawai dengan 5 tombol |
| `DataTable` (TanStack Table) | header *sticky* berwarna lembut + eyebrow, sort, kolom bisa disembunyikan, pilih baris, aksi baris (menu "…" + 1 aksi primer opsional), kepadatan nyaman/rapat, **render kartu otomatis di ponsel**, skeleton baris, empty/error bawaan | tabel manual di pegawai, dokumen, log, jenis, referensi, backup, verifikasi, dan pengajuan |
| `DataTablePagination` | satu model: nomor halaman + ukuran halaman (server-side bila API mendukung; "Muat lebih banyak" hanya untuk log/linimasa) | 3 model paginasi |
| `FilterBar` | pencarian + *faceted filter* berbentuk chip (Popover + Command) + "Reset", label konsisten; di ponsel menjadi drawer | 2 gaya bar filter |
| `KpiCard` | eyebrow, angka metric, delta/keterangan, ikon, tautan "Lihat", varian sorotan (amber) | 2 gaya tile statistik |
| `ProgressMeter` | **satu** visual kelengkapan: bar tersegmen (terverifikasi/menunggu/ditolak/belum) + legenda + persen; varian ringkas untuk sel tabel | 5 visual kelengkapan |
| `StatusBadge` + `lib/status.ts` | registri tunggal: status → label, tone, ikon | 7 peta tone, 9 helper |
| `SectionCard` | judul sebagai `h2`, deskripsi, aksi kanan, isi, footer | `Card` + `CardTitle` div |
| `EmptyState` / `ErrorState` | ikon dalam lingkaran lembut, judul, kalimat, aksi; ukuran halaman/kartu/sel | 4 gaya kosong, galat tanpa retry |
| `FormSection` + `StickySaveBar` | grid formulir 2 kolom, penanda bidang terkunci (ikon gembok), bilah simpan dengan status "Semua perubahan tersimpan" | dua set helper bidang (`profil-page` vs `pegawai/fields`) |
| `EntitySheet` / `FormDialog` | **aturan**: buat/ubah entitas dengan > 6 bidang → Sheet kanan (lebar tetap `sm:max-w-xl`); ≤ 6 bidang → Dialog `sm:max-w-lg`; destruktif → AlertDialog; tombol utama **selalu kanan** | 3 lebar dialog, 3 lebar sheet, posisi tombol campur |
| `Timeline` | aktivitas dengan ikon tindakan, aktor, waktu relatif + WITA | daftar aktivitas ad hoc |
| `CommandMenu` | ⌘K global | baru |
| `ThemeProvider` + `ThemeToggle` | terang/gelap/sistem, disimpan per perangkat (`localStorage`, dengan try/catch) | sonner terkunci `light` |
| `Chart` (shadcn + recharts) | area/bar/donut dengan token `--chart-*`, tooltip berbahasa Indonesia | token grafik tak terpakai |

Panduan teks: kalimat biasa (sentence case) untuk tombol dan judul ("Simpan perubahan"), elipsis "…", kata "Ubah" (bukan "Edit"), dan waktu selalu "21 Okt 2026, 13.45 WITA".

---

## 8. Redesign per halaman

| Layar | Sekarang | Setelah redesign |
|---|---|---|
| **Login** | Panel foto + kartu, tanpa heading | Panel kiri: foto Kantor SAMSAT dengan overlay tinta (bukan gradien biru), lambang, "SIKAP" sebagai display, nama instansi. Kanan: kartu `e2` dengan `h1`, input 40 px, tautan "Lupa password? Hubungi Admin TU". Di ponsel lambang di atas. |
| **Beranda Admin** | 4 pintasan + 4 KPI kecil + aktivitas + kartu keamanan + dashboard pegawai diulang | Baris KPI (Pegawai aktif per status, Antrean verifikasi = sorotan amber, Pengajuan menunggu, Kelengkapan instansi %). Grafik: **kelengkapan per unit** (bar bertumpuk) dan **unggahan 30 hari** (area). Kolom kanan: antrean verifikasi (5 teratas, "Lihat semua"), Aksi cepat, Linimasa aktivitas. Kartu keamanan menjadi KPI "Akun password default" dengan tautan ke daftar terfilter. Dashboard pribadi admin dipindah ke tab "Data saya". |
| **Beranda Pegawai** | Cincin SVG, kartu profil, 4 tile, daftar prioritas | Kartu sambutan dengan `ProgressMeter` besar, **daftar tugas berurutan** (lengkapi profil → unggah dokumen wajib X → perbaiki dokumen ditolak) dengan tombol langsung, ringkasan dokumen terbaru, status pengajuan. |
| **Master Data Pegawai** | Tabel + filter tanpa label + paginasi sendiri | `DataTable`: kolom Pegawai (avatar, nama, NIP tabular), Status kepegawaian + golongan (digabung, sesuai mockup), Unit/Jabatan, Kelengkapan (`ProgressMeter` ringkas), Akun (badge). `FilterBar` faceted (status, kelengkapan, akun, belum unggah), simpan filter di URL. Tab Aktif/Terhapus sebagai *segmented control*. |
| **Detail Pegawai** | Kartu header dengan 5 tombol, `h1` 20 px | Header entitas (avatar 64, nama `h1`, NIP, chip status, 1 aksi utama "Ubah data" + menu "…" untuk reset password/nonaktifkan/hapus). Tab: Ringkasan (kolom kiri ringkasan pangkat/unit/masa kerja seperti mockup), Dokumen (grid kartu jenis dokumen dengan status), Riwayat, Pengajuan. |
| **Verifikasi Dokumen** | Split 60/40, daftar tombol kustom | **Workspace 3 panel**: antrean kiri (filter jenis, tanda waktu tunggu), pratinjau tengah (fit-to-screen, zoom, halaman), panel keputusan kanan (data pegawai, "Status saat ini", riwayat dokumen jenis ini, **Setujui** hijau / **Tolak** merah + alasan template). Tombol "Setujui & lanjutkan", pintasan keyboard `A`/`R`/`J`/`K`. Di ponsel: antrean → sheet penuh. |
| **Arsip Dokumen (pegawai)** | Kartu ringkas dengan chip terpotong, Alert kuning panjang, tabel | Header + tombol "Unggah dokumen". `ProgressMeter` + legenda (tanpa terpotong). Bila profil belum lengkap: **satu** callout ringkas berisi daftar bidang dalam chip dan tombol "Lengkapi profil". **Grid kartu per jenis dokumen** (ikon jenis, wajib/opsional, status, versi terakhir, aksi Unggah/Lihat/Ganti); daftar tabel tersedia sebagai mode tampilan kedua. |
| **Profil Pegawai** | Kartu orang, Alert, tab, dua kartu formulir | Kolom kiri menempel: avatar + crop, nama, NIP, chip, `ProgressMeter` profil, ringkasan kepegawaian. Kanan: `FormSection` Identitas, Kontak, Kepegawaian (baca saja dengan ikon gembok + tombol "Ajukan perubahan"). Urutan tab sama dengan sheet admin. `StickySaveBar`. |
| **Pengaturan Akun** | Grid formulir password, info, sesi | Template Pengaturan: seksi Keamanan (ganti password + indikator kekuatan), Sesi aktif (tabel ringkas, "Keluar dari semua perangkat"), Tampilan (tema). |
| **Pengajuan Perubahan** | Satu kartu per item, tanpa paginasi, batas 100 | `DataTable` (pegawai, bidang yang diubah, diajukan, status) + **Sheet tinjauan** berisi diff berdampingan (lama → baru) dan tombol Setujui/Tolak seragam dengan Verifikasi. |
| **Log Aktivitas** | Filter berlabel, tabel, "Muat lebih banyak" | `FilterBar` (rentang tanggal sebagai satu *date range picker*), `DataTable` rapat dengan ikon kategori; mode Linimasa opsional; ekspor CSV untuk Admin. |
| **Jenis Dokumen** | Tabel + dialog dengan konfirmasi inline | `DataTable` + `FormDialog`; matriks wajib per status kepegawaian dalam tabel centang yang jelas; nonaktifkan lewat AlertDialog. |
| **Pengaturan Sistem** | Tab dengan lebar `max-w-3xl` ad hoc | Template Pengaturan dengan navigasi seksi kiri: Notifikasi, WhatsApp, Referensi (pangkat, unit sebagai `DataTable` + dialog), Backup (status job, tabel riwayat responsif), **Tampilan** (fase opsional). |
| **404/403/galat** | `Empty` layar penuh | `ErrorState` dengan ilustrasi garis tipis, tautan kembali ke Beranda, dan kode galat kecil. |

---

## 9. Mode gelap, tema, aksesibilitas

- **Mode gelap** penuh: token `.dark`, `ThemeProvider` berbasis kelas (`html.dark`), sonner mengikuti tema, dan grafik memakai token. Pilihan disimpan per perangkat.
- **Tema Admin** (opsional, fase 6): tab *Tampilan* di Pengaturan Sistem, mencontoh PINTU D-057. Isinya pilihan aksen (dengan turunan yang dipaksa lolos kontras AA), kelengkungan sudut, kepadatan tabel, dan skala 90–110%. Disimpan di D1 lewat API pengaturan. Butuh perubahan backend kecil, jadi diputuskan terpisah.
- **Aksesibilitas (wajib lulus per fase):**
  - semua judul seksi berupa heading berurutan; login punya `h1`;
  - kontras teks ≥ 4,5:1 dan non-teks ≥ 3:1;
  - fokus terlihat 2 px;
  - target sentuh ≥ 40 px di ponsel;
  - tabel punya `caption` tersembunyi;
  - status tidak hanya berupa warna;
  - titik penanda di tab diganti teks tersembunyi (`sr-only`);
  - `prefers-reduced-motion` dihormati;
  - navigasi keyboard di Verifikasi.

---

## 10. Rencana implementasi bertahap

Dikerjakan di branch `feat/redesign-uiux` (dicabang dari `feat/cloudflare-migration`) dan di-merge ke `main` lewat PR #3 setelah PR #2; kedua branch kerja sudah dihapus. Setiap fase:

- merupakan irisan utuh yang bisa di-deploy;
- diverifikasi dengan `npm run typecheck`, `npm run lint`, `npm run test:web`, `npm run test:api`, dan `npm run build`;
- diverifikasi secara visual dengan tangkapan layar desktop 1440 px dan ponsel 375 px memakai data fiktif lokal, ditambah pemeriksaan aksesibilitas (axe/Lighthouse ≥ 95);
- rilis ke produksi lewat merge ke `main`, yang di-deploy otomatis oleh GitHub Actions dengan paket rilis terisolasi ([`DEPLOY.md`](DEPLOY.md)). Rollback cukup dengan *rollback* deployment Pages.

| Fase | Isi | Hasil yang terlihat | Estimasi |
|---|---|---|---|
| **0. Fondasi** | Token warna/tipografi/elevasi/ukuran di `index.css` (terang + gelap), ukuran kontrol naik satu tingkat, `CardTitle` → heading, `ThemeProvider`, konstanta nama instansi, halaman `/_design` (dev saja). Pasang dependensi: `@tanstack/react-table`, `recharts` + shadcn `chart`, `cmdk` + shadcn `command`, (opsional) `vaul` | Seluruh aplikasi langsung lebih lega dan berlapis tanpa mengubah struktur halaman | 1 hari |
| **1. Shell** | Sidebar terang + lockup, header (breadcrumb, ⌘K, tugas, menu pengguna + tema), banner password diganti indikator, bottom nav ponsel, template halaman | Kerangka baru di semua halaman | 1–1,5 hari |
| **2. Pustaka pola** | `PageHeader` v2, `StatusBadge` + `lib/status.ts`, `DataTable` + paginasi + `FilterBar`, `KpiCard`, `ProgressMeter`, `SectionCard`, `EmptyState`/`ErrorState`, `FormSection` + `StickySaveBar`, aturan Sheet/Dialog, `Timeline`, tes unit untuk registri status dan util tabel | Komponen siap pakai (diperagakan di `/_design`) | 2 hari |
| **3. Layar Admin utama** | Beranda Admin (KPI + grafik + antrean + linimasa), Master Data Pegawai, Detail Pegawai, Verifikasi (workspace 3 panel + pintasan) | Layar yang paling sering dipakai Admin TU | 3 hari |
| **4. Layar Pegawai** | Beranda Pegawai (daftar tugas), Arsip Dokumen (grid kartu jenis), Profil, Pengaturan Akun, Login | Pengalaman pegawai | 2–2,5 hari |
| **5. Layar Admin sekunder** | Pengajuan (tabel + sheet diff), Log, Jenis Dokumen, Pengaturan Sistem (navigasi seksi, referensi, backup responsif), 404/403 | Semua layar memakai pola yang sama | 2 hari |
| **6. Poles & opsional** | QA mode gelap per layar, QA ponsel, audit aksesibilitas, performa (lazy load grafik), bersihkan komponen mati (`coming-soon.tsx`), dokumentasi pola; opsional tab *Tampilan* Admin | Siap rilis | 1–1,5 hari (+1–2 hari tab Tampilan) |

Total perkiraan: **±12–14 hari kerja** tanpa tab Tampilan. Fase 0–1 sudah memberi perubahan visual besar dan bisa dirilis lebih dulu.

Dependensi baru, dengan versi yang sudah dipakai di proyek Anda:

- `@tanstack/react-table` ^9.2;
- `recharts` ^3.10;
- `cmdk` ^1.1;
- `vaul` ^1.1 (opsional).

Komponen shadcn yang ditambahkan: `chart`, `command`, `drawer` (opsional), `toggle-group`, `kbd`, `hover-card`.

---

## 11. Keputusan yang dibutuhkan dari pemilik

| # | Pertanyaan | Rekomendasi | Alternatif |
|---|---|---|---|
| 1 | Arah visual | **Sekeluarga dengan PINTU** (kertas hangat, sidebar terang, aksen navy SIKAP) | Pertahankan sidebar navy, hanya rapikan |
| 2 | Huruf | **Inter Variable** (sudah terpasang, konsisten lintas OS) | Tumpukan SF Pro sistem seperti PINTU |
| 3 | Warna tombol utama | **Navy SIKAP** `#1E3A8A` | Tinta `#0F1319` seperti PINTU, navy hanya aksen |
| 4 | Mode gelap | **Ya**, pilihan per perangkat | Tunda |
| 5 | Tab *Tampilan* (tema Admin) | **Tunda ke fase 6** (butuh API kecil) | Kerjakan bersamaan |
| 6 | Status "Belum diunggah" | **Netral abu** (merah hanya untuk ditolak/gagal) | Tetap merah |
| 7 | Urutan rilis | **Bertahap**: rilis setelah fase 1, 3, dan 6 | Satu rilis besar di akhir |

---

## 12. Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| Regresi fungsi di produksi | Tanpa perubahan API/skema; tes web/API wajib lulus; uji klik alur utama (login, unggah, verifikasi, ubah pegawai, pengajuan) di lokal dengan data fiktif sebelum setiap rilis |
| Pengguna kaget dengan tata letak baru | Nama menu dan urutannya dipertahankan; rilis bertahap; catatan "Yang baru" singkat di Beranda |
| Paginasi server-side belum ada di semua endpoint | `DataTable` mendukung mode klien (data ≤ ratusan baris) dan server; endpoint tidak diubah pada redesign ini |
| Ukuran bundle naik (recharts) | Grafik di-*lazy load* per rute; ukur `vite build` sebelum/sesudah |
| Mode gelap merusak kontras status | Token status gelap tersendiri + pemeriksaan kontras otomatis di `/_design` |

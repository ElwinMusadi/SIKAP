-- SIKAP — reference data (PROJECT_CONTEXT.md §4.6, owner decision #3).

-- ---------------------------------------------------------------------------
-- Pangkat / golongan. PNS (also used by CPNS): I/a – IV/e.
-- ---------------------------------------------------------------------------
INSERT INTO ref_pangkat_golongan (kode, nama, jenis_asn, urutan) VALUES
  ('I/a',   'Juru Muda (I/a)',                 'PNS', 1),
  ('I/b',   'Juru Muda Tk. I (I/b)',           'PNS', 2),
  ('I/c',   'Juru (I/c)',                      'PNS', 3),
  ('I/d',   'Juru Tk. I (I/d)',                'PNS', 4),
  ('II/a',  'Pengatur Muda (II/a)',            'PNS', 5),
  ('II/b',  'Pengatur Muda Tk. I (II/b)',      'PNS', 6),
  ('II/c',  'Pengatur (II/c)',                 'PNS', 7),
  ('II/d',  'Pengatur Tk. I (II/d)',           'PNS', 8),
  ('III/a', 'Penata Muda (III/a)',             'PNS', 9),
  ('III/b', 'Penata Muda Tk. I (III/b)',       'PNS', 10),
  ('III/c', 'Penata (III/c)',                  'PNS', 11),
  ('III/d', 'Penata Tk. I (III/d)',            'PNS', 12),
  ('IV/a',  'Pembina (IV/a)',                  'PNS', 13),
  ('IV/b',  'Pembina Tk. I (IV/b)',            'PNS', 14),
  ('IV/c',  'Pembina Utama Muda (IV/c)',       'PNS', 15),
  ('IV/d',  'Pembina Utama Madya (IV/d)',      'PNS', 16),
  ('IV/e',  'Pembina Utama (IV/e)',            'PNS', 17);

-- PPPK golongan I – XVII.
INSERT INTO ref_pangkat_golongan (kode, nama, jenis_asn, urutan) VALUES
  ('PPPK-I',     'Golongan I',     'PPPK', 101),
  ('PPPK-II',    'Golongan II',    'PPPK', 102),
  ('PPPK-III',   'Golongan III',   'PPPK', 103),
  ('PPPK-IV',    'Golongan IV',    'PPPK', 104),
  ('PPPK-V',     'Golongan V',     'PPPK', 105),
  ('PPPK-VI',    'Golongan VI',    'PPPK', 106),
  ('PPPK-VII',   'Golongan VII',   'PPPK', 107),
  ('PPPK-VIII',  'Golongan VIII',  'PPPK', 108),
  ('PPPK-IX',    'Golongan IX',    'PPPK', 109),
  ('PPPK-X',     'Golongan X',     'PPPK', 110),
  ('PPPK-XI',    'Golongan XI',    'PPPK', 111),
  ('PPPK-XII',   'Golongan XII',   'PPPK', 112),
  ('PPPK-XIII',  'Golongan XIII',  'PPPK', 113),
  ('PPPK-XIV',   'Golongan XIV',   'PPPK', 114),
  ('PPPK-XV',    'Golongan XV',    'PPPK', 115),
  ('PPPK-XVI',   'Golongan XVI',   'PPPK', 116),
  ('PPPK-XVII',  'Golongan XVII',  'PPPK', 117);

-- ---------------------------------------------------------------------------
-- Unit organisasi
-- ---------------------------------------------------------------------------
INSERT INTO ref_unit_organisasi (id, nama) VALUES
  (1, 'Subbagian Tata Usaha'),
  (2, 'Seksi Penetapan dan Penagihan'),
  (3, 'Seksi Verifikasi');

-- ---------------------------------------------------------------------------
-- Pendidikan
-- ---------------------------------------------------------------------------
INSERT INTO ref_pendidikan (kode, nama, urutan) VALUES
  ('SMA', 'SMA / SMK / Sederajat', 1),
  ('D1',  'D-I / Diploma Satu',    2),
  ('D2',  'D-II / Diploma Dua',    3),
  ('D3',  'D-III / Diploma Tiga',  4),
  ('D4',  'D-IV / Sarjana Terapan', 5),
  ('S1',  'S-1 / Sarjana',         6),
  ('S2',  'S-2 / Magister',        7),
  ('S3',  'S-3 / Doktoral',        8);

-- ---------------------------------------------------------------------------
-- Jenis dokumen
-- ---------------------------------------------------------------------------
INSERT INTO jenis_dokumen (id, nama, kategori, urutan) VALUES
  ('DOC-KTP',       'Kartu Tanda Penduduk (KTP)', 'Dokumen Pribadi',     1),
  ('DOC-KK',        'Kartu Keluarga (KK)',        'Dokumen Pribadi',     2),
  ('DOC-NPWP',      'NPWP',                       'Dokumen Pribadi',     3),
  ('DOC-SK-CPNS',   'SK CPNS',                    'Dokumen Kepegawaian', 4),
  ('DOC-SPMT-CPNS', 'SPMT CPNS',                  'Dokumen Kepegawaian', 5),
  ('DOC-SK-PNS',    'SK PNS',                     'Dokumen Kepegawaian', 6),
  ('DOC-DRH',       'DRH',                        'Dokumen Kepegawaian', 7),
  ('DOC-IJAZAH',    'Ijazah Terakhir',            'Dokumen Pendidikan',  8),
  ('DOC-SKP',       'SKP',                        'Dokumen Kepegawaian', 9),
  ('DOC-KARPEG',    'Kartu Pegawai (KARPEG)',     'Dokumen Kepegawaian', 10),
  ('DOC-TASPEN',    'Kartu Taspen',               'Dokumen Kepegawaian', 11);

-- ---------------------------------------------------------------------------
-- Required-document matrix (owner decision #3). This is only the initial
-- state; admins edit it later via /admin/jenis-dokumen. A document absent
-- from this table for a status is optional for that status
-- (DOC-KARPEG and DOC-TASPEN are optional for everyone).
-- ---------------------------------------------------------------------------
INSERT INTO jenis_dokumen_wajib (jenis_dokumen_id, status_kepegawaian) VALUES
  -- PNS
  ('DOC-KTP', 'PNS'), ('DOC-KK', 'PNS'), ('DOC-NPWP', 'PNS'),
  ('DOC-SK-CPNS', 'PNS'), ('DOC-SPMT-CPNS', 'PNS'), ('DOC-SK-PNS', 'PNS'),
  ('DOC-DRH', 'PNS'), ('DOC-IJAZAH', 'PNS'), ('DOC-SKP', 'PNS'),
  -- CPNS (no SK PNS, no SKP yet)
  ('DOC-KTP', 'CPNS'), ('DOC-KK', 'CPNS'), ('DOC-NPWP', 'CPNS'),
  ('DOC-SK-CPNS', 'CPNS'), ('DOC-SPMT-CPNS', 'CPNS'),
  ('DOC-DRH', 'CPNS'), ('DOC-IJAZAH', 'CPNS'),
  -- PPPK (no CPNS/PNS decrees)
  ('DOC-KTP', 'PPPK'), ('DOC-KK', 'PPPK'), ('DOC-NPWP', 'PPPK'),
  ('DOC-DRH', 'PPPK'), ('DOC-IJAZAH', 'PPPK'), ('DOC-SKP', 'PPPK');

-- ---------------------------------------------------------------------------
-- Default settings
-- ---------------------------------------------------------------------------
INSERT INTO pengaturan (key, value, is_secret) VALUES
  ('notif.dokumen_baru',     'true',   0),
  ('notif.dokumen_approved', 'true',   0),
  ('notif.dokumen_rejected', 'true',   0),
  ('wa.provider',            'fonnte', 0);

// Living design-system page (dev builds only, route /_design). Shows the v2 tokens, type scale and core
// components in the current theme, plus WCAG contrast ratios computed from the live CSS variables.
import { useEffect, useState } from 'react';
import { CircleCheck, CircleDashed, CircleX, Clock, Plus, Search } from 'lucide-react';
import { useTheme, type ThemePreference } from '@/app/theme';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const SWATCHES = [
  'background', 'card', 'foreground', 'muted', 'muted-foreground', 'border', 'input', 'primary', 'accent-soft', 'ring',
  'sidebar', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
] as const;

/** [label, foreground var, background var, minimum ratio] */
const PAIRS: [string, string, string, number][] = [
  ['Teks utama / latar', 'foreground', 'background', 4.5],
  ['Teks pendukung / latar', 'muted-foreground', 'background', 4.5],
  ['Teks pendukung / kartu', 'muted-foreground', 'card', 4.5],
  ['Tombol utama', 'primary-foreground', 'primary', 4.5],
  ['Batas input / kartu', 'input', 'card', 3],
  ['Cincin fokus / kartu', 'ring', 'card', 3],
  ['Sidebar teks', 'sidebar-foreground', 'sidebar', 4.5],
  ['Aksen aktif', 'primary', 'accent-soft', 4.5],
  ['Status terverifikasi', 'status-verified', 'status-verified-muted', 4.5],
  ['Status menunggu', 'status-pending', 'status-pending-muted', 4.5],
  ['Status ditolak', 'status-rejected', 'status-rejected-muted', 4.5],
  ['Status belum/netral', 'status-missing', 'status-missing-muted', 4.5],
  ['Grafik 1 / kartu', 'chart-1', 'card', 3],
  ['Grafik 3 / kartu', 'chart-3', 'card', 3],
  ['Grafik 4 / kartu', 'chart-4', 'card', 3],
];

function luminance(color: string): number {
  const probe = document.createElement('div');
  probe.style.color = color;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  probe.remove();
  const [r = 0, g = 0, b = 0] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function useContrast(resolved: string) {
  const [rows, setRows] = useState<{ label: string; value: number; min: number }[]>([]);
  useEffect(() => {
    // Next frame: ThemeProvider toggles html.dark in its own effect, so read the variables afterwards.
    const id = requestAnimationFrame(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
      setRows(PAIRS.map(([label, fg, bg, min]) => ({ label, value: ratio(v(fg), v(bg)), min })));
    });
    return () => cancelAnimationFrame(id);
  }, [resolved]);
  return rows;
}

const STATUS = [
  { label: 'Terverifikasi', tone: 'bg-status-verified-muted text-status-verified', icon: CircleCheck },
  { label: 'Menunggu', tone: 'bg-status-pending-muted text-status-pending', icon: Clock },
  { label: 'Ditolak', tone: 'bg-status-rejected-muted text-status-rejected', icon: CircleX },
  { label: 'Belum diunggah', tone: 'bg-status-missing-muted text-status-missing', icon: CircleDashed },
] as const;

export default function DesignPage() {
  const { preference, resolved, setPreference } = useTheme();
  const contrast = useContrast(resolved);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 p-6 lg:p-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-eyebrow text-muted-foreground uppercase">SIKAP design system v2</p>
          <h1 className="text-display">Panduan visual</h1>
          <p className="text-sm text-muted-foreground">Token, tipografi, dan komponen inti dalam tema aktif ({resolved}).</p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          value={preference}
          onValueChange={(value) => value && setPreference(value as ThemePreference)}
          aria-label="Tema"
        >
          <ToggleGroupItem value="light">Terang</ToggleGroupItem>
          <ToggleGroupItem value="dark">Gelap</ToggleGroupItem>
          <ToggleGroupItem value="system">Sistem</ToggleGroupItem>
        </ToggleGroup>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Warna</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {SWATCHES.map((name) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className="h-14 rounded-lg border" style={{ background: `var(--${name})` }} />
              <span className="text-xs text-muted-foreground">--{name}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Kontras (WCAG)</h2>
        <Card>
          <CardContent className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {contrast.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
                <span>{row.label}</span>
                <span className={row.value >= row.min ? 'text-status-verified tabular-nums' : 'font-semibold text-status-rejected tabular-nums'}>
                  {row.value.toFixed(2)}:1 {row.value >= row.min ? '✓' : `✗ (min ${row.min})`}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Tipografi</h2>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-eyebrow text-muted-foreground uppercase">Eyebrow · label seksi</p>
            <p className="text-display">Display 30 — Master Data Pegawai</p>
            <p className="text-h2">H2 20 — Kelengkapan dokumen</p>
            <p className="text-h3">H3 16 — Identitas pegawai</p>
            <p className="text-sm">Body 14 — Data pribadi sesuai dokumen kependudukan.</p>
            <p className="text-[13px] text-muted-foreground">Small 13 — Diperbarui 21 Okt 2026, 13.45 WITA</p>
            <p className="text-metric tabular-nums">46 <span className="text-sm font-normal text-muted-foreground">pegawai aktif</span></p>
            <p className="text-sm tabular-nums">NIP 199001012020011001</p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Tombol dan input</h2>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button><Plus data-icon="inline-start" />Tambah pegawai</Button>
              <Button variant="outline">Batal</Button>
              <Button variant="secondary">Sekunder</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Tolak</Button>
              <Button variant="link">Tautan</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="lg">Besar</Button>
              <Button>Default</Button>
              <Button size="sm">Kecil</Button>
              <Button size="xs">Ekstra kecil</Button>
              <Button size="icon" variant="outline" aria-label="Cari"><Search /></Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input placeholder="Cari nama atau NIP" />
              <Input placeholder="Tidak aktif" disabled />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2">Status, kartu, tabel</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS.map(({ label, tone, icon: Icon }) => (
            <span key={label} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </span>
          ))}
          <Badge>Default</Badge>
          <Badge variant="secondary">PNS</Badge>
          <Badge variant="outline">Admin</Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {['Pegawai aktif', 'Antrean verifikasi', 'Kelengkapan instansi'].map((label, i) => (
            <Card key={label}>
              <CardHeader>
                <CardDescription className="text-eyebrow uppercase">{label}</CardDescription>
                <CardTitle as="div" className="text-metric tabular-nums">{[46, 4, '78%'][i]}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pegawai</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {['Pegawai Contoh Satu', 'Pegawai Contoh Dua'].map((nama) => (
                <TableRow key={nama}>
                  <TableCell className="font-medium">{nama}</TableCell>
                  <TableCell>PNS · III/a</TableCell>
                  <TableCell className="text-muted-foreground">Sub Bagian TU</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}

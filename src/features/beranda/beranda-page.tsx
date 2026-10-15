import type { LucideIcon } from 'lucide-react';
import { FileCheck, FolderOpen, Info, KeyRound, UserRound, Users, GitPullRequestArrow } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionUser } from '@shared/api';

import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/features/auth/queries';
import { initials } from '@/lib/format';

interface QuickLink {
  to: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const PEGAWAI_LINKS: QuickLink[] = [
  { to: '/profil', title: 'Profil Pegawai', description: 'Lihat dan perbarui data diri Anda.', icon: UserRound },
  { to: '/dokumen', title: 'Arsip Dokumen', description: 'Unggah dan pantau dokumen kepegawaian.', icon: FolderOpen },
  { to: '/akun', title: 'Pengaturan Akun', description: 'Ganti password dan kelola sesi login.', icon: KeyRound },
];

const ADMIN_LINKS: QuickLink[] = [
  { to: '/admin/pegawai', title: 'Master Data Pegawai', description: 'Kelola data dan akun seluruh pegawai.', icon: Users },
  { to: '/admin/verifikasi', title: 'Verifikasi Dokumen', description: 'Periksa dokumen yang menunggu verifikasi.', icon: FileCheck },
  {
    to: '/admin/pengajuan',
    title: 'Pengajuan Perubahan',
    description: 'Tinjau pengajuan perubahan data kepegawaian.',
    icon: GitPullRequestArrow,
  },
  { to: '/akun', title: 'Pengaturan Akun', description: 'Ganti password dan kelola sesi login.', icon: KeyRound },
];

/** Leading academic/religious titles that should not be used as a greeting name. */
const TITLE_PREFIXES = new Set(['dr', 'drs', 'dra', 'ir', 'h', 'hj', 'prof', 'st', 'ns', 'apt']);

function firstName(nama: string): string {
  const words = nama.trim().split(/\s+/);
  const name = words.find((word) => {
    const bare = word.replace(/[.,]/g, '').toLowerCase();
    return bare.length > 0 && !word.endsWith('.') && !TITLE_PREFIXES.has(bare);
  });
  return (name ?? words[0] ?? '').replace(/,$/, '');
}

function ProfileSummaryCard({ user }: { user: SessionUser }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div
          aria-hidden="true"
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground"
        >
          {initials(user.nama)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-base font-semibold text-foreground">{user.nama}</p>
          <p className="text-sm text-muted-foreground">
            NIP <span className="font-mono tabular-nums">{user.nip}</span>
          </p>
          {user.jabatan ? <p className="text-sm text-muted-foreground">{user.jabatan}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {user.statusKepegawaian ? <Badge variant="secondary">{user.statusKepegawaian}</Badge> : null}
          {user.role === 'Admin' ? <Badge>Administrator TU</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function QuickLinkCard({ link }: { link: QuickLink }) {
  const Icon = link.icon;
  return (
    <Link
      to={link.to}
      className="group rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-colors group-hover:bg-muted/50">
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden="true" className="size-5" />
          </div>
          <CardTitle>{link.title}</CardTitle>
          <CardDescription>{link.description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

export default function BerandaPage() {
  const { data: user } = useMe();
  if (!user) return null;

  const isAdmin = user.role === 'Admin';
  const links = isAdmin ? ADMIN_LINKS : PEGAWAI_LINKS;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Selamat datang, ${firstName(user.nama)}`}
        description={isAdmin ? 'Panel Administrator TU' : 'Pantau kelengkapan data dan dokumen kepegawaian Anda.'}
      />

      <ProfileSummaryCard user={user} />

      <Alert>
        <Info />
        <AlertDescription>Fitur dashboard sedang dimigrasikan ke sistem baru (Fase 3).</AlertDescription>
      </Alert>

      <section aria-labelledby="akses-cepat" className="flex flex-col gap-3">
        <h2 id="akses-cepat" className="text-sm font-semibold text-muted-foreground">
          Akses cepat
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {links.map((link) => (
            <li key={link.to}>
              <QuickLinkCard link={link} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { Bell, CheckCheck, ChevronRight, ClipboardCheck, FilePen, KeyRound, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionUser } from '@shared/api';
import { formatBadge, type ShellCounts } from '@/app/use-shell-counts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Task {
  key: string;
  to: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  tone: 'pending' | 'primary';
}

/** Personal reminders and admin work queues; replaces the full-width banner on every page. */
export function tasksFor(user: SessionUser, counts: ShellCounts): Task[] {
  const tasks: Task[] = [];
  if (user.isDefaultPassword) {
    tasks.push({
      key: 'password',
      to: '/akun',
      icon: KeyRound,
      title: 'Ganti password default',
      detail: 'Password Anda masih 6 digit terakhir NIP.',
      tone: 'pending',
    });
  }
  if (user.role === 'Admin' && counts.verifikasiMenunggu > 0) {
    tasks.push({
      key: 'verifikasi',
      to: '/admin/verifikasi',
      icon: ClipboardCheck,
      title: `${formatBadge(counts.verifikasiMenunggu)} dokumen menunggu verifikasi`,
      detail: 'Periksa dan putuskan dokumen yang diunggah pegawai.',
      tone: 'primary',
    });
  }
  if (user.role === 'Admin' && counts.pengajuanMenunggu > 0) {
    tasks.push({
      key: 'pengajuan',
      to: '/admin/pengajuan',
      icon: FilePen,
      title: `${formatBadge(counts.pengajuanMenunggu)} pengajuan perubahan data`,
      detail: 'Tinjau perubahan data kepegawaian yang diajukan.',
      tone: 'primary',
    });
  }
  return tasks;
}

export function TasksMenu({ user, counts }: { user: SessionUser; counts: ShellCounts }) {
  const [open, setOpen] = useState(false);
  const tasks = tasksFor(user, counts);
  const label = tasks.length > 0 ? `Tugas (${tasks.length} perlu perhatian)` : 'Tugas (tidak ada)';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell />
          {tasks.length > 0 ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-pending px-1 text-[10px] leading-none font-semibold text-white tabular-nums ring-2 ring-background dark:text-black"
            >
              {tasks.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-h3">Tugas</p>
          <p className="text-xs text-muted-foreground">Hal yang menunggu tindakan Anda.</p>
        </div>
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-status-verified-muted text-status-verified">
              <CheckCheck className="size-5" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium">Semua beres</p>
            <p className="text-xs text-muted-foreground">Tidak ada yang perlu ditindaklanjuti saat ini.</p>
          </div>
        ) : (
          <ul className="flex flex-col p-1.5">
            {tasks.map((task) => (
              <li key={task.key}>
                <Link
                  to={task.to}
                  onClick={() => setOpen(false)}
                  className="flex items-start gap-3 rounded-lg px-2.5 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={
                      task.tone === 'pending'
                        ? 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-status-pending-muted text-status-pending'
                        : 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary'
                    }
                  >
                    <task.icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{task.title}</span>
                    <span className="text-xs text-muted-foreground">{task.detail}</span>
                  </span>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

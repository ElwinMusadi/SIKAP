import { useState } from 'react';
import { KeyRound, LockOpen, Trash2, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import type { StatusAkun } from '@shared/enums';
import { RETENTION } from '@shared/enums';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatDateTimeWITA } from '@/lib/format';
import { useDeletePegawai, useResetPassword, useSetStatusAkun, useUnlock } from './queries';

export type AccountAction = 'deactivate' | 'activate' | 'reset' | 'unlock' | 'delete';

export interface AccountTarget {
  id: number;
  nama: string;
  statusAkun: StatusAkun;
  terkunci: boolean;
}

/**
 * Actions the server allows for this row. Self-deactivate/delete/reset are 403 on the server,
 * so they are not offered at all (the admin uses Pengaturan Akun for their own password).
 */
export function availableActions(target: AccountTarget, selfId: number | undefined): AccountAction[] {
  const isSelf = target.id === selfId;
  const actions: AccountAction[] = [];
  if (!isSelf) actions.push(target.statusAkun === 'Aktif' ? 'deactivate' : 'activate');
  if (!isSelf) actions.push('reset');
  if (target.terkunci) actions.push('unlock');
  if (!isSelf) actions.push('delete');
  return actions;
}

export const ACTION_META: Record<AccountAction, { label: string; icon: typeof KeyRound; destructive?: boolean }> = {
  deactivate: { label: 'Nonaktifkan', icon: UserX },
  activate: { label: 'Aktifkan', icon: UserCheck },
  reset: { label: 'Reset password', icon: KeyRound },
  unlock: { label: 'Buka kunci', icon: LockOpen },
  delete: { label: 'Hapus', icon: Trash2, destructive: true },
};

interface CopyText {
  title: string;
  description: string;
  confirm: string;
}

function copyFor(action: AccountAction, nama: string): CopyText {
  switch (action) {
    case 'deactivate':
      return {
        title: `Nonaktifkan akun ${nama}?`,
        description: 'Pegawai tidak dapat masuk ke SIKAP dan semua sesi yang sedang aktif dikeluarkan. Akun dapat diaktifkan kembali kapan saja.',
        confirm: 'Nonaktifkan',
      };
    case 'activate':
      return {
        title: `Aktifkan akun ${nama}?`,
        description: 'Pegawai dapat kembali masuk ke SIKAP dengan password yang terakhir digunakan.',
        confirm: 'Aktifkan',
      };
    case 'reset':
      return {
        title: `Reset password ${nama}?`,
        description:
          'Password akan dikembalikan ke password default (6 digit terakhir NIP) dan semua sesi pegawai dikeluarkan.',
        confirm: 'Reset password',
      };
    case 'unlock':
      return {
        title: `Buka kunci akun ${nama}?`,
        description: 'Penguncian karena gagal login dihapus sehingga pegawai dapat langsung mencoba masuk lagi. Password tidak berubah.',
        confirm: 'Buka kunci',
      };
    case 'delete':
      return {
        title: `Hapus ${nama}?`,
        description: `Akun tidak dapat digunakan dan semua sesi dikeluarkan. Data dapat dipulihkan selama ${RETENTION.pegawaiSoftDeleteDays} hari, setelah itu dihapus permanen beserta dokumennya.`,
        confirm: 'Hapus pegawai',
      };
  }
}

interface AccountActionDialogProps {
  target: AccountTarget | null;
  action: AccountAction | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful action (e.g. navigate away after delete). */
  onDone?: (action: AccountAction) => void;
}

/** One confirmation dialog for every account action (reused by the list and the detail page). */
export function AccountActionDialog({ target, action, onOpenChange, onDone }: AccountActionDialogProps) {
  const setStatus = useSetStatusAkun();
  const reset = useResetPassword();
  const unlock = useUnlock();
  const remove = useDeletePegawai();
  const pending = setStatus.isPending || reset.isPending || unlock.isPending || remove.isPending;
  const open = target !== null && action !== null;
  const copy = open ? copyFor(action, target.nama) : null;

  const finish = (message: string) => {
    toast.success(message);
    onOpenChange(false);
    if (action) onDone?.(action);
  };
  const fail = (error: unknown) => toast.error(errorMessage(error));
  const sessions = (n: number) => (n > 0 ? ` ${n} sesi dikeluarkan.` : '');

  const confirm = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!target || !action) return;
    const opts = { onError: fail };
    switch (action) {
      case 'deactivate':
      case 'activate':
        setStatus.mutate(
          { id: target.id, statusAkun: action === 'deactivate' ? 'Nonaktif' : 'Aktif' },
          {
            ...opts,
            onSuccess: (res) =>
              finish(
                action === 'deactivate'
                  ? `Akun ${target.nama} dinonaktifkan.${sessions(res?.revokedSessions ?? 0)}`
                  : `Akun ${target.nama} diaktifkan kembali.`,
              ),
          },
        );
        return;
      case 'reset':
        reset.mutate(target.id, {
          ...opts,
          onSuccess: (res) => finish(`Password ${target.nama} dikembalikan ke default.${sessions(res?.revokedSessions ?? 0)}`),
        });
        return;
      case 'unlock':
        unlock.mutate(target.id, { ...opts, onSuccess: () => finish(`Kunci akun ${target.nama} dibuka.`) });
        return;
      case 'delete':
        remove.mutate(target.id, {
          ...opts,
          onSuccess: (res) =>
            finish(
              res?.purgeAfter
                ? `${target.nama} dihapus. Dapat dipulihkan sampai ${formatDateTimeWITA(res.purgeAfter)}.`
                : `${target.nama} dihapus.`,
            ),
        });
        return;
    }
  };

  const Icon = action ? ACTION_META[action].icon : null;
  const destructive = action === 'delete' || action === 'reset' || action === 'deactivate';

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? 'Konfirmasi'}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Batal</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={confirm} disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : Icon ? <Icon data-icon="inline-start" /> : null}
            {copy?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Local state for "which action on which row" + the dialog element. */
export function useAccountActionDialog(onDone?: (action: AccountAction) => void) {
  const [state, setState] = useState<{ target: AccountTarget; action: AccountAction } | null>(null);
  const dialog = (
    <AccountActionDialog
      target={state?.target ?? null}
      action={state?.action ?? null}
      onOpenChange={(open) => !open && setState(null)}
      onDone={onDone}
    />
  );
  return { request: (target: AccountTarget, action: AccountAction) => setState({ target, action }), dialog };
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Moon, Sun, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SessionUser } from '@shared/api';
import type { PegawaiListResponse } from '@shared/pegawai';
import { navGroupsForRole } from '@/app/nav';
import { useTheme } from '@/app/theme';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { DEFAULT_LIST_PARAMS, listQueryString } from '@/features/pegawai/pegawai-utils';
import { api } from '@/lib/api';

/** Opens on Ctrl+K / ⌘K anywhere in the app (except when another dialog already owns focus). */
export function useCommandMenuHotkey(setOpen: (update: (open: boolean) => boolean) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** Admin-only employee lookup by name or NIP (same API as Master Data Pegawai). */
function usePegawaiSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'pegawai', 'command-search', q],
    queryFn: ({ signal }) =>
      api<PegawaiListResponse>(`/admin/pegawai${listQueryString({ ...DEFAULT_LIST_PARAMS, q })}`, { signal }),
    enabled: enabled && q.length >= 2,
    staleTime: 30_000,
  });
}

interface CommandMenuProps {
  user: SessionUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandMenu({ user, open, onOpenChange }: CommandMenuProps) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const isAdmin = user.role === 'Admin';
  const pegawai = usePegawaiSearch(q, open && isAdmin);
  const groups = navGroupsForRole(user.role);

  const run = (action: () => void) => {
    onOpenChange(false);
    setSearch('');
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setSearch('');
      }}
      title="Cari di SIKAP"
      description="Lompat ke halaman, cari pegawai, atau ubah tema."
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={isAdmin ? 'Cari halaman, nama, atau NIP…' : 'Cari halaman atau perintah…'}
        />
        <CommandList>
          <CommandEmpty>{pegawai.isFetching ? 'Mencari…' : 'Tidak ada hasil.'}</CommandEmpty>
          {isAdmin && q.length >= 2 && pegawai.data && pegawai.data.items.length > 0 ? (
            <>
              <CommandGroup heading="Pegawai">
                {pegawai.data.items.slice(0, 8).map((item) => (
                  <CommandItem
                    key={item.id}
                    // Stable value (an id) so cmdk keeps its selection; the server already matched `q`.
                    value={`pegawai-${item.id}`}
                    keywords={[item.nama, item.nip, q]}
                    onSelect={() => run(() => void navigate(`/admin/pegawai/${item.id}`))}
                  >
                    <UserRound />
                    <span className="truncate">{item.nama}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{item.nip}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          {groups.map((group) => (
            <CommandGroup key={group.label} heading={group.label}>
              {group.items.map((item) => (
                <CommandItem key={item.to} value={`halaman ${item.label}`} onSelect={() => run(() => void navigate(item.to))}>
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup heading="Tampilan">
            <CommandItem
              value="tema mode gelap terang"
              onSelect={() => run(() => setTheme(isDark ? 'light' : 'dark'))}
            >
              {isDark ? <Sun /> : <Moon />}
              {isDark ? 'Matikan mode gelap' : 'Aktifkan mode gelap'}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

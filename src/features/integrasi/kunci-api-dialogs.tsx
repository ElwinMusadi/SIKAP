import { useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Check, Copy, KeyRound, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  IZIN_API,
  IZIN_API_LABELS,
  MASA_BERLAKU_BAWAAN,
  createKunciApiSchema,
  type IzinApi,
  type KunciApiCreateResponse,
  type KunciApiItem,
} from '@shared/integrasi';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateWITA } from '@/lib/format';
import { MASA_BERLAKU_OPTIONS, kunciLabel } from './kunci-api-utils';
import { useBuatKunciApi, useHapusKunciApi } from './queries';

type Errors = Record<string, string | undefined>;

function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) errors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return errors;
}

// ---------------------------------------------------------------------------
// Create → show once
// ---------------------------------------------------------------------------

/**
 * Two steps in one dialog: the form, then the new key shown exactly once. While saving, and on the
 * key step, Escape and outside clicks are ignored so the key cannot be lost by accident; only
 * "Saya sudah menyimpan kunci" closes it, and the key leaves memory once the dialog has closed.
 */
export function BuatKunciDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mutation = useBuatKunciApi();
  const [created, setCreated] = useState<KunciApiCreateResponse | null>(null);
  const locked = mutation.isPending || created !== null;

  const block = (event: Event) => {
    if (locked) event.preventDefault();
  };
  // Runs once the close animation has finished, so the content never blanks out mid-animation.
  const forget = () => {
    setCreated(null);
    mutation.reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !locked) onClose(); }}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!locked}
        onEscapeKeyDown={block}
        onInteractOutside={block}
        onCloseAutoFocus={forget}
        aria-busy={mutation.isPending || undefined}
      >
        {created ? (
          <KunciSekali created={created} onDone={onClose} />
        ) : (
          <BuatKunciForm mutation={mutation} onCreated={setCreated} onCancel={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BuatKunciForm({
  mutation,
  onCreated,
  onCancel,
}: {
  mutation: ReturnType<typeof useBuatKunciApi>;
  onCreated: (res: KunciApiCreateResponse) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const busy = mutation.isPending;
  const busyRef = useRef(false);
  const [nama, setNama] = useState('');
  const [keterangan, setKeterangan] = useState('');
  const [izin, setIzin] = useState<IzinApi[]>(['pegawai:baca']);
  const [masa, setMasa] = useState(String(MASA_BERLAKU_BAWAAN));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const touch = (key: string) => {
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFormError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const parsed = createKunciApiSchema.safeParse({ nama, keterangan, izin, masaBerlakuHari: Number(masa) });
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    busyRef.current = true;
    try {
      onCreated(await mutation.mutateAsync(parsed.data));
    } catch (error) {
      // Server field keys can be nested ("izin.0"); the form shows them on the top-level field.
      if (isApiError(error) && error.fields) {
        setErrors(issuesToErrors(Object.entries(error.fields).map(([key, message]) => ({ path: [key.split('.')[0] ?? key], message }))));
      }
      setFormError(errorMessage(error));
    } finally {
      busyRef.current = false;
    }
  };

  const toggleIzin = (value: IzinApi, checked: boolean) => {
    setIzin((list) => (checked ? IZIN_API.filter((i) => i === value || list.includes(i)) : list.filter((i) => i !== value)));
    touch('izin');
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Buat kunci API</DialogTitle>
        <DialogDescription>Untuk aplikasi lain yang perlu membaca data pegawai SIKAP, misalnya PINTU. Satu kunci untuk satu aplikasi.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={errors.nama ? true : undefined}>
          <FieldLabel htmlFor={`${id}-nama`}>Nama klien</FieldLabel>
          <Input
            id={`${id}-nama`}
            value={nama}
            onChange={(e) => { setNama(e.target.value); touch('nama'); }}
            disabled={busy}
            maxLength={60}
            placeholder="PINTU (produksi)"
            autoComplete="off"
            aria-invalid={errors.nama ? true : undefined}
            aria-describedby={errors.nama ? `${id}-nama-error` : `${id}-nama-desc`}
          />
          {errors.nama ? (
            <FieldError id={`${id}-nama-error`}>{errors.nama}</FieldError>
          ) : (
            <FieldDescription id={`${id}-nama-desc`}>Tampil di Log Aktivitas setiap kali kunci ini dipakai.</FieldDescription>
          )}
        </Field>
        <Field data-invalid={errors.keterangan ? true : undefined}>
          <FieldLabel htmlFor={`${id}-ket`}>
            Keterangan <span className="font-normal text-muted-foreground">(opsional)</span>
          </FieldLabel>
          <Textarea
            id={`${id}-ket`}
            value={keterangan}
            onChange={(e) => { setKeterangan(e.target.value); touch('keterangan'); }}
            disabled={busy}
            maxLength={200}
            rows={2}
            placeholder="Mis. dipakai form Tambah akun di PINTU"
            aria-invalid={errors.keterangan ? true : undefined}
            aria-describedby={errors.keterangan ? `${id}-ket-error` : undefined}
          />
          {errors.keterangan ? <FieldError id={`${id}-ket-error`}>{errors.keterangan}</FieldError> : null}
        </Field>
        <FieldSet data-invalid={errors.izin ? true : undefined}>
          <FieldLegend variant="label">Izin</FieldLegend>
          {IZIN_API.map((value) => (
            <Field key={value} orientation="horizontal" data-disabled={busy || undefined}>
              <Checkbox
                id={`${id}-izin-${value}`}
                checked={izin.includes(value)}
                onCheckedChange={(checked) => toggleIzin(value, checked === true)}
                disabled={busy}
                aria-describedby={`${id}-izin-${value}-desc`}
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${id}-izin-${value}`} className="font-normal">{IZIN_API_LABELS[value]}</Label>
                <span id={`${id}-izin-${value}-desc`} className="text-xs text-muted-foreground">
                  Cari pegawai aktif (NIP, nama, jabatan, unit). Email dan no HP hanya pada detail per NIP, dan setiap pembacaan dicatat.
                </span>
              </div>
            </Field>
          ))}
          {errors.izin ? <FieldError>{errors.izin}</FieldError> : null}
        </FieldSet>
        <Field data-invalid={errors.masaBerlakuHari ? true : undefined}>
          <FieldLabel htmlFor={`${id}-masa`}>Masa berlaku</FieldLabel>
          <Select value={masa} onValueChange={(v) => { setMasa(v); touch('masaBerlakuHari'); }} disabled={busy}>
            <SelectTrigger id={`${id}-masa`} className="w-full" aria-describedby={`${id}-masa-desc`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MASA_BERLAKU_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.masaBerlakuHari ? (
            <FieldError>{errors.masaBerlakuHari}</FieldError>
          ) : (
            <FieldDescription id={`${id}-masa-desc`}>Setelah lewat, kunci berhenti bekerja. Buat kunci baru sebelum tanggal itu.</FieldDescription>
          )}
        </Field>
      </FieldGroup>
      {formError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Gagal membuat kunci</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Batal</Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
          Buat kunci
        </Button>
      </DialogFooter>
    </form>
  );
}

function KunciSekali({ created, onDone }: { created: KunciApiCreateResponse; onDone: () => void }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.kunci);
      setCopied(true);
      toast.success('Kunci API disalin.');
    } catch {
      inputRef.current?.select();
      toast.error('Tidak bisa menyalin otomatis. Kunci sudah dipilih; tekan Ctrl+C.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Kunci API untuk {created.item.nama}</DialogTitle>
        <DialogDescription>Berlaku sampai {formatDateWITA(created.item.expiresAt)}.</DialogDescription>
      </DialogHeader>
      <Alert variant="pending">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>Salin sekarang. Kunci ini tidak akan ditampilkan lagi.</AlertTitle>
        <AlertDescription>
          SIKAP hanya menyimpan sidik kuncinya. Kalau hilang, hapus kunci ini lalu buat yang baru.
        </AlertDescription>
      </Alert>
      <Field>
        <FieldLabel htmlFor={`${id}-kunci`}>Kunci API</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={`${id}-kunci`}
            ref={inputRef}
            value={created.kunci}
            readOnly
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
            aria-describedby={`${id}-kunci-desc`}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={() => void copy()} aria-label="Salin kunci API">
              {copied ? <Check /> : <Copy />}
              {copied ? 'Disalin' : 'Salin'}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription id={`${id}-kunci-desc`}>
          Simpan hanya di server aplikasi klien, mis. variabel lingkungan <code className="font-mono">SIKAP_API_KEY</code> di PINTU. Jangan
          kirim lewat chat, jangan simpan di browser atau repo.
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          <Check data-icon="inline-start" />
          Saya sudah menyimpan kunci
        </Button>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function HapusKunciDialog({ item, onClose }: { item: KunciApiItem | null; onClose: () => void }) {
  const mutation = useHapusKunciApi();
  const busy = mutation.isPending;
  // Keep showing the last key while the close animation runs (item is already null by then).
  const [last, setLast] = useState<KunciApiItem | null>(item);
  if (item !== null && item !== last) setLast(item);
  const shown = item ?? last;

  const hapus = async (event: MouseEvent) => {
    event.preventDefault();
    if (!item || busy) return;
    try {
      await mutation.mutateAsync(item.id);
      toast.success(`Kunci API "${item.nama}" dihapus.`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <AlertDialog open={item !== null} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Hapus kunci API {shown ? `"${shown.nama}"` : ''}?</AlertDialogTitle>
          <AlertDialogDescription>
            Aplikasi yang memakai kunci <code className="font-mono">{shown ? kunciLabel(shown.idPublik) : ''}</code> langsung tidak bisa lagi
            mengambil data pegawai. Tindakan ini tidak dapat dibatalkan; jejaknya tetap ada di Log Aktivitas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Batal</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => void hapus(e)}>
            {busy ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
            Hapus kunci
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Bell, Check, DatabaseBackup, Eye, EyeOff, KeyRound, ListTree, MessageCircle, RefreshCw, Send, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  WA_PROVIDERS,
  notifSettingsSchema,
  updateWhatsAppSchema,
  type NotifSettings,
  type TestWhatsAppResponse,
  type WaProvider,
  type WhatsAppSettings,
} from '@shared/verifikasi';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { ErrorState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReferensiPanel } from '@/features/referensi/referensi-panel';
import BackupPanel from '@/features/backup/backup-panel';
import { errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  useNotifSettings,
  useTestWhatsApp,
  useUpdateNotifSettings,
  useUpdateWhatsApp,
  useWhatsAppSettings,
} from './queries';
import {
  buildWhatsAppPayload,
  cancelClearSecret,
  clearSecret,
  isClearingSecret,
  setPlainField,
  typeSecret,
  type DraftField,
  type WhatsAppDraft,
} from './settings-draft';

const NOTIFICATIONS: { key: keyof NotifSettings; title: string; description: string }[] = [
  { key: 'dokumenBaru', title: 'Dokumen baru → admin', description: 'Beri tahu admin saat pegawai mengunggah dokumen baru atau mengunggah ulang.' },
  { key: 'dokumenApproved', title: 'Dokumen disetujui → pegawai', description: 'Beri tahu pegawai ketika dokumennya selesai diverifikasi dan disetujui.' },
  { key: 'dokumenRejected', title: 'Dokumen ditolak → pegawai', description: 'Kirim alasan penolakan agar pegawai dapat memperbaiki dan mengunggah ulang.' },
];
const PROVIDER_LABELS: Record<WaProvider, string> = { fonnte: 'Fonnte', meta: 'Meta Cloud API' };

const SECTIONS: { id: string; label: string; description: string; icon: LucideIcon }[] = [
  { id: 'notifikasi', label: 'Notifikasi', description: 'Pesan otomatis saat dokumen diunggah, disetujui, atau ditolak.', icon: Bell },
  { id: 'whatsapp', label: 'WhatsApp', description: 'Provider pengiriman pesan dan antrean pengiriman.', icon: MessageCircle },
  { id: 'referensi', label: 'Referensi', description: 'Pangkat/golongan, unit kerja, dan jenjang pendidikan.', icon: ListTree },
  { id: 'backup', label: 'Backup', description: 'Ekspor data logis dan riwayat backup.', icon: DatabaseBackup },
];
type SectionId = (typeof SECTIONS)[number]['id'];

const LG_QUERY = '(min-width: 1024px)';
function subscribeLg(onChange: () => void) {
  const mql = window.matchMedia(LG_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Section nav: vertical list on lg+ (arrow up/down), horizontal scroller on phones (arrow left/right). */
function useNavOrientation(): 'vertical' | 'horizontal' {
  return useSyncExternalStore(
    subscribeLg,
    () => (window.matchMedia(LG_QUERY).matches ? 'vertical' : 'horizontal'),
    () => 'vertical',
  );
}

export default function PengaturanPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const orientation = useNavOrientation();
  const requested = searchParams.get('bagian');
  const section: SectionId = SECTIONS.some((s) => s.id === requested) ? (requested as SectionId) : 'notifikasi';

  const changeSection = (value: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'notifikasi') next.delete('bagian');
        else next.set('bagian', value);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Pengaturan Sistem" description="Kelola notifikasi, koneksi WhatsApp, data referensi, dan backup SIKAP." />
      <Tabs value={section} onValueChange={changeSection} orientation={orientation} className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 lg:sticky lg:top-20 lg:w-52 lg:shrink-0 lg:overflow-visible">
          <TabsList
            aria-label="Bagian pengaturan sistem"
            className="lg:w-full lg:items-stretch lg:gap-0.5 lg:bg-transparent lg:p-0"
          >
            {SECTIONS.map((s) => (
              <TabsTrigger
                key={s.id}
                value={s.id}
                className="px-3 lg:h-9 lg:justify-start lg:data-active:bg-card lg:data-active:text-primary lg:data-active:shadow-card lg:data-active:ring-1 lg:data-active:ring-border"
              >
                <s.icon data-icon="inline-start" />
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* forceMount: every tab's aria-controls resolves; only the active section renders (and fetches). */}
        {SECTIONS.map((s) => (
          <TabsContent key={s.id} value={s.id} forceMount className="flex min-w-0 flex-col gap-4 data-[state=inactive]:hidden">
            {s.id === section ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-h2 text-foreground">{s.label}</h2>
                  <p className="text-sm text-muted-foreground">{s.description}</p>
                </div>
                {s.id === 'notifikasi' ? <NotificationsSection /> : null}
                {s.id === 'whatsapp' ? <WhatsAppSection /> : null}
                {s.id === 'referensi' ? <ReferensiPanel /> : null}
                {s.id === 'backup' ? <BackupPanel /> : null}
              </>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function NotificationsSection() {
  const query = useNotifSettings();
  const save = useUpdateNotifSettings();
  // A synchronous latch closes the small gap before React renders isPending.
  const saving = useRef(false);
  const id = useId();
  const toggle = async (key: keyof NotifSettings, checked: boolean) => {
    if (!query.data || saving.current) return;
    saving.current = true;
    try {
      await save.mutateAsync(notifSettingsSchema.parse({ ...query.data, [key]: checked }));
      toast.success('Pengaturan notifikasi disimpan.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      saving.current = false;
    }
  };

  if (query.isPending) return <SettingsSkeleton />;
  if (query.isError) return <LoadError error={query.error} fetching={query.isFetching} retry={() => void query.refetch()} />;
  return (
    <SectionCard
      className="max-w-3xl"
      headingLevel="h3"
      title="Notifikasi dokumen"
      description="Pesan dikirim melalui provider WhatsApp yang aktif. Perubahan tersimpan otomatis."
      footer={
        <p className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {save.isPending ? (
            <>
              <Spinner />
              Menyimpan perubahan…
            </>
          ) : (
            'Notifikasi hanya dikirim jika penerima telah mengisi nomor HP.'
          )}
        </p>
      }
    >
      <FieldGroup className="gap-0" aria-busy={save.isPending}>
        {NOTIFICATIONS.map((row) => (
          <Field
            key={row.key}
            orientation="horizontal"
            data-disabled={save.isPending || undefined}
            className="items-center border-b py-4 first:pt-0 last:border-0 last:pb-0"
          >
            <FieldContent>
              <FieldLabel htmlFor={`${id}-${row.key}`}>{row.title}</FieldLabel>
              <FieldDescription id={`${id}-${row.key}-description`}>{row.description}</FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-${row.key}`}
              checked={query.data[row.key]}
              onCheckedChange={(checked) => void toggle(row.key, checked)}
              disabled={save.isPending}
              aria-describedby={`${id}-${row.key}-description`}
            />
          </Field>
        ))}
      </FieldGroup>
    </SectionCard>
  );
}

function WhatsAppSection() {
  const query = useWhatsAppSettings();
  if (query.isPending) return <SettingsSkeleton />;
  if (query.isError) return <LoadError error={query.error} fetching={query.isFetching} retry={() => void query.refetch()} />;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <WhatsAppForm settings={query.data} />
      <OutboxHealth outbox={query.data.outbox} refreshing={query.isFetching} onRefresh={() => void query.refetch()} />
    </div>
  );
}

/** Result/error box under the WhatsApp form. */
function Callout({ tone, icon: Icon, title, children }: { tone: 'verified' | 'rejected'; icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <Alert variant={tone === 'verified' ? 'success' : 'destructive'} role={tone === 'rejected' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function WhatsAppForm({ settings }: { settings: WhatsAppSettings }) {
  const id = useId();
  const save = useUpdateWhatsApp();
  const test = useTestWhatsApp();
  const [providerDraft, setProviderDraft] = useState<WaProvider | undefined>();
  const [draft, setDraft] = useState<WhatsAppDraft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestWhatsAppResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const provider = providerDraft ?? settings.provider;
  const dirty = provider !== settings.provider || Object.keys(draft).length > 0;
  const busy = save.isPending || test.isPending;
  const configured = settings[settings.provider].configured;

  const updateDraft = (field: DraftField, change: (current: WhatsAppDraft) => WhatsAppDraft) => {
    setDraft(change);
    setErrors((current) => ({ ...current, [field]: '' }));
    setFormError(null);
    setTestResult(null);
    setTestError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !dirty) return;
    // provider is mandatory in the fixed schema, even when only a secret changed.
    const parsed = updateWhatsAppSchema.safeParse(buildWhatsAppPayload(provider, draft));
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0])] ??= issue.message;
      setErrors(fields);
      return;
    }
    busyRef.current = true;
    setErrors({});
    setFormError(null);
    try {
      await save.mutateAsync(parsed.data);
      // Clear secrets from component state immediately after saving.
      setDraft({});
      setProviderDraft(undefined);
      setTestResult(null);
      setTestError(null);
      toast.success('Pengaturan WhatsApp disimpan.');
    } catch (error) {
      if (isApiError(error, 'VALIDATION_ERROR') && error.fields) setErrors(error.fields);
      setFormError(errorMessage(error));
    } finally {
      busyRef.current = false;
    }
  };

  const sendTest = async () => {
    if (busyRef.current || dirty) return;
    busyRef.current = true;
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await test.mutateAsync());
    } catch (error) {
      setTestError(errorMessage(error));
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-col gap-1 border-b p-5">
        <h3 className="text-h3">Koneksi WhatsApp</h3>
        <p className="text-sm text-muted-foreground">Token disimpan terenkripsi dan tidak pernah ditampilkan kembali.</p>
      </div>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="p-5">
          <FieldGroup>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Provider</FieldLegend>
              <RadioGroup
                value={provider}
                onValueChange={(value) => {
                  if (!WA_PROVIDERS.includes(value as WaProvider)) return;
                  setProviderDraft(value as WaProvider);
                  setTestResult(null);
                  setTestError(null);
                }}
                className="grid-cols-1 sm:grid-cols-2"
                aria-label="Provider WhatsApp"
              >
                {WA_PROVIDERS.map((value) => (
                  <FieldLabel key={value} htmlFor={`${id}-${value}`}>
                    <Field orientation="horizontal" data-checked={provider === value ? '' : undefined}>
                      <RadioGroupItem value={value} id={`${id}-${value}`} disabled={busy} />
                      <FieldContent>
                        <span className="text-sm font-medium">{PROVIDER_LABELS[value]}</span>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>
            {provider === 'fonnte' ? (
              <TokenField
                key="fonnte"
                id={`${id}-fonnte-token`}
                label="Token Fonnte"
                value={draft.fonnteToken ?? ''}
                configured={settings.fonnte.configured}
                tokenHint={settings.fonnte.tokenHint}
                clearing={isClearingSecret(draft, 'fonnteToken')}
                onChange={(value) => updateDraft('fonnteToken', (d) => typeSecret(d, 'fonnteToken', value))}
                onClear={() => updateDraft('fonnteToken', (d) => clearSecret(d, 'fonnteToken'))}
                onCancelClear={() => updateDraft('fonnteToken', (d) => cancelClearSecret(d, 'fonnteToken'))}
                disabled={busy}
                error={errors.fonnteToken}
                maxLength={200}
              />
            ) : (
              <>
                <TokenField
                  key="meta"
                  id={`${id}-meta-token`}
                  label="Token Meta Cloud API"
                  value={draft.metaToken ?? ''}
                  configured={settings.meta.configured}
                  tokenHint={settings.meta.tokenHint}
                  clearing={isClearingSecret(draft, 'metaToken')}
                  onChange={(value) => updateDraft('metaToken', (d) => typeSecret(d, 'metaToken', value))}
                  onClear={() => updateDraft('metaToken', (d) => clearSecret(d, 'metaToken'))}
                  onCancelClear={() => updateDraft('metaToken', (d) => cancelClearSecret(d, 'metaToken'))}
                  disabled={busy}
                  error={errors.metaToken}
                  maxLength={1000}
                />
                <Field data-invalid={errors.metaPhoneNumberId ? true : undefined} data-disabled={busy || undefined}>
                  <FieldLabel htmlFor={`${id}-phone-id`}>Phone Number ID</FieldLabel>
                  <Input
                    id={`${id}-phone-id`}
                    value={draft.metaPhoneNumberId ?? settings.meta.phoneNumberId ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateDraft('metaPhoneNumberId', (d) => setPlainField(d, 'metaPhoneNumberId', value));
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={30}
                    disabled={busy}
                    placeholder="ID nomor dari Meta WhatsApp Manager"
                    aria-invalid={errors.metaPhoneNumberId ? true : undefined}
                    aria-describedby={errors.metaPhoneNumberId ? `${id}-phone-error` : undefined}
                  />
                  {errors.metaPhoneNumberId ? <FieldError id={`${id}-phone-error`}>{errors.metaPhoneNumberId}</FieldError> : null}
                </Field>
                <FieldDescription>
                  Template Meta harus disetujui dalam bahasa Indonesia: <code>dokumen_baru_admin</code>,{' '}
                  <code>dokumen_terverifikasi</code>, dan <code>dokumen_ditolak</code>.
                </FieldDescription>
              </>
            )}
            {formError ? (
              <Callout tone="rejected" icon={TriangleAlert} title="Gagal menyimpan">
                {formError}
              </Callout>
            ) : null}
            {testResult || testError ? (
              testResult?.ok ? (
                <Callout tone="verified" icon={Check} title="Pesan uji berhasil dikirim">
                  {`Pesan dikirim ke nomor HP akun Anda melalui ${PROVIDER_LABELS[testResult.provider]}.`}
                </Callout>
              ) : (
                <Callout tone="rejected" icon={TriangleAlert} title="Pesan uji gagal dikirim">
                  {testError ?? testResult?.detail ?? 'Periksa token, koneksi provider, dan nomor HP akun Anda.'}
                </Callout>
              )
            ) : null}
          </FieldGroup>
        </div>
        <div className="flex flex-col gap-3 border-t bg-muted/40 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || busy}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
              Simpan pengaturan
            </Button>
            <Button type="button" variant="outline" className="bg-card" onClick={() => void sendTest()} disabled={busy || dirty || !configured}>
              {test.isPending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
              Kirim pesan uji
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" role="status">
            {dirty
              ? 'Ada perubahan yang belum disimpan. Simpan sebelum mengirim pesan uji.'
              : !configured
                ? 'Lengkapi dan simpan token provider untuk mengirim pesan uji.'
                : 'Pesan uji dikirim ke nomor HP admin yang sedang masuk.'}
          </p>
        </div>
      </form>
    </Card>
  );
}

function TokenField({
  id,
  label,
  value,
  configured,
  tokenHint,
  clearing,
  onChange,
  onClear,
  onCancelClear,
  disabled,
  error,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  configured: boolean;
  tokenHint: string | null;
  clearing: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  onCancelClear: () => void;
  disabled: boolean;
  error?: string;
  maxLength: number;
}) {
  const [visible, setVisible] = useState(false);
  const deleting = clearing && configured;
  const hint = deleting
    ? 'Token akan dihapus — isi untuk mengganti'
    : tokenHint
      ? `Tersimpan (${tokenHint.includes('•') ? tokenHint : `••••${tokenHint}`}) — isi untuk mengganti`
      : 'Tersimpan — isi untuk mengganti';
  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={configured ? hint : 'Masukkan token provider'}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-description${error ? ` ${id}-error` : ''}`}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            aria-label={visible ? 'Sembunyikan token' : 'Tampilkan token'}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            disabled={disabled}
          >
            {visible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldDescription
          id={`${id}-description`}
          role="status"
          className={deleting ? 'flex items-center gap-1.5 font-medium text-destructive' : undefined}
        >
          {deleting ? (
            <>
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Token akan dihapus saat pengaturan disimpan.
            </>
          ) : (
            'Biarkan kosong untuk mempertahankan token tersimpan.'
          )}
        </FieldDescription>
        {configured ? (
          deleting ? (
            <Button type="button" variant="link" size="sm" disabled={disabled} onClick={onCancelClear}>
              Batalkan hapus
            </Button>
          ) : (
            <Button type="button" variant="link" size="sm" className="text-destructive" disabled={disabled} onClick={onClear}>
              Hapus token
            </Button>
          )
        ) : null}
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

function OutboxHealth({ outbox, refreshing, onRefresh }: { outbox: WhatsAppSettings['outbox']; refreshing: boolean; onRefresh: () => void }) {
  const stats = [
    { label: 'Menunggu', value: outbox.pending, tone: 'text-status-pending' },
    { label: 'Gagal', value: outbox.failed, tone: 'text-status-rejected' },
    { label: 'Terkirim 24 jam', value: outbox.sentLast24h, tone: 'text-status-verified' },
  ];
  return (
    <SectionCard
      headingLevel="h3"
      title="Antrean pengiriman"
      description="Status pesan WhatsApp yang diproses sistem."
      action={
        <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={refreshing} aria-label="Muat ulang status pengiriman">
          {refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
      }
    >
      <div className="flex flex-col gap-5" aria-busy={refreshing}>
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1">
              <dt className="text-eyebrow text-muted-foreground uppercase">{stat.label}</dt>
              <dd className={cn('text-metric tabular-nums', stat.tone)}>{stat.value.toLocaleString('id-ID')}</dd>
            </div>
          ))}
        </dl>
        {outbox.lastError ? (
          <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-medium">Kesalahan terakhir</p>
            <p className="text-xs break-words text-muted-foreground">{outbox.lastError}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Belum ada kesalahan pengiriman.</p>
        )}
        <p className="text-xs text-muted-foreground">Pesan yang gagal dikirim dicoba ulang otomatis hingga batas percobaan tercapai.</p>
      </div>
    </SectionCard>
  );
}

function LoadError({ error, fetching, retry }: { error: unknown; fetching: boolean; retry: () => void }) {
  return (
    <Card className="max-w-3xl py-0">
      <ErrorState error={error} title="Gagal memuat pengaturan" onRetry={retry} retrying={fetching} />
    </Card>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex max-w-3xl flex-col gap-4" aria-busy="true" aria-label="Memuat pengaturan">
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

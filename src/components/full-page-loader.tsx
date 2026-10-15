import { Spinner } from '@/components/ui/spinner';

export function FullPageLoader({ label = 'Memuat…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-svh flex-col items-center justify-center gap-3 bg-background">
      <Spinner className="size-6 text-primary" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

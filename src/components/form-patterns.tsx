// Form and overlay patterns (docs/RENCANA-REDESIGN-UIUX.md §7):
// - FormSection: titled 1- or 2-column field grid; LockedHint marks read-only fields.
// - StickySaveBar: save/discard bar that stays visible above the mobile bottom nav.
// - EntitySheet (> 6 fields) and FormDialog (<= 6 fields): fixed widths, scrollable body, actions on the right.
import type { ReactNode } from 'react';
import { CircleCheck, Lock, Save, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface FormSectionProps {
  title: string;
  description?: ReactNode;
  columns?: 1 | 2;
  children: ReactNode;
  className?: string;
}

/** A titled group of fields. Use inside a SectionCard or a sheet body. */
export function FormSection({ title, description, columns = 2, children, className }: FormSectionProps) {
  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-4', className)}>
      <div className="flex flex-col gap-0.5">
        <legend className="text-h3 text-foreground">{title}</legend>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className={cn('grid gap-x-4 gap-y-5', columns === 2 && 'sm:grid-cols-2')}>{children}</div>
    </fieldset>
  );
}

/** Lock icon with an explanation, placed next to the label of a read-only field. */
export function LockedHint({ reason = 'Diubah melalui pengajuan perubahan data.' }: { reason?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Terkunci: ${reason}`}
        >
          <Lock className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

interface StickySaveBarProps {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  /** Overrides the status text, e.g. a validation summary. */
  message?: ReactNode;
  /** `submit` when the bar sits inside a <form> (Enter submits). */
  saveType?: 'button' | 'submit';
  className?: string;
}

/**
 * Save bar at the end of a form. While there are unsaved changes it sticks to the bottom of the
 * viewport (above the phone bottom nav) so Save stays reachable; when clean it sits in the flow.
 */
export function StickySaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  saveLabel = 'Simpan perubahan',
  message,
  saveType = 'button',
  className,
}: StickySaveBarProps) {
  const pinned = dirty || saving || message !== undefined;
  return (
    <div
      className={cn(
        'z-[5] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/85',
        pinned ? 'sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] shadow-pop md:bottom-4' : 'shadow-card',
        className,
      )}
    >
      {/* basis-48: on narrow screens the status takes its own line instead of running under the buttons. */}
      <p className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        {message ?? (dirty ? (
          'Ada perubahan yang belum disimpan.'
        ) : (
          <>
            <CircleCheck className="size-4 shrink-0 text-status-verified" aria-hidden="true" />
            <span className="min-w-0">Semua perubahan tersimpan.</span>
          </>
        ))}
      </p>
      <div className="ml-auto flex items-center gap-2">
        {onDiscard ? (
          <Button type="button" variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
            <Undo2 data-icon="inline-start" />
            Batalkan
          </Button>
        ) : null}
        <Button type={saveType} onClick={saveType === 'button' ? onSave : undefined} disabled={!dirty || saving}>
          {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {saving ? 'Menyimpan…' : saveLabel}
        </Button>
      </div>
    </div>
  );
}

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Footer actions, cancel first then the primary action (rendered right-aligned). */
  footer?: ReactNode;
  className?: string;
}

/** Create/edit surface for entities with more than six fields: right sheet, fixed width, scrolling body. */
export function EntitySheet({ open, onOpenChange, title, description, children, footer, className }: OverlayProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Same data-[side] variants as the base classes, otherwise the default w-3/4 / sm:max-w-sm win. */}
      <SheetContent className={cn('flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl', className)}>
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}

/** Create/edit surface for six fields or fewer, and for focused decisions (reject with reason). */
export function FormDialog({ open, onOpenChange, title, description, children, footer, className }: OverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="flex flex-col gap-4">{children}</div>
        {footer ? <DialogFooter className="gap-2 sm:justify-end">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

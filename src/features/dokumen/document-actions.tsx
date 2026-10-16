import { Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { DOCUMENT_POLICY, type DokumenItem } from '@shared/dokumen';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { uploadLabel } from './dokumen-utils';
import { useDeleteDocument } from './queries';

type ButtonProps = React.ComponentProps<typeof Button>;

/** Upload / re-upload button; when blocked, a disabled button whose reason is reachable by keyboard via a tooltip. */
export function UploadActionButton({
  item,
  onUpload,
  variant = 'default',
  size = 'sm',
  className,
}: {
  item: DokumenItem;
  onUpload: (item: DokumenItem) => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) {
  const label = uploadLabel(item);
  if (item.can.upload) {
    return (
      <Button variant={variant} size={size} className={className} onClick={() => onUpload(item)}>
        <Upload data-icon="inline-start" />
        {label}
      </Button>
    );
  }
  const reason = item.uploadBlockedReason ?? 'Dokumen tidak dapat diunggah saat ini.';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button receives no pointer/focus events: the wrapper carries the tooltip. */}
        <span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`${label}: ${reason}`}>
          <Button variant={variant} size={size} className={className} disabled tabIndex={-1} aria-hidden="true">
            <Upload data-icon="inline-start" />
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
  );
}

export function DeleteDocumentDialog({
  item,
  onOpenChange,
  onDeleted,
}: {
  item: DokumenItem | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (item: DokumenItem) => void;
}) {
  const remove = useDeleteDocument();
  const arsip = item?.arsip;
  const days = DOCUMENT_POLICY.softDeleteRetentionDays;

  const confirm = (event: React.MouseEvent) => {
    // Keep the dialog open while the request runs.
    event.preventDefault();
    if (!arsip || !item) return;
    remove.mutate(arsip.id, {
      onSuccess: ({ item: updated }) => {
        toast.success(`${item.nama} dihapus. Anda dapat memulihkannya dalam ${days} hari.`);
        onOpenChange(false);
        onDeleted?.(updated);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <AlertDialog open={item !== null} onOpenChange={(open) => !remove.isPending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>Hapus {item?.nama}?</AlertDialogTitle>
          <AlertDialogDescription>
            File <span className="font-medium break-all text-foreground">{arsip?.fileName}</span> akan dihapus dan status
            dokumen kembali menjadi Belum diunggah. File masih dapat dipulihkan dalam {days} hari sebelum dihapus permanen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Batal</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={remove.isPending}>
            {remove.isPending ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
            Hapus
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

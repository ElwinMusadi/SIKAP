import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ImageUp, Minus, Plus, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { PHOTO_POLICY } from '@shared/profile';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { useUploadPhoto } from '@/features/profil/queries';
import { errorMessage } from '@/lib/api';

const ACCEPTED_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;
/** Keyboard pan step as a fraction of the viewport. */
const PAN_STEP = 0.05;

/** Crop state in natural image pixels: centre of the square viewport + zoom (1 = cover). */
interface CropState {
  cx: number;
  cy: number;
  zoom: number;
}

function validateInput(file: File): string | null {
  if (!ACCEPTED_INPUT_TYPES.includes(file.type)) return 'Format foto harus JPG, PNG, atau WebP.';
  if (file.size > MAX_INPUT_BYTES) return 'Ukuran foto maksimal 10 MB.';
  return null;
}

function clampCrop(img: HTMLImageElement, next: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
  const half = Math.min(img.naturalWidth, img.naturalHeight) / (2 * zoom);
  return {
    zoom,
    cx: Math.min(img.naturalWidth - half, Math.max(half, next.cx)),
    cy: Math.min(img.naturalHeight - half, Math.max(half, next.cy)),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Renders the crop to PHOTO_POLICY.outputSize² WebP (JPEG fallback), shrinking quality if needed. */
async function exportCrop(img: HTMLImageElement, crop: CropState): Promise<Blob> {
  const size = PHOTO_POLICY.outputSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Browser tidak mendukung pengolahan gambar.');
  ctx.imageSmoothingQuality = 'high';
  const side = Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom;
  ctx.drawImage(img, crop.cx - side / 2, crop.cy - side / 2, side, side, 0, 0, size, size);

  for (const quality of [0.9, 0.8, 0.7]) {
    let blob = await toBlob(canvas, 'image/webp', quality);
    // Safari < 17 silently returns PNG for unsupported types: re-encode as JPEG.
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
    if (!blob) break;
    if (blob.size <= PHOTO_POLICY.maxBytes) return blob;
  }
  throw new Error('Foto hasil potongan terlalu besar. Coba foto lain.');
}

interface PhotoCropperProps {
  /** Content of the trigger button (icon and/or text). */
  children: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
}

/**
 * Photo picker + 1:1 cropper + uploader. Only the auth/profile photo URL caches are
 * updated on success, so unsaved profile form edits are never lost.
 */
export function PhotoCropper({ children, triggerClassName, triggerLabel = 'Ubah foto profil' }: PhotoCropperProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const upload = useUploadPhoto();

  const pick = () => inputRef.current?.click();

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!selected) return;
    const error = validateInput(selected);
    upload.reset();
    setInputError(error);
    setFile(error ? null : selected);
    setOpen(true);
  };

  const onOpenChange = (next: boolean) => {
    if (upload.isPending) return;
    setOpen(next);
    if (!next) {
      setFile(null);
      setInputError(null);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_INPUT_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFileChange}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        className={triggerClassName}
        aria-label={triggerLabel}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" showCloseButton={!upload.isPending}>
          <DialogHeader>
            <DialogTitle>Ubah Foto Profil</DialogTitle>
            <DialogDescription>
              Geser foto untuk mengatur posisi dan gunakan pengatur zoom. Foto akan disimpan berbentuk persegi.
            </DialogDescription>
          </DialogHeader>
          {file ? (
            <CropperBody
              key={`${file.name}-${file.lastModified}-${file.size}`}
              file={file}
              uploading={upload.isPending}
              uploadError={upload.isError ? errorMessage(upload.error) : null}
              onPickAnother={pick}
              onCancel={() => onOpenChange(false)}
              onSave={(blob, onProgress) =>
                upload.mutate(
                  { blob, filename: blob.type === 'image/webp' ? 'foto.webp' : 'foto.jpg', onProgress },
                  {
                    onSuccess: () => {
                      toast.success('Foto profil berhasil diperbarui.');
                      setOpen(false);
                      setFile(null);
                    },
                  },
                )
              }
            />
          ) : (
            <>
              <Alert variant="destructive" role="alert">
                <TriangleAlert />
                <AlertTitle>Foto tidak dapat digunakan</AlertTitle>
                <AlertDescription>{inputError ?? 'Pilih foto terlebih dahulu.'}</AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Batal
                </Button>
                <Button onClick={pick}>
                  <ImageUp data-icon="inline-start" />
                  Pilih foto lain
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

interface CropperBodyProps {
  file: File;
  uploading: boolean;
  uploadError: string | null;
  onPickAnother: () => void;
  onCancel: () => void;
  onSave: (blob: Blob, onProgress: (p: number) => void) => void;
}

function CropperBody({ file, uploading, uploadError, onPickAnother, onCancel, onSave }: CropperBodyProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; crop: CropState } | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setSrc(url);
      setImg(image);
      setCrop({ cx: image.naturalWidth / 2, cy: image.naturalHeight / 2, zoom: 1 });
    };
    image.onerror = () => setLoadError('Foto tidak dapat dibaca. Pastikan file gambar tidak rusak.');
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const update = (next: CropState) => img && setCrop(clampCrop(img, next));

  /** Natural pixels per viewport pixel at the current zoom. */
  const naturalPerPx = () => {
    if (!img || !crop || !viewportRef.current) return 1;
    const width = viewportRef.current.getBoundingClientRect().width || 1;
    return Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom / width;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!crop || uploading) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, crop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const k = naturalPerPx();
    update({ ...drag.crop, cx: drag.crop.cx - (event.clientX - drag.x) * k, cy: drag.crop.cy - (event.clientY - drag.y) * k });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!crop || !img || uploading) return;
    const step = (Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom) * PAN_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      update({ ...crop, cx: crop.cx + move[0], cy: crop.cy + move[1] });
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      update({ ...crop, zoom: crop.zoom + ZOOM_STEP });
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      update({ ...crop, zoom: crop.zoom - ZOOM_STEP });
    }
  };

  const save = async () => {
    if (!img || !crop) return;
    setExportError(null);
    setExporting(true);
    try {
      const blob = await exportCrop(img, crop);
      setProgress(0);
      onSave(blob, setProgress);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Gagal memproses foto.');
    } finally {
      setExporting(false);
    }
  };

  // Image geometry as percentages of the viewport, so no measurement is needed to render.
  let imageStyle: React.CSSProperties | undefined;
  if (img && crop) {
    const scale = crop.zoom / Math.min(img.naturalWidth, img.naturalHeight); // viewport fraction per natural px
    imageStyle = {
      width: `${img.naturalWidth * scale * 100}%`,
      height: `${img.naturalHeight * scale * 100}%`,
      left: `${(0.5 - crop.cx * scale) * 100}%`,
      top: `${(0.5 - crop.cy * scale) * 100}%`,
    };
  }

  const busy = uploading || exporting;
  const error = loadError ?? exportError ?? uploadError;

  return (
    <>
      <div className="flex flex-col items-center gap-4">
        <div
          ref={viewportRef}
          role="group"
          tabIndex={0}
          aria-label="Area potong foto. Gunakan tombol panah untuk menggeser, tombol plus dan minus untuk memperbesar atau memperkecil."
          aria-busy={!img}
          className="relative aspect-square w-full max-w-72 cursor-grab touch-none overflow-hidden rounded-xl bg-muted outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          {src && imageStyle ? (
            <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={imageStyle} />
          ) : !loadError ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-6 text-muted-foreground" />
            </div>
          ) : null}
          {/* Circular guide: the avatar is shown round across the app. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_color-mix(in_oklch,var(--background)_55%,transparent)] ring-1 ring-background/80"
          />
        </div>

        <div className="flex w-full max-w-72 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Perkecil"
            disabled={!crop || busy || crop.zoom <= MIN_ZOOM}
            onClick={() => crop && update({ ...crop, zoom: crop.zoom - ZOOM_STEP * 2 })}
          >
            <Minus />
          </Button>
          <input
            type="range"
            aria-label="Zoom foto"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={crop?.zoom ?? 1}
            disabled={!crop || busy}
            onChange={(event) => crop && update({ ...crop, zoom: Number(event.target.value) })}
            className="h-1.5 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Perbesar"
            disabled={!crop || busy || crop.zoom >= MAX_ZOOM}
            onClick={() => crop && update({ ...crop, zoom: crop.zoom + ZOOM_STEP * 2 })}
          >
            <Plus />
          </Button>
        </div>

        {uploading ? (
          <div className="flex w-full flex-col gap-1.5" aria-live="polite">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Mengunggah foto…</span>
              <span className="tabular-nums">{progress}%</span>
            </div>
            <Progress value={progress} aria-label="Progres unggah foto" />
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive" role="alert" className="w-full">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="ghost" disabled={busy} onClick={onPickAnother}>
          <ImageUp data-icon="inline-start" />
          Pilih foto lain
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Batal
          </Button>
          <Button type="button" disabled={!crop || busy} onClick={() => void save()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Simpan Foto
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

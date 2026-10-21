import { useState } from 'react';
import { format, subDays } from 'date-fns';
import { id as localeId } from 'date-fns/locale/id';
import { CalendarDays } from 'lucide-react';
import { id as dayPickerId } from 'react-day-picker/locale/id';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fromIsoDate, toIsoDate } from '@/lib/iso-date';
import { cn } from '@/lib/utils';

interface DatePickerProps {
  id?: string;
  /** 'YYYY-MM-DD' or '' when empty. */
  value: string | null | undefined;
  onChange: (value: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Month shown when no value is selected. */
  defaultMonth?: Date;
  fromYear?: number;
  /** Latest selectable date (default: today). */
  maxDate?: Date;
  className?: string;
}

/** Date-only picker. Values are local calendar dates, so there is never a timezone shift. */
export function DatePicker({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  disabled,
  placeholder = 'Pilih tanggal',
  defaultMonth,
  fromYear = 1950,
  maxDate,
  className,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = fromIsoDate(value);
  const today = new Date();
  const max = maxDate ?? today;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onBlur?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cn(
            'w-full justify-start font-normal aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarDays data-icon="inline-start" />
          {selected ? format(selected, 'd MMMM yyyy', { locale: localeId }) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={dayPickerId}
          captionLayout="dropdown"
          selected={selected}
          defaultMonth={selected ?? defaultMonth ?? (max < today ? max : today)}
          startMonth={new Date(fromYear, 0)}
          endMonth={max}
          disabled={[{ before: new Date(fromYear, 0, 1) }, { after: max }]}
          onSelect={(date) => {
            onChange(date ? toIsoDate(date) : '');
            setOpen(false);
            onBlur?.();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface DateRange {
  /** 'YYYY-MM-DD' or '' (open end). */
  from: string;
  to: string;
}

interface DateRangePickerProps {
  id?: string;
  value: DateRange;
  onChange: (value: DateRange) => void;
  invalid?: boolean;
  placeholder?: string;
  fromYear?: number;
  /** `sm` matches FilterBar chips. */
  size?: 'default' | 'sm';
  className?: string;
}

const SHORT = 'd MMM yyyy';

function rangeLabel(from: Date | undefined, to: Date | undefined, placeholder: string): string {
  const fmt = (d: Date) => format(d, SHORT, { locale: localeId });
  if (from && to) return from.getTime() === to.getTime() ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
  if (from) return `Sejak ${fmt(from)}`;
  if (to) return `Sampai ${fmt(to)}`;
  return placeholder;
}

/**
 * One date-range control (log filters): pick a start and end day, then "Terapkan". Presets apply at once.
 * Days are local calendar dates; the latest selectable day is today.
 */
export function DateRangePicker({
  id,
  value,
  onChange,
  invalid,
  placeholder = 'Rentang tanggal',
  fromYear = 2020,
  size = 'default',
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ from?: Date; to?: Date }>({});
  const from = fromIsoDate(value.from);
  const to = fromIsoDate(value.to);
  const today = new Date();
  const active = Boolean(from || to);

  const apply = (next: DateRange) => {
    onChange(next);
    setOpen(false);
  };
  const preset = (days: number) => apply({ from: toIsoDate(subDays(today, days - 1)), to: toIsoDate(today) });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft({ from, to });
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          aria-invalid={invalid || undefined}
          className={cn(
            'justify-start bg-card font-normal aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
            !active && 'border-dashed text-muted-foreground',
            active && size === 'sm' && 'border-primary/40 bg-accent-soft text-primary',
            className,
          )}
        >
          <CalendarDays data-icon="inline-start" />
          {rangeLabel(from, to, placeholder)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-wrap gap-1.5 border-b p-2">
          <Button type="button" size="xs" variant="outline" onClick={() => preset(1)}>
            Hari ini
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => preset(7)}>
            7 hari
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => preset(30)}>
            30 hari
          </Button>
        </div>
        <Calendar
          mode="range"
          locale={dayPickerId}
          captionLayout="dropdown"
          selected={draft.from ? { from: draft.from, to: draft.to } : undefined}
          onSelect={(range) => setDraft({ from: range?.from, to: range?.to })}
          defaultMonth={draft.from ?? today}
          startMonth={new Date(fromYear, 0)}
          endMonth={today}
          disabled={[{ before: new Date(fromYear, 0, 1) }, { after: today }]}
        />
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => apply({ from: '', to: '' })} disabled={!active && !draft.from}>
            Hapus
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => apply({ from: draft.from ? toIsoDate(draft.from) : '', to: draft.to ? toIsoDate(draft.to) : draft.from ? toIsoDate(draft.from) : '' })}
            disabled={!draft.from}
          >
            Terapkan
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

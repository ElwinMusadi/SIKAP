import { useState } from 'react';
import { format } from 'date-fns';
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

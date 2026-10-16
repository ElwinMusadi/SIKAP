import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface SelectOption {
  value: string;
  label: string;
}

export function enumOptions(values: readonly string[]): SelectOption[] {
  return values.map((value) => ({ value, label: value }));
}

interface SelectControlProps {
  id: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  onBlur?: () => void;
  options: readonly SelectOption[];
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

/** Full-width Select bound to a string value ('' = nothing selected, shows the placeholder). */
export function SelectControl({ id, value, onChange, onBlur, options, placeholder = 'Pilih', invalid, disabled }: SelectControlProps) {
  return (
    <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid || undefined} onBlur={onBlur}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

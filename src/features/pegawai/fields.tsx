import type { ReactNode } from 'react';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { DatePicker } from '@/components/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SelectControl, type SelectOption } from '@/features/profil/select-control';
import type { PegawaiFormField, PegawaiFormValues } from './pegawai-utils';

/**
 * Small field wrappers for the admin pegawai form. They mirror the profile page markup
 * (Field + FieldLabel + control + FieldError, data-invalid/aria-invalid) without coupling
 * to its private render helpers.
 */
interface BaseProps {
  name: PegawaiFormField;
  label: string;
  errors: FieldErrors<PegawaiFormValues>;
  required?: boolean;
  description?: ReactNode;
  className?: string;
}

const idFor = (name: string) => `pegawai-${name}`;

function Label({ name, label, required }: Pick<BaseProps, 'name' | 'label' | 'required'>) {
  return (
    <FieldLabel htmlFor={idFor(name)}>
      {label}
      {required ? (
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
      ) : null}
    </FieldLabel>
  );
}

export function TextField({
  name,
  label,
  errors,
  required,
  description,
  className,
  register,
  inputProps,
}: BaseProps & { register: UseFormRegister<PegawaiFormValues>; inputProps?: React.ComponentProps<typeof Input> }) {
  const invalid = errors[name] ? true : undefined;
  return (
    <Field data-invalid={invalid} className={className}>
      <Label name={name} label={label} required={required} />
      <Input id={idFor(name)} aria-invalid={invalid} aria-required={required || undefined} {...inputProps} {...register(name)} />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={[errors[name]]} />
    </Field>
  );
}

export function TextareaField({
  name,
  label,
  errors,
  required,
  className,
  register,
  maxLength,
}: BaseProps & { register: UseFormRegister<PegawaiFormValues>; maxLength?: number }) {
  const invalid = errors[name] ? true : undefined;
  return (
    <Field data-invalid={invalid} className={className}>
      <Label name={name} label={label} required={required} />
      <Textarea id={idFor(name)} rows={3} maxLength={maxLength} aria-invalid={invalid} {...register(name)} />
      <FieldError errors={[errors[name]]} />
    </Field>
  );
}

export function SelectField({
  name,
  label,
  errors,
  required,
  description,
  className,
  control,
  options,
  placeholder,
  disabled,
  onValueChange,
}: BaseProps & {
  control: Control<PegawaiFormValues>;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Replaces the default onChange (e.g. to reset a dependent field). */
  onValueChange?: (value: string, onChange: (value: string) => void) => void;
}) {
  const invalid = errors[name] ? true : undefined;
  return (
    <Field data-invalid={invalid} className={className}>
      <Label name={name} label={label} required={required} />
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <SelectControl
            id={idFor(name)}
            value={field.value}
            onChange={(value) => (onValueChange ? onValueChange(value, field.onChange) : field.onChange(value))}
            onBlur={field.onBlur}
            options={options}
            invalid={invalid}
            placeholder={placeholder ?? `Pilih ${label.toLowerCase()}`}
            disabled={disabled}
          />
        )}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={[errors[name]]} />
    </Field>
  );
}

export function DateField({
  name,
  label,
  errors,
  required,
  className,
  control,
  defaultMonth,
  fromYear,
  maxDate,
}: BaseProps & { control: Control<PegawaiFormValues>; defaultMonth?: Date; fromYear?: number; maxDate?: Date }) {
  const invalid = errors[name] ? true : undefined;
  return (
    <Field data-invalid={invalid} className={className}>
      <Label name={name} label={label} required={required} />
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <DatePicker
            id={idFor(name)}
            value={field.value}
            onChange={(value) => field.onChange(value)}
            onBlur={field.onBlur}
            invalid={!!invalid}
            defaultMonth={defaultMonth}
            fromYear={fromYear}
            maxDate={maxDate}
          />
        )}
      />
      <FieldError errors={[errors[name]]} />
    </Field>
  );
}

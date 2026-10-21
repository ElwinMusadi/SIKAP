import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ListFilter, PlusCircle, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

export interface FacetOption {
  value: string;
  label: string;
  /** Optional row count shown next to the option. */
  count?: number;
}

export interface Facet {
  id: string;
  label: string;
  options: FacetOption[];
  /** Selected value or null (single-select, matching the existing API filters). */
  value: string | null;
  onChange: (value: string | null) => void;
}

interface FilterBarProps {
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  facets?: Facet[];
  /** Extra controls after the facets (toggles, view switch). */
  extra?: ReactNode;
  /** Right-aligned actions (export, column options). */
  actions?: ReactNode;
  onReset?: () => void;
  className?: string;
}

function FacetPicker({ facet, onPicked }: { facet: Facet; onPicked?: () => void }) {
  return (
    <Command>
      {facet.options.length > 7 ? <CommandInput placeholder={`Cari ${facet.label.toLowerCase()}…`} /> : null}
      <CommandList>
        <CommandEmpty>Tidak ada pilihan.</CommandEmpty>
        <CommandGroup>
          {facet.options.map((option) => {
            const selected = facet.value === option.value;
            return (
              <CommandItem
                key={option.value}
                value={option.label}
                onSelect={() => {
                  facet.onChange(selected ? null : option.value);
                  onPicked?.();
                }}
              >
                <span
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full border border-input',
                    selected && 'border-primary bg-primary text-primary-foreground',
                  )}
                >
                  {selected ? <Check className="size-3" /> : null}
                </span>
                <span className="flex-1">{option.label}</span>
                {option.count !== undefined ? <span className="text-xs text-muted-foreground tabular-nums">{option.count}</span> : null}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function FacetChip({ facet }: { facet: Facet }) {
  const [open, setOpen] = useState(false);
  const selected = facet.options.find((o) => o.value === facet.value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('border-dashed bg-card font-normal', selected && 'border-solid border-primary/40 bg-accent-soft text-primary')}
        >
          {selected ? <ListFilter data-icon="inline-start" /> : <PlusCircle data-icon="inline-start" />}
          {facet.label}
          {selected ? (
            <>
              <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-4" />
              <span className="font-medium">{selected.label}</span>
            </>
          ) : null}
          <ChevronDown data-icon="inline-end" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <FacetPicker facet={facet} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** One filter bar: search, faceted chips (desktop) or a filter drawer (phones), reset, actions. */
export function FilterBar({ search, facets = [], extra, actions, onReset, className }: FilterBarProps) {
  const searchId = useId();
  const activeCount = facets.filter((f) => f.value !== null).length;
  const hasActive = activeCount > 0 || Boolean(search?.value);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {search ? (
        <InputGroup className="w-full sm:w-72">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <label htmlFor={searchId} className="sr-only">
            {search.placeholder}
          </label>
          <InputGroupInput
            id={searchId}
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
          />
          {search.value ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Kosongkan pencarian" onClick={() => search.onChange('')}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      ) : null}

      {facets.length > 0 ? (
        <>
          <div className="hidden flex-wrap items-center gap-2 md:flex">
            {facets.map((facet) => (
              <FacetChip key={facet.id} facet={facet} />
            ))}
          </div>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="outline" size="sm" className="bg-card md:hidden">
                <ListFilter data-icon="inline-start" />
                Filter
                {activeCount > 0 ? (
                  <span className="ml-0.5 rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{activeCount}</span>
                ) : null}
              </Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Filter</DrawerTitle>
                <DrawerDescription>Pilih satu nilai per kategori.</DrawerDescription>
              </DrawerHeader>
              <div className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto px-4">
                {facets.map((facet) => (
                  <section key={facet.id} className="flex flex-col gap-2">
                    <h3 className="text-eyebrow text-muted-foreground uppercase">{facet.label}</h3>
                    <div className="flex flex-wrap gap-2">
                      {facet.options.map((option) => {
                        const selected = facet.value === option.value;
                        return (
                          <Button
                            key={option.value}
                            variant="outline"
                            size="sm"
                            aria-pressed={selected}
                            className={cn('bg-card font-normal', selected && 'border-primary/40 bg-accent-soft font-medium text-primary')}
                            onClick={() => facet.onChange(selected ? null : option.value)}
                          >
                            {option.label}
                          </Button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
              <DrawerFooter>
                {onReset ? (
                  <Button variant="outline" onClick={onReset} disabled={!hasActive}>
                    Atur ulang
                  </Button>
                ) : null}
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </>
      ) : null}

      {extra}

      {onReset && hasActive ? (
        <Button variant="ghost" size="sm" onClick={onReset} className="hidden md:inline-flex">
          <X data-icon="inline-start" />
          Atur ulang
        </Button>
      ) : null}

      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

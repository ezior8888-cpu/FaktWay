'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { invoiceListHref, INVOICE_PAGE_SIZES, type InvoiceListParams } from '@/lib/invoices/list-query';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Filtr Finory (`data-table.tsx`, `Filter` z `filterVariant: 'select'`):
 * `w-full max-w-2xs`, etykieta tylko dla czytników, `SelectContent p-1`.
 * Odstępstwo: nazwa filtra stoi w polu przed wartością („Płatność:
 * Wszystkie”) — u nas są trzy takie pola i samo „Wszystkie” byłoby nieczytelne.
 *
 * W formularzu GET: Base UI renderuje ukryte `<input name>`, więc „Filtruj”
 * wysyła wartość także bez JS (po hydracji to ten sam wybór).
 */
export function FilterSelect({
  name,
  label,
  value,
  options,
  className,
  submitOnChange = false,
}: {
  name: string;
  label: string;
  value: string;
  options: FilterOption[];
  className?: string;
  /** Wybór od razu wysyła formularz (jak filtr statusu w Finorze); bez JS działa „Filtruj”. */
  submitOnChange?: boolean;
}) {
  const id = `filtr-${name}`;
  return (
    <div className={cn('w-full max-w-2xs', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Select
        name={name}
        defaultValue={value}
        items={options}
        onValueChange={
          submitOnChange
            ? () => {
                // Po zatwierdzeniu wyboru: ukryte pole Base UI ma już nową wartość.
                setTimeout(() => document.getElementById(id)?.closest('form')?.requestSubmit(), 0);
              }
            : undefined
        }
      >
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <span className="text-muted-foreground shrink-0">{label}:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="p-1">
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * „Pokaż 10/25/50” (Finora: „Show”, `SelectTrigger w-fit whitespace-nowrap`,
 * `SelectContent p-0.5`) — zmiana od razu przeładowuje listę (`na_stronie`,
 * strona 1); bez JS działa „Filtruj”. Wartość idzie za adresem (Wstecz,
 * „Wyczyść”), a wybór widać od razu, zanim serwer odda nową stronę. Pasek
 * nie remontuje się przy tej zmianie, więc fokus zostaje na wyborze.
 */
export function PerPageSelect({ params, id, className }: { params: InvoiceListParams; id?: string; className?: string }) {
  const router = useRouter();
  const options: FilterOption[] = INVOICE_PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }));
  const [value, setValue] = useState(String(params.perPage));
  const [seenPerPage, setSeenPerPage] = useState(params.perPage);
  if (seenPerPage !== params.perPage) {
    setSeenPerPage(params.perPage);
    setValue(String(params.perPage));
  }
  return (
    <Select
      name="na_stronie"
      value={value}
      items={options}
      onValueChange={(next) => {
        const perPage = INVOICE_PAGE_SIZES.find((n) => String(n) === next);
        if (perPage === undefined) return;
        setValue(String(perPage));
        if (perPage !== params.perPage) router.push(invoiceListHref(params, { perPage }));
      }}
    >
      <SelectTrigger id={id} aria-label="Liczba faktur na stronie" className={cn('w-fit whitespace-nowrap', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="p-0.5">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { suggestProductsAction } from '@/app/actions/produkty';
import { Input } from '@/components/ui/input';
import { formatPlMoney } from '@/lib/format/pl';
import {
  PRODUCT_SUGGESTIONS_MIN_QUERY,
  PRODUCT_VAT_RATE_LABELS,
  type ProductSuggestion,
} from '@/lib/produkty/model';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { cn } from '@/lib/utils';

/** Przerwa po ostatnim znaku, zanim pójdzie zapytanie do katalogu. */
const DEBOUNCE_MS = 250;

const UNAVAILABLE = 'Podpowiedzi z katalogu są chwilowo niedostępne, nazwę wpiszesz ręcznie.';

/** Druga linia podpowiedzi: jednostka, cena netto i stawka, jeśli produkt je ma. */
function details(p: ProductSuggestion): string {
  return [
    p.unit,
    p.priceNet !== null ? `${formatPlMoney(p.priceNet)} zł netto` : null,
    p.vatRate ? `VAT ${PRODUCT_VAT_RATE_LABELS[p.vatRate]}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function countText(n: number): string {
  return `${n} ${n === 1 ? 'podpowiedź' : 'podpowiedzi'} z katalogu. Strzałki wybierają, Enter wstawia.`;
}

/**
 * Pole nazwy pozycji z podpowiedzią produktów z katalogu (plan kompletnej
 * aplikacji, krok 2.6, część 2a). Po wpisaniu co najmniej dwóch znaków
 * pokazuje pod polem produkty firmy z tą frazą w nazwie; wybór strzałkami
 * i Enterem albo kliknięciem wstawia nazwę, jednostkę, cenę netto i stawkę
 * VAT (cenę i stawkę tylko wtedy, gdy produkt je ma). Ilości nie zmienia.
 * Nazwę dalej można wpisać ręcznie; bez wyboru nic się nie podmienia.
 *
 * Wzorzec combobox z listą (WAI-ARIA): `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`, liczba podpowiedzi w regionie `role="status"`.
 * Lista stoi w układzie pod polem, nie nad nim, bo wiersze siatki pozycji
 * leżą w kontenerze z przewijaniem w bok, który ucinałby warstwę nad treścią.
 * Starsza odpowiedź katalogu nie nadpisuje nowszej (licznik zapytań).
 */
export function ProductNameInput({
  form,
  index,
  id,
  ariaLabel,
  placeholder,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  index: number;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const listId = `${useId()}-podpowiedzi`;
  const [items, setItems] = useState<ProductSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [unavailable, setUnavailable] = useState(false);
  const [status, setStatus] = useState('');
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const field = form.register(`lines.${index}.name`);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  /** Unieważnia zaplanowane i trwające zapytanie: ich wynik już się nie pokaże. */
  function cancelPending() {
    request.current += 1;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function schedule(value: string) {
    cancelPending();
    const phrase = value.trim();
    if (phrase.length < PRODUCT_SUGGESTIONS_MIN_QUERY) {
      setItems([]);
      close();
      setUnavailable(false);
      setStatus('');
      return;
    }
    const mine = request.current;
    timer.current = setTimeout(() => {
      timer.current = null;
      void suggestProductsAction(phrase)
        .catch(() => ({ ok: false as const }))
        .then((res) => {
          if (mine !== request.current) return;
          if (!res.ok) {
            setItems([]);
            close();
            setUnavailable(true);
            setStatus('');
            return;
          }
          setUnavailable(false);
          setItems(res.items);
          setActive(-1);
          setOpen(res.items.length > 0);
          setStatus(res.items.length > 0 ? countText(res.items.length) : '');
        });
    }, DEBOUNCE_MS);
  }

  function choose(p: ProductSuggestion) {
    cancelPending();
    const opts = { shouldDirty: true, shouldTouch: true, shouldValidate: form.formState.isSubmitted };
    form.setValue(`lines.${index}.name`, p.name, opts);
    form.setValue(`lines.${index}.unit`, p.unit, opts);
    if (p.priceNet !== null) form.setValue(`lines.${index}.unitPriceNet`, p.priceNet, opts);
    if (p.vatRate) form.setValue(`lines.${index}.vatRate`, p.vatRate, opts);
    setItems([]);
    close();
    setStatus(`Wstawiono z katalogu: ${p.name}.`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      if (items.length === 0) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      if (!open || items.length === 0) return;
      e.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      const picked = open && active >= 0 ? items[active] : undefined;
      if (picked) {
        e.preventDefault();
        choose(picked);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      }
    }
  }

  return (
    <div className="min-w-0">
      <Input
        id={id}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        {...field}
        onChange={(e) => {
          void field.onChange(e);
          schedule(e.target.value);
        }}
        onBlur={(e) => {
          void field.onBlur(e);
          close();
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Produkty z katalogu"
          className="border-border bg-background mt-1 max-h-60 overflow-y-auto border text-sm shadow-sm"
        >
          {items.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn('cursor-pointer px-2 py-1.5', i === active ? 'bg-muted' : 'hover:bg-muted/60')}
              // Fokus zostaje w polu: kliknięcie nie zamyka listy przez `blur`.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(p)}
            >
              <span className="block truncate">{p.name}</span>
              <span className="text-muted-foreground block truncate text-xs">{details(p)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {unavailable ? <p className="text-muted-foreground mt-1 text-xs">{UNAVAILABLE}</p> : null}
      <span role="status" className="sr-only">
        {status}
      </span>
    </div>
  );
}

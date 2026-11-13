'use client';

import { useEffect, useRef, useState } from 'react';

import { invoiceNumberPreviewAction } from '@/app/actions/numeracja';
import { DocumentHeaderRow } from '@/components/invoices/finora/invoice-document';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectedNumberingOption, type InvoiceNumbering } from '@/lib/numeracja/model';

/**
 * Seria numeracji w formularzu faktury (krok 2.5). Wiersz pojawia się tylko,
 * gdy firma ma więcej niż jedną serię (D1: firma z jedną serią widzi formularz
 * bez zmian). Po zmianie serii albo daty wystawienia pole numeru dostaje
 * podpowiedź nowej serii, ale tylko gdy klient nie wpisał w nie własnego
 * numeru: numer wpisany ręcznie zostaje.
 */

export interface NumberFieldState {
  number: string;
  preview: string | undefined;
}

export interface NumberFieldWrite {
  seriesId: string | undefined;
  preview: string | undefined;
  /** `undefined`: pole numeru bez zmian (klient wpisał własny numer). */
  number: string | undefined;
}

/** Nowe wartości pól po podpowiedzi `preview` serii `seriesId`. */
export function nextNumberFields(current: NumberFieldState, seriesId: string | null, preview: string | null): NumberFieldWrite {
  const typed = current.number.trim();
  const untouched = typed === '' || (current.preview !== undefined && typed === current.preview.trim());
  return {
    seriesId: seriesId ?? undefined,
    preview: preview ?? undefined,
    number: untouched ? preview ?? '' : undefined,
  };
}

/** Domyślne pola numeracji formularza (seria domyślna rodzaju i jej podpowiedź). */
export function numberingDefaults(numbering: InvoiceNumbering | null | undefined): {
  numberSeriesId: string | undefined;
  numberPreview: string | undefined;
  preview: string | null;
} {
  const option = selectedNumberingOption(numbering);
  return {
    numberSeriesId: option?.id ?? undefined,
    numberPreview: option?.id && option.preview ? option.preview : undefined,
    preview: option?.preview ?? null,
  };
}

/**
 * Stan serii i odświeżenie podpowiedzi po zmianie serii albo daty. `read`
 * i `write` czytają i ustawiają pola formularza (każdy formularz ma swój typ).
 */
export function useSeriesNumber({
  numbering,
  issueDate,
  read,
  write,
}: {
  numbering: InvoiceNumbering | null | undefined;
  issueDate: string;
  read: () => NumberFieldState;
  write: (next: NumberFieldWrite) => void;
}): { seriesId: string | null; selectSeries: (id: string) => void } {
  const [seriesId, setSeriesId] = useState<string | null>(() => selectedNumberingOption(numbering)?.id ?? null);
  const io = useRef({ read, write });
  useEffect(() => {
    io.current = { read, write };
  });
  const firstRun = useRef(true);
  const kind = numbering?.kind ?? null;

  useEffect(() => {
    // Przy otwarciu formularza podpowiedź przyszła z serwera.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!kind || !seriesId || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoiceNumberPreviewAction(kind, seriesId, issueDate)
        .catch(() => null)
        .then((result) => {
          if (cancelled || !result) return;
          io.current.write(nextNumberFields(io.current.read(), seriesId, result.preview));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kind, seriesId, issueDate]);

  const selectSeries = (id: string) => {
    const option = numbering?.options.find((o) => o.id === id);
    if (!option?.id) return;
    setSeriesId(option.id);
    // Od razu podpowiedź na dziś; odświeżenie wyżej poprawi ją dla daty wystawienia.
    io.current.write(nextNumberFields(io.current.read(), option.id, option.preview));
  };

  return { seriesId, selectSeries };
}

interface SeriesSelectProps {
  numbering: InvoiceNumbering | null | undefined;
  seriesId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** Id pola (etykieta wskazuje je przez htmlFor); domyślnie `number-series`. */
  id?: string;
}

/** Serie do wyboru; mniej niż dwie zapisane serie: bez wyboru (formularz jak dotąd). */
export function hasSeriesChoice(numbering: InvoiceNumbering | null | undefined): boolean {
  return (numbering?.options.filter((o) => o.id !== null).length ?? 0) >= 2;
}

/** Samo pole wyboru serii (formularz korekty ma własny układ etykiet). */
export function SeriesSelect({ numbering, seriesId, onSelect, disabled = false, id = 'number-series' }: SeriesSelectProps) {
  const options = numbering?.options.filter((o): o is typeof o & { id: string } => o.id !== null) ?? [];
  if (options.length < 2) return null;
  const items = options.map((o) => ({ value: o.id, label: o.name }));
  return (
    <Select
      value={seriesId ?? options[0]!.id}
      items={items}
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value === 'string') onSelect(value);
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Wiersz nagłówka dokumentu z wyborem serii (zwykła, zaliczkowa, końcowa). */
export function SeriesSelectRow(props: SeriesSelectProps) {
  if (!hasSeriesChoice(props.numbering)) return null;
  return (
    <DocumentHeaderRow label="Seria numeracji" htmlFor="number-series">
      <SeriesSelect {...props} />
    </DocumentHeaderRow>
  );
}

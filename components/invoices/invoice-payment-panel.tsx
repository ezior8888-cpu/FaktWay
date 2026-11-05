'use client';

import { useId, useOptimistic, useState } from 'react';
import { RiCheckboxCircleLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { cn } from '@/lib/utils';

import { MarkPaidButton, TOUCH_TARGET, useInvoicePayment, type PayableInvoice } from './use-invoice-payment';

/** Stan płatności faktury na szczegółach: liczy serwer (`loadPaymentPanel` strony faktury). */
export interface InvoicePaymentPanelData {
  /** Pokazać „Zapłacone”: faktura sprzedaży przyjęta w KSeF z resztą do zapłaty, rola z prawem oznaczania. */
  canMark: boolean;
  /** Pokazać „Cofnij zapłatę”: jest wpłata ręczna z `mark_invoice_paid`, rola z prawem oznaczania. */
  canUndo: boolean;
  /** Dzień zapłaty RRRR-MM-DD; `null` — faktura nie jest zapłacona. */
  paidOn: string | null;
  /** Data zapłaty pochodzi z FA(3) (`Zaplacono` + `DataZaplaty`), nie z oznaczenia. */
  paidOnFromDocument: boolean;
  /** Dziś w Europe/Warsaw: górna granica wyboru daty. */
  today: string;
}

type View = Pick<InvoicePaymentPanelData, 'canMark' | 'canUndo' | 'paidOn' | 'paidOnFromDocument'>;

/**
 * Szczegóły faktury: to jedyne miejsce z wyborem innej daty i z „Cofnij zapłatę”
 * także po czasie (na listach cofnięcie żyje tylko w toaście). Pole daty jest
 * natywne, bo na telefonie otwiera systemowy kalendarz.
 */
export function InvoicePaymentPanel({
  invoice,
  data,
}: {
  invoice: PayableInvoice;
  data: InvoicePaymentPanelData;
}) {
  const [view, setView] = useOptimistic<View, View>(data, (_current, next) => next);
  const [dateOpen, setDateOpen] = useState(false);
  const [date, setDate] = useState(data.today);
  const dateId = useId();

  const { mark, undo } = useInvoicePayment<PayableInvoice>({
    onPaid: (_invoice, paidOn) =>
      setView({ canMark: false, canUndo: true, paidOn: paidOn ?? data.today, paidOnFromDocument: false }),
    onRestored: () => setView({ canMark: true, canUndo: false, paidOn: null, paidOnFromDocument: false }),
  });

  if (view.paidOn === null && !view.canMark) return null;

  if (view.paidOn !== null) {
    return (
      <div data-testid="platnosc-faktury" className="space-y-3 border-t pt-4">
        <p className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
          <RiCheckboxCircleLine className="size-4 shrink-0" aria-hidden />
          Zapłacona {formatIsoDatePl(view.paidOn)}
          {view.paidOnFromDocument ? ' (data z faktury)' : ''}
        </p>
        {view.canUndo ? (
          <Button
            type="button"
            variant="outline"
            className={cn(TOUCH_TARGET, 'w-full')}
            onClick={() => undo(invoice)}
          >
            Cofnij zapłatę
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="platnosc-faktury" className="space-y-3 border-t pt-4">
      <MarkPaidButton number={invoice.number} className="w-full" onClick={() => mark(invoice)} />
      {dateOpen ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (date) mark(invoice, date);
          }}
        >
          <Label htmlFor={dateId}>Data zapłaty</Label>
          <Input
            id={dateId}
            type="date"
            required
            max={data.today}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={TOUCH_TARGET}
          />
          <Button type="submit" variant="secondary" className={cn(TOUCH_TARGET, 'w-full')}>
            Zapisz zapłatę
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className={cn(TOUCH_TARGET, 'w-full')}
          onClick={() => setDateOpen(true)}
        >
          Zapłacono innego dnia
        </Button>
      )}
    </div>
  );
}

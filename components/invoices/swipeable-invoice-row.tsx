'use client';

import { useState, useTransition } from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from 'framer-motion';
import { RiDownloadLine, RiLoader4Line } from '@remixicon/react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PaymentIndicator } from '@/app/(dashboard)/invoices/_components/payment-indicator';
import { downloadInvoiceXmlAction } from '@/components/invoices/actions-detail';

import { StatusBadge } from './status-badge';

import {
  currencySymbol,
  resolveOutstanding,
  resolvePaymentState,
  type InvoiceRow,
} from './invoice-row-types';
import { MarkPaidButton } from './use-invoice-payment';
import { saveBlob } from '@/lib/download';
import { shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import { formatInvoiceDate } from '@/lib/invoices/display-date';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';

export type SwipeableInvoiceRowInvoice = InvoiceRow;

const SPRING = { type: 'spring' as const, stiffness: 300, damping: 30 };

interface Props {
  invoice: SwipeableInvoiceRowInvoice;
  /** Fakty płatności z serwera (`loadInvoiceListRowFacts`); bez nich karta nie pokazuje płatności. */
  facts?: InvoiceListRowFacts;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) — „po terminie” liczone przy renderze. */
  today?: string;
  /** „Zapłacone”: tylko gdy rola pozwala; bez tego karta nie pokazuje przycisku. */
  onMarkPaid?: (invoice: SwipeableInvoiceRowInvoice, facts: InvoiceListRowFacts | undefined) => void;
}

/**
 * Wiersz faktury z gestem poziomym (framer-motion `drag="x"` + `animate` ze
 * springiem), karta w stylu Finory. Na touch: swipe w lewo → pobierz XML.
 */
export function SwipeableInvoiceRow({ invoice, facts, today, onMarkPaid }: Props) {
  const x = useMotionValue(0);
  const [isResetting, setIsResetting] = useState(false);
  const [isDownloading, startDownload] = useTransition();

  const canDownload = Boolean(invoice.xml_storage_path);

  const leftActionOpacity = useTransform(x, [-120, -40, 0], [1, 0.5, 0]);

  const handleDragEnd = (_event: PointerEvent, info: PanInfo) => {
    const offset = info.offset.x;
    setIsResetting(true);

    if (offset < -100 && canDownload) {
      void animate(x, 0, SPRING);
      handleDownload();
    } else {
      void animate(x, 0, SPRING);
    }

    setTimeout(() => setIsResetting(false), 300);
  };

  const handleDownload = () => {
    startDownload(async () => {
      const result = await downloadInvoiceXmlAction(invoice.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const blob = new Blob([result.xml], { type: 'application/xml' });
      saveBlob(blob, result.filename);
      toast.success('Pobrano XML');
    });
  };

  const dragEnabled = canDownload;
  const state = today ? resolvePaymentState(invoice, facts, today) : null;
  const outstanding = resolveOutstanding(invoice, facts);
  const buyerName = invoice.buyer_data?.name ?? null;
  const symbol = currencySymbol(invoice.currency);

  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-6">
        <motion.div
          style={{ opacity: leftActionOpacity }}
          className="text-primary flex items-center gap-2"
        >
          <span className="text-sm font-medium">Pobierz XML</span>
          {isDownloading ? (
            <RiLoader4Line className="h-5 w-5 animate-spin" />
          ) : (
            <RiDownloadLine className="h-5 w-5" />
          )}
        </motion.div>
      </div>

      <motion.div
        drag={dragEnabled ? 'x' : false}
        dragConstraints={{
          left: canDownload ? -120 : 0,
          right: 0,
        }}
        dragElastic={0.2}
        style={{ x }}
        onDragEnd={handleDragEnd}
        className="bg-card text-card-foreground relative touch-pan-y"
      >
        <Link
          href={`/invoices/${invoice.id}`}
          className={`block p-4 ${isResetting ? 'pointer-events-none' : ''}`}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {invoice.internal_number ?? '(bez numeru)'}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {formatInvoiceDate(invoice.issue_date)}
              </p>
            </div>
            <StatusBadge status={invoice.ksef_status} errorCode={invoice.last_error_code} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={buyerName ?? undefined}>
                {buyerName ? shortenLegalForm(buyerName) : '—'}
              </p>
              {invoice.buyer_data?.nip ? (
                <p className="text-muted-foreground truncate text-xs">
                  NIP {invoice.buyer_data.nip}
                </p>
              ) : null}
            </div>
            <p className="shrink-0 text-sm font-medium tabular-nums">
              {invoice.gross_total != null
                ? `${formatPlMoney(Number(invoice.gross_total))} ${symbol}`
                : '—'}
            </p>
          </div>
          {state !== null ? (
            <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-xs">
              <PaymentIndicator state={state} showLabel />
              {/* Opłacona: wskaźnik po lewej już to mówi (ikona + etykieta) — bez drugiej plakietki. */}
              {state !== 'paid' && outstanding !== null && outstanding !== 0 ? (
                <span className="text-muted-foreground tabular-nums">
                  {`Do zapłaty: ${formatPlMoney(outstanding)} ${symbol}`}
                </span>
              ) : null}
            </div>
          ) : null}
        </Link>
      </motion.div>
      {/*
        Poza kartą z gestem i poza linkiem: dotknięcie nie otwiera faktury, a przesunięcie
        rozpoczęte na przycisku nie ciągnie karty. `bg-card` przykrywa warstwę „Pobierz XML”.
      */}
      {onMarkPaid && facts?.canMarkPaid ? (
        <div className="bg-card relative flex justify-end px-4 pb-3">
          <MarkPaidButton number={invoice.internal_number} onClick={() => onMarkPaid(invoice, facts)} />
        </div>
      ) : null}
    </div>
  );
}

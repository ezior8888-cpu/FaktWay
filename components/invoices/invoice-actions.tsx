'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { RiDownloadLine, RiEditLine, RiFileCodeLine, RiLoader4Line, RiPrinterLine, RiRepeatLine } from '@remixicon/react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmailInvoiceButton } from './email-invoice-button';
import { DraftInvoiceActions } from './draft-invoice-actions';
import { FailedInvoiceActions } from './failed-invoice-actions';
import { downloadInvoiceXmlAction } from './actions-detail';
import { saveBlob } from '@/lib/download';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { setAsRecurringHref } from '@/lib/invoices/recurring/visibility';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';

interface Props {
  invoice: {
    id: string;
    ksef_status: string;
    xml_storage_path: string | null;
    /** VAT / KOR / ZAL / ROZ — do przycisków szkicu. */
    invoice_type?: string | null;
    /** regular / correction / advance / final — dokument specjalny: przyciski wg faktów ponowienia z kopii. */
    invoice_kind?: string | null;
    /** Kod z katalogu `ksef_error_codes` — decyduje o przyciskach po błędzie. */
    last_error_code?: string | null;
    /** A4b PR2b: dane zapisane, rodzaj wstrzymany, data wystawienia minęła. */
    ksef_resend_facts: KsefResendFacts;
    /** `KSEF_ENV` aplikacji poprawny. */
    ksef_environment_known: boolean;
    /**
     * D-A4-1b-3 PR B: nad paskiem stoi panel duplikatu 440 (decyzja albo nota
     * z danymi oryginału) — pasek po błędzie odsyła do ramki wyżej.
     */
    ksef_duplicate_panel?: boolean;
    /**
     * D-A4-1b-3 PR B: szkic wycofany (wpis `number_taken`) — bez wysyłki do KSeF
     * i bez e-maila do nabywcy (decyzja 10); usunąć można tylko korektę i fakturę
     * rozliczeniową (`deletable`, decyzja 9). `null` — zwykły szkic albo inny stan.
     * PR C (5.12): `imported` — numer dokumentu przeszedł na fakturę K zapisaną z KSeF; zamiast
     * „Pobierz PDF” jest odnośnik do PDF faktury K (`internalNumber` = dawny numer dokumentu).
     */
    ksef_retired?: { deletable: boolean; imported?: { id: string; internalNumber: string } | null } | null;
    /**
     * E3 / P4: faktura może mieć korektę (liczy strona tym samym predykatem
     * co lista faktur) — w karcie „Dokument” pojawia się link „Korekta”.
     */
    can_correct?: boolean;
    /**
     * N1: faktura może być wzorem faktury cyklicznej — w karcie „Dokument”
     * pojawia się „Ustaw jako cykliczną” (arkusz na `/invoices/recurring?wzor=`).
     */
    can_set_recurring?: boolean;
  };
  /** Rola w firmie dopuszcza ponowną wysyłkę i powrót do szkicu (owner/admin). */
  canManageSend?: boolean;
  /**
   * E3 / P4: podgląd faktury stawia akcje w dwóch kartach, z TYMI SAMYMI
   * props — `primary` (karta „Status”: wysyłka szkicu, ponowienie po błędzie)
   * i `secondary` (karta „Dokument”: e-mail, PDF, Drukuj, XML, Korekta).
   * Każdy przycisk jest w DOM raz. `all` (domyślnie) to dotychczasowy pasek.
   */
  section?: 'primary' | 'secondary' | 'all';
  /** Adres nabywcy z dokumentu — podpowiedź pola „Do” w oknie „Wyślij e-mailem” (Finora: `invoice.email`). */
  buyerEmail?: string | null;
}

/** Odnośnik z odmowy 409 (PR C, 5.12): PDF faktury K z KSeF — tylko ścieżka względna tej aplikacji. */
interface PdfRefusalLink {
  href: string;
  label: string;
}

/** Komunikat (i ewentualny odnośnik) dla klienta po nieudanym pobraniu PDF — wspólny dla „Pobierz PDF” i „Drukuj”. */
async function pdfFailure(res: Response): Promise<{ message: string; link: PdfRefusalLink | null }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; link?: { href?: unknown; label?: unknown } };
  if (body.error === 'pdf_generation_failed') return { message: 'Nie udało się wygenerować PDF. Spróbuj ponownie.', link: null };
  if (res.status !== 409) return { message: 'Nie udało się pobrać PDF faktury.', link: null };
  const { href, label } = body.link ?? {};
  const link = typeof href === 'string' && typeof label === 'string' && /^\/(?!\/)/.test(href) ? { href, label } : null;
  return { message: body.error ?? 'PDF faktury offline jest obecnie niedostępny.', link };
}

/** Toast po nieudanym pobraniu PDF; odmowa z odnośnikiem (szkic wycofany) dostaje przycisk prowadzący do PDF faktury K. */
function toastPdfFailure({ message, link }: { message: string; link: PdfRefusalLink | null }): void {
  if (!link) {
    toast.error(message);
    return;
  }
  toast.error(message, { action: { label: link.label, onClick: () => window.location.assign(link.href) } });
}

/** Blob URL zostaje na czas oglądania PDF w nowej karcie (przeładowanie karty go potrzebuje). */
const PRINT_BLOB_URL_TTL_MS = 10 * 60_000;

export function InvoiceActions({ invoice, canManageSend = false, section = 'all', buyerEmail = null }: Props) {
  const [isDownloading, startDownloading] = useTransition();
  const [isDownloadingPdf, startDownloadingPdf] = useTransition();
  const [isOpeningPdf, startOpeningPdf] = useTransition();

  const canDownload = !!invoice.xml_storage_path;

  const handleDownload = () => {
    startDownloading(async () => {
      const result = await downloadInvoiceXmlAction(invoice.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      saveBlob(
        new Blob([result.xml], { type: 'application/xml' }),
        result.filename,
      );
    });
  };

  const handleDownloadPdf = () => {
    startDownloadingPdf(async () => {
      try {
        const res = await fetch(`/api/invoices/${invoice.id}/pdf`);
        if (!res.ok) {
          toastPdfFailure(await pdfFailure(res));
          return;
        }
        const cd = res.headers.get('Content-Disposition') ?? '';
        const filename =
          cd.match(/filename="(.+?)"/)?.[1] ?? `Faktura_${invoice.id}.pdf`;
        saveBlob(await res.blob(), filename);
      } catch {
        toast.error('Błąd połączenia przy pobieraniu PDF.');
      }
    });
  };

  /**
   * „Drukuj” (P4): dokumentem jest PDF z `/api/invoices/[id]/pdf`, a
   * `window.print()` wydrukowałby szkielet panelu. Kartę otwieramy od razu
   * w obsłudze kliknięcia (po `await` przeglądarki blokują okna), a PDF
   * wczytujemy do niej przez blob URL — te same trasa, zgody i komunikaty
   * błędów co przy „Pobierz PDF”.
   */
  const handlePrintPdf = () => {
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      toast.error('Przeglądarka zablokowała nową kartę. Zezwól na okna z tej strony i spróbuj ponownie.');
      return;
    }
    tab.opener = null;
    startOpeningPdf(async () => {
      try {
        const res = await fetch(`/api/invoices/${invoice.id}/pdf`);
        if (!res.ok) {
          tab.close();
          toastPdfFailure(await pdfFailure(res));
          return;
        }
        const url = URL.createObjectURL(await res.blob());
        tab.location.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), PRINT_BLOB_URL_TTL_MS);
      } catch {
        tab.close();
        toast.error('Błąd połączenia przy pobieraniu PDF.');
      }
    });
  };

  const hasPrimary =
    invoice.ksef_status === 'draft' ||
    invoice.ksef_status === 'rejected' ||
    invoice.ksef_status === 'failed';

  const primary = (
    <>
      {invoice.ksef_status === 'draft' && (
        <DraftInvoiceActions
          invoiceId={invoice.id}
          invoiceType={invoice.invoice_type ?? null}
          retired={invoice.ksef_retired ?? null}
        />
      )}
      {(invoice.ksef_status === 'rejected' || invoice.ksef_status === 'failed') && (
        <FailedInvoiceActions
          invoiceId={invoice.id}
          status={invoice.ksef_status}
          errorCode={invoice.last_error_code ?? null}
          invoiceKind={invoice.invoice_kind ?? null}
          canManage={canManageSend}
          facts={invoice.ksef_resend_facts}
          environmentKnown={invoice.ksef_environment_known}
          duplicatePanel={invoice.ksef_duplicate_panel ?? false}
        />
      )}
    </>
  );

  // Podział na karty: główna akcja (wysyłka, ponowienie) obok statusu, reszta w karcie „Dokument”.
  if (section === 'primary') {
    // Kolumna 18rem jak karta akcji Finory: przyciski jeden pod drugim, na całą szerokość.
    return hasPrimary ? <div className="space-y-4 [&>button]:w-full">{primary}</div> : null;
  }

  // Karta akcji Finory (`invoices-view/invoice-actions.tsx`): Send Invoice (główny) /
  // Download / Print → Wyślij e-mailem / Pobierz PDF / Drukuj, `w-full`, ikony Remix;
  // pod nimi nasze akcje dokumentu (XML, Korekta) w tym samym wariancie `outline`.
  const full = section === 'secondary' ? 'w-full' : undefined;
  // PR C (5.12): numer wycofanego dokumentu ma teraz faktura K — jej PDF zamiast PDF dokumentu (odmowa serwera zostaje jako obrona).
  const importedK = invoice.ksef_retired?.imported ?? null;
  const secondary = (
    <>
      {/* Decyzja 10: dokument wycofany nie jest fakturą dla nabywcy (odmawia też serwer). */}
      {!invoice.ksef_retired && (
        <EmailInvoiceButton invoiceId={invoice.id} defaultEmail={buyerEmail} className={full} />
      )}
      {importedK ? (
        <a
          href={`/api/invoices/${encodeURIComponent(importedK.id)}/pdf`}
          className={cn(buttonVariants({ variant: 'outline' }), full)}
        >
          <RiDownloadLine />
          {DUPLICATE_DECISION_TEXTS.FAKTFLOW.RETIRED_PDF_LINK(importedK.internalNumber)}
        </a>
      ) : (
        <Button
          variant="outline"
          className={full}
          onClick={handleDownloadPdf}
          disabled={isDownloadingPdf}
        >
          {isDownloadingPdf ? <RiLoader4Line className="animate-spin" /> : <RiDownloadLine />}
          Pobierz PDF
        </Button>
      )}
      <Button
        variant="outline"
        className={full}
        onClick={handlePrintPdf}
        disabled={isOpeningPdf}
      >
        {isOpeningPdf ? <RiLoader4Line className="animate-spin" /> : <RiPrinterLine />}
        Drukuj
      </Button>
      {canDownload && (
        <Button
          variant="outline"
          className={full}
          onClick={handleDownload}
          disabled={isDownloading}
        >
          {isDownloading ? <RiLoader4Line className="animate-spin" /> : <RiFileCodeLine />}
          Pobierz XML
        </Button>
      )}
      {invoice.can_correct && (
        <Link
          href={`/invoices/new/correction?parentId=${encodeURIComponent(invoice.id)}`}
          className={cn(buttonVariants({ variant: 'outline' }), full)}
        >
          <RiEditLine />
          Korekta
        </Link>
      )}
      {invoice.can_set_recurring && (
        <Link
          href={setAsRecurringHref(invoice.id)}
          className={cn(buttonVariants({ variant: 'outline' }), full)}
        >
          <RiRepeatLine />
          Ustaw jako cykliczną
        </Link>
      )}
    </>
  );

  if (section === 'secondary') {
    return <div className="space-y-4">{secondary}</div>;
  }

  return (
    <div className="flex flex-wrap gap-2 justify-end pt-2">
      {secondary}
      {primary}
    </div>
  );
}

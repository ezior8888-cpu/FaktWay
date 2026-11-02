'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/invoices/status-badge';
import { InvoiceActions } from '@/components/invoices/invoice-actions';
import { InvoiceErrorDisplay } from '@/components/invoices/error-display';
import { InvoiceQr, type InvoiceQrData } from '@/components/invoices/invoice-qr';
import { ImportedOriginalNote } from '@/components/invoices/imported-original-note';
import { KsefDuplicateDecision } from '@/components/invoices/ksef-duplicate-decision';
import { RetiredDraftBanner } from '@/components/invoices/retired-draft-banner';
import { UpoDownload } from '@/components/invoices/upo-download';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { formatInvoiceDate } from '@/lib/invoices/display-date';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { automaticResendExpected } from '@/lib/invoices/ksef-send-policy';
import { vatSummaryAgreesWithGross, vatSummaryByRate } from '@/lib/invoices/vat-summary';
import type { DuplicateOriginalView } from '@/lib/ksef/duplicate-check';
import type { DuplicateDecisionView, ImportedOriginalProvenance, RetiredDraftView } from '@/lib/ksef/duplicate-decision';
import { importedVatRateLabel } from '@/lib/xml/fa3-p12';
import type { Database } from '@/types/database';
import type { KsefEnvironment } from '@/types/ksef';

export interface InvoiceDetailLine {
  ordinal: number;
  name: string | null;
  unit: string | null;
  quantity: string | number | null;
  unit_price_net: string | number | null;
  vat_rate: string | null;
  /** E3 / P4: kwoty netto i VAT pozycji — podsumowanie VAT per stawka (`lib/invoices/vat-summary.ts`). */
  net_amount: string | number | null;
  vat_amount: string | number | null;
  gross_amount: string | number | null;
}

interface AddressSnapshot {
  countryCode?: string;
  addressLine1?: string;
  addressLine2?: string;
}

interface PartySnapshot {
  nip?: string | null;
  vatUeNumber?: string | null;
  name?: string | null;
  address?: AddressSnapshot | null;
  email?: string | null;
}

export interface InvoiceDetailInitial {
  id: string;
  internal_number: string | null;
  invoice_type: string | null;
  /** regular / correction / advance / final (`invoices.invoice_kind`). */
  invoice_kind: string | null;
  issue_date: string | null;
  sale_date: string | null;
  ksef_status: string;
  ksef_number: string | null;
  ksef_accepted_at: string | null;
  xml_storage_path: string | null;
  net_total: string | number | null;
  vat_total: string | number | null;
  gross_total: string | number | null;
  notes: string | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_field: string | null;
  last_error_suggestion: string | null;
  seller_data: unknown;
  buyer_data: unknown;
  /** `invoices.payment_data` — `PaymentInfo` z faktury; `null` w starych rekordach. */
  payment_data: unknown;
  lines: InvoiceDetailLine[];
  /** E3 / P4: waluta faktury (kod ISO; brak w wierszu = PLN) — podpis kwot zamiast „PLN” na sztywno. */
  currency: string;
  /** E3 / P4: MPP (P_18A) — flaga wyliczona na serwerze z adnotacji dokumentu; `fa3_data` nie trafia do klienta. */
  split_payment: boolean;
  /** E3 / P4: „Do zapłaty” (`amountDueOf`): dla ROZ reszta po zaliczkach, nie brutto zamówienia. */
  amount_due: number;
  /** E3 / P4: pokazać link „Korekta” (ten sam predykat co lista faktur + brak korekty w toku). */
  can_correct: boolean;
  /**
   * N1: pokazać „Ustaw jako cykliczną” (faktura spełnia warunki wzoru faktury
   * cyklicznej — liczy serwer tym samym predykatem co akcja tworzenia).
   * Brak pola = przycisk ukryty.
   */
  can_set_recurring?: boolean;
  /** E3 / P4: kod QR weryfikacji w KSeF (KOD I); `null` — faktura nie ma pliku XML ani numeru KSeF. */
  qr: InvoiceQrData | null;
  upo_status: Database['public']['Enums']['upo_status_enum'] | null;
  /** Rola zalogowanej osoby w firmie faktury dopuszcza „Wyślij ponownie” / „Wróć do szkicu”. */
  can_manage_send: boolean;
  /** D-A4-1b-3: dane faktury, którą KSeF ma już pod tym numerem (nierozstrzygnięty 440). */
  ksef_duplicate_original: DuplicateOriginalView | null;
  /** A4b PR2b: ponowienie z kopii (dane zapisane, rodzaj wstrzymany, data minęła) — bez treści dokumentu. */
  ksef_resend_facts: KsefResendFacts;
  /** `KSEF_ENV` aplikacji poprawny. */
  ksef_environment_known: boolean;
  /**
   * D-A4-1b-3 PR B: decyzja klienta przy nierozstrzygniętym 440 (`decidable` —
   * panel decyzji; `refused` — tekst odmowy jest już notą `ksef_duplicate_original`).
   */
  ksef_duplicate_decision: DuplicateDecisionView | null;
  /** D-A4-1b-3 PR B: szkic wycofany (wpis `number_taken`) — baner każdego rodzaju (decyzja 9). */
  ksef_retired_draft: RetiredDraftView | null;
  /**
   * D-A4-1b-3 PR C (INV-8): środowisko KSeF serwera pokazane klientowi — panel odsyła je do akcji
   * razem z trybem i ofertą, a serwer odmawia `STALE`, gdy się zmieniło. Brak pola = `null`.
   */
  ksef_server_environment?: KsefEnvironment | null;
  /**
   * D-A4-1b-3 PR C (6.5): faktura zapisana z KSeF decyzją klienta albo operatora — skąd się wzięła
   * (`importedOriginalProvenance(fa3_data)` liczy serwer; sama treść dokumentu nie trafia do klienta).
   * Brak pola = `null`.
   */
  ksef_imported_original?: ImportedOriginalProvenance | null;
}

interface PaymentSnapshot {
  method?: string | null;
  dueDate?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  /** Tylko faktury w walucie obcej, o ile dane go mają. */
  swift?: string | null;
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  transfer: 'Przelew',
  cash: 'Gotówka',
  card: 'Karta',
  other: 'Inna',
};

/**
 * Liczba po polsku („18 000,19”): co najmniej 2 miejsca, najwyżej
 * `maxDigits`. Ilość i cena jednostkowa mają w bazie i w XML 4 miejsca —
 * ekran pokazuje je w całości, jak PDF (F-094).
 */
function formatNumber(value: string | number | null, maxDigits = 2): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  });
}

/** Tytuł dokumentu wg rodzaju — te same nazwy co na PDF (`INVOICE_TYPE_LABEL` w rendererze). */
const DOCUMENT_TITLE: Record<string, string> = {
  VAT: 'Faktura VAT',
  KOR: 'Faktura korygująca',
  ZAL: 'Faktura zaliczkowa',
  ROZ: 'Faktura rozliczeniowa',
  UPR: 'Faktura uproszczona',
  KOR_ZAL: 'Korekta faktury zaliczkowej',
  KOR_ROZ: 'Korekta faktury rozliczeniowej',
};

function documentTitle(invoiceType: string | null, invoiceKind: string | null): string {
  const byType = DOCUMENT_TITLE[invoiceType ?? ''];
  if (byType) return byType;
  if (invoiceKind === 'correction') return DOCUMENT_TITLE.KOR!;
  if (invoiceKind === 'advance') return DOCUMENT_TITLE.ZAL!;
  if (invoiceKind === 'final') return DOCUMENT_TITLE.ROZ!;
  return 'Faktura';
}

function vatRateLabel(rate: string | null): string {
  if (!rate) return '—';
  // AUD-70: usługa z art. 100 ust. 1 pkt 4 (FA(3) „np II”) — jak na PDF.
  if (rate === 'np_ii') return 'np. II';
  if (['zw', 'oo', 'np'].includes(rate)) return rate;
  // W9: kod FA(3) z importu bez odpowiednika w FaktWay („0 WDT”, „nieznana”…).
  const imported = importedVatRateLabel(rate);
  if (imported) return `${rate} (${imported})`;
  return `${rate}%`;
}

/**
 * Kolumny `invoices`, od których zależą fakty liczone TYLKO na serwerze: kod QR
 * (`loadQr`: numer KSeF + hash pliku XML) i prawo do korekty (`loadCanCorrect`: status, numer).
 * Realtime niesie same kolumny wiersza, więc zmiana którejkolwiek z nich odświeża stronę
 * (`router.refresh()`) — tak jak `PAYMENT_FACT_FIELDS` na liście faktur. Inne zmiany
 * (np. podpowiedź błędu) są już w całości widoczne ze stanu lokalnego.
 */
const SERVER_FACT_FIELDS = ['ksef_status', 'ksef_number', 'xml_storage_path'] as const;

/**
 * Szczegóły faktury + nasłuch Realtime na UPDATE tego samego wiersza
 * (status KSeF, numer, ścieżka XML, błąd) — bez ręcznego odświeżania.
 */
export function InvoiceDetailView({ initial }: { initial: InvoiceDetailInitial }) {
  const router = useRouter();
  const [inv, setInv] = useState(initial);
  // `router.refresh()` (np. po decyzji albo po odmowie wysyłki/usunięcia — C15) przynosi
  // nowe `initial` z serwera: widok przyjmuje je w całości, inaczej baner szkicu wycofanego
  // i panel decyzji zostałyby ze stanu z pierwszego renderu. Realtime działa dalej na nim.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setInv(initial);
  }
  // Bieżący stan dla uchwytu Realtime (porównanie faktów bez wywoływania go w aktualizatorze
  // stanu — ten bywa uruchamiany dwa razy, a `router.refresh()` to efekt uboczny).
  const invRef = useRef(inv);
  useEffect(() => {
    invRef.current = inv;
  }, [inv]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`invoice-detail-${initial.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'invoices',
          filter: `id=eq.${initial.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          // C9: QR i „Korekta” liczy serwer — zmiana statusu, numeru albo pliku XML przynosi je
          // przez `router.refresh()`; nowe `initial` przyjmuje zerowanie `seenInitial` wyżej
          // (stan = serwer, więc kolejne zdarzenia o tych samych faktach już nie odświeżają).
          const current = invRef.current;
          if (SERVER_FACT_FIELDS.some((field) => field in row && String(row[field] ?? '') !== String(current[field] ?? ''))) {
            router.refresh();
          }
          setInv((prev) => {
            // Dane oryginału 440 i widok decyzji pochodzą z chwili otwarcia strony — po
            // zmianie stanu faktury są nieaktualne (nowy werdykt = nowe dane po odświeżeniu).
            const duplicateStale =
              (typeof row.ksef_status === 'string' && row.ksef_status !== prev.ksef_status) ||
              ('last_error_code' in row && row.last_error_code !== prev.last_error_code) ||
              ('last_error' in row && row.last_error !== prev.last_error);
            return {
              ...prev,
              ksef_duplicate_original: duplicateStale ? null : prev.ksef_duplicate_original,
              ksef_duplicate_decision: duplicateStale ? null : prev.ksef_duplicate_decision,
              // Szkic wycofany zostaje wycofany, dopóki faktura jest szkicem; każdy inny stan — bez banera.
              ksef_retired_draft:
                typeof row.ksef_status === 'string' && row.ksef_status !== 'draft' ? null : prev.ksef_retired_draft,
              ksef_status:
                typeof row.ksef_status === 'string'
                  ? row.ksef_status
                  : prev.ksef_status,
              ksef_number:
                (row.ksef_number as string | null | undefined) ?? prev.ksef_number,
              ksef_accepted_at:
                (row.ksef_accepted_at as string | null | undefined) ??
                prev.ksef_accepted_at,
              xml_storage_path:
                (row.xml_storage_path as string | null | undefined) ??
                prev.xml_storage_path,
              last_error:
                'last_error' in row
                  ? row.last_error as string | null
                  : prev.last_error,
              last_error_code:
                'last_error_code' in row
                  ? row.last_error_code as string | null
                  : prev.last_error_code,
              last_error_field:
                (row.last_error_field as string | null | undefined) ??
                prev.last_error_field,
              last_error_suggestion:
                (row.last_error_suggestion as string | null | undefined) ??
                prev.last_error_suggestion,
            };
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'upo_receipts',
          filter: `invoice_id=eq.${initial.id}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setInv((prev) => ({ ...prev, upo_status: null }));
            return;
          }
          const row = payload.new as Record<string, unknown>;
          const status = row.status;
          if (typeof status === 'string') {
            setInv((prev) => ({
              ...prev,
              upo_status: status as InvoiceDetailInitial['upo_status'],
            }));
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initial.id, router]);

  const seller = (inv.seller_data ?? {}) as PartySnapshot;
  const buyer = (inv.buyer_data ?? {}) as PartySnapshot;
  const payment = (inv.payment_data ?? null) as PaymentSnapshot | null;
  const lines = inv.lines;
  // Panel „W KSeF jest już faktura o tym numerze” (decyzja albo nota z danymi oryginału).
  // Obok niego bez karty błędu: tekst runnera jest dla operatora, klient ma panel.
  const duplicatePanel =
    inv.ksef_status === 'failed' &&
    inv.last_error_code === 'KSEF_DUPLICATE_RECONCILE' &&
    inv.ksef_duplicate_original !== null;
  const decision = duplicatePanel && inv.ksef_duplicate_decision?.kind === 'decidable' ? inv.ksef_duplicate_decision : null;
  const retired = inv.ksef_status === 'draft' ? inv.ksef_retired_draft : null;

  const currency = inv.currency.trim().toUpperCase() || 'PLN';
  const money = (value: string | number | null) => `${formatNumber(value)} ${currency}`;
  // Wiersze stawek tylko gdy kwoty pozycji są komplet i zgadzają się z nagłówkiem
  // (korekta `before_after` ma w pozycjach stan PO, a w nagłówku różnicę) — lepiej samo „Razem” niż złe liczby.
  const vatRows = vatSummaryByRate(lines);
  const showVatRows = vatRows !== null && vatRows.length > 0 && vatSummaryAgreesWithGross(vatRows, inv.gross_total);

  // Te same props dla obu miejsc paska akcji: główna akcja w karcie „Status”, reszta w karcie „Dokument”.
  const actionsInvoice = {
    id: inv.id,
    ksef_status: inv.ksef_status,
    xml_storage_path: inv.xml_storage_path ?? null,
    invoice_type: inv.invoice_type,
    invoice_kind: inv.invoice_kind,
    last_error_code: inv.last_error_code,
    ksef_resend_facts: initial.ksef_resend_facts,
    ksef_environment_known: initial.ksef_environment_known,
    ksef_duplicate_panel: duplicatePanel,
    ksef_retired: retired ? { deletable: retired.deletable, ...(retired.imported ? { imported: retired.imported } : {}) } : null,
    can_correct: inv.can_correct,
    can_set_recurring: inv.can_set_recurring ?? false,
  };

  return (
    <div>
      {/*
        Układ Finory (`invoices-view/index.tsx`): dokument po lewej, kolumna 18rem po prawej od `lg`.
        Prawa kolumna = karta akcji Finory (`invoice-actions.tsx`: Wyślij e-mailem, Pobierz PDF,
        Drukuj + nasze XML i Korekta) i — nad nią — karta „Status” KSeF (P4). Kolejność w DOM =
        kolejność na telefonie: karta „Status” NAD dokumentem, karta akcji pod nim. Każda akcja
        jest w DOM raz.
      */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem] lg:grid-rows-[auto_1fr] print:block">
        <Card
          data-testid="karta-statusu"
          className="h-max gap-4 shadow-none lg:col-start-2 lg:row-start-1 print:hidden"
        >
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <StatusBadge
                status={inv.ksef_status}
                errorCode={inv.last_error_code}
                automaticResend={automaticResendExpected({
                  status: inv.ksef_status,
                  errorCode: inv.last_error_code,
                  invoiceKind: inv.invoice_kind,
                  // Fakty z propsów (odświeżane przez router.refresh), stan i kod z Realtime.
                  facts: initial.ksef_resend_facts,
                  environmentKnown: initial.ksef_environment_known,
                })}
              />
            </div>

            {inv.ksef_status === 'accepted' && inv.ksef_number && (
              <UpoDownload
                invoiceId={inv.id}
                ksefNumber={inv.ksef_number}
                upoStatus={inv.upo_status}
              />
            )}

            {/* PR C (6.5): faktura zapisana z KSeF decyzją — skąd się wzięła i co dalej (wpłaty, przypomnienia). */}
            {inv.ksef_imported_original && <ImportedOriginalNote provenance={inv.ksef_imported_original} />}

            {inv.last_error && !duplicatePanel && (
              <InvoiceErrorDisplay
                errorMessage={inv.last_error}
                errorCode={inv.last_error_code}
                errorField={inv.last_error_field}
                errorSuggestion={inv.last_error_suggestion}
                invoiceId={inv.id}
                showEditLink={
                  inv.ksef_status === 'rejected' ||
                  inv.ksef_status === 'failed'
                }
              />
            )}

            {duplicatePanel && inv.ksef_duplicate_original && (
              <div className="border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {inv.ksef_duplicate_original.title}
                </h3>
                <dl className="mt-3 grid grid-cols-1 gap-y-1 text-sm">
                  {inv.ksef_duplicate_original.rows.map((row) => (
                    <div key={row.label} className="flex flex-wrap gap-x-2">
                      <dt className="text-amber-800 dark:text-amber-200">{row.label}:</dt>
                      <dd className="font-medium break-all">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                {decision ? (
                  <KsefDuplicateDecision invoiceId={inv.id} view={decision} env={initial.ksef_server_environment} />
                ) : (
                  <>
                    <p className="mt-3 text-sm text-amber-900 dark:text-amber-100">
                      {inv.ksef_duplicate_original.note}
                    </p>
                    {inv.ksef_duplicate_original.link && (
                      <p className="mt-2 text-sm">
                        <Link
                          href={inv.ksef_duplicate_original.link.href}
                          className="font-medium text-amber-900 underline underline-offset-2 hover:no-underline dark:text-amber-100"
                        >
                          {inv.ksef_duplicate_original.link.label}
                        </Link>
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Baner ma własny odstęp od dołu (`mb-6`) — w karcie odstępy daje `space-y-4`. */}
            {retired && (
              <div className="[&>*]:mb-0">
                <RetiredDraftBanner view={retired} />
              </div>
            )}

            <InvoiceActions
              section="primary"
              invoice={actionsInvoice}
              canManageSend={inv.can_manage_send}
            />
          </CardContent>
        </Card>

        <Card
          data-testid="dokument-faktury"
          className="gap-6 py-0 shadow-none lg:col-start-1 lg:row-span-2 lg:row-start-1 print:ring-0"
        >
          {/* Nagłówek dokumentu Finory (`invoice-document.tsx`): wystawca po lewej, numer i daty po prawej. */}
          <div className="bg-muted/50 flex flex-wrap items-start justify-between gap-6 p-6">
            <div className="min-w-0 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xl font-semibold uppercase">{seller.name ?? '—'}</span>
              </div>
              <div className="text-muted-foreground space-y-1 text-sm">
                {seller.address?.addressLine1 && <p>{seller.address.addressLine1}</p>}
                {seller.address?.addressLine2 && <p>{seller.address.addressLine2}</p>}
                {seller.nip && <p>NIP: {seller.nip}</p>}
              </div>
            </div>
            <div className="space-y-4 sm:text-right">
              <h1 className="text-lg font-semibold">
                {documentTitle(inv.invoice_type, inv.invoice_kind)} nr {inv.internal_number ?? '(bez numeru)'}
              </h1>
              <div className="text-muted-foreground space-y-1 text-sm">
                <p>Data wystawienia: {formatInvoiceDate(inv.issue_date)}</p>
                {inv.sale_date && <p>Data sprzedaży: {formatInvoiceDate(inv.sale_date)}</p>}
                {payment?.dueDate && <p>Termin płatności: {formatInvoiceDate(payment.dueDate)}</p>}
              </div>
            </div>
          </div>

          <CardContent className="space-y-6 px-6 pb-6">
            <div className="flex flex-wrap justify-between gap-6">
              <div className="min-w-0">
                <h2 className="font-medium">Nabywca:</h2>
                <div className="text-muted-foreground mt-2 space-y-1 text-sm">
                  <p className="text-foreground">{buyer.name ?? '—'}</p>
                  {buyer.address?.addressLine1 && <p>{buyer.address.addressLine1}</p>}
                  {buyer.address?.addressLine2 && <p>{buyer.address.addressLine2}</p>}
                  {buyer.nip ? (
                    <p>NIP: {buyer.nip}</p>
                  ) : buyer.vatUeNumber ? (
                    <p>VAT UE: {buyer.vatUeNumber}</p>
                  ) : null}
                  {buyer.email && <p>{buyer.email}</p>}
                </div>
              </div>
              <div className="min-w-0">
                <h2 className="font-medium">Płatność:</h2>
                <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-foreground">Do zapłaty:</dt>
                  <dd className="font-medium tabular-nums">{money(inv.amount_due)}</dd>
                  {payment?.method && (
                    <>
                      <dt className="text-foreground">Forma płatności:</dt>
                      <dd>{PAYMENT_METHOD_LABEL[payment.method] ?? payment.method}</dd>
                    </>
                  )}
                  {payment?.bankAccount && (
                    <>
                      <dt className="text-foreground">Rachunek:</dt>
                      <dd className="break-all">{payment.bankAccount}</dd>
                    </>
                  )}
                  {payment?.bankName && (
                    <>
                      <dt className="text-foreground">Bank:</dt>
                      <dd>{payment.bankName}</dd>
                    </>
                  )}
                  {currency !== 'PLN' && payment?.swift && (
                    <>
                      <dt className="text-foreground">SWIFT:</dt>
                      <dd>{payment.swift}</dd>
                    </>
                  )}
                  {inv.split_payment && (
                    <>
                      <dt className="text-foreground">MPP:</dt>
                      <dd>Mechanizm podzielonej płatności</dd>
                    </>
                  )}
                </dl>
              </div>
            </div>

            {/* Telefon: tabela pozycji przewija się w poziomie w kontenerze `Table` (to dokument, nie lista). */}
            <Table className="min-w-[40rem] border">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Lp.</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead>J.m.</TableHead>
                  <TableHead className="text-right">Cena netto</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">Netto</TableHead>
                  <TableHead className="pr-4 text-right">Brutto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground py-4 text-center text-xs">
                      Brak pozycji
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((line) => (
                  <TableRow key={line.ordinal}>
                    <TableCell className="pl-4">{line.ordinal}</TableCell>
                    <TableCell className="font-medium whitespace-normal">{line.name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.quantity, 4)}</TableCell>
                    <TableCell className="text-muted-foreground">{line.unit ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.unit_price_net, 4)}</TableCell>
                    <TableCell className="text-right">{vatRateLabel(line.vat_rate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.net_amount)}</TableCell>
                    <TableCell className="pr-4 text-right font-medium tabular-nums">
                      {formatNumber(line.gross_amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/*
              Stopka dokumentu Finory: po lewej (zamiast „Salesperson”) podsumowanie VAT per stawka,
              po prawej sumy. Kolumna sum szersza niż w Finorze (`max-w-64`, nie `max-w-56`):
              „Razem brutto:” i kwota z kodem waluty nie mieszczą się w 14rem (§7.2).
            */}
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0 flex-1 basis-72">
                {showVatRows && vatRows && (
                  <div data-testid="podsumowanie-vat">
                    <Table className="border">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Stawka</TableHead>
                          <TableHead className="text-right">Netto</TableHead>
                          <TableHead className="text-right">VAT</TableHead>
                          <TableHead className="pr-4 text-right">Brutto</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vatRows.map((row) => (
                          <TableRow key={row.rate}>
                            <TableCell className="pl-4">{vatRateLabel(row.rate)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(row.net)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(row.vat)}</TableCell>
                            <TableCell className="pr-4 text-right tabular-nums">{formatNumber(row.gross)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
              <div className="w-full max-w-64 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Razem netto:</span>
                  <span className="font-medium tabular-nums">{money(inv.net_total)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">VAT:</span>
                  <span className="font-medium tabular-nums">{money(inv.vat_total)}</span>
                </div>
                <Separator className="my-2" />
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium">Razem brutto:</span>
                  <span className="font-medium tabular-nums">{money(inv.gross_total)}</span>
                </div>
              </div>
            </div>

            {inv.notes && (
              <>
                <Separator />
                <p className="text-sm">
                  <span className="font-medium">Uwagi:</span>{' '}
                  <span className="text-muted-foreground whitespace-pre-wrap">{inv.notes}</span>
                </p>
              </>
            )}

            {inv.ksef_number && (
              <>
                <Separator />
                <div className="flex flex-wrap items-end justify-between gap-6">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="text-muted-foreground text-xs tracking-wide uppercase">Numer KSeF</p>
                    <p className="font-mono break-all">{inv.ksef_number}</p>
                    {inv.ksef_accepted_at && (
                      <p className="text-muted-foreground text-xs">
                        Zaakceptowana: {formatWarsawDateTime(inv.ksef_accepted_at)}
                      </p>
                    )}
                  </div>
                  <InvoiceQr qr={inv.qr} />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Karta akcji Finory (`invoice-actions.tsx`): `h-max shadow-none print:hidden`, przyciski na całą szerokość. */}
        <Card
          data-testid="karta-dokumentu"
          className="h-max shadow-none lg:col-start-2 lg:row-start-2 print:hidden"
        >
          <CardContent className="space-y-4">
            <InvoiceActions
              section="secondary"
              invoice={actionsInvoice}
              canManageSend={inv.can_manage_send}
              buyerEmail={buyer.email ?? null}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { calculateInvoiceTotals } from '@/lib/xml/invoice-calculator';
import {
  saveAndSendInvoiceAction,
  saveDraftAction,
  type PrefillFromLastInvoice,
} from './actions';
import type { CachedValidationResult } from '@/lib/validation/cache';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InvoiceTotals } from '@/components/invoices/invoice-totals';
import { suggestsSplitPayment } from '@/lib/invoices/annotations';
import { dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import type { SellerData } from '@/types/invoice-types';
import { Separator } from '@/components/ui/separator';
import { InvoiceCreateActions } from '@/components/invoices/finora/invoice-create-actions';
import {
  DocumentColumns,
  InvoiceCreateGrid,
  InvoiceCreatePageHeading,
  InvoiceDocumentCard,
  InvoiceDocumentHeader,
} from '@/components/invoices/finora/invoice-document';
import { BuyerSection } from './invoice-form-parts/buyer-section';
import { toLineItems } from './invoice-form-parts/calculations';
import { defaultLine, labelClass, type BuyerKind } from './invoice-form-parts/constants';
import { DocumentHeaderFields } from './invoice-form-parts/document-header-fields';
import { RecurringActionsCard, StickyFormActions } from './invoice-form-parts/form-actions';
import { MobileFormHeader, PrefillBanner } from './invoice-form-parts/form-header';
import { LineItemsSection } from './invoice-form-parts/line-items-section';
import { PaymentSection } from './invoice-form-parts/payment-section';
import { ReceiptInvoiceFields } from './invoice-form-parts/receipt-invoice-fields';
import { useLinesDesktopLayout } from './invoice-form-parts/use-lines-desktop-layout';
import { firstValidationMessage } from './invoice-form-parts/validation-message';

/**
 * Formularz zwykłej faktury. Ten plik trzyma stan (React Hook Form, watche,
 * stan białej listy), zapis i wysyłkę; sekcje są w `invoice-form-parts/`.
 * Niezmienniki podziału: `docs/koordynacja/PLAN-USPRAWNIENIA-PRACY.md`, 3.7c.
 */
export function InvoiceForm({
  tenantId,
  prefill = null,
  vatExempt = false,
  suggestedNumber = null,
  seller = null,
  initialValues = null,
  recurringInvoiceId = null,
  recurringPeriod = null,
  salesQuoteId = null,
  salesQuoteSeq = null,
}: {
  /**
   * Firma, dla której strona wyrenderowała formularz (UX-01). Zapis odsyła ją
   * jako `expectedTenantId`; akcja odmawia, gdy w innej karcie przełączono
   * firmę. Tylko do porównania — firmą faktury jest firma z sesji.
   */
  tenantId: string;
  /**
   * Dane sprzedawcy do nagłówka dokumentu (P5) — tylko do wyświetlenia.
   * Faktura i tak bierze sprzedawcę z profilu firmy po stronie serwera.
   */
  seller?: SellerData | null;
  /** Podkład z ostatniej faktury — `null`, gdy tenant nie ma jeszcze żadnej. */
  prefill?: PrefillFromLastInvoice | null;
  /** Podpowiedź kolejnego numeru (F-015) — pole pozostaje edytowalne. */
  suggestedNumber?: string | null;
  /**
   * Firma zwolniona z VAT (ustawiona podstawa w Ustawieniach → Podatek VAT).
   * Nowe pozycje dostają wtedy „zw” — inaczej z przyzwyczajenia wpada 23%.
   */
  vatExempt?: boolean;
  /**
   * Podkład wpisany od razu w formularz (plan Finora N1: `?wzor=` i
   * `?cykliczna=` — `prefillFromInvoiceAction`). Bez niego formularz pusty.
   */
  initialValues?: Partial<InvoiceFormValues> | null;
  /**
   * Pozycja cykliczna (`?cykliczna=`) — ukryte pole; „Wystaw i wyślij” zajmuje
   * nim okres. W tym trybie nie ma „Zapisz szkic” (C2): szkic nie zamyka okresu.
   */
  recurringInvoiceId?: string | null;
  /** Okres z banera strony (np. `2026-11`) — ukryte pole; zapis sprawdza, czy pozycja go nie zmieniła (C3). */
  recurringPeriod?: string | null;
  /**
   * Proforma albo oferta (krok 2.4, `?proforma=`), z której stronę otwarto:
   * ukryte pola; zapis wpisuje powiązanie w tym samym INSERT co fakturę.
   * Numer kolejnej zamiany nadaje strona (druga faktura tylko po potwierdzeniu).
   */
  salesQuoteId?: string | null;
  salesQuoteSeq?: string | null;
}) {
  const newLine: InvoiceFormValues['lines'][number] = vatExempt
    ? { ...defaultLine, vatRate: 'zw' }
    : defaultLine;
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const [isSending, startSending] = useTransition();
  const [buyerVatStatus, setBuyerVatStatus] =
    useState<CachedValidationResult | null>(null);

  // Synchroniczny re-entry guard — `isSaving`/`isSending` z `useTransition`
  // ustawia się dopiero po async-walidacji RHF/Zod (kilka ms okna), przez co
  // szybkie podwójne kliknięcie "Wystaw i wyślij" potrafiło stworzyć dwie
  // faktury z tym samym `internal_number` (audyt #11). Ten ref blokuje submit
  // od razu na pierwszym kliknięciu, jeszcze zanim transition pendinguje.
  // Stanowi PIERWSZĄ warstwę ochrony — drugą jest unique index z migracji
  // 00028, trzecią mapowanie 23505 → friendly error w `actions.ts`.
  const submitInFlightRef = useRef(false);

  // Wiersze siatki od 1360 px albo karty, nigdy oba naraz (powód w hooku).
  const linesDesktopLayout = useLinesDesktopLayout();

  // Daty w czasie polskim, nie UTC (F-013): po północy „dziś” to nowy dzień.
  const today = todayInWarsaw();
  const in14days = dueDateFrom(today, 14);

  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: {
      internalNumber: suggestedNumber ?? '',
      issueDate: today,
      saleDate: today,
      buyerNip: '',
      buyerName: '',
      buyerAddressLine1: '',
      buyerAddressLine2: '',
      buyerEmail: '',
      buyerIsConsumer: false,
      buyerConsumerIdType: undefined,
      buyerPesel: '',
      buyerIdDocument: '',
      buyerIsEu: false,
      buyerVatUe: '',
      buyerCountryCode: '',
      lines: [newLine],
      paymentMethod: 'transfer',
      paymentDueDate: in14days,
      bankAccount: '',
      notes: '',
      splitPayment: false,
      // Faktura do paragonu (krok 1.2): domyślnie wyłączona, pola puste.
      receiptInvoice: false,
      receiptNumber: '',
      receiptDate: '',
      cashRegisterNumber: '',
      receiptRequestDate: '',
      buyerNipOnReceipt: false,
      ...initialValues,
      ...(recurringInvoiceId ? { recurringInvoiceId } : {}),
      ...(recurringInvoiceId && recurringPeriod ? { recurringPeriod } : {}),
      ...(salesQuoteId && salesQuoteSeq ? { salesQuoteId, salesQuoteSeq } : {}),
    },
  });
  /** Tryb „Wystaw teraz” z faktury cyklicznej — bez szkicu (C2). */
  const recurringMode = Boolean(recurringInvoiceId);

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: 'lines',
  });

  const watchedLines = useWatch({ control: form.control, name: 'lines' });
  const buyerNipWatch = useWatch({ control: form.control, name: 'buyerNip' });
  const buyerIsConsumer = useWatch({ control: form.control, name: 'buyerIsConsumer' });
  const buyerConsumerIdType = useWatch({
    control: form.control,
    name: 'buyerConsumerIdType',
  });
  const buyerIsEu = useWatch({ control: form.control, name: 'buyerIsEu' });
  const buyerVatUeWatch = useWatch({ control: form.control, name: 'buyerVatUe' }) ?? '';
  const buyerCountryCode = useWatch({ control: form.control, name: 'buyerCountryCode' }) ?? '';
  const buyerKind: BuyerKind = buyerIsEu ? 'eu' : buyerIsConsumer ? 'consumer' : 'pl';
  const receiptInvoice = useWatch({ control: form.control, name: 'receiptInvoice' }) === true;

  // Faktura do paragonu (krok 1.2): data paragonu ustawia datę sprzedaży. Po
  // odznaczeniu FP wraca data sprzedaży sprzed zaznaczenia, jeśli od tamtej
  // pory zmieniła ją tylko data paragonu: zwykła faktura nie może po cichu
  // zostać z datą sprzedaży z paragonu (P_6).
  const saleDateBeforeReceipt = useRef<string | null>(null);
  const onReceiptInvoiceChange = (checked: boolean) => {
    if (checked) {
      saleDateBeforeReceipt.current = form.getValues('saleDate') ?? '';
      return;
    }
    const before = saleDateBeforeReceipt.current;
    saleDateBeforeReceipt.current = null;
    const receiptDate = form.getValues('receiptDate');
    if (before !== null && receiptDate && form.getValues('saleDate') === receiptDate) {
      form.setValue('saleDate', before, { shouldValidate: form.formState.isSubmitted });
    }
  };
  const onReceiptDateChange = (value: string) =>
    form.setValue('saleDate', value, { shouldValidate: form.formState.isSubmitted });

  // Ta sama tablica idzie do sum i do `InvoiceTotals` (rozbicie VAT na stawki).
  const lineItems = toLineItems(watchedLines);

  const totals = calculateInvoiceTotals(lineItems);
  const splitPayment = useWatch({ control: form.control, name: 'splitPayment' });
  // MPP dotyczy firm z Polski — nie osoby prywatnej ani firmy z UE (AUD-70).
  const podpowiedzMpp = !splitPayment && suggestsSplitPayment(totals.grossTotal, buyerKind !== 'pl');

  const [prefillUzyty, setPrefillUzyty] = useState(false);

  /**
   * Wypełnienie z ostatniej faktury.
   *
   * NIE RUSZAMY numeru ani żadnej daty — te pola formularz wypełnił sam
   * wartościami na dziś i przepisanie starych byłoby cofnięciem faktury
   * w czasie. Reszta to podmiana wartości: nabywca, pozycje i sposób zapłaty.
   */
  const wypelnijZOstatniej = () => {
    if (!prefill) return;
    const v = prefill.values;
    // Nabywca z UE (AUD-70) wraca z numerem VAT-UE i krajem zamiast NIP-u.
    const ue = v.buyerIsEu === true;
    form.setValue('buyerIsConsumer', false);
    form.setValue('buyerIsEu', ue);
    form.setValue('buyerVatUe', ue ? v.buyerVatUe ?? '' : '');
    form.setValue('buyerCountryCode', ue ? v.buyerCountryCode ?? '' : '');
    if (ue) setBuyerVatStatus(null);
    form.setValue('buyerNip', v.buyerNip, { shouldValidate: !ue });
    form.setValue('buyerName', v.buyerName);
    form.setValue('buyerAddressLine1', v.buyerAddressLine1);
    form.setValue('buyerAddressLine2', v.buyerAddressLine2);
    form.setValue('buyerEmail', v.buyerEmail);
    form.setValue('paymentMethod', v.paymentMethod);
    if (v.bankAccount) form.setValue('bankAccount', v.bankAccount);
    replace(v.lines);
    setPrefillUzyty(true);
    toast.success(`Wypełniłem na podstawie faktury dla ${prefill.contractorName}`);
  };

  const handleSaveDraft = form.handleSubmit(
    (values) => {
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      startSaving(async () => {
        try {
          const result = await saveDraftAction(values, tenantId);
          if (result.success) {
            toast.success('Szkic zapisany');
            router.push(`/invoices/${result.invoiceId}`);
          } else {
            toast.error(result.error);
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Błąd zapisu');
        } finally {
          submitInFlightRef.current = false;
        }
      });
    },
    (errors) => {
      submitInFlightRef.current = false;
      toast.error(firstValidationMessage(errors));
    }
  );

  const handleSend = form.handleSubmit(
    (values) => {
      if (submitInFlightRef.current) return;

      // BUG-010 (audyt przedlaunchowy): ostrzeżenie o fakturze bezpłatnej.
      // Puste pole ceny jest blokowane przez walidację Zod. Cena 0.00 zł jest
      // dozwolona (faktura bezpłatna jest legalna), ale wymaga świadomego
      // potwierdzenia, żeby user nie wysłał przypadkiem faktury na 0 zł.
      const hasZeroPriceLine = (values.lines ?? []).some(
        (l) => Number(l.unitPriceNet) === 0,
      );
      if (hasZeroPriceLine) {
        const proceed =
          typeof window !== 'undefined' &&
          confirm(
            'Co najmniej jedna pozycja ma cenę 0.00 zł. Czy na pewno chcesz wystawić fakturę bezpłatną?',
          );
        if (!proceed) return;
      }

      // Biała lista zna tylko polskie NIP-y — nie pytamy przy osobie prywatnej
      // ani firmie z UE.
      if (
        buyerKind === 'pl' &&
        buyerVatStatus &&
        !buyerVatStatus.isValid
      ) {
        const label =
          buyerVatStatus.legalName?.trim() ||
          `(NIP ${buyerVatStatus.nip ?? '?'})`;
        const proceed =
          typeof window !== 'undefined' &&
          confirm(
            `Uwaga: kontrahent ${label} ma status "${buyerVatStatus.vatStatus}". KSeF może odrzucić fakturę. Kontynuować?`,
          );
        if (!proceed) {
          return;
        }
      }

      submitInFlightRef.current = true;
      startSending(async () => {
        try {
          const result = await saveAndSendInvoiceAction(values, tenantId);
          if (result.success) {
            toast.success('Wysyłanie faktury do KSeF rozpoczęte');
            router.push(`/invoices/${result.invoiceId}`);
          } else {
            toast.error(result.error);
            if (result.invoiceId) router.push(`/invoices/${result.invoiceId}`);
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Błąd wysyłki');
        } finally {
          submitInFlightRef.current = false;
        }
      });
    },
    (errors) => {
      submitInFlightRef.current = false;
      toast.error(firstValidationMessage(errors));
    }
  );

  // Odczyt w renderze subskrybuje RHF na zmianę — handlery dostają świeżą wartość.
  const wyslanoRaz = form.formState.isSubmitted;

  // react-hook-form: watch() jest celowo niememoizowalny — React Compiler pomija ten hook.
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch dla warunkowego UI
  const paymentMethod = form.watch('paymentMethod');

  const busy = isSaving || isSending;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6 pb-32 lg:pb-10">
      {recurringInvoiceId ? <input type="hidden" {...form.register('recurringInvoiceId')} /> : null}
      {recurringInvoiceId && recurringPeriod ? <input type="hidden" {...form.register('recurringPeriod')} /> : null}
      {salesQuoteId && salesQuoteSeq ? <input type="hidden" {...form.register('salesQuoteId')} /> : null}
      {salesQuoteId && salesQuoteSeq ? <input type="hidden" {...form.register('salesQuoteSeq')} /> : null}
      {/* NAGŁÓWEK — dwa układy.
          Na telefonie pasek z makiety: strzałka wstecz, tytuł z podtytułem,
          „Szkic” po prawej. Zapis szkicu wchodzi tu z dolnego paska, żeby
          zostawić mu miejsce na dwa przyciski zamiast trzech.
          Od `sm` nagłówek strony jak na liście faktur (P3). */}
      <MobileFormHeader
        recurringMode={recurringMode}
        busy={busy}
        isSaving={isSaving}
        onSaveDraft={handleSaveDraft}
      />

      <InvoiceCreatePageHeading
        className="hidden sm:block"
        title="Nowa faktura"
        description="Wystaw fakturę B2B lub B2C i wyślij do KSeF jednym kliknięciem"
      />

      {/* PODPOWIEDŹ FLO — tylko gdy jest z czego wypełniać.
          Zniknie po użyciu: baner, który po kliknięciu zostaje, wygląda jakby
          nic się nie stało, a formularz jest już wypełniony. */}
      {prefill && !prefillUzyty ? (
        <PrefillBanner contractorName={prefill.contractorName} onFill={wypelnijZOstatniej} />
      ) : null}

      <InvoiceCreateGrid>
        <InvoiceDocumentCard
          header={
            <InvoiceDocumentHeader seller={seller}>
              <DocumentHeaderFields form={form} />
              <ReceiptInvoiceFields
                form={form}
                enabled={receiptInvoice}
                buyerKind={buyerKind}
                onToggle={onReceiptInvoiceChange}
                onReceiptDateChange={onReceiptDateChange}
              />
            </InvoiceDocumentHeader>
          }
        >
          <DocumentColumns>
            {/* NABYWCA (Finora: „Invoice To:”) */}
            <BuyerSection
              form={form}
              buyerKind={buyerKind}
              buyerNipWatch={buyerNipWatch}
              buyerConsumerIdType={buyerConsumerIdType}
              buyerVatUeWatch={buyerVatUeWatch}
              buyerCountryCode={buyerCountryCode}
              buyerVatStatus={buyerVatStatus}
              setBuyerVatStatus={setBuyerVatStatus}
              wyslanoRaz={wyslanoRaz}
            />

            {/* PŁATNOŚĆ (Finora: „Bill To:”) — termin jest w nagłówku, jak „Date Due”. */}
            <PaymentSection form={form} paymentMethod={paymentMethod} podpowiedzMpp={podpowiedzMpp} />
          </DocumentColumns>

          <Separator />

          <LineItemsSection
            form={form}
            fields={fields}
            watchedLines={watchedLines}
            linesDesktopLayout={linesDesktopLayout}
            remove={remove}
            onAddLine={() => append(newLine)}
          />

          <Separator />

          {/* Jedno podsumowanie pod oboma układami pozycji — po prawej, jak w Finorze. */}
          <InvoiceTotals totals={totals} lines={lineItems} />

          <Separator />

          <div>
            <Label htmlFor="invoice-notes" className={labelClass}>
              Uwagi
            </Label>
            <Textarea id="invoice-notes" rows={3} {...form.register('notes')} />
          </div>
        </InvoiceDocumentCard>

        {recurringMode ? (
          <RecurringActionsCard busy={busy} isSending={isSending} onSend={handleSend} />
        ) : (
          <InvoiceCreateActions
            onSend={handleSend}
            onSave={handleSaveDraft}
            sending={isSending}
            saving={isSaving}
            disabled={busy}
          />
        )}
      </InvoiceCreateGrid>

      {/* STICKY FOOTER — tylko telefon i tablet; od `lg` akcje są w prawej kolumnie. */}
      <StickyFormActions
        recurringMode={recurringMode}
        busy={busy}
        isSaving={isSaving}
        isSending={isSending}
        onSaveDraft={handleSaveDraft}
        onSend={handleSend}
      />
    </form>
  );
}

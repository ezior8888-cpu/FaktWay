'use client';

import { useEffect, useRef, useState, useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  useForm,
  useFieldArray,
  useWatch,
  type FieldErrors,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  EU_BUYER_COUNTRIES,
  invoiceFormSchema,
  type InvoiceFormValues,
} from '@/lib/schemas/invoice-form';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import { cn } from '@/lib/utils';
import {
  calculateLineItem,
  calculateInvoiceTotals,
} from '@/lib/xml/invoice-calculator';
import type { InvoiceLineItem } from '@/types/invoice';
import {
  saveAndSendInvoiceAction,
  saveDraftAction,
  type PrefillFromLastInvoice,
} from './actions';
import { BuyerLookup } from './buyer-lookup';
import { VatStatusBadge } from '@/components/validation/vat-status-badge';
import type { CachedValidationResult } from '@/lib/validation/cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import Link from 'next/link';
import { AlertCircle, ChevronLeft, Trash2, Loader2 } from 'lucide-react';
import { RiAddLine, RiCloseLine, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';
import { Card, CardContent } from '@/components/ui/card';
import { InvoiceTotals } from '@/components/invoices/invoice-totals';
import { suggestsSplitPayment } from '@/lib/invoices/annotations';
import { formatPlMoney } from '@/lib/format/pl';
import { dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import { BUYER_ID_TYPE_LABELS, type SellerData } from '@/types/invoice-types';
import { Separator } from '@/components/ui/separator';
import { InvoiceCreateActions } from '@/components/invoices/finora/invoice-create-actions';
import {
  DocumentColumns,
  DocumentHeaderRow,
  DocumentSection,
  InvoiceCreateGrid,
  InvoiceCreatePageHeading,
  InvoiceDocumentCard,
  InvoiceDocumentHeader,
} from '@/components/invoices/finora/invoice-document';

const defaultLine: InvoiceFormValues['lines'][number] = {
  name: '',
  unit: 'szt',
  quantity: 1,
  unitPriceNet: 0,
  vatRate: '23',
};

function firstValidationMessage(errors: FieldErrors<InvoiceFormValues>): string {
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const o = node as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.length) return o.message;
    if (Array.isArray(o)) {
      for (const item of o) {
        const m = walk(item);
        if (m) return m;
      }
      return null;
    }
    for (const v of Object.values(o)) {
      const m = walk(v);
      if (m) return m;
    }
    return null;
  };
  return walk(errors) ?? 'Sprawdź pola formularza (czerwone podpowiedzi).';
}

/** Etykieta pola w stylu Finory (`FieldLabel`): mały tekst nad polem. */
const labelClass = 'mb-2';

/**
 * Od tej szerokości pozycje idą wierszami siatki (Finora:
 * `invoice-line-items.tsx`), poniżej kartami. Do P5 próg był `lg`, ale od
 * `lg` obok dokumentu stoi kolumna akcji 18rem i wiersz z siedmioma polami
 * nie mieścił się w karcie. Przegląd P5 policzył też `xl` (1280 px): przy
 * rozwiniętym pasku bocznym na treść karty zostaje ok. 585 px, a wiersz
 * `LINE_GRID` z odstępami ma ok. 619 px — przewijał się w bok. Przy 1360 px
 * (laptopy 1366) zostaje ok. 660 px.
 */
const LINES_LAYOUT_MEDIA = '(min-width: 1360px)';

/** Kolumny wiersza pozycji: Nazwa · J.m. · Ilość · Cena netto · VAT · Brutto · usuń. */
const LINE_GRID =
  'grid grid-cols-[minmax(8rem,1fr)_3.5rem_4.5rem_6rem_5.5rem_6.5rem_2rem] gap-2';

/**
 * Rodzaj nabywcy (AUD-70). W schemacie to dwie flagi — `buyerIsConsumer`
 * i `buyerIsEu` — bo starsze wywołania znają tylko pierwszą; w interfejsie
 * jeden wybór z trzech, żeby nie dało się zaznaczyć obu naraz.
 *
 * `buyer-is-consumer` to id dawnego pola wyboru „osoba fizyczna” — zostaje
 * na opcji „Osoba prywatna”, bo klika w nie test e2e 07.
 */
type BuyerKind = 'pl' | 'consumer' | 'eu';

const BUYER_KINDS: ReadonlyArray<{ kind: BuyerKind; id: string; label: string; hint: string }> = [
  { kind: 'pl', id: 'buyer-kind-pl', label: 'Firma z Polski (NIP)', hint: 'Dane z GUS po numerze NIP' },
  { kind: 'consumer', id: 'buyer-is-consumer', label: 'Osoba prywatna', hint: 'PESEL, dowód, paszport lub bez identyfikatora' },
  { kind: 'eu', id: 'buyer-kind-eu', label: 'Firma z UE (VAT-UE)', hint: 'Numer VAT-UE z prefiksem kraju' },
];

const errorTextClass = 'mt-1.5 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400';

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const PAYMENT_METHOD_ITEMS = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'card', label: 'Karta' },
  { value: 'other', label: 'Inna' },
] as const

const EU_COUNTRY_ITEMS = EU_BUYER_COUNTRIES.map((k) => ({ value: k.code, label: k.name }))

const BUYER_ID_TYPE_ITEMS = (['pesel', 'id_card', 'passport', 'no_id'] as const).map((k) => ({
  value: k,
  label: BUYER_ID_TYPE_LABELS[k],
}))

/** Pod przyciskiem wysyłki w trybie „Wystaw teraz” z faktury cyklicznej (C2). */
const RECURRING_NO_DRAFT_TEXT = 'Fakturę cykliczną wystawiasz od razu — szkic nie zamyka okresu.';

function euCountryName(code: string): string | undefined {
  return EU_BUYER_COUNTRIES.find((k) => k.code === code)?.name;
}

export function InvoiceForm({
  tenantId,
  prefill = null,
  vatExempt = false,
  suggestedNumber = null,
  seller = null,
  initialValues = null,
  recurringInvoiceId = null,
  recurringPeriod = null,
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

  /**
   * Nie montuj jednocześnie tabeli desktop i kart mobile z tym samym
   * `register('lines.*')` — oba bloki były w DOM (tylko `display:none`), przez co
   * React Hook Form wiązał ref z „drugim” inputem i widoczne pole Nazwa nie
   * aktualizowało stanu.
   */
  const [linesDesktopLayout, setLinesDesktopLayout] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(LINES_LAYOUT_MEDIA);
    const sync = () => setLinesDesktopLayout(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

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
      ...initialValues,
      ...(recurringInvoiceId ? { recurringInvoiceId } : {}),
      ...(recurringInvoiceId && recurringPeriod ? { recurringPeriod } : {}),
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

  /** Podpowiedź pod polem VAT-UE — na bieżąco, zanim schemat pokaże błąd. */
  const vatUeParsed = parseVatUe(buyerVatUeWatch);
  const vatUeHint: { tone: 'muted' | 'warn' | 'ok'; text: string } = !buyerVatUeWatch.trim()
    ? { tone: 'muted', text: 'Prefiks kraju i numer, np. DE123456789 (Grecja: EL).' }
    : !vatUeParsed
      ? { tone: 'warn', text: 'Niepoprawny format — dwuliterowy prefiks kraju UE i do 12 znaków numeru.' }
      : vatUeParsed.kodUE === 'PL'
        ? { tone: 'warn', text: 'To polski numer — wybierz „Firma z Polski (NIP)”.' }
        : {
            tone: 'ok',
            text: `${euCountryName(addressCountryForKodUE(vatUeParsed.kodUE)) ?? vatUeParsed.kodUE} · ${vatUeParsed.normalized}`,
          };

  // Wyciągnięte do zmiennej, bo tej samej tablicy potrzebuje `InvoiceTotals`
  // do rozbicia VAT-u na stawki. Wcześniej mapowanie żyło wyłącznie w argumencie
  // `calculateInvoiceTotals`, więc podsumowanie nie miało jak zobaczyć stawek
  // i liczyło VAT jako `brutto − netto`.
  const lineItems = (
    (watchedLines ?? []) as InvoiceFormValues['lines']
  ).map<InvoiceLineItem>((line, idx) => {
    const calc = calculateLineItem({
      quantity: Number(line?.quantity) || 0,
      unitPriceNet: Number(line?.unitPriceNet) || 0,
      vatRate: line?.vatRate ?? '23',
    });
    return {
      ordinal: idx + 1,
      name: line?.name ?? '',
      unit: line?.unit ?? 'szt',
      quantity: Number(line?.quantity) || 0,
      unitPriceNet: Number(line?.unitPriceNet) || 0,
      vatRate: line?.vatRate ?? '23',
      ...calc,
    };
  });

  const totals = calculateInvoiceTotals(lineItems);
  const splitPayment = useWatch({ control: form.control, name: 'splitPayment' });
  // MPP dotyczy firm z Polski — nie osoby prywatnej ani firmy z UE (AUD-70).
  const podpowiedzMpp = !splitPayment && suggestsSplitPayment(totals.grossTotal, buyerKind !== 'pl');

  // Podtytuł nagłówka na telefonie („wrzesień 2026 · KSeF”). Liczony przy
  // renderze, a nie wpisany na stałe.
  const miesiacRok = new Date().toLocaleDateString('pl-PL', {
    month: 'long',
    year: 'numeric',
  });

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

  /**
   * Pigułki terminu: „14 dni” zamiast wybierania daty z kalendarza.
   * Liczone od daty wystawienia z formularza, nie od dzisiaj — inaczej przy
   * fakturze wystawionej wstecz termin wypadałby przed datą wystawienia,
   * a schemat to odrzuca (`paymentDueDate >= issueDate`).
   */
  const ustawTermin = (dni: number) => {
    // Dodawanie dni na samej dacie — lokalna północ zamieniona na UTC dawała
    // w Polsce termin o dzień krótszy (F-013).
    form.setValue('paymentDueDate', dueDateFrom(form.getValues('issueDate'), dni), {
      shouldValidate: true,
    });
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

  const handleBuyerSelected = (data: {
    nip: string;
    name: string;
    addressLine1: string;
    addressLine2: string;
  }) => {
    form.setValue('buyerNip', data.nip);
    form.setValue('buyerName', data.name);
    form.setValue('buyerAddressLine1', data.addressLine1);
    form.setValue('buyerAddressLine2', data.addressLine2);
  };

  /**
   * Zmiana rodzaju nabywcy czyści identyfikatory pozostałych dwóch rodzajów
   * (NIP, PESEL/dokument, VAT-UE i kraj) — inaczej zostałyby w danych faktury.
   * Nazwa, adres i e-mail zostają: to częsta poprawka „pomyliłem rodzaj”.
   */
  // Odczyt w renderze subskrybuje RHF na zmianę — handlery dostają świeżą wartość.
  const wyslanoRaz = form.formState.isSubmitted;

  /** Błąd stawki pozycji — np. „np. II” bez nabywcy z UE (AUD-70). */
  const bladStawki = (index: number): string | undefined =>
    form.formState.errors.lines?.[index]?.vatRate?.message;

  const zmienRodzajNabywcy = (kind: BuyerKind) => {
    const opts = { shouldDirty: true } as const;
    setBuyerVatStatus(null);
    form.setValue('buyerIsConsumer', kind === 'consumer', opts);
    form.setValue('buyerIsEu', kind === 'eu', opts);
    if (kind !== 'pl') form.setValue('buyerNip', '', opts);
    if (kind === 'consumer') {
      form.setValue('buyerConsumerIdType', 'pesel', opts);
    } else {
      form.setValue('buyerConsumerIdType', undefined, opts);
      form.setValue('buyerPesel', '', opts);
      form.setValue('buyerIdDocument', '', opts);
    }
    if (kind !== 'eu') {
      form.setValue('buyerVatUe', '', opts);
      form.setValue('buyerCountryCode', '', opts);
    }
    // Błędy poprzedniego rodzaju znikają od razu. Po pierwszej próbie zapisu
    // sprawdzamy całość jeszcze raz — np. pozycja „np. II” staje się poprawna,
    // gdy nabywcą zostaje firma z UE.
    form.clearErrors([
      'buyerNip',
      'buyerIsEu',
      'buyerVatUe',
      'buyerCountryCode',
      'buyerConsumerIdType',
      'buyerPesel',
      'buyerIdDocument',
    ]);
    if (wyslanoRaz) void form.trigger();
  };

  /**
   * Kraj adresu podpowiadamy z prefiksu numeru VAT-UE (Grecja: `EL` → `GR`),
   * ale tylko gdy prefiks się zmienił — kraju wybranego ręcznie nie
   * nadpisujemy przy poprawianiu cyfr numeru.
   */
  const onVatUeChange = (previous: string, next: string) => {
    const before = parseVatUe(previous)?.kodUE;
    const after = parseVatUe(next)?.kodUE;
    if (after && after !== 'PL' && after !== before) {
      form.setValue('buyerCountryCode', addressCountryForKodUE(after), {
        shouldDirty: true,
        shouldValidate: wyslanoRaz,
      });
    }
  };

  // react-hook-form: watch() jest celowo niememoizowalny — React Compiler pomija ten hook.
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch dla warunkowego UI
  const paymentMethod = form.watch('paymentMethod');

  const busy = isSaving || isSending;

  /** Pole stawki VAT — ten sam zestaw opcji co przed P5, w obu układach pozycji. */
  const vatSelectClass =
    'border-input bg-background dark:bg-input/30 h-8 w-full min-w-0 rounded-none border px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:text-[16px]';

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6 pb-32 lg:pb-10">
      {recurringInvoiceId ? <input type="hidden" {...form.register('recurringInvoiceId')} /> : null}
      {recurringInvoiceId && recurringPeriod ? <input type="hidden" {...form.register('recurringPeriod')} /> : null}
      {/* NAGŁÓWEK — dwa układy.
          Na telefonie pasek z makiety: strzałka wstecz, tytuł z podtytułem,
          „Szkic” po prawej. Zapis szkicu wchodzi tu z dolnego paska, żeby
          zostawić mu miejsce na dwa przyciski zamiast trzech.
          Od `sm` nagłówek strony jak na liście faktur (P3). */}
      <div className="flex items-center gap-2 sm:hidden">
        <Link
          href="/invoices/new"
          aria-label="Wróć do wyboru rodzaju faktury"
          className="text-muted-foreground hover:bg-muted -ml-2 flex size-10 shrink-0 items-center justify-center transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">Nowa faktura</h1>
          <p className="text-muted-foreground truncate text-sm">{miesiacRok} · KSeF</p>
        </div>
        {recurringMode ? null : (
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={busy}
            className="text-primary shrink-0 px-2 py-2 text-sm font-semibold transition-opacity disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Szkic'}
          </button>
        )}
      </div>

      <InvoiceCreatePageHeading
        className="hidden sm:block"
        title="Nowa faktura"
        description="Wystaw fakturę B2B lub B2C i wyślij do KSeF jednym kliknięciem"
      />

      {/* PODPOWIEDŹ FLO — tylko gdy jest z czego wypełniać.
          Zniknie po użyciu: baner, który po kliknięciu zostaje, wygląda jakby
          nic się nie stało, a formularz jest już wypełniony. */}
      {prefill && !prefillUzyty ? (
        <div className="flex items-start gap-3 border border-[var(--ff-accent)]/25 bg-[var(--ff-accent-tint)] p-4">
          <span
            aria-hidden
            className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center text-sm font-semibold"
          >
            F
          </span>
          <p className="min-w-0 flex-1 text-sm leading-relaxed">
            Mogę wypełnić to za Ciebie na podstawie ostatniej faktury dla{' '}
            <span className="font-semibold">{prefill.contractorName}</span>.{' '}
            <button
              type="button"
              onClick={wypelnijZOstatniej}
              className="font-semibold text-[var(--ff-accent)] underline-offset-4 hover:underline"
            >
              Wypełnij →
            </button>
          </p>
        </div>
      ) : null}

      <InvoiceCreateGrid>
        <InvoiceDocumentCard
          header={
            <InvoiceDocumentHeader seller={seller}>
              <DocumentHeaderRow
                label="Numer faktury"
                htmlFor="internalNumber"
                error={
                  form.formState.errors.internalNumber ? (
                    <p className={errorTextClass}>
                      <AlertCircle className="h-3 w-3" />
                      {form.formState.errors.internalNumber.message}
                    </p>
                  ) : null
                }
              >
                <Input
                  id="internalNumber"
                  placeholder="FV/2026/04/001"
                  {...form.register('internalNumber')}
                />
              </DocumentHeaderRow>
              <DocumentHeaderRow label="Data wystawienia" htmlFor="issue-date">
                <Input id="issue-date" type="date" {...form.register('issueDate')} />
              </DocumentHeaderRow>
              <DocumentHeaderRow
                label="Data sprzedaży / dostawy"
                htmlFor="sale-date"
                hint="Opcjonalnie, gdy jest inna od daty wystawienia (pole P_6 w KSeF); identyczna data nie jest duplikowana w XML."
                error={
                  form.formState.errors.saleDate ? (
                    <p className={errorTextClass}>
                      <AlertCircle className="h-3 w-3" />
                      {form.formState.errors.saleDate.message}
                    </p>
                  ) : null
                }
              >
                <Input id="sale-date" type="date" {...form.register('saleDate')} />
              </DocumentHeaderRow>
              <DocumentHeaderRow
                label="Termin płatności"
                htmlFor="payment-due-date"
                hint={
                  /* Skróty zamiast kalendarza: na telefonie wybranie daty
                     z natywnego okna to cztery dotknięcia, a „14 dni” jedno.
                     Liczone od daty WYSTAWIENIA, nie od dzisiaj. */
                  <span className="flex flex-wrap gap-2 sm:justify-end">
                    {[7, 14, 30].map((dni) => (
                      <button
                        key={dni}
                        type="button"
                        onClick={() => ustawTermin(dni)}
                        className="border-border text-muted-foreground hover:text-foreground hover:bg-muted min-h-8 border px-3 text-xs transition-colors"
                      >
                        {dni} dni
                      </button>
                    ))}
                  </span>
                }
              >
                <Input id="payment-due-date" type="date" {...form.register('paymentDueDate')} />
              </DocumentHeaderRow>
            </InvoiceDocumentHeader>
          }
        >
          <DocumentColumns>
            {/* NABYWCA (Finora: „Invoice To:”) */}
            <DocumentSection
              title="Nabywca"
              testId="sekcja-nabywca"
              description={
                buyerKind === 'consumer'
                  ? 'Dane osoby fizycznej (bez NIP podatnika)'
                  : buyerKind === 'eu'
                    ? 'Firma z innego kraju UE — identyfikuje ją numer VAT-UE'
                    : 'Wyszukaj po NIP w bazie GUS lub wprowadź ręcznie'
              }
            >
              {/* Rodzaj nabywcy — trzy wykluczające się opcje (AUD-70). Natywne
                  pola radio: grupa z klawiatury (strzałki) i czytnik ekranu bez
                  dodatkowej biblioteki; kółko zostaje widoczne, bo klika w nie e2e. */}
              <fieldset>
                <legend className={cn(labelClass, 'text-muted-foreground')}>Rodzaj nabywcy</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
                  {BUYER_KINDS.map((opcja) => {
                    const wybrana = buyerKind === opcja.kind;
                    return (
                      <label
                        key={opcja.kind}
                        htmlFor={opcja.id}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 border p-3 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                          wybrana
                            ? 'border-primary/40 bg-primary/5 dark:bg-primary/10'
                            : 'border-border hover:bg-muted/50',
                        )}
                      >
                        <input
                          type="radio"
                          id={opcja.id}
                          name="buyerKind"
                          value={opcja.kind}
                          checked={wybrana}
                          onChange={() => zmienRodzajNabywcy(opcja.kind)}
                          className="accent-primary mt-0.5 size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block text-sm font-medium leading-none">{opcja.label}</span>
                          <span className="text-muted-foreground block text-xs">{opcja.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {form.formState.errors.buyerIsEu ? (
                  <p className={errorTextClass}>
                    <AlertCircle className="h-3 w-3" />
                    {form.formState.errors.buyerIsEu.message}
                  </p>
                ) : null}
              </fieldset>
              {buyerKind === 'eu' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div>
                    <Label htmlFor="buyer-vat-ue" className={labelClass}>
                      Numer VAT-UE nabywcy
                    </Label>
                    <Input
                      id="buyer-vat-ue"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      placeholder="DE123456789"
                      className="uppercase"
                      aria-invalid={form.formState.errors.buyerVatUe ? true : undefined}
                      aria-describedby="buyer-vat-ue-hint"
                      {...form.register('buyerVatUe', {
                        onChange: (e: ChangeEvent<HTMLInputElement>) =>
                          onVatUeChange(buyerVatUeWatch, e.target.value),
                      })}
                    />
                    {form.formState.errors.buyerVatUe ? (
                      <p id="buyer-vat-ue-hint" className={errorTextClass}>
                        <AlertCircle className="h-3 w-3" />
                        {form.formState.errors.buyerVatUe.message}
                      </p>
                    ) : (
                      <p
                        id="buyer-vat-ue-hint"
                        aria-live="polite"
                        className={cn(
                          'mt-1.5 text-xs',
                          vatUeHint.tone === 'warn'
                            ? 'text-amber-700 dark:text-amber-400'
                            : vatUeHint.tone === 'ok'
                              ? 'text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        {vatUeHint.text}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="buyer-country" className={labelClass}>
                      Kraj nabywcy
                    </Label>
                    <Select
                      value={buyerCountryCode}
                      items={EU_COUNTRY_ITEMS}
                      onValueChange={(v) => {
                        if (v == null) return
                        form.setValue('buyerCountryCode', v, {
                          shouldDirty: true,
                          shouldValidate: wyslanoRaz,
                        })
                      }}
                    >
                      <SelectTrigger
                        id="buyer-country"
                        className="w-full"
                        aria-invalid={form.formState.errors.buyerCountryCode ? true : undefined}
                      >
                        <SelectValue placeholder="Wybierz kraj UE" />
                      </SelectTrigger>
                      <SelectContent>
                        {EU_COUNTRY_ITEMS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.formState.errors.buyerCountryCode ? (
                      <p className={errorTextClass}>
                        <AlertCircle className="h-3 w-3" />
                        {form.formState.errors.buyerCountryCode.message}
                      </p>
                    ) : (
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        Ustawiamy go z prefiksu numeru — zmień, jeśli adres jest w innym kraju UE.
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
              {buyerKind === 'pl' ? (
                <div className="space-y-2">
                  <Label htmlFor="buyer-nip" className={labelClass}>NIP nabywcy</Label>
                  <BuyerLookup
                    inputId="buyer-nip"
                    nip={buyerNipWatch ?? ''}
                    onNipChange={(digits) => {
                      form.setValue('buyerNip', digits, { shouldDirty: true });
                      if (digits.length === 10) void form.trigger('buyerNip');
                    }}
                    onSelected={handleBuyerSelected}
                    nipError={form.formState.errors.buyerNip?.message}
                    onValidationComplete={(result) => {
                      setBuyerVatStatus(result);
                      if (
                        result?.legalName &&
                        !form.getValues('buyerName')?.trim()
                      ) {
                        form.setValue('buyerName', result.legalName, {
                          shouldDirty: true,
                        });
                      }
                    }}
                  />
                  {buyerVatStatus ? (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <VatStatusBadge
                        status={buyerVatStatus.vatStatus}
                        source={buyerVatStatus.source}
                        fromCache={buyerVatStatus.fromCache}
                        warning={buyerVatStatus.warning ?? null}
                        size="sm"
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {buyerKind === 'consumer' ? (
                <div className="space-y-2">
                  <Label htmlFor="buyer-id-type" className={labelClass}>Typ identyfikatora</Label>
                  <Select
                    value={buyerConsumerIdType ?? 'pesel'}
                    items={BUYER_ID_TYPE_ITEMS}
                    onValueChange={(v) => {
                      if (v == null) return
                      form.setValue(
                        'buyerConsumerIdType',
                        v as InvoiceFormValues['buyerConsumerIdType'],
                        { shouldDirty: true },
                      );
                      form.setValue('buyerPesel', '', { shouldDirty: true });
                      form.setValue('buyerIdDocument', '', { shouldDirty: true });
                      void form.trigger(['buyerConsumerIdType', 'buyerPesel', 'buyerIdDocument']);
                    }}
                  >
                    <SelectTrigger id="buyer-id-type" className="w-full">
                      <SelectValue placeholder="Wybierz typ" />
                    </SelectTrigger>
                    <SelectContent>
                      {BUYER_ID_TYPE_ITEMS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.formState.errors.buyerConsumerIdType ? (
                    <p className={errorTextClass}>
                      <AlertCircle className="h-3 w-3" />
                      {form.formState.errors.buyerConsumerIdType.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {buyerKind === 'consumer' && buyerConsumerIdType === 'pesel' ? (
                <div>
                  <Label htmlFor="buyer-pesel" className={labelClass}>PESEL</Label>
                  <Input
                    id="buyer-pesel"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="11 cyfr"
                    {...form.register('buyerPesel')}
                  />
                  {form.formState.errors.buyerPesel ? (
                    <p className={errorTextClass}>
                      <AlertCircle className="h-3 w-3" />
                      {form.formState.errors.buyerPesel.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {buyerKind === 'consumer' &&
              (buyerConsumerIdType === 'id_card' || buyerConsumerIdType === 'passport') ? (
                <div>
                  <Label htmlFor="buyer-id-document" className={labelClass}>Numer dokumentu</Label>
                  <Input
                    id="buyer-id-document"
                    autoComplete="off"
                    placeholder={
                      buyerConsumerIdType === 'id_card' ? 'Seria i numer dowodu' : 'Numer paszportu'
                    }
                    {...form.register('buyerIdDocument')}
                  />
                  {form.formState.errors.buyerIdDocument ? (
                    <p className={errorTextClass}>
                      <AlertCircle className="h-3 w-3" />
                      {form.formState.errors.buyerIdDocument.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="sm:col-span-2 xl:col-span-1">
                  <Label htmlFor="buyer-name" className={labelClass}>Nazwa firmy</Label>
                  <Input id="buyer-name" {...form.register('buyerName')} />
                </div>
                <div>
                  <Label htmlFor="buyer-address-1" className={labelClass}>Adres (linia 1)</Label>
                  <Input id="buyer-address-1" {...form.register('buyerAddressLine1')} />
                </div>
                <div>
                  <Label htmlFor="buyer-address-2" className={labelClass}>Adres (linia 2)</Label>
                  <Input id="buyer-address-2" {...form.register('buyerAddressLine2')} />
                </div>
                <div className="sm:col-span-2 xl:col-span-1">
                  <Label htmlFor="buyer-email" className={labelClass}>Email (opcjonalnie)</Label>
                  <Input
                    id="buyer-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    {...form.register('buyerEmail')}
                  />
                </div>
              </div>
            </DocumentSection>

            {/* PŁATNOŚĆ (Finora: „Bill To:”) — termin jest w nagłówku, jak „Date Due”. */}
            <DocumentSection title="Płatność" testId="sekcja-platnosc" description="Sposób zapłaty i rachunek">
              <div>
                <Label htmlFor="payment-method" className={labelClass}>Metoda płatności</Label>
                <Select
                  value={paymentMethod}
                  items={PAYMENT_METHOD_ITEMS}
                  onValueChange={(v) => {
                    if (v == null) return
                    form.setValue(
                      'paymentMethod',
                      v as InvoiceFormValues['paymentMethod']
                    )
                  }}
                >
                  <SelectTrigger id="payment-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHOD_ITEMS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="bank-account" className={labelClass}>Numer rachunku (dla przelewu)</Label>
                <Input
                  id="bank-account"
                  {...form.register('bankAccount')}
                  placeholder="12 3456 7890 ..."
                />
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-3 text-sm">
                  <input type="checkbox" className="accent-primary h-4 w-4" {...form.register('splitPayment')} />
                  Mechanizm podzielonej płatności (MPP)
                </label>
                {podpowiedzMpp ? (
                  <p className="text-muted-foreground text-xs">
                    Faktura dla firmy na ponad 15 000 zł brutto. Jeśli sprzedajesz towary lub usługi z załącznika 15
                    do ustawy o VAT (np. roboty budowlane, elektronika, paliwa), MPP jest obowiązkowy.
                  </p>
                ) : null}
                {form.formState.errors.splitPayment ? (
                  <p className="text-destructive text-xs">{form.formState.errors.splitPayment.message}</p>
                ) : null}
              </div>
            </DocumentSection>
          </DocumentColumns>

          <Separator />

          {/* POZYCJE (Finora: `invoice-line-items.tsx`) — wiersze siatki vs karty
              wg `linesDesktopLayout` (od 1360 px, `LINES_LAYOUT_MEDIA`). */}
          <DocumentSection title="Pozycje" testId="sekcja-pozycje" description="Towary i usługi na fakturze">
            {/* Tylko jeden wariant layoutu naraz — patrz `linesDesktopLayout` powyżej. */}
            {linesDesktopLayout ? (
              <div className="-mx-1 overflow-x-auto px-1">
                <div className="min-w-[38rem] space-y-3">
                  <div className={cn(LINE_GRID, 'text-muted-foreground text-xs font-medium')}>
                    <span>Nazwa</span>
                    <span>J.m.</span>
                    <span>Ilość</span>
                    <span>Cena netto</span>
                    <span>VAT</span>
                    <span className="text-right">Brutto</span>
                    <span />
                  </div>
                  {fields.map((field, index) => {
                    const w = watchedLines?.[index];
                    const calc = calculateLineItem({
                      quantity: Number(w?.quantity) || 0,
                      unitPriceNet: Number(w?.unitPriceNet) || 0,
                      vatRate: w?.vatRate ?? '23',
                    });
                    return (
                      <div key={field.id} className={cn(LINE_GRID, 'items-start')}>
                        <Input
                          aria-label={`Nazwa pozycji ${index + 1}`}
                          {...form.register(`lines.${index}.name`)}
                        />
                        <Input
                          aria-label={`Jednostka pozycji ${index + 1}`}
                          {...form.register(`lines.${index}.unit`)}
                        />
                        <Input
                          type="number"
                          step="0.0001"
                          inputMode="decimal"
                          aria-label={`Ilość pozycji ${index + 1}`}
                          className="text-right tabular-nums"
                          {...form.register(`lines.${index}.quantity`, {
                            valueAsNumber: true,
                          })}
                        />
                        <Input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          aria-label={`Cena netto pozycji ${index + 1}`}
                          className="text-right tabular-nums"
                          {...form.register(`lines.${index}.unitPriceNet`, {
                            valueAsNumber: true,
                          })}
                        />
                        <select
                          className={vatSelectClass}
                          aria-label={`Stawka VAT pozycji ${index + 1}`}
                          aria-invalid={bladStawki(index) ? true : undefined}
                          title={bladStawki(index)}
                          {...form.register(`lines.${index}.vatRate`)}
                        >
                          <option value="23">23%</option>
                          <option value="8">8%</option>
                          <option value="5">5%</option>
                          <option value="0">0%</option>
                          <option value="zw">zw</option>
                          <option value="oo">oo</option>
                          <option value="np">np</option>
                          <option value="np_ii">np. II (usługa dla firmy z UE)</option>
                        </select>
                        <span className="mt-1.5 text-right text-sm tabular-nums">
                          <span className="block font-medium">{formatPlMoney(calc.grossAmount)} zł</span>
                          <span className="text-muted-foreground block text-xs">
                            netto {formatPlMoney(calc.netAmount)} zł
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Usuń pozycję ${index + 1}`}
                          disabled={fields.length === 1}
                          onClick={() => remove(index)}
                          className="hover:text-destructive"
                        >
                          <RiCloseLine className="size-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {/* Komórka stawki jest za wąska na komunikat — jeden pod wierszami. */}
                {fields.some((_, i) => bladStawki(i)) ? (
                  <p className={errorTextClass}>
                    <AlertCircle className="h-3 w-3" />
                    {fields.map((_, i) => bladStawki(i)).find(Boolean)}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                {fields.map((field, index) => {
                  const w = watchedLines?.[index];
                  const calc = calculateLineItem({
                    quantity: Number(w?.quantity) || 0,
                    unitPriceNet: Number(w?.unitPriceNet) || 0,
                    vatRate: w?.vatRate ?? '23',
                  });
                  return (
                    <div key={field.id} className="border-border space-y-3 border p-4">
                      <div className="flex items-center justify-between">
                        <span className="bg-foreground text-background inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium">
                          {index + 1}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Usuń pozycję ${index + 1}`}
                          disabled={fields.length === 1}
                          onClick={() => remove(index)}
                          className="hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div>
                        <Label htmlFor={`line-${index}-name`} className={labelClass}>Nazwa pozycji</Label>
                        <Input
                          id={`line-${index}-name`}
                          placeholder="np. Usługa programistyczna"
                          {...form.register(`lines.${index}.name`)}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor={`line-${index}-quantity`} className={labelClass}>Ilość</Label>
                          <Input
                            id={`line-${index}-quantity`}
                            type="number"
                            step="0.0001"
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            {...form.register(`lines.${index}.quantity`, {
                              valueAsNumber: true,
                            })}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`line-${index}-unit`} className={labelClass}>Jednostka</Label>
                          <Input
                            id={`line-${index}-unit`}
                            placeholder="szt."
                            {...form.register(`lines.${index}.unit`)}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor={`line-${index}-unit-price`} className={labelClass}>Cena netto (zł)</Label>
                          <Input
                            id={`line-${index}-unit-price`}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            {...form.register(`lines.${index}.unitPriceNet`, {
                              valueAsNumber: true,
                            })}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`line-${index}-vat-rate`} className={labelClass}>
                            Stawka VAT
                          </Label>
                          <select
                            id={`line-${index}-vat-rate`}
                            className={vatSelectClass}
                            aria-invalid={bladStawki(index) ? true : undefined}
                            {...form.register(`lines.${index}.vatRate`)}
                          >
                            <option value="23">23%</option>
                            <option value="8">8%</option>
                            <option value="5">5%</option>
                            <option value="0">0%</option>
                            <option value="zw">zw — zwolniona</option>
                            <option value="oo">oo — odwrotne obciążenie</option>
                            <option value="np">np — nie podlega</option>
                            <option value="np_ii">np. II (usługa dla firmy z UE)</option>
                          </select>
                        </div>
                        {bladStawki(index) ? (
                          <p className={cn(errorTextClass, 'col-span-2 mt-0')}>
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            {bladStawki(index)}
                          </p>
                        ) : null}
                      </div>

                      <div className="border-border flex items-center justify-between border-t pt-3">
                        <span className="text-muted-foreground text-xs">Brutto</span>
                        <div className="text-right">
                          <p className="text-base font-semibold tabular-nums">
                            {formatPlMoney(calc.grossAmount)} zł
                          </p>
                          <p className="text-muted-foreground text-xs tabular-nums">
                            Netto: {formatPlMoney(calc.netAmount)} zł
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <Button type="button" variant="secondary" size="sm" onClick={() => append(newLine)}>
              <RiAddLine />
              Dodaj pozycję
            </Button>
          </DocumentSection>

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
          // Ta sama karta co `InvoiceCreateActions`, bez „Zapisz szkic” (C2).
          <Card data-testid="akcje-formularza" className="h-max shadow-none max-lg:hidden">
            <CardContent className="space-y-4">
              <Button type="button" className="w-full" disabled={busy} onClick={handleSend}>
                {isSending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiSendPlaneLine aria-hidden />}
                Wystaw i wyślij do KSeF
              </Button>
              <p className="text-muted-foreground text-xs">{RECURRING_NO_DRAFT_TEXT}</p>
            </CardContent>
          </Card>
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
      <div className="ff-sticky-actions pointer-events-none lg:hidden">
        {/* Na telefonie wysyłka jest szeroka i pierwsza (kciuk trafia w nią bez
            celowania), a „Zapisz” wąskie obok — układ z makiety. Od `sm`
            wracają dwa przyciski o naturalnej szerokości, dosunięte do prawej.
            Na telefonie „Zapisz” niesie tę samą akcję co „Szkic” w nagłówku;
            to nie jest dubel do usunięcia, tylko ten sam wybór w zasięgu kciuka
            i w zasięgu wzroku. */}
        {recurringMode ? (
          <p className="text-muted-foreground pointer-events-auto mx-auto mb-2 max-w-7xl text-xs sm:text-right">
            {RECURRING_NO_DRAFT_TEXT}
          </p>
        ) : null}
        <div className="pointer-events-auto mx-auto flex max-w-7xl gap-3 sm:justify-end">
          {recurringMode ? null : (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={handleSaveDraft}
              disabled={busy}
              className="order-2 flex-1 sm:order-1 sm:flex-none"
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <span className="sm:hidden">Zapisz</span>
              <span className="hidden sm:inline">Zapisz szkic</span>
            </Button>
          )}
          <Button
            type="button"
            size="lg"
            onClick={handleSend}
            disabled={busy}
            className="order-1 flex-[2] sm:order-2 sm:flex-none"
          >
            {isSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <span className="sm:hidden">Wyślij do KSeF</span>
            <span className="hidden sm:inline">Wystaw i wyślij do KSeF</span>
          </Button>
        </div>
      </div>
    </form>
  );
}

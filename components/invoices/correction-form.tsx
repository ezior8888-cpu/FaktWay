'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  Copy,
} from 'lucide-react';
import type { Resolver, UseFormReturn } from 'react-hook-form';
import {
  useFieldArray,
  useForm,
  useWatch,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  correctionInvoiceSchema,
  correctionNpIiBuyerError,
  type CorrectionInvoiceSchemaIn,
  type InvoiceLineSchema,
} from '@/lib/validators/invoice-validators';
import { calculateCorrectionTotals } from '@/lib/invoices/calculator';
import { zeroVatRateFromParentLines } from '@/lib/invoices/correction-amount-change';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import { dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import { EU_BUYER_COUNTRIES } from '@/lib/schemas/invoice-form';
import { calculateLineItem } from '@/lib/xml/invoice-calculator';
import { CORRECTION_TYPE_LABELS } from '@/types/invoice-types';
import type { CorrectionInvoiceData, ZeroVatAmountChangeRate } from '@/types/invoice-types';

import {
  getCorrectionParentContextAction,
  saveCorrectionDraftAction,
  saveAndSendCorrectionAction,
} from '@/components/invoices/correction-actions';

type CorrectionFormIn = z.input<typeof correctionInvoiceSchema>;
type CorrectionFormParsed = CorrectionInvoiceSchemaIn;

type ParentContextSuccess = Exclude<
  Awaited<ReturnType<typeof getCorrectionParentContextAction>>,
  { success: false }
>;

export interface CorrectionParentInvoiceRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  issue_date: string;
  gross_total: number | null;
  buyer_data: unknown;
}

type CorrectionFormBuyer = CorrectionFormIn['buyer'];

function buyerLabel(buyer: unknown): string {
  if (buyer && typeof buyer === 'object' && buyer !== null) {
    const name = (buyer as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return '—';
}

/** Nazwa kraju UE po kodzie ISO adresu (Grecja `GR`) — jak w formularzu zwykłej faktury. */
function euCountryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return EU_BUYER_COUNTRIES.find((k) => k.code === upper)?.name;
}

/** „VAT UE: DE123456789 · Niemcy” — kraj z adresu, a bez niego z prefiksu numeru. */
function vatUeLabel(vatUeNumber: string, countryCode?: string): string {
  const parsed = parseVatUe(vatUeNumber);
  const numer = parsed?.normalized ?? vatUeNumber.trim().toUpperCase();
  const kraj =
    euCountryName(countryCode) ??
    (parsed ? euCountryName(addressCountryForKodUE(parsed.kodUE)) : undefined);
  return kraj ? `VAT UE: ${numer} · ${kraj}` : `VAT UE: ${numer}`;
}

/**
 * Identyfikator nabywcy z `buyer_data` faktury pierwotnej (lista do wyboru):
 * NIP albo — dla firmy z UE (AUD-70) — numer VAT UE z krajem. Osoba prywatna
 * bez identyfikatora w etykiecie, jak dotąd.
 */
function buyerIdLabel(buyer: unknown): string | null {
  if (!buyer || typeof buyer !== 'object') return null;
  const rec = buyer as Record<string, unknown>;
  const nip = typeof rec.nip === 'string' ? rec.nip.trim() : '';
  if (nip) return `NIP: ${nip}`;
  const vatUe = typeof rec.vatUeNumber === 'string' ? rec.vatUeNumber.trim() : '';
  if (!vatUe) return null;
  const address = rec.address;
  const countryCode =
    address && typeof address === 'object'
      ? (address as Record<string, unknown>).countryCode
      : undefined;
  return vatUeLabel(vatUe, typeof countryCode === 'string' ? countryCode : undefined);
}

/** Nabywca na liście faktur do korekty: nazwa i pod nią NIP albo VAT UE. */
function ParentBuyerLabel({ buyer }: { buyer: unknown }) {
  const idLabel = buyerIdLabel(buyer);
  return (
    <>
      {buyerLabel(buyer)}
      {idLabel ?
        <span className="mt-0.5 block text-xs text-muted-foreground">{idLabel}</span>
      : null}
    </>
  );
}

/** Identyfikator nabywcy korekty (z faktury pierwotnej) do nagłówka formularza. */
function correctionBuyerIdLabel(buyer: CorrectionFormBuyer): string | null {
  switch (buyer.type) {
    case 'b2b':
      return `NIP: ${buyer.nip}`;
    case 'eu':
      return vatUeLabel(buyer.vatUeNumber, buyer.address.countryCode);
    case 'b2c':
      return null;
    default: {
      const nieznany: never = buyer;
      return nieznany;
    }
  }
}

/** Etykieta stawki np. II — ta sama co w formularzu zwykłej faktury. */
// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const CORRECTION_TYPE_ITEMS = (
  Object.entries(CORRECTION_TYPE_LABELS) as [CorrectionFormParsed['correctionType'], string][]
).map(([value, label]) => ({ value, label }))

const NP_II_OPTION_LABEL = 'np. II (usługa dla firmy z UE)';

/**
 * `null`, gdy pozycje korekty mogą mieć stawkę np. II (firma z innego kraju UE,
 * bez Irlandii Płn. — `isNpIiBuyerVat`); inaczej komunikat przy takiej pozycji.
 */
function npIiBlockMessage(buyer: CorrectionFormBuyer): string | null {
  // Ta sama reguła co w schemacie i generatorze KOR — zapytana o jedną pozycję np. II.
  return correctionNpIiBuyerError({ buyer, linesAfter: [{ vatRate: 'np_ii' }] });
}

/** Stawki bez VAT, które korekta kwotowa przejmuje z faktury pierwotnej — opis dla użytkownika. */
const ZERO_VAT_RATE_LABELS = {
  np: 'np (nie podlega)',
  np_ii: NP_II_OPTION_LABEL,
  oo: 'oo (odwrotne obciążenie)',
} satisfies Record<ZeroVatAmountChangeRate, string>;

/** Etykiety MF `TypKorekty` (1–3) — uproszczony opis dla użytkownika. */
const TYPOLOGY_KOREKTY_LABELS = {
  '1':
    '1 — Skutek w okresie pierwotnym (np. wyższa podstawa w dawnym okresie rozliczenia)',
  '2':
    '2 — Skutek w dacie tej korekty — najczęstszy (rabat, zwrot, korekta błędu kwot)',
  '3': '3 — Inna przyczyna (skonsultuj z księgowym lub doradcą podatkowym)',
} satisfies Record<'1' | '2' | '3', string>;

export interface CorrectionInvoiceFormProps {
  parentInvoices: CorrectionParentInvoiceRow[];
  preselectedParentId?: string;
  /** Firma, dla której wyrenderowano listę faktur pierwotnych — zapis odsyła ją jako `expectedTenantId` (UX-01). */
  tenantId: string;
}

// Daty w czasie polskim, nie UTC (F-013).
const TYPOLOGY_KOREKTY_ITEMS = (
  Object.entries(TYPOLOGY_KOREKTY_LABELS) as [CorrectionFormParsed['typKorekty'], string][]
).map(([value, label]) => ({ value, label }))

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const PAYMENT_METHOD_ITEMS = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'card', label: 'Karta' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'compensation', label: 'Kompensata' },
  { value: 'other', label: 'Inna' },
] as const

function defaultIssueDateIso(): string {
  return todayInWarsaw();
}

function defaultPaymentDueIso(): string {
  return dueDateFrom(todayInWarsaw(), 14);
}

function correctionDataFromForm(v: CorrectionFormParsed): CorrectionInvoiceData {
  const bankNorm = v.bankAccount?.trim() ?? '';
  return {
    invoiceType: 'correction',
    internalNumber: v.internalNumber,
    issueDate: v.issueDate,
    paymentMethod: v.paymentMethod,
    paymentDueDate: v.paymentDueDate,
    bankAccount: bankNorm === '' ? undefined : bankNorm,
    notes: v.notes,
    seller: v.seller,
    buyer: v.buyer,
    parentInvoiceId: v.parentInvoiceId,
    parentInvoiceNumber: v.parentInvoiceNumber,
    parentInvoiceIssueDate: v.parentInvoiceIssueDate,
    parentKsefNumber: v.parentKsefNumber,
    correctionType: v.correctionType,
    correctionReason: v.correctionReason,
    typKorekty: v.typKorekty,
    linesBefore: v.linesBefore,
    linesAfter: v.linesAfter,
    amountChange: v.amountChange,
  };
}

/** Pusta korekta kwotowa; stawka bez VAT wspólna dla pozycji faktury pierwotnej (jeśli jest). */
function emptyAmountChange(
  zeroVatRate: ZeroVatAmountChangeRate | undefined,
): NonNullable<CorrectionFormIn['amountChange']> {
  return {
    netDelta: 0,
    vatDelta: 0,
    grossDelta: 0,
    description: '',
    ...(zeroVatRate ? { vatRate: zeroVatRate } : {}),
  };
}

function buildDefaultCorrectionFormValues(
  parent: CorrectionParentInvoiceRow,
  ctx: ParentContextSuccess,
): CorrectionFormIn {
  return {
    invoiceType: 'correction',
    internalNumber: '',
    issueDate: defaultIssueDateIso(),
    paymentMethod: 'transfer',
    paymentDueDate: defaultPaymentDueIso(),
    bankAccount: '',
    notes: '',

    parentInvoiceId: parent.id,
    parentInvoiceNumber: parent.internal_number ?? '',
    parentInvoiceIssueDate: ctx.issueDate,
    parentKsefNumber: ctx.ksefNumber ?? undefined,

    correctionType: 'before_after',
    correctionReason: '',
    typKorekty: '2',

    seller: ctx.seller,
    buyer: ctx.buyer,

    linesBefore: ctx.linesBefore,
    linesAfter: structuredClone(ctx.linesAfter),

    // Stawka np / np. II / oo nie wynika z kwot (VAT 0 to także „0 KR”) —
    // korekta kwotowa bierze ją z pozycji faktury pierwotnej.
    amountChange: emptyAmountChange(zeroVatRateFromParentLines(ctx.linesBefore)),
  };
}

const labelClass =
  'text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block';

type InvoiceLineDraft = InvoiceLineSchema;

const defaultLineRow: InvoiceLineDraft = {
  name: 'Pozycja',
  unit: 'szt.',
  quantity: 1,
  unitPriceNet: 0,
  vatRate: '23',
};

export function CorrectionInvoiceForm({
  parentInvoices,
  preselectedParentId,
  tenantId,
}: CorrectionInvoiceFormProps) {
  const validPreselect = useMemo(() => {
    const id = preselectedParentId?.trim();
    if (!id) return undefined;
    return parentInvoices.some((r) => r.id === id) ? id : undefined;
  }, [parentInvoices, preselectedParentId]);

  const [step, setStep] = useState<'select-parent' | 'fill-correction'>(() =>
    validPreselect ? 'fill-correction' : 'select-parent',
  );
  const [selectedParent, setSelectedParent] =
    useState<CorrectionParentInvoiceRow | null>(() =>
      validPreselect
        ? parentInvoices.find((p) => p.id === validPreselect) ?? null
        : null,
    );

  const [contextLoading, setContextLoading] = useState(() => !!validPreselect);
  const [defaults, setDefaults] = useState<CorrectionFormIn | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  /** Gdy jest `parentId` w URL, zapobiega ponownemu otwieraniu formularza po cofnięciu do listy. */
  const userDismissedPrefillRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const loadParentContext = useCallback(
    async (parent: CorrectionParentInvoiceRow): Promise<boolean> => {
      const gen = ++loadGenerationRef.current;
      setContextLoading(true);
      setContextError(null);
      setDefaults(null);
      try {
        const res = await getCorrectionParentContextAction(parent.id);
        if (gen !== loadGenerationRef.current) return false;
        if (!res.success) {
          setContextError(res.error);
          toast.error(res.error);
          setStep('select-parent');
          setSelectedParent(null);
          return false;
        }

        const formDefaults = buildDefaultCorrectionFormValues(parent, res);
        setDefaults(formDefaults);
        setSelectedParent(parent);
        setStep('fill-correction');
        return true;
      } finally {
        if (gen === loadGenerationRef.current) setContextLoading(false);
      }
    },
    [],
  );

  const handleSelectParentRow = async (parent: CorrectionParentInvoiceRow) => {
    userDismissedPrefillRef.current = false;
    await loadParentContext(parent);
  };

  const handleBackToPick = () => {
    userDismissedPrefillRef.current = !!validPreselect;
    setStep('select-parent');
    setSelectedParent(null);
    setDefaults(null);
    setContextError(null);
  };

  useEffect(() => {
    userDismissedPrefillRef.current = false;
  }, [preselectedParentId]);

  // `loadParentContext` jest async i wewnętrznie wywołuje setState — React
  // Compiler flaguje to jako "setState within effect". Tu jest to świadomy
  // bridge URL-param → form-state (pre-select rodzica korekty), więc wzorzec
  // jest pożądany. Refaktor na `useSyncExternalStore` byłby przesadą dla
  // jednego pre-fillu; suppress z explicit komentarzem.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-fill bridge for ?parent=<id> URL param
  useEffect(() => {
    if (!validPreselect || userDismissedPrefillRef.current) return;
    const row = parentInvoices.find((p) => p.id === validPreselect);
    if (!row) return;
    void loadParentContext(row);
  }, [validPreselect, parentInvoices, loadParentContext]);

  if (step === 'select-parent' || !selectedParent || !defaults) {
    return (
      <div className="space-y-6">
        <Link
          href="/invoices/new"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Wybór typu faktury
        </Link>

        <div>
          <h1 className="font-display text-4xl font-semibold tracking-tighter-display">
            Faktura korygująca
          </h1>
          <p className="mt-2 text-muted-foreground">
            Wybierz fakturę pierwotną zaakceptowaną w KSeF (faktura zwykła, kierunek
            nadawczy)
          </p>
        </div>

        {(contextLoading && step === 'select-parent') || contextError ? (
          <div className="rounded-3xl border border-white/55 bg-white/45 p-8 text-center text-sm backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)]">
            {contextLoading && (
              <p className="inline-flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Ładowanie danych faktury pierwotnej…
              </p>
            )}
            {contextError && !contextLoading && (
              <p className="text-red-600 dark:text-red-400">{contextError}</p>
            )}
          </div>
        ) : null}

        {parentInvoices.length === 0 ? (
          <div className="rounded-3xl border border-white/55 bg-white/45 py-12 text-center shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)]">
            <p className="text-muted-foreground">
              Nie masz jeszcze żadnych zaakceptowanych faktur do korekty
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-white/55 bg-white/45 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)]">
            <table className="w-full text-sm">
              <thead className="border-b border-white/55 bg-foreground/[0.03] dark:border-white/14">
                <tr className="text-left">
                  <th className="px-6 py-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Numer
                  </th>
                  <th className="px-6 py-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Data
                  </th>
                  <th className="px-6 py-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Nabywca
                  </th>
                  <th className="px-6 py-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Brutto
                  </th>
                  <th className="px-6 py-4" />
                </tr>
              </thead>
              <tbody>
                {parentInvoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="cursor-pointer border-b border-white/55 transition-colors last:border-0 hover:bg-foreground/[0.02] dark:border-white/[0.07]"
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleSelectParentRow(inv)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void handleSelectParentRow(inv);
                      }
                    }}
                  >
                    <td className="px-6 py-4 font-mono text-sm">
                      {inv.internal_number ?? inv.id.slice(0, 8)}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">{inv.issue_date}</td>
                    <td className="px-6 py-4">
                      <ParentBuyerLabel buyer={inv.buyer_data} />
                    </td>
                    <td className="px-6 py-4 text-right font-medium tabular-nums">
                      {inv.gross_total != null ?
                        `${Number(inv.gross_total).toFixed(2)} PLN`
                      : '—'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button
                        type="button"
                        variant="glass"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleSelectParentRow(inv);
                        }}
                      >
                        Wybierz
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <CorrectionFillForm
      key={selectedParent.id}
      parentRow={selectedParent}
      defaults={defaults}
      onPickOther={handleBackToPick}
      tenantId={tenantId}
    />
  );
}

function CorrectionTotalsPreview({
  form,
}: {
  form: UseFormReturn<CorrectionFormIn, unknown, CorrectionFormParsed>;
}) {
  const values = useWatch({ control: form.control }) as CorrectionFormIn | undefined;

  const totals = useMemo(() => {
    if (!values) return null;
    const parsed = correctionInvoiceSchema.safeParse(values);
    if (!parsed.success) return null;
    try {
      return calculateCorrectionTotals(correctionDataFromForm(parsed.data));
    } catch {
      return null;
    }
  }, [values]);

  if (!totals) return null;

  return (
    <section className="rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
      <h2 className="font-display text-lg font-semibold tracking-tighter-text">
        Podsumowanie skutku korekty (symulacja FA)
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Rzeczywiste kwoty w KSeF wynikają z przyjętej struktury pozycji i zaokrągleń VAT.
      </p>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: 'Netto Δ', val: totals.netDelta },
          { label: 'VAT Δ', val: totals.vatDelta },
          { label: 'Brutto Δ', val: totals.grossDelta },
        ].map(({ label, val }) => (
          <div key={label} className="rounded-xl border border-white/45 bg-white/40 p-4 dark:border-white/10 dark:bg-white/5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd
              className={`mt-1 text-lg font-semibold tabular-nums ${val < -1e-9 ? 'text-red-600 dark:text-red-400' : ''}`}
            >
              {val.toFixed(2)} PLN
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface CorrectionFillFormProps {
  parentRow: CorrectionParentInvoiceRow;
  defaults: CorrectionFormIn;
  onPickOther: () => void;
  tenantId: string;
}

function CorrectionFillForm({ parentRow, defaults, onPickOther, tenantId }: CorrectionFillFormProps) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const [isSending, startSending] = useTransition();

  const form = useForm<CorrectionFormIn, unknown, CorrectionFormParsed>({
    resolver: zodResolver(correctionInvoiceSchema) as Resolver<
      CorrectionFormIn,
      unknown,
      CorrectionFormParsed
    >,
    defaultValues: defaults,
  });

  const correctionType = useWatch({ control: form.control, name: 'correctionType' });
  const typKorekty = useWatch({ control: form.control, name: 'typKorekty' }) ?? '2';

  // Nabywca i pozycje „Było” przychodzą z faktury pierwotnej (formularz nabywcy
  // nie zmienia) — z nich wynika dostępność np. II i stawka korekty kwotowej.
  const buyer = defaults.buyer;
  const buyerIdText = correctionBuyerIdLabel(buyer);
  const npIiBlock = npIiBlockMessage(buyer);
  const parentZeroVatRate = useMemo(
    () => zeroVatRateFromParentLines(defaults.linesBefore ?? []),
    [defaults.linesBefore],
  );

  const handleCorrectionTypeChange = (value: CorrectionFormParsed['correctionType']) => {
    form.setValue('correctionType', value);
    const current = form.getValues('amountChange');
    if (value === 'amount_change' && !current) {
      form.setValue('amountChange', emptyAmountChange(parentZeroVatRate));
    }
  };

  const handleSaveDraft = () => {
    startSaving(async () => {
      await form.trigger();
      const raw = form.getValues();
      const parsed = correctionInvoiceSchema.safeParse(raw);
      if (!parsed.success) {
        toast.error(
          parsed.error.issues.map((i) => i.message).join(' · ') || 'Walidacja nie powiodła się.',
        );
        return;
      }
      const result = await saveCorrectionDraftAction(parsed.data, tenantId);
      if (result.success) {
        toast.success('Zapisano szkic');
        router.push(`/invoices/${result.invoiceId}`);
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleSend = () => {
    form.handleSubmit(
      async (data) => {
        startSending(async () => {
          const result = await saveAndSendCorrectionAction(data, tenantId);
          if (result.success) {
            toast.success('Korekta wysłana do kolejki KSeF');
            router.push(`/invoices/${result.invoiceId}`);
          } else {
            toast.error(result.error);
          }
        });
      },
      () => toast.error('Popraw błędy w formularzu'),
    )();
  };

  const busy = isSaving || isSending;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-8 pb-32">
      <button
        type="button"
        onClick={onPickOther}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Wybierz inną fakturę
      </button>

      <div>
        <h1 className="font-display text-4xl font-semibold tracking-tighter-display">
          Korekta faktury{' '}
          {parentRow.internal_number ?? parentRow.id.slice(0, 8)}
        </h1>
        <p className="mt-2 text-muted-foreground">
          Korekta wystawiana do pierwotnej z dnia{' '}
          <span className="font-medium text-foreground">{parentRow.issue_date}</span>
          {parentRow.ksef_number ?
            <>
              {' '}
              <span className="text-muted-foreground">· KSeF</span>{' '}
              <span className="font-mono text-sm">{parentRow.ksef_number}</span>
            </>
          : null}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Nabywca:{' '}
          <span className="font-medium text-foreground">{buyer.name}</span>
          {buyerIdText ?
            <>
              {' · '}
              <span className="tabular-nums">{buyerIdText}</span>
            </>
          : null}
        </p>
      </div>

      {/* Dane korekty */}
      <section className="space-y-5 rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
        <h2 className="font-display text-lg font-semibold tracking-tighter-text">
          Dane korekty
        </h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label className={labelClass}>Numer korekty</Label>
            <Input placeholder="KOR/2026/04/001" {...form.register('internalNumber')} />
            {form.formState.errors.internalNumber && (
              <p className="mt-1 text-xs text-red-600">
                {form.formState.errors.internalNumber.message}
              </p>
            )}
          </div>
          <div>
            <Label className={labelClass}>Data korekty</Label>
            <Input type="date" {...form.register('issueDate')} />
          </div>
        </div>

        <div>
          <Label className={labelClass}>Typ korekty</Label>
          <Select
            value={correctionType}
            items={CORRECTION_TYPE_ITEMS}
            onValueChange={(v) => {
              if (v == null) return
              handleCorrectionTypeChange(v as CorrectionFormParsed['correctionType'])
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Typ" />
            </SelectTrigger>
            <SelectContent>
              {CORRECTION_TYPE_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.formState.errors.correctionType && (
            <p className="mt-1 text-xs text-red-600">
              {form.formState.errors.correctionType.message}
            </p>
          )}
        </div>

        <div>
          <Label className={labelClass}>Typ KSeF (skutek w czasie)</Label>
          <Select
            value={typKorekty}
            items={TYPOLOGY_KOREKTY_ITEMS}
            onValueChange={(v) => {
              if (v == null) return
              form.setValue(
                'typKorekty',
                v as CorrectionFormParsed['typKorekty'],
                { shouldDirty: true },
              )
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Typ" />
            </SelectTrigger>
            <SelectContent>
              {TYPOLOGY_KOREKTY_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.formState.errors.typKorekty ? (
            <p className="mt-1 text-xs text-red-600">
              {form.formState.errors.typKorekty.message}
            </p>
          ) : null}
        </div>

        <div>
          <Label className={labelClass}>Przyczyna korekty (obowiązkowe)</Label>
          <Textarea
            rows={2}
            placeholder="Np. błąd w nazwie nabywcy, zwrot towaru, rabat post-fakturowy…"
            {...form.register('correctionReason')}
          />
          {form.formState.errors.correctionReason && (
            <p className="mt-1 flex items-center gap-1 text-xs text-red-600">
              <AlertCircle className="h-3 w-3" />
              {form.formState.errors.correctionReason.message}
            </p>
          )}
        </div>
      </section>

      {correctionType === 'before_after' ?
        <BeforeAfterSection form={form} npIiBlock={npIiBlock} />
      : null}
      {correctionType === 'amount_change' ?
        <AmountChangeSection form={form} zeroVatRate={parentZeroVatRate} />
      : null}
      {correctionType === 'cancellation' ?
        <CancellationConfirmation parentInvoice={parentRow} form={form} />
      : null}

      {/* Płatność */}
      <section className="space-y-5 rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
        <h2 className="font-display text-lg font-semibold tracking-tighter-text">
          Płatność
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label className={labelClass}>Metoda płatności</Label>
            <Select
              value={form.watch('paymentMethod')}
              items={PAYMENT_METHOD_ITEMS}
              onValueChange={(v) => {
                if (v == null) return
                form.setValue(
                  'paymentMethod',
                  v as CorrectionFormParsed['paymentMethod'],
                  { shouldDirty: true },
                )
              }}
            >
              <SelectTrigger>
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
            <Label className={labelClass}>Termin płatności</Label>
            <Input type="date" {...form.register('paymentDueDate')} />
            {form.formState.errors.paymentDueDate && (
              <p className="mt-1 text-xs text-red-600">
                {form.formState.errors.paymentDueDate.message}
              </p>
            )}
          </div>
          <div className="sm:col-span-2">
            <Label className={labelClass}>Numer rachunku (dla przelewu, 26 cyfr)</Label>
            <Input
              {...form.register('bankAccount')}
              placeholder="Opcjonalnie — tylko cyfry bez spacji"
            />
            {form.formState.errors.bankAccount && (
              <p className="mt-1 text-xs text-red-600">
                {String(form.formState.errors.bankAccount.message)}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Uwagi */}
      <section className="rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
        <Label className={labelClass}>Uwagi</Label>
        <Textarea rows={3} {...form.register('notes')} />
      </section>

      <CorrectionTotalsPreview form={form} />

      {typeof form.formState.errors.root?.message === 'string' && (
        <p className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-700 dark:border-red-500/30 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{form.formState.errors.root.message}</span>
        </p>
      )}

      <div className="ff-sticky-actions pointer-events-none">
        <div className="mx-auto flex max-w-7xl justify-end gap-3 pointer-events-auto">
          <Button type="button" variant="glass" size="lg" onClick={handleSaveDraft} disabled={busy}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Zapisz szkic
          </Button>
          <Button
            type="button"
            variant="glass-primary"
            size="lg"
            onClick={handleSend}
            disabled={busy}
          >
            {isSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Wystaw korektę i wyślij do KSeF
          </Button>
        </div>
      </div>
    </form>
  );
}

function linesTableClasses() {
  return {
    thead:
      'border-b border-white/55 text-left text-muted-foreground dark:border-white/[0.07]',
    th: 'py-3 text-xs font-medium uppercase tracking-wider',
    tdRow:
      'border-b border-white/55 last:border-0 dark:border-white/[0.07]',
  };
}

function CorrectionLinesTable(props: {
  title: string;
  subtitle?: string;
  form: UseFormReturn<CorrectionFormIn, unknown, CorrectionFormParsed>;
  name: 'linesBefore' | 'linesAfter';
  /** `null` — np. II dozwolona; inaczej komunikat dla pozycji z np. II. */
  npIiBlock: string | null;
}) {
  const { title, subtitle, form, name, npIiBlock } = props;
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name,
    shouldUnregister: false,
  });
  const watched = useWatch({ control: form.control, name });
  const c = linesTableClasses();
  const lineErrors =
    name === 'linesBefore' ? form.formState.errors.linesBefore : form.formState.errors.linesAfter;

  /**
   * Błąd stawki pozycji: ze schematu, a bez niego — np. II u nabywcy, który jej
   * nie dopuszcza. Takiej stawki nie zmieniamy po cichu: zostaje z komunikatem.
   */
  const rateError = (index: number): string | undefined =>
    lineErrors?.[index]?.vatRate?.message ??
    (watched?.[index]?.vatRate === 'np_ii' && npIiBlock ? npIiBlock : undefined);
  const rateErrors = fields
    .map((_, index) => ({ index, message: rateError(index) }))
    .filter((e): e is { index: number; message: string } => !!e.message);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-medium tracking-tight">{title}</h3>
          {subtitle ?
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          : null}
        </div>
        <Button type="button" variant="glass" size="sm" onClick={() => append(defaultLineRow)}>
          <Plus className="mr-2 h-4 w-4" />
          Dodaj pozycję
        </Button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/45 dark:border-white/10">
        <table className="w-full text-sm">
          <thead className={c.thead}>
            <tr className="">
              {['#', 'Nazwa', 'J.m.', 'Ilość', 'Cena netto', 'VAT', 'Netto', 'Brutto', ''].map(
                (h) => (
                  <th key={`${title}-${h}`} className={c.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => {
              const wl = watched?.[index];
              const calc = calculateLineItem({
                quantity: Number(wl?.quantity) || 0,
                unitPriceNet: Number(wl?.unitPriceNet) || 0,
                vatRate: wl?.vatRate ?? '23',
              });
              return (
                <tr key={field.id} className={c.tdRow}>
                  <td className="py-3 text-muted-foreground">{index + 1}</td>
                  <td className="py-3 pr-2">
                    <Input className="h-9 min-w-[8rem]" {...form.register(`${name}.${index}.name`)} />
                  </td>
                  <td className="py-3 pr-2">
                    <Input className="h-9 w-20" {...form.register(`${name}.${index}.unit`)} />
                  </td>
                  <td className="py-3 pr-2">
                    <Input
                      type="number"
                      step="0.0001"
                      className="h-9 w-24 tabular-nums"
                      {...form.register(`${name}.${index}.quantity`, { valueAsNumber: true })}
                    />
                  </td>
                  <td className="py-3 pr-2">
                    <Input
                      type="number"
                      step="0.01"
                      className="h-9 w-28 tabular-nums"
                      {...form.register(`${name}.${index}.unitPriceNet`, { valueAsNumber: true })}
                    />
                  </td>
                  <td className="py-3 pr-2">
                    <select
                      className="h-9 w-full rounded-xl border border-white/55 bg-white/50 px-2 text-sm backdrop-blur-[12px] transition-colors focus:outline-none focus:ring-2 focus:ring-foreground/20 aria-invalid:border-red-500/60 dark:border-white/14 dark:bg-white/[0.05]"
                      aria-label={`Stawka VAT pozycji ${index + 1} (${title})`}
                      aria-invalid={rateError(index) ? true : undefined}
                      title={rateError(index)}
                      {...form.register(`${name}.${index}.vatRate`)}
                    >
                      <option value="23">23%</option>
                      <option value="8">8%</option>
                      <option value="5">5%</option>
                      <option value="0">0%</option>
                      <option value="oo">oo</option>
                      <option value="np">np</option>
                      {npIiBlock === null || wl?.vatRate === 'np_ii' ?
                        <option value="np_ii">{NP_II_OPTION_LABEL}</option>
                      : null}
                    </select>
                  </td>
                  <td className="py-3 pr-2 text-right tabular-nums">
                    {calc.netAmount.toFixed(2)}
                  </td>
                  <td className="py-3 pr-2 text-right font-medium tabular-nums">
                    {calc.grossAmount.toFixed(2)}
                  </td>
                  <td className="py-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={fields.length === 1}
                      className="h-9 w-9 rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rateErrors.length ?
        <ul className="space-y-1">
          {rateErrors.map(({ index, message }) => (
            <li key={`${name}-rate-${index}`} className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Pozycja {index + 1}: {message}
              </span>
            </li>
          ))}
        </ul>
      : null}

      {(name === 'linesBefore' && form.formState.errors.linesBefore) ||
      (name === 'linesAfter' && form.formState.errors.linesAfter) ?
        <p className="text-xs text-red-600">
          {String(
            (name === 'linesBefore' ? form.formState.errors.linesBefore : form.formState.errors.linesAfter)?.message ??
              'Sprawdź pozycje',
          )}
        </p>
      : null}
    </div>
  );
}

function BeforeAfterSection({
  form,
  npIiBlock,
}: {
  form: UseFormReturn<CorrectionFormIn, unknown, CorrectionFormParsed>;
  npIiBlock: string | null;
}) {
  const copyLines = () => {
    const lines = structuredClone(form.getValues('linesBefore') ?? []);
    form.setValue('linesAfter', lines, { shouldValidate: true, shouldDirty: true });
    toast.success('Skopiowano „Było” → „Jest”');
  };

  return (
    <section className="space-y-8 rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="font-display text-lg font-semibold tracking-tighter-text">
            Korekta: Było → Jest
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            „Było” to stan z faktury pierwotnej (domyślnie załadowany). „Jest” docelowy po
            korekcie.
          </p>
        </div>
        <Button type="button" variant="glass" size="sm" onClick={copyLines}>
          <Copy className="mr-2 h-4 w-4" />
          Skopiuj „Było” do „Jest”
        </Button>
      </div>

      <CorrectionLinesTable
        form={form}
        name="linesBefore"
        title="Było"
        subtitle="Stan pierwotny"
        npIiBlock={npIiBlock}
      />

      <CorrectionLinesTable
        form={form}
        name="linesAfter"
        title="Jest"
        subtitle="Stan po korekcie"
        npIiBlock={npIiBlock}
      />
    </section>
  );
}

function AmountChangeSection({
  form,
  zeroVatRate,
}: {
  form: UseFormReturn<CorrectionFormIn, unknown, CorrectionFormParsed>;
  /** Wspólna stawka bez VAT pozycji faktury pierwotnej — wtedy VAT 0 i brutto = netto. */
  zeroVatRate: ZeroVatAmountChangeRate | undefined;
}) {
  const netDelta = useWatch({ control: form.control, name: 'amountChange.netDelta' });
  const hintId = 'amount-change-rate-hint';

  // Stawka bez VAT: zmiana VAT zawsze 0, a brutto idzie za netto (pola tylko do odczytu).
  const syncZeroVat = () => {
    form.setValue('amountChange.vatDelta', 0);
    form.setValue('amountChange.grossDelta', form.getValues('amountChange.netDelta'));
  };

  return (
    <section className="space-y-5 rounded-3xl border border-white/55 bg-white/45 p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl dark:border-white/14 dark:bg-[rgba(15,10,30,0.45)] lg:p-8">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tighter-text">
          Korekta kwotowa
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Zwrot, rabat lub inna zmiana sumarycznego skutku (np. uproszczony wiersz korekty).
        </p>
        {zeroVatRate ?
          <p id={hintId} className="mt-3 rounded-xl border border-white/45 bg-white/40 p-3 text-sm dark:border-white/10 dark:bg-white/5">
            Stawka z faktury pierwotnej: {ZERO_VAT_RATE_LABELS[zeroVatRate]} — bez VAT. Zmiana VAT
            wynosi 0, a brutto jest równe netto.
          </p>
        : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="amount-change-net" className={labelClass}>Zmiana netto (±)</Label>
          <Input
            id="amount-change-net"
            type="number"
            step="0.01"
            {...form.register('amountChange.netDelta', {
              valueAsNumber: true,
              onChange: zeroVatRate ? syncZeroVat : undefined,
            })}
          />
        </div>
        <div>
          <Label htmlFor="amount-change-vat" className={labelClass}>Zmiana VAT (±)</Label>
          {zeroVatRate ?
            <Input
              id="amount-change-vat"
              type="number"
              value={0}
              readOnly
              disabled
              aria-describedby={hintId}
            />
          : <Input
              id="amount-change-vat"
              type="number"
              step="0.01"
              {...form.register('amountChange.vatDelta', { valueAsNumber: true })}
            />
          }
        </div>
        <div>
          <Label htmlFor="amount-change-gross" className={labelClass}>Zmiana brutto (±)</Label>
          {zeroVatRate ?
            <Input
              id="amount-change-gross"
              type="number"
              value={Number.isFinite(netDelta) ? netDelta : ''}
              readOnly
              aria-describedby={hintId}
            />
          : <Input
              id="amount-change-gross"
              type="number"
              step="0.01"
              {...form.register('amountChange.grossDelta', { valueAsNumber: true })}
            />
          }
        </div>
      </div>

      <div>
        <Label htmlFor="amount-change-description" className={labelClass}>Opis pozycji korekty</Label>
        <Input id="amount-change-description" {...form.register('amountChange.description')} />
        {form.formState.errors.amountChange?.description ? (
          <p className="mt-1 text-xs text-red-600">
            {form.formState.errors.amountChange.description.message}
          </p>
        ) : null}
      </div>
      {form.formState.errors.amountChange?.message ? (
        <p className="text-xs text-red-600">{form.formState.errors.amountChange.message}</p>
      ) : null}
    </section>
  );
}

function CancellationConfirmation({
  parentInvoice,
  form,
}: {
  parentInvoice: CorrectionParentInvoiceRow;
  form: UseFormReturn<CorrectionFormIn, unknown, CorrectionFormParsed>;
}) {
  const linesBeforeWatch = useWatch({ control: form.control, name: 'linesBefore' });
  let previewTotal = Number(parentInvoice.gross_total) || 0;
  if (linesBeforeWatch?.length) {
    const parsed = correctionInvoiceSchema.safeParse(form.getValues());
    if (parsed.success) {
      try {
        previewTotal = calculateCorrectionTotals(correctionDataFromForm(parsed.data)).grossBefore;
      } catch {
        /* noop */
      }
    }
  }

  return (
    <section className="rounded-3xl border border-red-500/25 bg-red-500/[0.07] p-7 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl lg:p-8">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-600 dark:text-red-400" />
        <div className="flex-1">
          <h3 className="mb-2 font-display font-semibold tracking-tighter-text">
            Anulowanie skutku faktury
          </h3>
          <p className="text-sm leading-relaxed">
            Wybierzesz{' '}
            <strong>korektę</strong>{' '}
            z negacją wartości na podstawie pozycji pierwotnych (wartość referencyjna brutto{' '}
            <strong>{previewTotal.toFixed(2)} PLN</strong>).
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Po akceptacji w KSeF skutek faktury {parentInvoice.internal_number ?? 'pierwotnej'} jest
            rozliczany jako odwrócony — upewnij się, że jest to zamierzone.
          </p>
        </div>
      </div>
    </section>
  );
}

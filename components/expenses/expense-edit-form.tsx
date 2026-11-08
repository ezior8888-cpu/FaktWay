'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  RiArrowLeftLine,
  RiDeleteBinLine,
  RiLoader4Line,
  RiSave3Line,
  RiSparkling2Line,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  deleteExpenseAction,
  reviewExpenseAction,
} from '@/app/actions/expenses';
import {
  documentLabel,
  kpirShortLabel,
  NO_CATEGORY,
  plDate,
  REVIEW_LABELS,
  REVIEW_STYLES,
  sourceLabel,
  sourceStyle,
} from '@/components/expenses/finora/labels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';
import type { ExpenseRow } from '@/components/expenses/expenses-list';
import type { Database } from '@/types/database';

type KpirColumn = Database['public']['Enums']['kpir_column'];

const KPIR_OPTIONS: { value: KpirColumn; label: string }[] = [
  { value: 'col_7', label: 'Kol. 7' },
  { value: 'col_8', label: 'Kol. 8' },
  { value: 'col_10', label: 'Kol. 10 — Towary handlowe i materiały' },
  { value: 'col_11', label: 'Kol. 11 — Koszty uboczne zakupu' },
  { value: 'col_12', label: 'Kol. 12 — Wynagrodzenia' },
  { value: 'col_13', label: 'Kol. 13 — Pozostałe wydatki' },
  { value: 'col_15', label: 'Kol. 15 — Koszty B+R' },
  { value: 'col_16', label: 'Kol. 16' },
];

const KPIR_VALUE_SET = new Set<string>(KPIR_OPTIONS.map((o) => o.value));

const COMMON_CATEGORIES = [
  'Paliwo',
  'Telekomunikacja',
  'Oprogramowanie',
  'Marketing',
  'Materiały biurowe',
  'Reprezentacja',
  'Podróże służbowe',
  'Usługi obce',
  'Energia',
  'Czynsz',
  'Pozostałe wydatki',
];

function normalizeKpirColumn(raw: string | null): KpirColumn {
  if (raw && KPIR_VALUE_SET.has(raw)) return raw as KpirColumn;
  return 'col_13';
}

interface ExpenseEditFormProps {
  expense: ExpenseRow;
  photoUrl: string | null;
  ksefCurrency: string | null;
}

interface FormState {
  seller_name: string;
  seller_nip: string;
  document_number: string;
  issue_date: string;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  kpir_column: KpirColumn;
  category_label: string;
  is_deductible: boolean;
  notes: string;
}

function buildInitialForm(expense: ExpenseRow): FormState {
  return {
    seller_name: expense.seller_name,
    seller_nip: expense.seller_nip?.replace(/\D/g, '') ?? '',
    document_number: expense.document_number ?? '',
    issue_date: expense.issue_date,
    net_amount: Number(expense.net_amount),
    vat_amount: Number(expense.vat_amount),
    gross_amount: Number(expense.gross_amount),
    kpir_column: normalizeKpirColumn(expense.kpir_column),
    category_label: expense.category_label ?? 'Pozostałe wydatki',
    is_deductible: expense.is_deductible,
    notes: expense.notes ?? '',
  };
}

export function ExpenseEditForm({ expense, photoUrl, ksefCurrency }: ExpenseEditFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => buildInitialForm(expense));
  const [confirmedForeignCurrency, setConfirmedForeignCurrency] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  const currency = ksefCurrency?.trim().toUpperCase();
  const ksefCurrencyUnknown = expense.source === 'ksef_inbox' && (!currency || !/^[A-Z]{3}$/.test(currency));
  const foreignKsef = expense.source === 'ksef_inbox' && !ksefCurrencyUnknown && currency !== 'PLN';
  const hasKsefRate = foreignKsef && hasKsefCurrencyRate(
    expense.ocr_extracted_data,
    currency ?? '',
    form.issue_date,
  );
  // Jednostka kwoty w karcie szczegółów: bez potwierdzonego kursu w kolumnie
  // zostaje kwota w walucie faktury KSeF (runner kategoryzacji), więc „zł”
  // tylko dla PLN albo po przeliczeniu kursem.
  const grossUnit = ksefCurrencyUnknown
    ? '(waluta do wyjaśnienia)'
    : foreignKsef && !hasKsefRate
      ? currency
      : 'zł';

  const confidence = Number(expense.categorization_confidence ?? 0);
  const method = expense.categorization_method;
  const wasAutoClassified =
    method != null &&
    ['rule_nip', 'rule_keyword', 'ml_heuristic', 'ai_claude'].includes(method);

  const handleSave = () => {
    startSave(async () => {
      const result = await reviewExpenseAction(expense.id, {
        seller_name: form.seller_name,
        seller_nip: form.seller_nip === '' ? null : form.seller_nip,
        document_number: form.document_number.trim() || undefined,
        issue_date: form.issue_date,
        net_amount: form.net_amount,
        vat_amount: form.vat_amount,
        gross_amount: form.gross_amount,
        kpir_column: form.kpir_column,
        category_label: form.category_label,
        is_deductible: form.is_deductible,
        confirmForeignCurrencyReview: foreignKsef && confirmedForeignCurrency,
        notes: form.notes.trim() ? form.notes.trim() : undefined,
      });

      if (result.success) {
        toast.success('Zapisano wydatek');
        router.push('/expenses');
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleDelete = () => {
    if (!window.confirm('Usunąć ten wydatek?')) return;
    startDelete(async () => {
      const result = await deleteExpenseAction(expense.id);
      if (result.success) {
        toast.success('Usunięto');
        router.push('/expenses');
      } else {
        toast.error(result.error);
      }
    });
  };

  const reviewStatus = expense.is_reviewed ? 'reviewed' : 'unreviewed';
  const deductibleToggleDisabled =
    (foreignKsef && !hasKsefRate && !form.is_deductible) || (ksefCurrencyUnknown && !form.is_deductible);

  // Oprawa: karta szczegółów jak Finora `transaction-detail-sheet.tsx`
  // (kwota + status, sprzedawca z awatarem, wiersze etykieta → wartość),
  // pod nią karty formularza. Logika zapisu, usuwania, waluty KSeF i zdjęcia
  // bez zmian (plan Finora §2.2, E6).
  return (
    <div className="space-y-6 pb-32">
      <Link
        href="/expenses"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <RiArrowLeftLine className="size-3.5" />
        Wydatki
      </Link>

      <div>
        <h1 className="text-2xl font-semibold">
          {!expense.is_reviewed ? 'Zaakceptuj wydatek' : 'Edytuj wydatek'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {!expense.is_reviewed
            ? 'Sprawdź dane rozpoznane automatycznie i zatwierdź'
            : 'Wprowadź zmiany w wydatku'}
        </p>
      </div>

      {ksefCurrencyUnknown ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Nie można potwierdzić waluty faktury KSeF. Sprawdź dane źródłowe.
            Jeśli ten koszt jest już w KPiR, możesz go wyłączyć i zostawić do ręcznego wyjaśnienia.
          </AlertDescription>
        </Alert>
      ) : null}

      {foreignKsef ? (
        <Alert role="alert" className="border-amber-600/30">
          <AlertTitle>Faktura w {currency} wymaga ręcznego uzgodnienia.</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Kwoty na ekranie mogą nie sumować się do brutto: KSeF podaje VAT już w PLN,
              a netto i brutto w walucie faktury. Porównaj oryginalny XML, kurs NBP i kwoty PLN
              przed włączeniem wydatku do KPiR.
            </p>
            {!hasKsefRate ? (
              <p className="text-foreground font-medium">
                Brak potwierdzonego kursu przy tym koszcie. Kwoty netto i brutto mogą nadal być w {currency};
                nie można włączyć ich do KPiR. Możesz zapisać wydatek poza KPiR, aby pozostał do sprawdzenia.
              </p>
            ) : (
              <label className="text-foreground flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={confirmedForeignCurrency}
                  onCheckedChange={(checked) => setConfirmedForeignCurrency(checked === true)}
                  className="mt-0.5"
                />
                <span>Sprawdziłem XML, kurs i kwoty PLN; świadomie zatwierdzam ten wydatek.</span>
              </label>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {wasAutoClassified ? (
        <Alert
          className={cn(
            confidence >= 0.9
              ? 'border-green-600/30'
              : confidence >= 0.7
                ? 'border-primary/30'
                : 'border-amber-600/30',
          )}
        >
          <RiSparkling2Line
            className={cn(
              confidence >= 0.9
                ? 'text-green-700 dark:text-green-400'
                : confidence >= 0.7
                  ? 'text-primary'
                  : 'text-amber-700 dark:text-amber-400',
            )}
          />
          <AlertTitle>Auto-kategoryzacja</AlertTitle>
          <AlertDescription>
            <p>
              Wykryto: <strong className="text-foreground">{expense.category_label ?? '—'}</strong> ·{' '}
              <strong className="text-foreground">
                {KPIR_OPTIONS.find((o) => o.value === expense.kpir_column)
                  ?.label ?? '—'}
              </strong>
            </p>
            <p>
              Pewność: {Math.round(confidence * 100)}% (metoda:{' '}
              {expense.categorization_method ?? '—'})
            </p>
            {confidence < 0.7 ? (
              <p className="text-foreground">
                Uwaga: niska pewność — sprawdź szczególnie kategorię.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {photoUrl ? (
          <Card className="order-2 lg:order-1">
            <CardHeader>
              <CardTitle>Zdjęcie paragonu</CardTitle>
            </CardHeader>
            <CardContent>
              {/* eslint-disable-next-line @next/next/no-img-element -- podpisany URL R2, krótki TTL */}
              <img src={photoUrl} alt="Paragon" className="w-full border" />
            </CardContent>
          </Card>
        ) : null}

        <div
          className={`space-y-6 ${photoUrl ? 'order-1 lg:order-2' : 'lg:col-span-2'}`}
        >
          <Card>
            <CardHeader>
              <CardTitle>Szczegóły wydatku</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xl font-semibold tabular-nums wrap-break-word">
                  {formatPlMoney(Number(expense.gross_amount))} {grossUnit}
                </span>
                <Badge className={REVIEW_STYLES[reviewStatus]}>{REVIEW_LABELS[reviewStatus]}</Badge>
              </div>

              <Separator />

              <div className="flex items-center gap-2">
                <Avatar>
                  <AvatarFallback>{companyInitials(expense.seller_name)}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium" title={expense.seller_name}>
                    {shortenLegalForm(expense.seller_name)}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {expense.category_label?.trim() || NO_CATEGORY}
                  </span>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <DetailRow label="Źródło">
                  <Badge className={sourceStyle(expense.source)}>{sourceLabel(expense.source)}</Badge>
                </DetailRow>
                <DetailRow label="Kolumna KPiR">{kpirShortLabel(expense.kpir_column)}</DetailRow>
                <DetailRow label="Dokument">
                  {documentLabel(expense.document_type)}
                  {expense.document_number ? ` · ${expense.document_number}` : ''}
                </DetailRow>
                <DetailRow label="Data wystawienia">{plDate(expense.issue_date)}</DetailRow>
                <DetailRow label="NIP sprzedawcy">
                  <span className="font-mono">{expense.seller_nip ?? '—'}</span>
                </DetailRow>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sprzedawca</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Nazwa" htmlFor="expense-seller-name">
                <Input
                  id="expense-seller-name"
                  value={form.seller_name}
                  onChange={(e) =>
                    setForm({ ...form, seller_name: e.target.value })
                  }
                />
              </Field>
              <Field label="NIP (opcjonalnie)" htmlFor="expense-seller-nip">
                <Input
                  id="expense-seller-nip"
                  value={form.seller_nip}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      seller_nip: e.target.value.replace(/\D/g, '').slice(0, 10),
                    })
                  }
                  inputMode="numeric"
                  maxLength={10}
                  className="font-mono"
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dokument</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Numer" htmlFor="expense-document-number">
                <Input
                  id="expense-document-number"
                  value={form.document_number}
                  onChange={(e) =>
                    setForm({ ...form, document_number: e.target.value })
                  }
                />
              </Field>
              <Field label="Data wystawienia" htmlFor="expense-issue-date">
                <Input
                  id="expense-issue-date"
                  type="date"
                  value={form.issue_date}
                  onChange={(e) =>
                    setForm({ ...form, issue_date: e.target.value })
                  }
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Kwoty</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Netto" htmlFor="expense-net">
                <Input
                  id="expense-net"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={form.net_amount}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      net_amount: Number(e.target.value),
                    })
                  }
                  className="text-right tabular-nums"
                />
              </Field>
              <Field label="VAT" htmlFor="expense-vat">
                <Input
                  id="expense-vat"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={form.vat_amount}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      vat_amount: Number(e.target.value),
                    })
                  }
                  className="text-right tabular-nums"
                />
              </Field>
              <Field label="Brutto" htmlFor="expense-gross">
                <Input
                  id="expense-gross"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={form.gross_amount}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      gross_amount: Number(e.target.value),
                    })
                  }
                  className="text-right font-medium tabular-nums"
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Kategoryzacja KPiR</CardTitle>
              <CardDescription>
                Apka się uczy — jeśli zmienisz, następne wydatki tego sprzedawcy
                będą tak kategoryzowane
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Kolumna KPiR" htmlFor="expense-kpir-column">
                <Select
                  items={KPIR_OPTIONS}
                  value={form.kpir_column}
                  onValueChange={(value: string | null) => {
                    if (value) setForm({ ...form, kpir_column: normalizeKpirColumn(value) });
                  }}
                >
                  <SelectTrigger id="expense-kpir-column" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="p-1" alignItemWithTrigger={false}>
                    <SelectGroup>
                      {KPIR_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Kategoria (czytelna nazwa)" htmlFor="expense-category">
                <Input
                  id="expense-category"
                  list="expense-categories"
                  value={form.category_label}
                  onChange={(e) =>
                    setForm({ ...form, category_label: e.target.value })
                  }
                />
                <datalist id="expense-categories">
                  {COMMON_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>

              <label
                className={cn(
                  'hover:bg-muted/50 flex w-full items-start gap-3 p-3 transition-colors',
                  deductibleToggleDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                )}
              >
                <Checkbox
                  checked={form.is_deductible}
                  disabled={deductibleToggleDisabled}
                  onCheckedChange={() =>
                    setForm({ ...form, is_deductible: !form.is_deductible })
                  }
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium">Uwzględnij w KPiR</span>
                  <span className="text-muted-foreground block text-xs">
                    Odhacz jeśli ten wydatek nie jest kosztem firmowym
                  </span>
                </span>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notatki</CardTitle>
            </CardHeader>
            <CardContent>
              <Label htmlFor="expense-notes" className="sr-only">
                Notatki
              </Label>
              <Textarea
                id="expense-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                className="resize-none"
                placeholder="np. Zakup na potrzeby projektu X"
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="ff-sticky-actions bg-background border-t">
        <div className="mx-auto flex max-w-7xl justify-between gap-3">
          {expense.source !== 'ksef_inbox' && expense.ksef_invoice_id === null ? (
            <Button
              variant="destructive"
              size="lg"
              onClick={handleDelete}
              disabled={isDeleting || isSaving}
              aria-label="Usuń wydatek"
            >
              {isDeleting ? (
                <RiLoader4Line className="animate-spin" />
              ) : (
                <RiDeleteBinLine />
              )}
              <span className="hidden sm:inline">Usuń</span>
            </Button>
          ) : <span />}
          <Button
            size="lg"
            onClick={handleSave}
            disabled={isSaving || isDeleting || (ksefCurrencyUnknown && form.is_deductible) || (foreignKsef && form.is_deductible && (!hasKsefRate || !confirmedForeignCurrency))}
          >
            {isSaving ? (
              <RiLoader4Line className="animate-spin" />
            ) : (
              <RiSave3Line />
            )}
            {(foreignKsef || ksefCurrencyUnknown) && !form.is_deductible && !confirmedForeignCurrency
              ? 'Zapisz poza KPiR'
              : !expense.is_reviewed ? 'Zaakceptuj' : 'Zapisz zmiany'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Wiersz „etykieta → wartość” jak w Finora `transaction-detail-sheet.tsx`. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-right text-sm font-medium">{children}</span>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

'use client';

import { useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiBankLine,
  RiCheckboxCircleLine,
  RiFileUploadLine,
  RiLoader4Line,
  RiQuestionLine,
  RiSearchLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  confirmBankOperationAction,
  importBankStatementAction,
  skipBankOperationAction,
  undoBankOperationAction,
} from '@/app/actions/bank-statement';
import StatsCards, { type StatItem } from '@/components/dashboard/stats-cards';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt } from '@/lib/format/pl';
import type { MatchKind, MatchResult } from '@/lib/import/bank/dopasowanie';
import {
  BANK_LOAD_FAILED,
  CANDIDATES_LOAD_FAILED,
  CONFIDENCE_LABELS,
  DECISION_FAILED,
  FILE_TOO_BIG,
  IMPORT_FAILED,
  MATCH_KIND_LABELS,
  MAX_BANK_FILE_BYTES,
  formatAccount,
  importSummaryText,
  type BankDecisionResult,
  type BankOperationsData,
  type DecidedOperation,
  type ImportBankStatementResult,
  type PendingOperation,
} from '@/lib/import/bank/ekran';
import type { BankInvoiceOption } from '@/lib/import/bank/kandydaci';
import type { PrzelewyPodatkoweEkranu } from '@/lib/import/bank/podatki';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';
import { cn } from '@/lib/utils';

import { BankTaxSection } from './bank-tax-section';

/**
 * Ekran „Bank” (plan kompletnej aplikacji, krok 3.2, część 1; układ P12 z
 * Finory: kafle, karta wgrania, lista operacji). Wpłata zapisuje się dopiero po
 * „Potwierdź”; „Wybierz fakturę” to wybór ręczny z niezapłaconych faktur,
 * „Pomiń” usuwa dane osób trzecich. Dane i propozycje liczy serwer
 * (`app/(dashboard)/bank/page.tsx`), zapisy robią akcje z
 * `app/actions/bank-statement.ts`. Pola dotyku 44 px poniżej `lg`, karty
 * zamiast tabeli, więc ekran działa w telefonie bez przewijania w bok.
 */

const TOUCH = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';
const READ_ONLY = 'Wyciąg wgrywa i wpłaty potwierdza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.';
const PRIVACY_NOTE =
  'Zapisujemy tylko wpływy w złotych potrzebne do dopasowania. Przy pominiętej operacji usuwamy tytuł przelewu, nazwę i rachunek nadawcy, a zostają kwota, dzień i znacznik, że ta operacja już była.';
/** Przy włączonym module księgowości zapisujemy też przelewy do ZUS i urzędu (00186). */
const PRIVACY_NOTE_TAX =
  'Zapisujemy tylko wpływy w złotych potrzebne do dopasowania oraz przelewy do ZUS i urzędu skarbowego; innych wypływów nie zapisujemy. Przy pominiętej operacji usuwamy tytuł przelewu, nazwę i rachunek drugiej strony, a zostają kwota, dzień i znacznik, że ta operacja już była.';

const money = (grosze: number) => formatPaymentMoney(grosze / 100);

interface BankViewProps {
  /** `null`: operacji nie udało się wczytać. */
  data: BankOperationsData | null;
  /** `null`: faktur do dopasowania nie udało się wczytać (bez propozycji i wyboru). */
  invoices: BankInvoiceOption[] | null;
  proposals: Record<string, MatchResult>;
  canWrite: boolean;
  /** Przelewy do ZUS i urzędu (krok 3.2, część 2); `null` albo brak: moduł księgowości wyłączony dla firmy. */
  tax?: PrzelewyPodatkoweEkranu | null;
  /** Zapłaty rozliczeń potwierdza owner/admin. */
  canWriteTax?: boolean;
}

async function safely<T extends { success: boolean }>(run: () => Promise<T>, fallback: string): Promise<T | { success: false; error: string }> {
  try {
    return await run();
  } catch {
    return { success: false, error: fallback };
  }
}

export function BankView({ data, invoices, proposals, canWrite, tax = null, canWriteTax = false }: BankViewProps) {
  const byId = useMemo(() => new Map((invoices ?? []).map((invoice) => [invoice.id, invoice])), [invoices]);
  const withProposal = data ? data.pending.filter((op) => isConfirmable(proposals[op.id])).length : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Bank</h1>
        <p className="text-muted-foreground text-sm">
          Wgraj wyciąg z banku, a FaktWay zaproponuje faktury do wpłat. Wpłata zapisuje się dopiero po Twoim potwierdzeniu.
        </p>
      </div>

      {data ? (
        <StatsCards
          stats={
            [
              { label: 'Do sprawdzenia', value: formatPlInt(data.pendingTotal), icon: RiQuestionLine },
              { label: 'Z propozycją faktury', value: formatPlInt(withProposal), icon: RiCheckboxCircleLine },
              { label: 'Zapisane wpłaty', value: formatPlInt(data.confirmedTotal), icon: RiBankLine },
              { label: 'Rachunki', value: formatPlInt(data.accounts.length), icon: RiFileUploadLine },
            ] satisfies StatItem[]
          }
        />
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{BANK_LOAD_FAILED}</AlertDescription>
        </Alert>
      )}

      {canWrite ? (
        <ImportCard />
      ) : (
        <Alert>
          <AlertDescription>{READ_ONLY}</AlertDescription>
        </Alert>
      )}

      {data ? (
        <>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Wpływy do sprawdzenia</CardTitle>
              <CardDescription>
                {data.pendingTotal > data.pending.length
                  ? `Pokazujemy ${formatPlInt(data.pending.length)} najnowszych z ${formatPlInt(data.pendingTotal)}. Kolejne pojawią się po decyzji przy tych.`
                  : 'Każdą propozycję sprawdź i potwierdź albo pomiń.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {invoices === null ? (
                <Alert variant="destructive">
                  <AlertDescription>{CANDIDATES_LOAD_FAILED}</AlertDescription>
                </Alert>
              ) : null}
              {data.pending.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nie ma wpływów do sprawdzenia. Wgraj wyciąg, żeby zobaczyć nowe operacje.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {data.pending.map((op) => (
                    <PendingRow key={op.id} op={op} proposal={proposals[op.id]} byId={byId} invoices={invoices} canWrite={canWrite} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {data.decided.length > 0 ? (
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Ostatnie decyzje</CardTitle>
                <CardDescription>Potwierdzoną wpłatę cofniesz tutaj: operacja wróci do sprawdzenia.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {data.decided.map((op) => (
                    <DecidedRow key={op.id} op={op} canWrite={canWrite} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      {tax ? <BankTaxSection data={tax} canWrite={canWriteTax} /> : null}

      <p className="text-muted-foreground text-xs">{tax ? PRIVACY_NOTE_TAX : PRIVACY_NOTE}</p>
    </div>
  );
}

function isConfirmable(proposal: MatchResult | undefined): proposal is Extract<MatchResult, { invoiceId: string }> {
  return proposal !== undefined && 'invoiceId' in proposal && proposal.amount !== 'over';
}

function ImportCard() {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const upload = () => {
    const file = input.current?.files?.[0];
    if (!file) {
      setMessage({ ok: false, text: 'Wybierz plik wyciągu pobrany z banku.' });
      return;
    }
    if (file.size > MAX_BANK_FILE_BYTES) {
      setMessage({ ok: false, text: FILE_TOO_BIG });
      return;
    }
    const form = new FormData();
    form.set('file', file);
    startTransition(async () => {
      const result: ImportBankStatementResult = await safely(() => importBankStatementAction(form), IMPORT_FAILED);
      if (!result.success) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: importSummaryText(result) });
      if (input.current) input.current.value = '';
      router.refresh();
    });
  };

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Wgraj wyciąg</CardTitle>
        <CardDescription>
          MT940 albo CAMT.053 (XML) z bankowości internetowej albo raport CSV PKO BP w formacie Elixir, do 900 KB. Ten sam plik możesz wgrać
          drugi raz: operacje wgrane wcześniej nie wejdą ponownie.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-3 max-sm:flex-col sm:items-center">
          <label htmlFor={inputId} className="sr-only">
            Plik wyciągu
          </label>
          <Input id={inputId} ref={input} type="file" accept=".sta,.mt940,.940,.txt,.xml,.csv" className={cn(TOUCH, 'min-w-0 sm:max-w-sm')} disabled={pending} />
          <Button type="button" className={TOUCH} onClick={upload} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiFileUploadLine aria-hidden />}
            Wgraj wyciąg
          </Button>
        </div>
        {message ? (
          <Alert variant={message.ok ? 'default' : 'destructive'} role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function proposalText(proposal: MatchResult | undefined, byId: Map<string, BankInvoiceOption>, amountGrosze: number): string | null {
  if (!proposal) return null;
  if (proposal.kind === 'ambiguous') {
    const numbers = proposal.invoiceIds.map((id) => byId.get(id)?.number).filter((n): n is string => Boolean(n));
    return `Pasuje kilka faktur${numbers.length > 0 ? ` (${numbers.join(', ')})` : ''}. Jedna operacja to wpłata do jednej faktury: wybierz ją ręcznie.`;
  }
  if (proposal.kind === 'none') {
    return proposal.unknownKsefNumber
      ? 'Numer KSeF z tytułu nie pasuje do żadnej niezapłaconej faktury tej firmy. Sprawdź tytuł albo wybierz fakturę ręcznie.'
      : 'Bez propozycji. Wybierz fakturę ręcznie albo pomiń operację, jeśli to nie wpłata za fakturę.';
  }
  const invoice = byId.get(proposal.invoiceId);
  const number = invoice?.number ?? 'bez numeru';
  const how = `${MATCH_KIND_LABELS[proposal.kind]} (${CONFIDENCE_LABELS[proposal.confidence]})`;
  if (proposal.amount === 'over' && invoice) {
    return `Faktura ${number}: ${how}. Wpływ jest większy niż pozostało do zapłaty (${money(invoice.outstandingGrosze)}), a FaktWay nie zapisuje nadpłat. Wybierz inną fakturę albo zapisz przy fakturze wpłatę na kwotę reszty i pomiń tę operację.`;
  }
  if (proposal.amount === 'partial' && invoice) {
    return `Faktura ${number}: ${how}. Wpłata częściowa: po niej zostanie do zapłaty ${money(invoice.outstandingGrosze - amountGrosze)}.`;
  }
  return `Faktura ${number}: ${how}. Wpłata pokrywa całą resztę do zapłaty.`;
}

function PendingRow({
  op,
  proposal,
  byId,
  invoices,
  canWrite,
}: {
  op: PendingOperation;
  proposal: MatchResult | undefined;
  byId: Map<string, BankInvoiceOption>;
  invoices: BankInvoiceOption[] | null;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [skipOpen, setSkipOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);

  const run = (action: () => Promise<BankDecisionResult>, after?: () => void) =>
    startTransition(async () => {
      const result = await safely(action, DECISION_FAILED);
      after?.();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.message);
      router.refresh();
    });

  const confirm = (invoiceId: string, matchKind: MatchKind) =>
    run(() => confirmBankOperationAction({ operationId: op.id, invoiceId, matchKind }), () => setPickOpen(false));

  const confirmable = isConfirmable(proposal) ? proposal : null;
  const text = invoices === null ? null : proposalText(proposal, byId, op.amountGrosze);

  return (
    <li className="flex flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-base font-semibold tabular-nums">{money(op.amountGrosze)}</span>
        <span className="text-muted-foreground text-sm">{formatIsoDatePl(op.bookingDate)}</span>
      </div>
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">{op.counterpartyName ?? 'Nadawca nieznany'}</p>
        <p className="text-muted-foreground line-clamp-2 break-words">{op.title ?? 'Bez tytułu'}</p>
        <p className="text-muted-foreground truncate text-xs">Na rachunek {formatAccount(op.account)}</p>
      </div>
      {text ? <p className="text-sm">{text}</p> : null}
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {confirmable ? (
            <Button type="button" size="sm" className={TOUCH} disabled={pending} onClick={() => confirm(confirmable.invoiceId, confirmable.kind)}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Potwierdź
            </Button>
          ) : null}
          {invoices && invoices.length > 0 ? (
            <Button type="button" size="sm" variant="outline" className={TOUCH} disabled={pending} onClick={() => setPickOpen(true)}>
              Wybierz fakturę ręcznie
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className={TOUCH} disabled={pending} onClick={() => setSkipOpen(true)}>
            Pomiń
          </Button>
        </div>
      ) : null}

      {invoices ? (
        <PickInvoiceDialog
          open={pickOpen}
          onOpenChange={(next) => (pending ? undefined : setPickOpen(next))}
          op={op}
          invoices={invoices}
          proposal={confirmable}
          pending={pending}
          onPick={(invoiceId) => confirm(invoiceId, confirmable && confirmable.invoiceId === invoiceId ? confirmable.kind : 'manual')}
        />
      ) : null}

      <AlertDialog open={skipOpen} onOpenChange={(next) => (pending ? undefined : setSkipOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pominąć wpływ {money(op.amountGrosze)} z {formatIsoDatePl(op.bookingDate)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Usuniemy tytuł przelewu, nazwę i rachunek nadawcy, a operacji nie da się potem potwierdzić. Jeśli to jednak wpłata za fakturę, zapiszesz ją
              przy fakturze przyciskiem „Zapisz wpłatę”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <Button type="button" variant="destructive" className={TOUCH} disabled={pending} onClick={() => run(() => skipBankOperationAction(op.id), () => setSkipOpen(false))}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Pomiń operację
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function PickInvoiceDialog({
  open,
  onOpenChange,
  op,
  invoices,
  proposal,
  pending,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  op: PendingOperation;
  invoices: BankInvoiceOption[];
  proposal: Extract<MatchResult, { invoiceId: string }> | null;
  pending: boolean;
  onPick: (invoiceId: string) => void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? invoices : invoices.filter((i) => `${i.number ?? ''} ${i.buyerName ?? ''}`.toLowerCase().includes(q));
    // Najpierw faktury z resztą równą kwocie wpływu, potem najnowsze.
    return [...filtered]
      .sort((a, b) => Number(b.outstandingGrosze === op.amountGrosze) - Number(a.outstandingGrosze === op.amountGrosze) || (b.issueDate ?? '').localeCompare(a.issueDate ?? ''))
      .slice(0, 50);
  }, [invoices, op.amountGrosze, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Wybierz fakturę dla wpływu {money(op.amountGrosze)}</DialogTitle>
          <DialogDescription>
            Wpłata zapisze się z dniem {formatIsoDatePl(op.bookingDate)}. Na liście są niezapłacone faktury sprzedaży w złotych przyjęte w KSeF.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Szukaj faktury
          </label>
          <RiSearchLine className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" aria-hidden />
          <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Numer faktury albo nabywca" className={cn(TOUCH, 'pl-8')} />
        </div>
        <ul className="flex flex-col gap-2">
          {shown.length === 0 ? <li className="text-muted-foreground text-sm">Nie ma takiej niezapłaconej faktury.</li> : null}
          {shown.map((invoice) => {
            const over = op.amountGrosze > invoice.outstandingGrosze;
            return (
              <li key={invoice.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">
                    {invoice.number ?? 'Faktura bez numeru'}
                    {proposal?.invoiceId === invoice.id ? ' (propozycja)' : ''}
                  </p>
                  <p className="text-muted-foreground truncate">
                    {invoice.buyerName ?? 'Nabywca bez nazwy'} · pozostało {money(invoice.outstandingGrosze)}
                  </p>
                  {over ? <p className="text-destructive text-xs">Wpływ większy niż reszta: nadpłat nie zapisujemy.</p> : null}
                </div>
                <Button type="button" size="sm" variant="outline" className={TOUCH} disabled={pending || over} onClick={() => onPick(invoice.id)}>
                  Wybierz
                </Button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" className={TOUCH} disabled={pending} onClick={() => onOpenChange(false)}>
            Anuluj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecidedRow({ op, canWrite }: { op: DecidedOperation; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const undo = () =>
    startTransition(async () => {
      const result = await safely(() => undoBankOperationAction(op.id), DECISION_FAILED);
      setOpen(false);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.message);
      router.refresh();
    });

  const confirmed = op.state === 'confirmed';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="min-w-0 text-sm">
        <p className="font-medium tabular-nums">
          {money(op.amountGrosze)} · {formatIsoDatePl(op.bookingDate)}
        </p>
        <p className="text-muted-foreground truncate">
          {confirmed
            ? `Zapisana wpłata${op.invoiceNumber ? ` do faktury ${op.invoiceNumber}` : ''}${op.counterpartyName ? ` od ${op.counterpartyName}` : ''}`
            : 'Pominięta, dane nadawcy usunięte'}
        </p>
      </div>
      {confirmed && canWrite ? (
        <>
          <Button type="button" size="sm" variant="ghost" className={TOUCH} disabled={pending} onClick={() => setOpen(true)}>
            Cofnij
          </Button>
          <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cofnąć wpłatę {money(op.amountGrosze)}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {op.invoiceNumber ? `Kwota wróci do pozostałej do zapłaty na fakturze ${op.invoiceNumber}` : 'Kwota wróci do pozostałej do zapłaty'}, wpłata zostanie w
                  historii faktury jako cofnięta, a operacja wróci do sprawdzenia.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
                <Button type="button" variant="destructive" className={TOUCH} disabled={pending} onClick={undo}>
                  {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
                  Cofnij wpłatę
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </li>
  );
}

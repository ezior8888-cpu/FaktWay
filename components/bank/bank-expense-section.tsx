'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { confirmBankExpensePaymentAction, skipBankExpenseOperationAction, undoBankExpensePaymentAction } from '@/app/actions/bank-statement';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt } from '@/lib/format/pl';
import { DECISION_FAILED, formatAccount, type BankDecisionResult } from '@/lib/import/bank/ekran';
import {
  EXPENSE_BANK_ROLE_REFUSAL,
  opisDopasowania,
  type KosztDoPrzelewu,
  type PropozycjeKosztow,
  type PrzelewDoDecyzji,
  type RodzajDopasowaniaKosztu,
  type ZaplataKosztuRozstrzygnieta,
  type ZaplatyKosztowEkranu,
} from '@/lib/import/bank/koszty';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';

/**
 * „Zapłaty kosztów z wyciągu” na ekranie „Bank” (plan kompletnej aplikacji,
 * krok 3.2, część 3). Przelewy na rachunki dostawców z listy „Do zapłaty”
 * z ostatnio wgranego pliku są tylko w przeglądarce: zapisują się dopiero po
 * „Potwierdź” (pewne dopasowanie), wyborze kosztów albo jako znacznik bez danych
 * odbiorcy po „Pomiń”. Ostatnie decyzje z „Cofnij” czyta serwer (RPC
 * `bank_expense_operations`, 00196). Pola dotyku 44 px poniżej `lg`, karty
 * zamiast tabeli (telefon bez przewijania w bok).
 */

const TOUCH = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';
const money = (grosze: number) => formatPaymentMoney(grosze / 100);

async function safely<T extends { success: boolean }>(run: () => Promise<T>, fallback: string): Promise<T | { success: false; error: string }> {
  try {
    return await run();
  } catch {
    return { success: false, error: fallback };
  }
}

function useDecision() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<BankDecisionResult>, after?: (ok: boolean) => void) =>
    startTransition(async () => {
      const result = await safely(action, DECISION_FAILED);
      after?.(result.success);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.message);
      router.refresh();
    });
  return { pending, run };
}

export function BankExpenseSection({
  propozycje,
  decyzje,
  canWrite,
  onResolved,
}: {
  propozycje: PropozycjeKosztow | null;
  /** `null`: nie pokazujemy ostatnich decyzji (brak odczytu na tej stronie). */
  decyzje: ZaplatyKosztowEkranu | null;
  canWrite: boolean;
  /** Przelew rozstrzygnięty (zapisany albo pominięty): znika z propozycji. */
  onResolved: (key: string, oplaconeKoszty: readonly string[]) => void;
}) {
  const przelewy = propozycje?.przelewy ?? [];
  const koszty = useMemo(() => new Map((propozycje?.koszty ?? []).map((k) => [k.id, k])), [propozycje]);
  const decided = decyzje?.ok ? decyzje.decided : [];
  const blad = propozycje?.error ?? null;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Zapłaty kosztów z wyciągu</CardTitle>
        <CardDescription>
          Przelewy z wyciągu na rachunki dostawców z listy „Do zapłaty”. Zapisujemy je dopiero po Twojej decyzji: „Potwierdź” oznacza koszt jako
          zapłacony z dniem księgowania z wyciągu, tak jak „Oznacz jako zapłacone” w Wydatkach.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {canWrite ? null : <p className="text-muted-foreground text-sm">{EXPENSE_BANK_ROLE_REFUSAL}</p>}
        {blad ? (
          <Alert variant="destructive">
            <AlertDescription>{blad}</AlertDescription>
          </Alert>
        ) : null}
        {przelewy.length > 0 ? (
          <>
            <p className="text-muted-foreground text-sm">
              Przelewy z ostatnio wgranego pliku ({formatPlInt(przelewy.length)}). Nie zapisujemy ich przed decyzją: po wyjściu ze strony wystarczy
              wgrać ten sam plik jeszcze raz.
            </p>
            <ul className="flex flex-col gap-3" aria-label="Przelewy do dostawców do decyzji">
              {przelewy.map((p) => (
                <ProposalRow key={p.key} przelew={p} koszty={koszty} canWrite={canWrite} onResolved={onResolved} />
              ))}
            </ul>
          </>
        ) : decided.length === 0 && !blad ? (
          <p className="text-muted-foreground text-sm">
            Po wgraniu wyciągu pojawią się tu przelewy na rachunki dostawców z listy „Do zapłaty” z propozycją kosztu.
          </p>
        ) : null}
        {decyzje && !decyzje.ok ? (
          <Alert variant="destructive">
            <AlertDescription>{decyzje.error}</AlertDescription>
          </Alert>
        ) : null}
        {decided.length > 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <h3 className="text-sm font-medium">Ostatnie decyzje</h3>
            <ul className="flex flex-col gap-3" aria-label="Ostatnie decyzje o przelewach do dostawców">
              {decided.map((op) => (
                <DecidedRow key={op.id} op={op} canWrite={canWrite} />
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProposalRow({
  przelew,
  koszty,
  canWrite,
  onResolved,
}: {
  przelew: PrzelewDoDecyzji;
  koszty: ReadonlyMap<string, KosztDoPrzelewu>;
  canWrite: boolean;
  onResolved: (key: string, oplaconeKoszty: readonly string[]) => void;
}) {
  const { pending, run } = useDecision();
  const [skipOpen, setSkipOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const propozycja = przelew.propozycja;
  const kandydaci = przelew.kandydaci.filter((id) => koszty.has(id));

  const confirm = (expenseIds: string[], matchKind: RodzajDopasowaniaKosztu) =>
    run(
      () => confirmBankExpensePaymentAction({ fileFormat: przelew.fileFormat, przelew: bezPropozycji(przelew), expenseIds, matchKind }),
      (ok) => {
        setPickOpen(false);
        if (ok) onResolved(przelew.key, expenseIds);
      },
    );

  return (
    <li className="flex flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-base font-semibold tabular-nums">{money(-przelew.amountGrosze)}</span>
        <span className="text-muted-foreground text-sm">{formatIsoDatePl(przelew.bookingDate)}</span>
      </div>
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">{przelew.counterpartyName ?? 'Odbiorca bez nazwy'}</p>
        <p className="text-muted-foreground line-clamp-2 break-words">{przelew.title ?? 'Bez tytułu'}</p>
        <p className="text-muted-foreground truncate text-xs">
          Z rachunku {formatAccount(przelew.account)}
          {przelew.counterpartyAccount ? ` na ${formatAccount(przelew.counterpartyAccount)}` : ''}
        </p>
      </div>
      <p className="text-sm">{opisDopasowania(przelew, koszty)}</p>
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {propozycja?.pewne ? (
            <Button type="button" size="sm" className={TOUCH} disabled={pending} onClick={() => confirm(propozycja.kosztIds, propozycja.rodzaj)}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Potwierdź
            </Button>
          ) : null}
          {kandydaci.length > 0 ? (
            <Button type="button" size="sm" variant="outline" className={TOUCH} disabled={pending} onClick={() => setPickOpen(true)}>
              Wybierz koszt
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className={TOUCH} disabled={pending} onClick={() => setSkipOpen(true)}>
            Pomiń
          </Button>
        </div>
      ) : null}

      {canWrite && kandydaci.length > 0 ? (
        <PickExpenseDialog
          open={pickOpen}
          onOpenChange={(next) => (pending ? undefined : setPickOpen(next))}
          przelew={przelew}
          kandydaci={kandydaci.map((id) => koszty.get(id)!)}
          pending={pending}
          onPick={(ids) => confirm(ids, propozycja && sameIds(propozycja.kosztIds, ids) ? propozycja.rodzaj : 'manual')}
        />
      ) : null}

      <AlertDialog open={skipOpen} onOpenChange={(next) => (pending ? undefined : setSkipOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pominąć przelew {money(-przelew.amountGrosze)} z {formatIsoDatePl(przelew.bookingDate)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Tytułu przelewu, nazwy ani rachunku odbiorcy nie zapiszemy; zostaną tylko kwota i dzień, żeby przelew nie wrócił przy kolejnym wgraniu.
              Jeśli to jednak zapłata kosztu, oznacza się ją w Wydatkach przyciskiem „Oznacz jako zapłacone”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className={TOUCH}
              disabled={pending}
              onClick={() =>
                run(() => skipBankExpenseOperationAction({ fileFormat: przelew.fileFormat, przelew: bezPropozycji(przelew) }), (ok) => {
                  setSkipOpen(false);
                  if (ok) onResolved(przelew.key, []);
                })
              }
            >
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Pomiń przelew
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Do akcji idzie sam przelew: bez propozycji, wyboru i formatu pliku. */
function bezPropozycji(p: PrzelewDoDecyzji) {
  return {
    key: p.key,
    account: p.account,
    bookingDate: p.bookingDate,
    amountGrosze: p.amountGrosze,
    counterpartyName: p.counterpartyName,
    counterpartyAccount: p.counterpartyAccount ?? '',
    title: p.title,
    reference: p.reference,
  };
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

function PickExpenseDialog({
  open,
  onOpenChange,
  przelew,
  kandydaci,
  pending,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  przelew: PrzelewDoDecyzji;
  kandydaci: KosztDoPrzelewu[];
  pending: boolean;
  onPick: (ids: string[]) => void;
}) {
  const kwotaGr = -przelew.amountGrosze;
  const poczatkowe = przelew.propozycja?.kosztIds ?? (przelew.wskazane.length > 0 ? przelew.wskazane : []);
  const [wybrane, setWybrane] = useState<Set<string>>(() => new Set(poczatkowe));
  // Tylko koszty, które są jeszcze do wyboru: koszt zapłacony innym przelewem w tej sesji wypada.
  const aktywne = kandydaci.filter((k) => wybrane.has(k.id));
  const sumaGr = aktywne.reduce((s, k) => s + k.kwotaGr, 0);
  const roznica = kwotaGr - sumaGr;

  const przelacz = (id: string, tak: boolean) =>
    setWybrane((prev) => {
      const next = new Set(prev);
      if (tak) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Wybierz koszt dla przelewu {money(kwotaGr)}</DialogTitle>
          <DialogDescription>
            Zapłata zapisze się z dniem {formatIsoDatePl(przelew.bookingDate)}. Na liście są koszty z listy „Do zapłaty” na ten sam rachunek odbiorcy.
            Przelew łączymy z kosztami tylko wtedy, gdy suma ich kwot do zapłaty równa się przelewowi; inną kwotę zapłaty oznacza się w Wydatkach.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {kandydaci.map((k) => (
            <li key={k.id} className="flex items-center gap-3 border-b pb-2 last:border-b-0">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 max-lg:min-h-[44px]">
                <Checkbox
                  checked={wybrane.has(k.id)}
                  onCheckedChange={(tak) => przelacz(k.id, tak === true)}
                  aria-label={`Koszt ${k.numerFaktury || 'bez numeru'} na ${money(k.kwotaGr)}`}
                />
                <span className="min-w-0 text-sm">
                  <span className="block truncate font-medium">
                    {k.numerFaktury || 'Faktura bez numeru'}
                    {przelew.propozycja?.kosztIds.includes(k.id) ? ' (propozycja)' : ''}
                  </span>
                  <span className="text-muted-foreground block truncate">
                    {k.sprzedawca} · do zapłaty {money(k.kwotaGr)} · termin {formatIsoDatePl(k.termin)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="text-sm" role="status">
          {aktywne.length === 0
            ? 'Zaznacz koszt albo kilka kosztów zapłaconych tym przelewem.'
            : roznica === 0
              ? `Wybrane: ${money(sumaGr)}, tyle co przelew.`
              : `Wybrane: ${money(sumaGr)}, przelew o ${money(Math.abs(roznica))} ${roznica > 0 ? 'więcej' : 'mniej'}.`}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" className={TOUCH} disabled={pending} onClick={() => onOpenChange(false)}>
            Anuluj
          </Button>
          <Button type="button" className={TOUCH} disabled={pending || aktywne.length === 0 || roznica !== 0} onClick={() => onPick(aktywne.map((k) => k.id))}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
            Zapisz zapłatę
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecidedRow({ op, canWrite }: { op: ZaplataKosztuRozstrzygnieta; canWrite: boolean }) {
  const { pending, run } = useDecision();
  const [open, setOpen] = useState(false);
  const confirmed = op.state === 'confirmed';
  const numery = op.koszty.map((k) => k.numer ?? 'bez numeru').join(', ');
  const zmienione = op.koszty.filter((k) => k.zaplaconoO !== op.bookingDate).map((k) => k.numer ?? 'bez numeru');

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="min-w-0 text-sm">
        <p className="font-medium tabular-nums">
          {money(-op.amountGrosze)} · {formatIsoDatePl(op.bookingDate)}
        </p>
        <p className="text-muted-foreground">
          {confirmed
            ? `Zapłata ${op.koszty.length > 1 ? 'kosztów' : 'kosztu'} ${numery}${op.koszty[0]?.sprzedawca ? ` (${op.koszty[0].sprzedawca})` : ''}`
            : 'Pominięty, tytułu i danych odbiorcy nie zapisaliśmy'}
        </p>
        {confirmed && zmienione.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Zapłata {zmienione.length > 1 ? `kosztów ${zmienione.join(', ')}` : `kosztu ${zmienione[0]}`} zmieniła się później w Wydatkach.
          </p>
        ) : null}
      </div>
      {confirmed && canWrite ? (
        <>
          <Button type="button" size="sm" variant="ghost" className={TOUCH} disabled={pending} onClick={() => setOpen(true)}>
            Cofnij
          </Button>
          <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cofnąć zapłatę z przelewu {money(-op.amountGrosze)}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Koszty oznaczone tym przelewem wrócą na listę „Do zapłaty”, chyba że ich zapłata zmieniła się później w Wydatkach. Przelewu nie
                  przechowujemy: żeby przypisać go do innego kosztu, wgraj wyciąg jeszcze raz.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
                <Button type="button" variant="destructive" className={TOUCH} disabled={pending} onClick={() => run(() => undoBankExpensePaymentAction(op.id), () => setOpen(false))}>
                  {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
                  Cofnij zapłatę
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </li>
  );
}

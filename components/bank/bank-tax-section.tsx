'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { confirmBankTaxPaymentAction, skipBankOperationAction, undoBankTaxPaymentAction } from '@/app/actions/bank-statement';
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
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt } from '@/lib/format/pl';
import { DECISION_FAILED, formatAccount, type BankDecisionResult } from '@/lib/import/bank/ekran';
import {
  ODLICZENIE_OD_WYLICZONEJ,
  TAX_ROLE_REFUSAL,
  TAX_SETTLEMENTS_LOAD_FAILED,
  type OpcjaZaplaty,
  type PrzelewNaEkranie,
  type PrzelewyPodatkoweEkranu,
  type RodzajDopasowaniaPodatku,
  type RozstrzygniecieNaEkranie,
  type SposobPrzypisania,
} from '@/lib/import/bank/podatki';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';

/**
 * „Zapłaty do ZUS i urzędu skarbowego” na ekranie „Bank” (plan kompletnej
 * aplikacji, krok 3.2, część 2). Widać ją tylko przy włączonym module
 * księgowości dla firmy. Przelew do ZUS albo na mikrorachunek dostaje
 * propozycję rozliczenia z „Ten miesiąc”; zapłata zapisuje się dopiero po
 * „Potwierdź” albo wyborze z listy, a „Cofnij” oddaje rozliczeniom stan.
 * Dane i propozycje liczy serwer (`lib/import/bank/podatki-dane.ts`), zapisy
 * robią akcje z `app/actions/bank-statement.ts`. Pola dotyku 44 px poniżej
 * `lg`, karty zamiast tabeli (telefon bez przewijania w bok).
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
  return { pending, run };
}

const matchKind = (sposob: SposobPrzypisania): RodzajDopasowaniaPodatku => (sposob === 'tytul' ? 'title' : 'amount');
const sameOption = (a: OpcjaZaplaty | null, b: OpcjaZaplaty) => a !== null && a.ids.join(',') === b.ids.join(',');

export function BankTaxSection({ data, canWrite }: { data: PrzelewyPodatkoweEkranu; canWrite: boolean }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Zapłaty do ZUS i urzędu skarbowego</CardTitle>
        <CardDescription>
          Przelewy z wyciągu na rachunek składkowy ZUS i na mikrorachunek podatkowy firmy. Po potwierdzeniu rozliczenie w „Ten miesiąc” jest
          oznaczone jako zapłacone z dniem księgowania z wyciągu, a kwota z banku zostaje przy przelewie.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.ok ? (
          <TaxLists data={data} canWrite={canWrite} />
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{data.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function TaxLists({ data, canWrite }: { data: Extract<PrzelewyPodatkoweEkranu, { ok: true }>; canWrite: boolean }) {
  return (
    <>
      {canWrite ? null : <p className="text-muted-foreground text-sm">{TAX_ROLE_REFUSAL}</p>}
      {data.bladRozliczen ? (
        <Alert variant="destructive">
          <AlertDescription>{TAX_SETTLEMENTS_LOAD_FAILED}</AlertDescription>
        </Alert>
      ) : null}
      {data.pending.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nie ma przelewów do ZUS ani urzędu skarbowego do sprawdzenia. Po wgraniu wyciągu pojawią się tu przelewy na rachunek składkowy
          i mikrorachunek firmy.
        </p>
      ) : (
        <>
          {data.pendingTotal > data.pending.length ? (
            <p className="text-muted-foreground text-sm">
              Pokazujemy {formatPlInt(data.pending.length)} najnowszych z {formatPlInt(data.pendingTotal)}. Kolejne pojawią się po decyzji przy tych.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3" aria-label="Przelewy do ZUS i urzędu skarbowego do sprawdzenia">
            {data.pending.map((op) => (
              <TaxPendingRow key={op.id} op={op} canWrite={canWrite} />
            ))}
          </ul>
        </>
      )}
      {data.decided.length > 0 ? (
        <div className="flex flex-col gap-2 pt-2">
          <h3 className="text-sm font-medium">Ostatnie decyzje</h3>
          <ul className="flex flex-col gap-3" aria-label="Ostatnie decyzje o przelewach do ZUS i urzędu skarbowego">
            {data.decided.map((op) => (
              <TaxDecidedRow key={op.id} op={op} canWrite={canWrite} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function TaxPendingRow({ op, canWrite }: { op: PrzelewNaEkranie; canWrite: boolean }) {
  const { pending, run } = useDecision();
  const [skipOpen, setSkipOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const propozycja = op.propozycja;
  const assigned = propozycja?.przypisanie ?? null;

  const confirm = (opcja: OpcjaZaplaty, kind: RodzajDopasowaniaPodatku) =>
    run(() => confirmBankTaxPaymentAction({ operationId: op.id, settlementIds: opcja.ids, matchKind: kind }), () => setPickOpen(false));

  return (
    <li className="flex flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-base font-semibold tabular-nums">{money(-op.amountGrosze)}</span>
        <span className="text-muted-foreground text-sm">{formatIsoDatePl(op.bookingDate)}</span>
      </div>
      <div className="min-w-0 text-sm">
        <p className="font-medium">{op.rodzaj === 'zus' ? 'Przelew do ZUS' : 'Przelew do urzędu skarbowego'}</p>
        {op.title ? <p className="text-muted-foreground line-clamp-2 break-words">{op.title}</p> : null}
        <p className="text-muted-foreground truncate text-xs">
          Z rachunku {formatAccount(op.account)}
          {op.counterpartyAccount ? ` na ${formatAccount(op.counterpartyAccount)}` : ''}
        </p>
      </div>
      {op.opis ? <p className="text-sm">{op.opis}</p> : null}
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {assigned ? (
            <Button type="button" size="sm" className={TOUCH} disabled={pending} onClick={() => confirm(assigned.opcja, matchKind(assigned.sposob))}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Potwierdź
            </Button>
          ) : null}
          {propozycja && propozycja.opcje.length > 0 ? (
            <Button type="button" size="sm" variant="outline" className={TOUCH} disabled={pending} onClick={() => setPickOpen(true)}>
              Wybierz rozliczenie
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className={TOUCH} disabled={pending} onClick={() => setSkipOpen(true)}>
            Pomiń
          </Button>
        </div>
      ) : null}

      {propozycja ? (
        <PickSettlementDialog
          open={pickOpen}
          onOpenChange={(next) => (pending ? undefined : setPickOpen(next))}
          op={op}
          opcje={propozycja.opcje}
          proposed={assigned?.opcja ?? null}
          pending={pending}
          onPick={(opcja) => confirm(opcja, assigned && sameOption(assigned.opcja, opcja) ? matchKind(assigned.sposob) : 'manual')}
        />
      ) : null}

      <AlertDialog open={skipOpen} onOpenChange={(next) => (pending ? undefined : setSkipOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pominąć przelew {money(-op.amountGrosze)} z {formatIsoDatePl(op.bookingDate)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Usuniemy tytuł przelewu i dane odbiorcy, a przelewu nie da się potem potwierdzić. Zapłatę rozliczenia oznacza się wtedy w „Ten miesiąc”
              przyciskiem „Zapłacone”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <Button type="button" variant="destructive" className={TOUCH} disabled={pending} onClick={() => run(() => skipBankOperationAction(op.id), () => setSkipOpen(false))}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Pomiń przelew
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function PickSettlementDialog({
  open,
  onOpenChange,
  op,
  opcje,
  proposed,
  pending,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  op: PrzelewNaEkranie;
  opcje: OpcjaZaplaty[];
  proposed: OpcjaZaplaty | null;
  pending: boolean;
  onPick: (opcja: OpcjaZaplaty) => void;
}) {
  const kwotaGr = -op.amountGrosze;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Wybierz rozliczenie dla przelewu {money(kwotaGr)}</DialogTitle>
          <DialogDescription>
            Zapłata zapisze się z dniem {formatIsoDatePl(op.bookingDate)}, a kwota z banku zostanie przy przelewie. Na liście są zatwierdzone
            rozliczenia z „Ten miesiąc” do dnia przelewu.
            {op.rodzaj === 'zus' ? ` Przy kwocie niższej niż wyliczona rozliczenie też będzie oznaczone jako zapłacone. ${ODLICZENIE_OD_WYLICZONEJ}` : ''}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {opcje.map((opcja) => {
            const roznica = kwotaGr - opcja.wyliczoneGr;
            return (
              <li key={opcja.ids.join(',')} className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {opcja.etykieta}
                    {sameOption(proposed, opcja) ? ' (propozycja)' : ''}
                  </p>
                  <p className="text-muted-foreground">
                    Wyliczone {money(opcja.wyliczoneGr)}
                    {roznica === 0 ? ', tyle co przelew' : `, przelew o ${money(Math.abs(roznica))} ${roznica > 0 ? 'więcej' : 'mniej'}`}
                  </p>
                  {opcja.zaplacone && opcja.zaplaconeO ? (
                    <p className="text-muted-foreground text-xs">Już oznaczone jako zapłacone {formatIsoDatePl(opcja.zaplaconeO)}; ta data zostanie.</p>
                  ) : null}
                </div>
                <Button type="button" size="sm" variant="outline" className={TOUCH} disabled={pending} onClick={() => onPick(opcja)}>
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

function TaxDecidedRow({ op, canWrite }: { op: RozstrzygniecieNaEkranie; canWrite: boolean }) {
  const { pending, run } = useDecision();
  const [open, setOpen] = useState(false);
  const confirmed = op.state === 'confirmed';

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="min-w-0 text-sm">
        <p className="font-medium tabular-nums">
          {money(-op.amountGrosze)} · {formatIsoDatePl(op.bookingDate)}
        </p>
        <p className="text-muted-foreground">{op.opis}</p>
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
                  Rozliczenia oznaczone tym potwierdzeniem wrócą do stanu „zatwierdzone”, chyba że ich zapłata zmieniła się później w „Ten miesiąc”.
                  Przelew wróci do sprawdzenia.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
                <Button type="button" variant="destructive" className={TOUCH} disabled={pending} onClick={() => run(() => undoBankTaxPaymentAction(op.id), () => setOpen(false))}>
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

'use client';

import { useState, useTransition } from 'react';
import { RiArrowRightLine, RiCheckLine, RiLoader4Line, RiSparklingLine } from '@remixicon/react';
import { toast } from 'sonner';

import { LegalInline } from '@/components/legal/legal-document';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { PRICE_GROSS, PRICE_NET, TRIAL_DAYS } from '@/lib/billing/pricing';
import type { BlikDisclosure } from '@/lib/billing/trial-payment';
import { CHECKOUT_STATEMENT } from '@/lib/legal/versions';

import { startCheckoutAction } from '../actions';

import { BlikTerms } from './blik-terms';

const FEATURES = [
  'Faktury sprzedaż + zakupy bez limitu',
  'OCR z auto-kategoryzacją KPiR',
  'KSeF 2.0 + UPO + walidacja',
  'Wkurzacz Dłużników',
  // Decyzja Bartosza 22.10.2026: bez Magicznego importu — historia z KSeF pobiera się sama.
  'Historia z KSeF i import z innych programów',
  'Co-Pilot Księgowego',
  // Dawniej „PWA mobilna z OCR” — panel na telefonie jest wyłączony (/mobile).
  'Odczyt paragonów (AI) z limitem dziennym i miesięcznym',
  'Wsparcie po polsku',
];

interface PlanCardProps {
  isPending: boolean;
  onSelect: () => void;
  statementAccepted: boolean;
  onStatementChange: (accepted: boolean) => void;
  blikDisclosure: BlikDisclosure | null;
  paymentHint: string;
}

/**
 * Jeden plan miesięczny (decyzja z 1 października 2026, lib/billing/pricing.ts).
 * Plan roczny nie jest sprzedawany — akcja zakupu też go odrzuca.
 *
 * Wygląd: `Card` Finory (nagłówek, treść, stopka), odznaka jak jej `Badge`.
 * Oświadczenie przed płatnością (art. 15 ust. 3 i art. 35 ustawy o prawach
 * konsumenta) — brzmienie z lib/legal/versions.ts; serwer odrzuca zakup bez
 * niego (`startCheckoutAction`, `statement-required`).
 */
function PlanCard({
  isPending,
  onSelect,
  statementAccepted,
  onStatementChange,
  blikDisclosure,
  paymentHint,
}: PlanCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-lg">Miesięcznie</CardTitle>
            <CardDescription>Płać co miesiąc, anuluj kiedy chcesz</CardDescription>
          </div>
          <Badge className="bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
            <RiSparklingLine aria-hidden />
            {TRIAL_DAYS} dni za darmo
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-3xl font-semibold">
            {PRICE_GROSS}
            <span className="text-muted-foreground ml-1 text-base font-normal">/ mc</span>
          </p>
          <p className="text-muted-foreground mt-1 text-xs">z VAT · {PRICE_NET} netto</p>
        </div>

        <ul className="flex flex-col gap-2">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm">
              <RiCheckLine className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="text-muted-foreground">{f}</span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter className="flex flex-col items-stretch gap-2">
        {/* Zgoda stoi w polu wyboru pod spodem: jej zaznaczenie jest warunkiem startu próby. */}
        {blikDisclosure ? (
          <BlikTerms
            title="Płatność kartą albo BLIK-iem"
            rows={[
              { label: 'Dziś płacisz', value: blikDisclosure.dueToday },
              { label: 'Pierwsza płatność', value: `${blikDisclosure.firstCharge}, jeśli zaczniesz dziś` },
              { label: 'Potem', value: blikDisclosure.cycle },
            ]}
            banks={blikDisclosure.banks}
          />
        ) : null}
        <label className="text-muted-foreground flex items-start gap-2.5 text-xs leading-relaxed">
          <input
            type="checkbox"
            checked={statementAccepted}
            onChange={(e) => onStatementChange(e.target.checked)}
            className="accent-primary mt-0.5 size-4 shrink-0"
          />
          <span>
            <LegalInline text={CHECKOUT_STATEMENT.text} linkClassName="underline underline-offset-2" />
            {blikDisclosure ? <> {blikDisclosure.consent}</> : null}
          </span>
        </label>
        <Button size="lg" className="w-full" disabled={isPending || !statementAccepted} onClick={onSelect}>
          {isPending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zacznij {TRIAL_DAYS} dni za darmo
          <RiArrowRightLine aria-hidden />
        </Button>
        <p className="text-muted-foreground text-center text-xs">{paymentHint}</p>
      </CardFooter>
    </Card>
  );
}

interface PlanCardsProps {
  /** Ujawnienia BLIK-a z serwera; `null`, gdy `STRIPE_BLIK_RECURRING` jest wyłączony. */
  blikDisclosure: BlikDisclosure | null;
  paymentHint: string;
}

export function PlanCards({ blikDisclosure, paymentHint }: PlanCardsProps) {
  const [isPending, startTransition] = useTransition();
  const [statementAccepted, setStatementAccepted] = useState(false);

  const handleSelect = () => {
    startTransition(async () => {
      try {
        await startCheckoutAction('monthly', statementAccepted, blikDisclosure?.version ?? null);
        // `startCheckoutAction` rzuca NEXT_REDIRECT — kod tu nie dotrze przy
        // sukcesie. Toast wyląduje gdy redirect wróci z `?error=...`.
      } catch (e) {
        // NEXT_REDIRECT to NIE jest błąd — Next.js re-throws go w server actions.
        // Inny rzut = realny problem.
        const err = e as Error;
        if (err.message?.includes('NEXT_REDIRECT')) return;
        toast.error('Nie udało się rozpocząć subskrypcji. Spróbuj ponownie.');
      }
    });
  };

  return (
    <div className="max-w-md">
      <PlanCard
        isPending={isPending}
        onSelect={handleSelect}
        statementAccepted={statementAccepted}
        onStatementChange={setStatementAccepted}
        blikDisclosure={blikDisclosure}
        paymentHint={paymentHint}
      />
    </div>
  );
}

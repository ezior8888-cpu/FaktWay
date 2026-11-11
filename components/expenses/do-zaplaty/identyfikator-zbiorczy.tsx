'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line, RiStackLine } from '@remixicon/react';
import { toast } from 'sonner';

import { utworzIdentyfikatorZbiorczyAction } from '@/app/actions/identyfikator-zbiorczy';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GrupaIdentyfikatora, IdentyfikatorZbiorczyResult } from '@/lib/expenses/identyfikator-zbiorczy';
import { formatPlMoney } from '@/lib/format/pl';
import { shortenLegalForm } from '@/lib/format/legal-form';
import { cn } from '@/lib/utils';

import { KopiujWiersz, kwotaDoSchowka, rachunekDoCzytania } from './dane-przelewu';

/**
 * Blok „Przelew za kilka faktur jednego dostawcy” na liście „Do zapłaty”
 * (plan kompletnej aplikacji, krok 1.4, część 2). Nowy blok z istniejących
 * komponentów (karta, przycisk, alert) nad kosztami, jak plik przelewów
 * z kroku 3.4 (decyzja D1: karty kosztów bez zmian).
 *
 * Przy grupie (co najmniej 2 faktury z numerem KSeF od jednego dostawcy,
 * osobno z MPP i bez) właściciel i administrator mają „Identyfikator
 * zbiorczy”: akcja pyta KSeF tylko wtedy, gdy dla tego zestawu faktur nie ma
 * zapisanego identyfikatora. Zapisany identyfikator to tytuł przelewu grupy,
 * a przy MPP stoi w komunikacie w miejscu numeru faktury. Na telefonie
 * przycisk na całą szerokość, pola dotyku co najmniej 44 px.
 */

const DOTYK = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';
const BLAD = 'Nie udało się utworzyć identyfikatora zbiorczego. Sprawdź połączenie i spróbuj ponownie.';

function faktury(n: number): string {
  if (n === 1) return '1 faktura';
  const ostatnia = n % 10;
  const nastolatki = n % 100 >= 12 && n % 100 <= 14;
  return ostatnia >= 2 && ostatnia <= 4 && !nastolatki ? `${n} faktury` : `${n} faktur`;
}

const numer = (n: string) => n || 'bez numeru';

function DaneIdentyfikatora({ grupa, identyfikator }: { grupa: GrupaIdentyfikatora; identyfikator: string }) {
  const kwota = (
    <KopiujWiersz
      etykieta="Kwota przelewu"
      wartosc={`${formatPlMoney(grupa.suma)} zł`}
      doSchowka={kwotaDoSchowka(grupa.suma)}
      opisPrzycisku="Kopiuj kwotę przelewu"
    />
  );
  const rachunek = grupa.rachunek ? (
    <KopiujWiersz
      etykieta="Rachunek sprzedawcy"
      wartosc={rachunekDoCzytania(grupa.rachunek)}
      doSchowka={grupa.rachunek}
      opisPrzycisku="Kopiuj numer rachunku"
      mono
    />
  ) : null;

  if (!grupa.mpp) {
    return (
      <div className="flex flex-col gap-3">
        <KopiujWiersz
          etykieta="Tytuł przelewu"
          wartosc={identyfikator}
          doSchowka={identyfikator}
          opisPrzycisku="Kopiuj identyfikator zbiorczy"
          mono
        />
        {kwota}
        {rachunek}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        W komunikacie przelewu MPP identyfikator zbiorczy stoi w miejscu numeru faktury, a kwota VAT to suma VAT tych
        faktur.
      </p>
      <KopiujWiersz
        etykieta="Identyfikator zbiorczy (w miejscu numeru faktury)"
        wartosc={identyfikator}
        doSchowka={identyfikator}
        opisPrzycisku="Kopiuj identyfikator zbiorczy"
        mono
      />
      {grupa.vat !== null ? (
        <KopiujWiersz
          etykieta="Kwota VAT do komunikatu MPP"
          wartosc={`${formatPlMoney(grupa.vat)} zł`}
          doSchowka={kwotaDoSchowka(grupa.vat)}
          opisPrzycisku="Kopiuj kwotę VAT"
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          Co najmniej jedna z tych faktur podaje wpłaty częściowe, więc kwotę VAT do komunikatu MPP trzeba sprawdzić
          w fakturach.
        </p>
      )}
      <KopiujWiersz
        etykieta="NIP sprzedawcy"
        wartosc={grupa.nip}
        doSchowka={grupa.nip}
        opisPrzycisku="Kopiuj NIP sprzedawcy"
        mono
      />
      {kwota}
      {rachunek}
    </div>
  );
}

function GrupaFaktur({ grupa, mozeTworzyc }: { grupa: GrupaIdentyfikatora; mozeTworzyc: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [nowy, setNowy] = useState<{ identyfikator: string; zapisany: boolean } | null>(null);
  const identyfikator = grupa.identyfikator ?? nowy?.identyfikator ?? null;

  const utworz = () =>
    start(async () => {
      const wynik: IdentyfikatorZbiorczyResult = await utworzIdentyfikatorZbiorczyAction(
        grupa.faktury.map((f) => f.id),
      ).catch(() => ({ success: false as const, error: BLAD }));
      if (!wynik.success) {
        toast.error(wynik.error);
        return;
      }
      setNowy({ identyfikator: wynik.identyfikator, zapisany: wynik.zapisany });
      toast.success(
        wynik.status === 'utworzony' ? 'KSeF nadał identyfikator zbiorczy' : 'Ten identyfikator zbiorczy był już zapisany',
      );
      router.refresh();
    });

  const bezNumeru = grupa.poza.filter((f) => f.powod === 'brak_numeru_ksef');
  const bezMpp = grupa.poza.filter((f) => f.powod === 'mpp_nieznane');

  return (
    <Card data-grupa={grupa.klucz}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="truncate" title={grupa.sprzedawca}>
            {shortenLegalForm(grupa.sprzedawca)}
          </CardTitle>
          <p className="text-muted-foreground font-mono text-xs">NIP {grupa.nip}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <span className="text-base font-semibold tabular-nums">{formatPlMoney(grupa.suma)} zł</span>
          <span className="text-muted-foreground text-xs">
            {faktury(grupa.faktury.length)}
            {grupa.mpp ? ', podzielona płatność (MPP)' : ''}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-xs">Faktury: {grupa.faktury.map((f) => numer(f.numerFaktury)).join(', ')}</p>

        {identyfikator ? (
          <DaneIdentyfikatora grupa={grupa} identyfikator={identyfikator} />
        ) : mozeTworzyc ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              Identyfikator nadaje KSeF dla tych {grupa.faktury.length} faktur. FaktWay go zapisze, więc kolejne
              kliknięcie poda ten sam identyfikator.
            </p>
            <Button
              type="button"
              onClick={utworz}
              disabled={pending}
              className={cn('self-start max-sm:self-stretch', DOTYK)}
            >
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiStackLine aria-hidden />}
              Identyfikator zbiorczy
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Identyfikator zbiorczy tworzy właściciel albo administrator firmy. Do tego czasu każdą z tych faktur można
            zapłacić osobnym przelewem z jej numerem KSeF w tytule.
          </p>
        )}

        {nowy && !nowy.zapisany ? (
          <Alert className="border-amber-600/30" role="status">
            <AlertDescription>
              KSeF nadał identyfikator, ale nie udało się go zapisać w FaktWay. Skopiuj go teraz: po odświeżeniu strony
              może go tu nie być.
            </AlertDescription>
          </Alert>
        ) : null}

        {identyfikator ? (
          <p className="text-muted-foreground text-xs">
            Identyfikator obejmuje dokładnie te faktury. Przelew tylko za część z nich ma w tytule numery KSeF tych
            faktur.
          </p>
        ) : null}

        {grupa.rozneRachunki ? (
          <p className="text-muted-foreground text-xs">
            Faktury podają różne rachunki albo nie podają rachunku, więc nie ma tu jednego rachunku do przelewu.
            Rachunek do zapłaty sprawdź w fakturach.
          </p>
        ) : null}

        {bezNumeru.length > 0 ? (
          <p className="text-muted-foreground text-xs" data-poza="brak_numeru_ksef">
            Poza identyfikatorem: {bezNumeru.map((f) => numer(f.numerFaktury)).join(', ')}.{' '}
            {bezNumeru.length === 1 ? 'Ta faktura nie ma numeru KSeF' : 'Te faktury nie mają numeru KSeF'}, a
            identyfikator obejmuje tylko faktury z numerem KSeF. Fakturę wystawioną offline obejmie, gdy KSeF ją przyjmie
            i nada numer. Faktury awaryjnej albo wystawionej poza KSeF nie obejmie; za taką fakturę płaci się osobnym
            przelewem z jej numerem w tytule.
          </p>
        ) : null}

        {bezMpp.length > 0 ? (
          <p className="text-muted-foreground text-xs" data-poza="mpp_nieznane">
            Poza identyfikatorem: {bezMpp.map((f) => numer(f.numerFaktury)).join(', ')}. Z pliku KSeF nie wiadomo, czy
            obowiązuje podzielona płatność (MPP), więc nie wiadomo, którym przelewem zapłacić. Sprawdź to w fakturze;
            za taką fakturę płaci się osobnym przelewem z jej numerem KSeF w tytule.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function IdentyfikatoryZbiorcze({
  grupy,
  mozeTworzyc,
}: {
  grupy: readonly GrupaIdentyfikatora[];
  /** Właściciel albo administrator (`mozeTworzycIdentyfikator`). */
  mozeTworzyc: boolean;
}) {
  if (grupy.length === 0) return null;
  return (
    <section aria-labelledby="identyfikator-zbiorczy-tytul" className="bg-muted/40 flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <h2 id="identyfikator-zbiorczy-tytul" className="text-sm font-semibold">
          Przelew za kilka faktur jednego dostawcy
        </h2>
        <p className="text-muted-foreground text-xs">
          Od 1 stycznia 2027 r. przy przelewie za kilka faktur jednego dostawcy w tytule podaje się identyfikator
          zbiorczy (art. 108g ustawy o VAT). Identyfikator nadaje KSeF; przy jednej fakturze w tytule wystarczy jej
          numer KSeF. Plik przelewów do banku ma osobny przelew dla każdej faktury, więc identyfikator jest do
          przelewu zleconego w bankowości.
        </p>
      </div>
      <ul className="flex flex-col gap-3" aria-label="Grupy faktur do identyfikatora zbiorczego">
        {grupy.map((grupa) => (
          <li key={grupa.klucz}>
            <GrupaFaktur grupa={grupa} mozeTworzyc={mozeTworzyc} />
          </li>
        ))}
      </ul>
    </section>
  );
}

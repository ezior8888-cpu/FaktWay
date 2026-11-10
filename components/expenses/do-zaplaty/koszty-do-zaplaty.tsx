'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RiCalendarCheckLine } from '@remixicon/react';

import { plDate } from '@/components/expenses/finora/labels';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { ListaDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { formatPlMoney } from '@/lib/format/pl';
import { shortenLegalForm } from '@/lib/format/legal-form';
import { cn } from '@/lib/utils';

import { DanePrzelewu, opisTerminu } from './dane-przelewu';
import { PlikPrzelewow } from './plik-przelewow';

/**
 * Zakładka „Do zapłaty” w Wydatkach (krok 3.4, część 1). Nowy widok z
 * komponentów Finory (karta, plakietka, awatar), w karcie sekcji Kosztów:
 * podsumowanie (suma, po terminie), potem koszty od najbliższego terminu.
 * Na telefonie karty jedna pod drugą, pola dotyku co najmniej 44 px.
 *
 * Część 2 (plik przelewów): kto może płacić, ten zaznacza koszty polem przy
 * nazwie sprzedawcy i pobiera plik Elixir-0 z bloku nad listą (decyzja D1:
 * nowy blok i pole wyboru, reszta karty bez zmian).
 */

function kosztowWalutach(n: number): string {
  if (n === 1) return '1 koszt w walucie obcej ma';
  const ostatnia = n % 10;
  const nastolatki = n % 100 >= 12 && n % 100 <= 14;
  return ostatnia >= 2 && ostatnia <= 4 && !nastolatki ? `${n} koszty w walutach obcych mają` : `${n} kosztów w walutach obcych ma`;
}

export function KosztyDoZaplaty({
  lista,
  dzis,
  mozeOznaczac,
  obcieta = false,
  rachunekFirmy = null,
}: {
  lista: ListaDoZaplaty;
  dzis: string;
  mozeOznaczac: boolean;
  /** Zapytanie oddało pełną paczkę: suma dotyczy tylko pokazanych kosztów. */
  obcieta?: boolean;
  /** Rachunek firmy z Ustawień (26 cyfr): rachunek zleceniodawcy w pliku przelewów. */
  rachunekFirmy?: string | null;
}) {
  const { pozycje, suma, przeterminowane, pominiete } = lista;
  const [wybrane, setWybrane] = useState<Set<string>>(() => new Set());
  // Koszt oznaczony jako zapłacony znika z listy po odświeżeniu: nie liczy się już do pliku.
  const zaznaczone = new Set(pozycje.filter((p) => wybrane.has(p.id)).map((p) => p.id));
  const przelacz = (id: string, tak: boolean) =>
    setWybrane((obecne) => {
      const nowe = new Set(obecne);
      if (tak) nowe.add(id);
      else nowe.delete(id);
      return nowe;
    });

  return (
    <div className="flex flex-col gap-4 px-4 pb-6">
      {pozycje.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="bg-muted/40 p-3">
            <div className="text-muted-foreground text-xs">Razem do zapłaty</div>
            <div className="text-lg font-semibold tabular-nums">{formatPlMoney(suma)} zł</div>
          </div>
          <div className={cn('p-3', przeterminowane.liczba > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted/40')}>
            <div className="text-xs">Po terminie: {przeterminowane.liczba}</div>
            <div className="text-lg font-semibold tabular-nums">{formatPlMoney(przeterminowane.suma)} zł</div>
          </div>
          <div className="bg-muted/40 p-3">
            <div className="text-muted-foreground text-xs">Faktur do zapłaty</div>
            <div className="text-lg font-semibold tabular-nums">{pozycje.length}</div>
          </div>
        </div>
      ) : null}

      {obcieta ? (
        <Alert className="border-amber-600/30">
          <AlertDescription>
            Lista pokazuje 500 kosztów z najbliższym terminem, a suma dotyczy tylko ich. Zapłacone koszty oznacz jako
            zapłacone, żeby zobaczyć kolejne.
          </AlertDescription>
        </Alert>
      ) : null}

      {pominiete > 0 ? (
        <Alert className="border-amber-600/30">
          <AlertDescription>
            {kosztowWalutach(pominiete)} termin płatności. Nie ma ich na tej liście ani w sumie, bo kwota do zapłaty jest
            w innej walucie niż złote: kwotę i rachunek sprawdź w fakturze (zakładka Miesiąc).
          </AlertDescription>
        </Alert>
      ) : null}

      {mozeOznaczac && pozycje.length > 0 ? (
        <PlikPrzelewow pozycje={pozycje} zaznaczone={zaznaczone} onZaznacz={setWybrane} rachunekFirmy={rachunekFirmy} />
      ) : null}

      {pozycje.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Avatar className="size-12 after:border-0">
            <AvatarFallback className="bg-primary/10 text-primary [&>svg]:size-6">
              <RiCalendarCheckLine />
            </AvatarFallback>
          </Avatar>
          <h3 className="text-foreground text-base font-semibold">Nie ma kosztów do zapłaty z terminem</h3>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            Termin, rachunek i tytuł przelewu pojawiają się tu przy fakturach kosztowych z KSeF, które podają termin
            płatności.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Koszty do zapłaty">
          {pozycje.map((koszt) => (
            <li key={koszt.id}>
              <Card data-przeterminowany={koszt.przeterminowany ? 'true' : 'false'} className={cn(koszt.przeterminowany && 'border-destructive/50')}>
                <CardHeader className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    {mozeOznaczac ? (
                      <label className="flex shrink-0 cursor-pointer items-center justify-center pt-0.5 max-lg:min-h-[44px] max-lg:min-w-[44px] max-lg:pt-0">
                        <Checkbox
                          checked={zaznaczone.has(koszt.id)}
                          onCheckedChange={(tak) => przelacz(koszt.id, tak === true)}
                          aria-label={`Do pliku przelewów: ${shortenLegalForm(koszt.sprzedawca)}, ${koszt.numerFaktury || 'bez numeru'}`}
                        />
                      </label>
                    ) : null}
                    <div className="min-w-0">
                      <CardTitle className="truncate" title={koszt.sprzedawca}>
                        <Link href={`/expenses/${koszt.id}`} className="hover:underline">
                          {shortenLegalForm(koszt.sprzedawca)}
                        </Link>
                      </CardTitle>
                      <p className="text-muted-foreground font-mono text-xs">
                        {koszt.nip ? `NIP ${koszt.nip}` : 'bez NIP'} · {koszt.numerFaktury || 'bez numeru'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-right">
                    <span className="text-base font-semibold tabular-nums">{formatPlMoney(koszt.kwota)} zł</span>
                    <span className="text-muted-foreground text-xs">Termin {plDate(koszt.termin)}</span>
                    <Badge variant={koszt.przeterminowany ? 'destructive' : 'outline'}>{opisTerminu(koszt)}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <DanePrzelewu koszt={koszt} dzis={dzis} mozeOznaczac={mozeOznaczac} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

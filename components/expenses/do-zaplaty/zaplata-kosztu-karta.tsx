'use client';

import { RiArrowGoBackLine, RiLoader4Line } from '@remixicon/react';

import { plDate } from '@/components/expenses/finora/labels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';

import { DanePrzelewu, OznaczZaplacone, opisTerminu, useCofnijZaplate } from './dane-przelewu';

/**
 * Karta „Płatność” na stronie kosztu (krok 3.4, część 1). Decyzja D1: nowa
 * sekcja istniejącym komponentem `Card` na końcu kolumny kart, nic nie jest
 * przestawione. Zapłacony koszt: dzień zapłaty i „Cofnij zapłatę”;
 * niezapłacony z terminem: dane do przelewu jak na liście „Do zapłaty”.
 */
export function ZaplataKosztuKarta({
  expenseId,
  zaplaconoDnia,
  koszt,
  termin,
  dzis,
  mozeOznaczac,
}: {
  expenseId: string;
  zaplaconoDnia: string | null;
  /** Pozycja listy „Do zapłaty” (koszt w złotych z faktury KSeF), inaczej `null`. */
  koszt: KosztDoZaplaty | null;
  termin: string | null;
  dzis: string;
  mozeOznaczac: boolean;
}) {
  const { cofnij, pending } = useCofnijZaplate();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Płatność</CardTitle>
        <CardDescription>
          {zaplaconoDnia
            ? `Zapłacono ${plDate(zaplaconoDnia)}`
            : termin
              ? `Termin ${plDate(termin)}${koszt ? `: ${opisTerminu(koszt).toLowerCase()}` : ''}`
              : 'Faktura nie podaje terminu płatności'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {zaplaconoDnia ? (
          mozeOznaczac ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => cofnij(expenseId)}
              disabled={pending}
              className="self-start max-lg:min-h-[44px]"
            >
              {pending ? <RiLoader4Line className="animate-spin" /> : <RiArrowGoBackLine />}
              Cofnij zapłatę
            </Button>
          ) : null
        ) : koszt ? (
          <DanePrzelewu koszt={koszt} dzis={dzis} mozeOznaczac={mozeOznaczac} />
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {termin
                ? 'Kwotę, rachunek i tytuł przelewu tego kosztu sprawdź w fakturze: koszt jest w innej walucie niż złote albo nie pochodzi z KSeF.'
                : 'Bez terminu płatności ten koszt nie trafia na listę „Do zapłaty”. Zapłatę możesz oznaczyć tutaj.'}
            </p>
            {mozeOznaczac ? <OznaczZaplacone expenseId={expenseId} dzis={dzis} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

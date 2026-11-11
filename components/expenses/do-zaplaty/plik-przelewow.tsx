'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { RiDownload2Line, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { pobierzPlikPrzelewowAction } from '@/app/actions/plik-przelewow';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { saveBlob } from '@/lib/download';
import type { KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';
import {
  LIMIT_PRZELEWOW_W_PLIKU,
  type PlikPrzelewowResult,
  type PodsumowaniePliku,
} from '@/lib/expenses/plik-przelewow';
import { KOTWICA_RACHUNKU_FIRMY, rachunekFirmyDoCzytania } from '@/lib/expenses/rachunek-firmy';
import { formatPlMoney } from '@/lib/format/pl';
import { shortenLegalForm } from '@/lib/format/legal-form';

/**
 * Plik przelewów na liście „Do zapłaty” (krok 3.4, część 2): nowy blok
 * z istniejących komponentów (przycisk, alert) nad kosztami, a po pobraniu
 * podsumowanie: co weszło do pliku i co zostało poza nim z powodem.
 * Na telefonie przyciski jeden pod drugim, pola dotyku co najmniej 44 px.
 */

const DOTYK = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';
const BLAD = 'Nie udało się przygotować pliku przelewów. Sprawdź połączenie i spróbuj ponownie.';

const dataPl = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

function przelewy(n: number): string {
  if (n === 1) return '1 przelew';
  const ostatnia = n % 10;
  const nastolatki = n % 100 >= 12 && n % 100 <= 14;
  return ostatnia >= 2 && ostatnia <= 4 && !nastolatki ? `${n} przelewy` : `${n} przelewów`;
}

function plikZBase64(base64: string): Blob {
  const tekst = atob(base64);
  const bajty = new Uint8Array(tekst.length);
  for (let i = 0; i < tekst.length; i++) bajty[i] = tekst.charCodeAt(i);
  return new Blob([bajty], { type: 'text/plain;charset=windows-1250' });
}

export function PodsumowaniePlikuPrzelewow({ podsumowanie }: { podsumowanie: PodsumowaniePliku }) {
  const { nazwaPliku, liczba, suma, mpp, przelewy: wPliku, pominiete, dzien } = podsumowanie;
  const sprawdzone = wPliku.filter((p) => p.bialaLista);

  return (
    <div className="flex flex-col gap-3" role="status">
      {nazwaPliku ? (
        <Alert className="border-green-600/30">
          <AlertTitle>
            Plik {nazwaPliku}: {przelewy(liczba)} na {formatPlMoney(suma)} zł
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Wgraj go w bankowości firmowej jako import przelewów w formacie Elixir-0 (kodowanie Windows-1250)
              i sprawdź przelewy przed zatwierdzeniem. Data wykonania to termin płatności, a gdy termin już minął: dziś.
            </p>
            {mpp > 0 ? (
              <p>
                W pliku {mpp === 1 ? 'jest 1 przelew' : `są ${przelewy(mpp)}`} w podzielonej płatności (MPP, kod 53,
                komunikat VAT z numerem KSeF). Przed zatwierdzeniem sprawdź w banku, że bank pokazuje je jako przelewy
                MPP. Jeśli nie, usuń je z paczki i zapłać jako przelew MPP.
              </p>
            ) : null}
            {sprawdzone.length > 0 ? (
              <p>
                Sprawdzone w wykazie podatników VAT (stan na {dataPl(dzien)}):{' '}
                {sprawdzone
                  .map((p) => `${shortenLegalForm(p.sprzedawca)}, numer zapytania ${p.bialaLista!.requestId}`)
                  .join('; ')}
                . Wykaz liczy się na dzień zlecenia przelewu, więc plik wgraj w banku dziś.
              </p>
            ) : null}
            <p>
              Pobranie pliku niczego nie oznacza jako zapłacone. Po zapłacie użyj „Oznacz jako zapłacone” przy koszcie.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-amber-600/30">
          <AlertTitle>Żaden z zaznaczonych kosztów nie trafił do pliku</AlertTitle>
          <AlertDescription>
            <p>Powody są niżej. Te koszty zapłać w bankowości.</p>
          </AlertDescription>
        </Alert>
      )}
      {pominiete.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Pominięte: {pominiete.length}</h3>
          <ul className="flex flex-col gap-2 text-sm">
            {pominiete.map((p) => (
              <li key={p.id} data-kod={p.kod}>
                <span className="font-medium">
                  {shortenLegalForm(p.sprzedawca)}
                  {p.numerFaktury ? `, ${p.numerFaktury}` : ''}:
                </span>{' '}
                <span className="text-muted-foreground">{p.powod}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function PlikPrzelewow({
  pozycje,
  zaznaczone,
  onZaznacz,
  rachunekFirmy,
}: {
  pozycje: readonly KosztDoZaplaty[];
  zaznaczone: ReadonlySet<string>;
  onZaznacz: (ids: Set<string>) => void;
  /** 26 cyfr z Ustawień albo `null` (plik odmówi z komunikatem, co uzupełnić). */
  rachunekFirmy: string | null;
}) {
  const [pending, start] = useTransition();
  const [podsumowanie, setPodsumowanie] = useState<PodsumowaniePliku | null>(null);
  const doWyboru = pozycje.slice(0, LIMIT_PRZELEWOW_W_PLIKU);
  const wszystkie = doWyboru.length > 0 && doWyboru.every((p) => zaznaczone.has(p.id));
  const zaDuzo = zaznaczone.size > LIMIT_PRZELEWOW_W_PLIKU;

  const pobierz = () =>
    start(async () => {
      const wynik: PlikPrzelewowResult = await pobierzPlikPrzelewowAction([...zaznaczone]).catch(() => ({
        success: false as const,
        error: BLAD,
      }));
      if (!wynik.success) {
        toast.error(wynik.error);
        return;
      }
      setPodsumowanie(wynik.podsumowanie);
      if (wynik.plik) {
        saveBlob(plikZBase64(wynik.plik.base64), wynik.plik.nazwa);
        toast.success(`Pobrano plik: ${przelewy(wynik.podsumowanie.liczba)}`);
      } else {
        toast.info('Żaden z zaznaczonych kosztów nie trafił do pliku. Powody są pod przyciskiem.');
      }
    });

  return (
    <section aria-labelledby="plik-przelewow-tytul" className="bg-muted/40 flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <h2 id="plik-przelewow-tytul" className="text-sm font-semibold">
          Plik przelewów do banku
        </h2>
        <p className="text-muted-foreground text-xs">
          Zaznacz koszty i pobierz plik Elixir-0 do importu przelewów w bankowości firmowej. Pobranie pliku nie
          oznacza kosztów jako zapłaconych.
        </p>
        {rachunekFirmy ? (
          <p className="text-xs">
            Przelewy z rachunku firmy: <span className="font-mono">{rachunekFirmyDoCzytania(rachunekFirmy)}</span>
          </p>
        ) : null}
      </div>
      {rachunekFirmy ? null : (
        <Alert className="border-amber-600/30">
          <AlertDescription>
            <p>
              Uzupełnij rachunek firmy w{' '}
              <Link href={`/settings#${KOTWICA_RACHUNKU_FIRMY}`} className="text-primary underline underline-offset-2">
                Ustawieniach (zakładka Firma)
              </Link>
              : z niego plik zleca przelewy.
            </p>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <Button
          type="button"
          variant="outline"
          onClick={() => onZaznacz(wszystkie ? new Set() : new Set(doWyboru.map((p) => p.id)))}
          className={DOTYK}
        >
          {wszystkie ? 'Odznacz wszystkie' : 'Zaznacz wszystkie'}
        </Button>
        <Button
          type="button"
          onClick={pobierz}
          disabled={!rachunekFirmy || zaznaczone.size === 0 || zaDuzo || pending}
          className={DOTYK}
        >
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiDownload2Line aria-hidden />}
          Pobierz plik przelewów{zaznaczone.size > 0 ? ` (${zaznaczone.size})` : ''}
        </Button>
      </div>
      {pozycje.length > LIMIT_PRZELEWOW_W_PLIKU ? (
        <p className="text-muted-foreground text-xs">
          „Zaznacz wszystkie” bierze {LIMIT_PRZELEWOW_W_PLIKU} kosztów z najbliższym terminem: tyle przelewów
          przyjmuje w jednym pliku część banków.
        </p>
      ) : null}
      {zaDuzo ? (
        <p className="text-destructive text-xs">
          Plik może mieć najwyżej {LIMIT_PRZELEWOW_W_PLIKU} przelewów. Odznacz część kosztów.
        </p>
      ) : null}
      {podsumowanie ? <PodsumowaniePlikuPrzelewow podsumowanie={podsumowanie} /> : null}
    </section>
  );
}

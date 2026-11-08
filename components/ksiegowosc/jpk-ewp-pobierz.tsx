'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { pobierzJpkEwpAction, pobierzJpkPkpirAction } from '@/app/actions/ksiegowosc-ewidencja';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { saveBlob } from '@/lib/download';

/**
 * Pobranie pliku JPK_EWP(4) albo, przy skali i liniowym (K7), JPK_PKPIR(3)
 * za okres od 1 stycznia. Imię, nazwisko i datę urodzenia schemat MF wymaga
 * dla osoby fizycznej; FaktWay ich nie zapisuje, więc klient podaje je przy
 * każdym pobraniu (jak dane autoryzujące w D9).
 */
export function JpkEwpPobierz({ rok, doMiesiaca, plik = 'JPK_EWP' }: { rok: number; doMiesiaca: number; plik?: 'JPK_EWP' | 'JPK_PKPIR' }) {
  const [imie, setImie] = useState('');
  const [nazwisko, setNazwisko] = useState('');
  const [dataUrodzenia, setDataUrodzenia] = useState('');
  const [blad, setBlad] = useState<{ pole?: string; tekst: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const pobierz = () =>
    startTransition(async () => {
      setBlad(null);
      const akcja = plik === 'JPK_PKPIR' ? pobierzJpkPkpirAction : pobierzJpkEwpAction;
      const wynik = await akcja({ rok, doMiesiaca, imie, nazwisko, dataUrodzenia });
      if (wynik.success) {
        saveBlob(new Blob([wynik.xml], { type: 'application/xml' }), wynik.nazwa);
        toast.success(`Plik ${plik} pobrany`);
      } else {
        setBlad({ pole: wynik.pole, tekst: wynik.error });
        toast.error(wynik.error);
      }
    });

  const komunikat = (pole: string) =>
    blad?.pole === pole ? (
      <p id={`jpk-blad-${pole}`} role="alert" className="text-destructive text-xs">
        {blad.tekst}
      </p>
    ) : null;

  return (
    <FieldGroup>
      <FieldDescription>
        Imię, nazwisko i data urodzenia trafiają tylko do tego pliku. FaktWay ich nie zapisuje.
      </FieldDescription>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="jpk-imie">Pierwsze imię</FieldLabel>
          <Input id="jpk-imie" value={imie} autoComplete="given-name" disabled={pending} onChange={(e) => setImie(e.target.value)} />
          {komunikat('imie')}
        </Field>
        <Field>
          <FieldLabel htmlFor="jpk-nazwisko">Nazwisko</FieldLabel>
          <Input
            id="jpk-nazwisko"
            value={nazwisko}
            autoComplete="family-name"
            disabled={pending}
            onChange={(e) => setNazwisko(e.target.value)}
          />
          {komunikat('nazwisko')}
        </Field>
        <Field>
          <FieldLabel htmlFor="jpk-data-urodzenia">Data urodzenia</FieldLabel>
          <Input
            id="jpk-data-urodzenia"
            type="date"
            value={dataUrodzenia}
            disabled={pending}
            onChange={(e) => setDataUrodzenia(e.target.value)}
          />
          {komunikat('dataUrodzenia')}
        </Field>
      </div>
      {blad && !blad.pole ? (
        <p role="alert" className="text-destructive text-sm">
          {blad.tekst}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" onClick={pobierz} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Pobierz {plik}
        </Button>
      </div>
    </FieldGroup>
  );
}

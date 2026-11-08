'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { pobierzJpkV7mAction, pobierzUpoJpkAction, sprawdzStatusJpkAction, wyslijJpkV7mAction } from '@/app/actions/ksiegowosc-vat';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { saveBlob } from '@/lib/download';

/**
 * Akcje ekranu VAT (plan księgowości JDG, K6). Imię, nazwisko i data
 * urodzenia trafiają tylko do pliku i do danych autoryzujących; FaktWay ich
 * nie zapisuje, więc klient podaje je przy każdym pobraniu i wysyłce (D9).
 */

/** Kwota w złotych z przecinkiem albo kropką, bez separatorów tysięcy, na grosze; null: niepoprawna. */
function naGrosze(tekst: string): number | null {
  const t = tekst.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [zl, gr = ''] = t.split('.');
  return Number(zl) * 100 + Number(gr.padEnd(2, '0'));
}

/** Nadwyżka z deklaracji za poprzedni miesiąc (P_62, pełne złote), wpisana przez klienta: idzie do adresu strony. */
export function NadwyzkaPoprzednia({ adres, poprzedni, wartosc }: { adres: string; poprzedni: string; wartosc: number | null }) {
  const router = useRouter();
  const [tekst, setTekst] = useState(wartosc === null ? '' : String(wartosc));
  const [blad, setBlad] = useState<string | null>(null);
  const zastosuj = () => {
    const t = tekst.replace(/\s/g, '');
    if (!/^\d+$/.test(t)) {
      setBlad('Nadwyżka w pełnych złotych, bez groszy (także 0).');
      return;
    }
    setBlad(null);
    const url = new URL(adres, window.location.origin);
    url.searchParams.set('nadwyzka', String(Number(t)));
    router.push(`${url.pathname}?${url.searchParams.toString()}`);
  };
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="vat-nadwyzka">Nadwyżka z deklaracji za {poprzedni} (P_62), zł</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input id="vat-nadwyzka" inputMode="numeric" className="max-w-48" value={tekst} onChange={(e) => setTekst(e.target.value)} />
          <Button type="button" variant="outline" onClick={zastosuj}>
            Przelicz
          </Button>
        </div>
        <FieldDescription>Kwota z deklaracji złożonej poza FaktWay; przy jej braku 0.</FieldDescription>
        {blad ? (
          <p role="alert" className="text-destructive text-xs">
            {blad}
          </p>
        ) : null}
      </Field>
    </FieldGroup>
  );
}

function useDaneOsoby(emailKonta: string | null) {
  const [imie, setImie] = useState('');
  const [nazwisko, setNazwisko] = useState('');
  const [dataUrodzenia, setDataUrodzenia] = useState('');
  const [email, setEmail] = useState(emailKonta ?? '');
  return { imie, setImie, nazwisko, setNazwisko, dataUrodzenia, setDataUrodzenia, email, setEmail };
}

function PolaOsoby({ id, osoba, pending, komunikat }: { id: string; osoba: ReturnType<typeof useDaneOsoby>; pending: boolean; komunikat: (pole: string) => React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field>
        <FieldLabel htmlFor={`${id}-imie`}>Pierwsze imię</FieldLabel>
        <Input id={`${id}-imie`} value={osoba.imie} autoComplete="given-name" disabled={pending} onChange={(e) => osoba.setImie(e.target.value)} />
        {komunikat('imie')}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-nazwisko`}>Nazwisko</FieldLabel>
        <Input
          id={`${id}-nazwisko`}
          value={osoba.nazwisko}
          autoComplete="family-name"
          disabled={pending}
          onChange={(e) => osoba.setNazwisko(e.target.value)}
        />
        {komunikat('nazwisko')}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-data-urodzenia`}>Data urodzenia</FieldLabel>
        <Input
          id={`${id}-data-urodzenia`}
          type="date"
          value={osoba.dataUrodzenia}
          disabled={pending}
          onChange={(e) => osoba.setDataUrodzenia(e.target.value)}
        />
        {komunikat('dataUrodzenia')}
      </Field>
      <Field className="sm:col-span-3">
        <FieldLabel htmlFor={`${id}-email`}>E-mail podatnika w pliku</FieldLabel>
        <Input id={`${id}-email`} type="email" value={osoba.email} autoComplete="email" disabled={pending} onChange={(e) => osoba.setEmail(e.target.value)} />
        {komunikat('email')}
      </Field>
    </div>
  );
}

function useBlad() {
  const [blad, setBlad] = useState<{ pole?: string; tekst: string } | null>(null);
  const komunikat = (pole: string) =>
    blad?.pole === pole ? (
      <p role="alert" className="text-destructive text-xs">
        {blad.tekst}
      </p>
    ) : null;
  const ogolny = blad && !blad.pole ? (
    <p role="alert" className="text-destructive text-sm">
      {blad.tekst}
    </p>
  ) : null;
  return { setBlad, komunikat, ogolny };
}

export function JpkV7mPobierz({ miesiac, nadwyzka, email }: { miesiac: string; nadwyzka: number | null; email: string | null }) {
  const osoba = useDaneOsoby(email);
  const { setBlad, komunikat, ogolny } = useBlad();
  const [pending, startTransition] = useTransition();
  const pobierz = () =>
    startTransition(async () => {
      setBlad(null);
      const wynik = await pobierzJpkV7mAction({
        miesiac,
        nadwyzka,
        imie: osoba.imie,
        nazwisko: osoba.nazwisko,
        dataUrodzenia: osoba.dataUrodzenia,
        email: osoba.email,
      });
      if (wynik.success) {
        saveBlob(new Blob([wynik.xml], { type: 'application/xml' }), wynik.nazwa);
        toast.success('Plik JPK_V7M pobrany');
      } else {
        setBlad({ pole: wynik.pole, tekst: wynik.error });
        toast.error(wynik.error);
      }
    });
  return (
    <FieldGroup>
      <FieldDescription>
        Imię, nazwisko i data urodzenia trafiają tylko do tego pliku. FaktWay ich nie zapisuje.
      </FieldDescription>
      <PolaOsoby id="v7m" osoba={osoba} pending={pending} komunikat={komunikat} />
      {ogolny}
      <div className="flex justify-end">
        <Button type="button" onClick={pobierz} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Pobierz JPK_V7M
        </Button>
      </div>
    </FieldGroup>
  );
}

export function JpkV7mWyslij({
  miesiac,
  nadwyzka,
  rokKwoty,
  testowe,
  korekta,
  email,
}: {
  miesiac: string;
  nadwyzka: number | null;
  rokKwoty: number;
  testowe: boolean;
  korekta: boolean;
  email: string | null;
}) {
  const router = useRouter();
  const osoba = useDaneOsoby(email);
  const [kwota, setKwota] = useState('');
  const { setBlad, komunikat, ogolny } = useBlad();
  const [pending, startTransition] = useTransition();
  const wyslij = () =>
    startTransition(async () => {
      setBlad(null);
      const kwotaGr = naGrosze(kwota);
      if (kwotaGr === null) {
        setBlad({ pole: 'kwotaGr', tekst: 'Kwota przychodu w złotych, np. 54321,98.' });
        return;
      }
      const wynik = await wyslijJpkV7mAction({
        miesiac,
        nadwyzka,
        imie: osoba.imie,
        nazwisko: osoba.nazwisko,
        dataUrodzenia: osoba.dataUrodzenia,
        email: osoba.email,
        kwotaGr,
      });
      if (wynik.success) {
        // Kwota przychodu nie zostaje w formularzu po wysyłce.
        setKwota('');
        toast.success(wynik.duplikat ? 'MF ma już ten plik; status jest na liście wysyłek' : 'Plik wysłany do MF');
        router.refresh();
      } else {
        setBlad({ pole: wynik.pole, tekst: wynik.error });
        toast.error(wynik.error);
      }
    });
  return (
    <FieldGroup>
      <FieldDescription>
        Dane autoryzujące: imię, nazwisko, data urodzenia i kwota przychodu z zeznania za {rokKwoty} r. FaktWay ich nie zapisuje; są
        potrzebne przy każdej wysyłce.{korekta ? ' MF przyjęło już deklarację za ten miesiąc, więc ten plik to korekta.' : ''}
        {testowe ? ' Wysyłka idzie na środowisko testowe MF i nie jest złożeniem deklaracji.' : ''}
      </FieldDescription>
      <PolaOsoby id="mf" osoba={osoba} pending={pending} komunikat={komunikat} />
      <Field>
        <FieldLabel htmlFor="mf-kwota">Przychód z zeznania za {rokKwoty} r., zł</FieldLabel>
        <Input id="mf-kwota" inputMode="decimal" autoComplete="off" className="max-w-48" value={kwota} disabled={pending} onChange={(e) => setKwota(e.target.value)} />
        {komunikat('kwotaGr')}
      </Field>
      {ogolny}
      <div className="flex justify-end">
        <Button type="button" onClick={wyslij} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Wyślij do MF
        </Button>
      </div>
    </FieldGroup>
  );
}

/** Status wysyłki w toku: sprawdzany raz po otwarciu strony i na przycisk. */
export function SprawdzStatus({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const sprawdzone = useRef(false);
  const sprawdz = (cicho: boolean) =>
    startTransition(async () => {
      const wynik = await sprawdzStatusJpkAction({ id });
      if (!wynik.success) {
        if (!cicho) toast.error(wynik.error);
        return;
      }
      if (wynik.stan !== 'w_toku') router.refresh();
      else if (!cicho) toast.message(wynik.tresc);
    });
  useEffect(() => {
    if (sprawdzone.current) return;
    sprawdzone.current = true;
    sprawdz(true);
    // Jedno sprawdzenie po otwarciu strony.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => sprawdz(false)} disabled={pending}>
      {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      Sprawdź status
    </Button>
  );
}

export function PobierzUpo({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const pobierz = () =>
    startTransition(async () => {
      const wynik = await pobierzUpoJpkAction({ id });
      if (wynik.success) saveBlob(new Blob([wynik.xml], { type: 'application/xml' }), wynik.nazwa);
      else toast.error(wynik.error);
    });
  return (
    <Button type="button" variant="outline" size="sm" onClick={pobierz} disabled={pending}>
      {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      Pobierz UPO
    </Button>
  );
}

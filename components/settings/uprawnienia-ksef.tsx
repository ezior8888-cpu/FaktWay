'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RiBuilding2Line, RiLoader4Line, RiShieldKeyholeLine } from '@remixicon/react';
import { toast } from 'sonner';

import {
  nadajUprawnienieKsefAction,
  odbierzUprawnienieKsefAction,
  sprawdzUprawnienieKsefAction,
} from '@/app/actions/uprawnienia-ksef';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  NAPISY_AKCJI,
  NAZWY_ZAKRESOW,
  OPISY_ZAKRESOW,
  ZAKRESY,
  biuroWZdaniu,
  nadanieUprawnieniaSchema,
  normalizujNip,
  stanDlaKlienta,
  type AkcjaUprawnienia,
  type SekcjaUprawnien,
  type Ton,
  type UprawnienieBiura,
  type WynikUprawnienia,
  type Zakres,
} from '@/lib/accountant/uprawnienia-ksef';
import { cn } from '@/lib/utils';

/**
 * „Uprawnienie dla biura rachunkowego w KSeF” (Ustawienia, zakładka Księgowa;
 * plan kompletnej aplikacji, krok 6.2, część 4). Decyzja D1: nowa sekcja
 * z istniejących komponentów (pola, przełączniki, odznaki i wiersze jak
 * `accountant-list.tsx`), pod linkami dla księgowej. Na telefonie przyciski
 * na całą szerokość i pola dotyku 44 px (`max-sm:`).
 *
 * Formularz sprawdza dane tym samym schematem co akcja (konwencja repo);
 * nadanie, sprawdzenie i odebranie robią akcje serwerowe
 * (`app/actions/uprawnienia-ksef.ts`), a lista odświeża się z bazy.
 */

/** Tekst odznak w jasnym motywie bez green-600 i amber-600 (kontrast WCAG AA). */
const TONY: Readonly<Record<Ton, string>> = {
  ok: 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400',
  czeka: 'bg-amber-600/10 text-amber-800 dark:bg-amber-400/10 dark:text-amber-400',
  blad: 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-400',
  neutralny: '',
};

const DOTYK = 'max-sm:min-h-11 max-sm:w-full';

export function UprawnieniaKsefBiura({ firma, sekcja }: { firma: string; sekcja: SekcjaUprawnien }) {
  const [stepUp, setStepUp] = useState<string | null>(null);

  return (
    <section aria-labelledby="ksef-biuro-tytul" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <RiShieldKeyholeLine className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p id="ksef-biuro-tytul" className="text-sm font-medium">
            Uprawnienie dla biura rachunkowego w KSeF
          </p>
          <p className="text-muted-foreground text-xs/relaxed">
            Z tym uprawnieniem biuro pobiera faktury firmy prosto z KSeF, w swoim programie albo w Aplikacji Podatnika.
            Nadajesz je i odbierasz tutaj, bez logowania do Aplikacji Podatnika KSeF. Robi to tylko właściciel firmy.
          </p>
        </div>
      </div>

      {sekcja.srodowisko === 'test' ? (
        <Alert role="status">
          <AlertDescription>Środowisko testowe: uprawnienie trafi tylko do KSeF testowego, nie do produkcyjnego.</AlertDescription>
        </Alert>
      ) : null}

      <Tresc firma={firma} sekcja={sekcja} onStepUp={setStepUp} />

      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings/accountant">
          {stepUp} Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ) : null}
    </section>
  );
}

function Tresc({ firma, sekcja, onStepUp }: { firma: string; sekcja: SekcjaUprawnien; onStepUp: (tekst: string | null) => void }) {
  if (sekcja.srodowisko === null) {
    return (
      <Alert role="status">
        <AlertDescription>
          FaktWay nie ma teraz bezpiecznie ustawionego środowiska KSeF, więc nie nada ani nie odbierze uprawnienia. Do tego
          czasu zrobisz to w Aplikacji Podatnika KSeF; napisz też do pomocy FaktWay.
        </AlertDescription>
      </Alert>
    );
  }
  if (sekcja.lista.rodzaj === 'niedostepna') {
    return (
      <Alert role="status">
        <AlertDescription>
          Nadawanie uprawnień w KSeF będzie dostępne po najbliższej aktualizacji FaktWay. Do tego czasu uprawnienie nadasz
          w Aplikacji Podatnika KSeF.
        </AlertDescription>
      </Alert>
    );
  }
  if (sekcja.lista.rodzaj === 'blad') {
    return (
      <Alert role="status">
        <AlertDescription>Nie udało się wczytać listy uprawnień w KSeF. Odśwież stronę za chwilę.</AlertDescription>
      </Alert>
    );
  }

  const wiersze = sekcja.lista.wiersze;
  return (
    <div className="flex flex-col gap-4">
      {sekcja.polaczono ? (
        <FormularzNadania firma={firma} nipFirmy={sekcja.nipFirmy} onStepUp={onStepUp} />
      ) : (
        <Alert role="status">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              Najpierw połącz FaktWay z KSeF certyfikatem właściciela firmy. Uprawnienie nadaje KSeF w imieniu firmy, więc bez
              połączenia FaktWay go nie nada ani nie odbierze.
            </span>
            <Link href="/settings/ksef" className={buttonVariants({ variant: 'outline' })}>
              Ustawienia KSeF
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Biura z uprawnieniem</p>
        {wiersze.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiBuilding2Line />
              </EmptyMedia>
              <EmptyTitle>Żadne biuro nie ma jeszcze uprawnienia nadanego z FaktWay</EmptyTitle>
              <EmptyDescription>Po nadaniu biuro pojawi się tutaj razem ze stanem w KSeF.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          wiersze.map((w) => <WierszUprawnienia key={w.id} w={w} teraz={sekcja.teraz} firma={firma} onStepUp={onStepUp} />)
        )}
      </div>
    </div>
  );
}

function FormularzNadania({
  firma,
  nipFirmy,
  onStepUp,
}: {
  firma: string;
  nipFirmy: string | null;
  onStepUp: (tekst: string | null) => void;
}) {
  const router = useRouter();
  const [nip, setNip] = useState('');
  const [nazwa, setNazwa] = useState('');
  const [zakres, setZakres] = useState<Zakres>('odczyt');
  const [przekazanie, setPrzekazanie] = useState(true);
  const [bledy, setBledy] = useState<Partial<Record<'nip' | 'nazwa' | 'zakres', string>>>({});
  const [pending, startTransition] = useTransition();

  const wyslij = () => {
    const dane = nadanieUprawnieniaSchema.safeParse({ firma, nip, nazwa, zakres, przekazanie });
    if (!dane.success) {
      const nowe: typeof bledy = {};
      for (const issue of dane.error.issues) {
        const pole = issue.path[0];
        if ((pole === 'nip' || pole === 'nazwa' || pole === 'zakres') && !nowe[pole]) nowe[pole] = issue.message;
      }
      setBledy(nowe);
      if (Object.keys(nowe).length === 0) toast.error('Odśwież stronę i spróbuj ponownie.');
      return;
    }
    if (nipFirmy && normalizujNip(nipFirmy) === dane.data.nip) {
      setBledy({ nip: 'To NIP Twojej firmy. Uprawnienie nadaje się biuru rachunkowemu, więc wpisz NIP biura.' });
      return;
    }
    setBledy({});
    onStepUp(null);
    startTransition(async () => {
      const wynik = await nadajUprawnienieKsefAction(dane.data);
      if (wynik.success) {
        toast.success(wynik.komunikat);
        setNip('');
        setNazwa('');
      } else if (wynik.mfaStepUp) {
        onStepUp(wynik.error);
        return;
      } else {
        toast.error(wynik.error);
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4 border p-3">
      <div>
        <p className="text-sm font-medium">Nadaj uprawnienie biuru</p>
        <p className="text-muted-foreground text-xs">
          KSeF sprawdzi NIP biura i nada uprawnienie w imieniu firmy. Wynik zwykle jest po chwili.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field data-invalid={bledy.nip ? true : undefined}>
          <FieldLabel htmlFor="ksef-biuro-nip">NIP biura rachunkowego</FieldLabel>
          <Input
            id="ksef-biuro-nip"
            inputMode="numeric"
            autoComplete="off"
            value={nip}
            disabled={pending}
            aria-invalid={bledy.nip ? true : undefined}
            aria-describedby={bledy.nip ? 'ksef-biuro-nip-blad' : undefined}
            onChange={(e) => setNip(e.target.value)}
            placeholder="10 cyfr, np. 1111111111"
          />
          {bledy.nip ? <FieldError id="ksef-biuro-nip-blad">{bledy.nip}</FieldError> : null}
        </Field>
        <Field data-invalid={bledy.nazwa ? true : undefined}>
          <FieldLabel htmlFor="ksef-biuro-nazwa">Pełna nazwa biura</FieldLabel>
          <Input
            id="ksef-biuro-nazwa"
            autoComplete="organization"
            value={nazwa}
            disabled={pending}
            aria-invalid={bledy.nazwa ? true : undefined}
            aria-describedby={bledy.nazwa ? 'ksef-biuro-nazwa-blad' : 'ksef-biuro-nazwa-opis'}
            onChange={(e) => setNazwa(e.target.value)}
            placeholder="Biuro Rachunkowe Kowalska sp. z o.o."
          />
          {bledy.nazwa ? (
            <FieldError id="ksef-biuro-nazwa-blad">{bledy.nazwa}</FieldError>
          ) : (
            <FieldDescription id="ksef-biuro-nazwa-opis">Tak jak w rejestrze, od 5 do 90 znaków.</FieldDescription>
          )}
        </Field>
      </div>

      <Field>
        <FieldLabel id="ksef-biuro-zakres">Zakres uprawnienia</FieldLabel>
        <RadioGroup
          aria-labelledby="ksef-biuro-zakres"
          value={zakres}
          disabled={pending}
          onValueChange={(v) => setZakres(v as Zakres)}
        >
          {ZAKRESY.map((z) => (
            <label key={z} className="flex items-start gap-2 text-sm max-sm:min-h-11">
              <RadioGroupItem value={z} className="mt-0.5" />
              <span>
                <span className="font-medium">{NAZWY_ZAKRESOW[z]}</span>
                <span className="text-muted-foreground block text-xs">{OPISY_ZAKRESOW[z]}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {bledy.zakres ? <FieldError>{bledy.zakres}</FieldError> : null}
      </Field>

      <label className="flex items-start gap-2 text-sm max-sm:min-h-11">
        <Checkbox
          checked={przekazanie}
          disabled={pending}
          onCheckedChange={(c) => setPrzekazanie(c === true)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Biuro może przekazać ten dostęp swoim pracownikom</span>
          <span className="text-muted-foreground block text-xs">
            KSeF pozwoli wtedy biuru nadać pracownikom dostęp tylko do faktur tej firmy.
          </span>
        </span>
      </label>

      <div className="flex sm:justify-end">
        <Button type="button" onClick={wyslij} disabled={pending} className={DOTYK}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Nadaj uprawnienie w KSeF
        </Button>
      </div>
    </div>
  );
}

function WierszUprawnienia({
  w,
  teraz,
  firma,
  onStepUp,
}: {
  w: UprawnienieBiura;
  teraz: string;
  firma: string;
  onStepUp: (tekst: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const stan = stanDlaKlienta(w, new Date(teraz));

  const pokaz = (wynik: WynikUprawnienia) => {
    if (wynik.success) toast.success(wynik.komunikat);
    else if (wynik.mfaStepUp) onStepUp(wynik.error);
    else toast.error(wynik.error);
    router.refresh();
  };

  const wykonaj = (akcja: AkcjaUprawnienia) => {
    if (akcja === 'odbierz' && !confirm(`Odebrać uprawnienie w KSeF dla ${biuroWZdaniu(w)}?`)) return;
    onStepUp(null);
    startTransition(async () => {
      if (akcja === 'sprawdz') return pokaz(await sprawdzUprawnienieKsefAction(w.id));
      if (akcja === 'odbierz' || akcja === 'ponow_odebranie') return pokaz(await odbierzUprawnienieKsefAction(w.id));
      return pokaz(
        await nadajUprawnienieKsefAction({ firma, nip: w.nip, nazwa: w.nazwa, zakres: w.zakres, przekazanie: w.przekazanie }),
      );
    });
  };

  const data =
    w.stan === 'granted' && w.nadano
      ? `Nadane ${formatSettingsDate(w.nadano)}`
      : w.stan === 'revoked' && w.odebrano
        ? `Odebrane ${formatSettingsDate(w.odebrano)}`
        : null;

  return (
    <div className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar className="size-10 items-center justify-center">
          <AvatarFallback className="bg-transparent">
            <RiBuilding2Line className="text-foreground size-5" />
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium" title={w.nazwa}>
              {w.nazwa}
            </p>
            <Badge variant={stan.ton === 'neutralny' ? 'secondary' : 'default'} className={TONY[stan.ton]}>
              {stan.etykieta}
            </Badge>
            <Badge variant="outline">{NAZWY_ZAKRESOW[w.zakres]}</Badge>
          </div>
          <p className="text-muted-foreground font-mono text-xs">NIP {w.nip}</p>
          <p className="text-muted-foreground text-xs/relaxed">{stan.opis}</p>
          {data ? <p className="text-muted-foreground text-xs">{data}</p> : null}
        </div>
      </div>

      {stan.akcje.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {stan.akcje.map((a) => (
            <Button
              key={a}
              type="button"
              variant={a === 'odbierz' ? 'ghost' : 'outline'}
              disabled={pending}
              onClick={() => wykonaj(a)}
              className={cn(DOTYK)}
            >
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              {NAPISY_AKCJI[a]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

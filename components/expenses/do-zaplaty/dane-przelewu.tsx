'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiCheckLine, RiFileCopyLine, RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { toast } from 'sonner';

import { markExpensePaidAction, undoExpensePaidAction } from '@/app/actions/expense-payments';
import { validateBankAccountAction } from '@/app/actions/validation';
import { plDate } from '@/components/expenses/finora/labels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { skutkiRachunkuSpozaWykazu } from '@/lib/expenses/biala-lista-pit';
import type { KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';
import {
  MARK_EXPENSE_PAID_FAILED,
  UNDO_EXPENSE_PAID_FAILED,
  type MarkExpensePaidResult,
  type UndoExpensePaidResult,
} from '@/lib/expenses/zaplata-kosztu';
import { formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

/**
 * Dane do przelewu przy koszcie (krok 3.4, część 1): rachunek, kwota i tytuł
 * z przyciskami kopiowania, informacja o MPP, uwagi, sprawdzenie rachunku
 * w wykazie podatników VAT przy kwocie ponad 15 000 zł i „Oznacz jako
 * zapłacone” z datą (domyślnie dziś, nie z przyszłości) i cofnięciem.
 * Ten sam blok stoi na liście „Do zapłaty” i na karcie kosztu.
 */

/** Pole dotyku na telefonie co najmniej 44×44 px (piksele: `--spacing` aplikacji jest mniejszy niż 4 px). */
const DOTYK = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';
const WYSZUKIWARKA = 'https://www.podatki.gov.pl/wykaz-podatnikow-vat-wyszukiwarka';
/** Czas na „Cofnij” w toaście: dłuższy od domyślnego, bo wiersz znika z listy. */
const CZAS_COFNIECIA_MS = 10_000;

/** Rachunek do czytania: „PL61 1090 1014 …” albo „61 1090 1014 …”; kopiujemy bez spacji. */
export function rachunekDoCzytania(numer: string): string {
  const m = /^(PL)?(\d{2})(\d{24})$/.exec(numer);
  if (m) return `${m[1] ?? ''}${m[2]} ${m[3]!.replace(/(\d{4})(?=\d)/g, '$1 ')}`;
  return numer.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Kwota do wklejenia w banku: bez spacji tysięcy, z przecinkiem („1230,00”). */
export function kwotaDoSchowka(kwota: number): string {
  return kwota.toFixed(2).replace('.', ',');
}

function dni(n: number): string {
  return n === 1 ? '1 dzień' : `${n} dni`;
}

export function opisTerminu(koszt: Pick<KosztDoZaplaty, 'dniDoTerminu'>): string {
  if (koszt.dniDoTerminu < 0) return `Po terminie (${dni(-koszt.dniDoTerminu)})`;
  if (koszt.dniDoTerminu === 0) return 'Termin dziś';
  return `Za ${dni(koszt.dniDoTerminu)}`;
}

/** Wiersz z wartością i przyciskiem kopiowania (także w bloku identyfikatora zbiorczego, krok 1.4). */
export function KopiujWiersz({
  etykieta,
  wartosc,
  doSchowka,
  opisPrzycisku,
  mono,
}: {
  etykieta: string;
  wartosc: string;
  doSchowka: string;
  opisPrzycisku: string;
  mono?: boolean;
}) {
  const kopiuj = async () => {
    try {
      await navigator.clipboard.writeText(doSchowka);
      toast.success(`Skopiowano: ${etykieta.toLowerCase()}`);
    } catch {
      toast.error('Nie udało się skopiować. Zaznacz tekst i skopiuj go ręcznie.');
    }
  };
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-muted-foreground text-xs">{etykieta}</div>
        <div className={cn('text-sm font-medium break-all', mono && 'font-mono')}>{wartosc}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={kopiuj}
        aria-label={opisPrzycisku}
        title={opisPrzycisku}
        className={DOTYK}
      >
        <RiFileCopyLine />
      </Button>
    </div>
  );
}

type StanBialejListy =
  | { typ: 'przed' }
  | { typ: 'w-wykazie'; dzien: string }
  | { typ: 'poza-wykazem'; dzien: string }
  | { typ: 'nie-sprawdzono'; opis: string };

const linkWyszukiwarki = (
  <a href={WYSZUKIWARKA} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
    wyszukiwarce wykazu na podatki.gov.pl
  </a>
);

/**
 * RP-BL-01: trzy stany odpowiedzi; błąd API to „nie udało się sprawdzić”, nigdy „w porządku”.
 * `sankcjaPit`: skutek w PIT przy rachunku spoza wykazu według dnia wystawienia faktury
 * (`KosztDoZaplaty.sankcjaPitBialejListy`); VAT i ZAW-NR zawsze.
 */
export function SprawdzenieBialejListy({
  nip,
  rachunek,
  sankcjaPit,
}: {
  nip: string | null;
  rachunek: string | null;
  sankcjaPit: boolean;
}) {
  const [stan, setStan] = useState<StanBialejListy>({ typ: 'przed' });
  const [pending, start] = useTransition();
  const nip10 = nip?.replace(/\D/g, '') ?? '';

  if (nip10.length !== 10 || !rachunek) {
    return (
      <Alert className="border-amber-600/30">
        <AlertTitle>Rachunku nie da się sprawdzić w wykazie podatników VAT</AlertTitle>
        <AlertDescription>
          <p>
            Brak polskiego NIP sprzedawcy albo numeru rachunku z faktury. Przed zapłatą ponad 15 000 zł sprawdź
            rachunek w {linkWyszukiwarki}.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const sprawdz = () =>
    start(async () => {
      const wynik = await validateBankAccountAction(nip10, rachunek).catch(() => ({
        success: false as const,
        error: 'brak połączenia',
      }));
      if (!wynik.success) setStan({ typ: 'nie-sprawdzono', opis: wynik.error });
      else setStan({ typ: wynik.isOnWhitelist ? 'w-wykazie' : 'poza-wykazem', dzien: wynik.checkedOn });
    });

  const przycisk = (
    <Button type="button" variant="outline" onClick={sprawdz} disabled={pending} className={DOTYK}>
      {pending ? <RiLoader4Line className="animate-spin" /> : <RiShieldCheckLine />}
      {stan.typ === 'przed' ? 'Sprawdź rachunek w wykazie' : 'Sprawdź jeszcze raz'}
    </Button>
  );

  if (stan.typ === 'w-wykazie') {
    return (
      <Alert className="border-green-600/30" role="status">
        <AlertTitle>Rachunek jest w wykazie podatników VAT (stan na {plDate(stan.dzien)})</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>Sprawdzenie dotyczy tego dnia. Jeśli zlecisz przelew innego dnia, sprawdź rachunek jeszcze raz.</p>
          {przycisk}
        </AlertDescription>
      </Alert>
    );
  }
  if (stan.typ === 'poza-wykazem') {
    return (
      <Alert variant="destructive">
        <AlertTitle>Tego rachunku nie ma w wykazie podatników VAT (stan na {plDate(stan.dzien)})</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{skutkiRachunkuSpozaWykazu(sankcjaPit)}</p>
          {przycisk}
        </AlertDescription>
      </Alert>
    );
  }
  if (stan.typ === 'nie-sprawdzono') {
    return (
      <Alert className="border-amber-600/30">
        <AlertTitle>Nie udało się sprawdzić rachunku w wykazie podatników VAT</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            {stan.opis}. To nie znaczy, że rachunek jest w porządku. Spróbuj ponownie albo sprawdź go
            w {linkWyszukiwarki} przed zapłatą.
          </p>
          {przycisk}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="border-amber-600/30">
      <AlertTitle>Kwota ponad 15 000 zł</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Przy takiej płatności liczy się, czy rachunek sprzedawcy jest w wykazie podatników VAT (biała lista)
          w dniu zlecenia przelewu.
        </p>
        {przycisk}
      </AlertDescription>
    </Alert>
  );
}

const bezpieczneOznaczenie = (id: string, dzien?: string): Promise<MarkExpensePaidResult> =>
  markExpensePaidAction(id, dzien).catch(() => ({ success: false, error: MARK_EXPENSE_PAID_FAILED }));
const bezpieczneCofniecie = (id: string): Promise<UndoExpensePaidResult> =>
  undoExpensePaidAction(id).catch(() => ({ success: false, error: UNDO_EXPENSE_PAID_FAILED }));

/** Cofnięcie zapłaty: z toastu po oznaczeniu i z karty zapłaconego kosztu. */
export function useCofnijZaplate() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const cofnij = (expenseId: string) =>
    start(async () => {
      const wynik = await bezpieczneCofniecie(expenseId);
      if (!wynik.success) {
        toast.error(wynik.error);
        return;
      }
      if (wynik.status === 'undone') toast.success('Cofnięto zapłatę. Koszt wrócił na listę do zapłaty.');
      else toast.info('Ten koszt nie był oznaczony jako zapłacony.');
      router.refresh();
    });
  return { cofnij, pending };
}

export function OznaczZaplacone({ expenseId, dzis }: { expenseId: string; dzis: string }) {
  const router = useRouter();
  const [dzien, setDzien] = useState(dzis);
  const [pending, start] = useTransition();
  const { cofnij } = useCofnijZaplate();
  const zlaData = !dzien || dzien > dzis;

  const oznacz = () =>
    start(async () => {
      const wynik = await bezpieczneOznaczenie(expenseId, dzien === dzis ? undefined : dzien);
      if (!wynik.success) {
        toast.error(wynik.error);
        return;
      }
      if (wynik.status === 'already_paid') {
        toast.info(`Ten koszt jest już oznaczony jako zapłacony${wynik.paidOn ? ` (${plDate(wynik.paidOn)})` : ''}.`);
      } else {
        toast.success(`Zapłacono ${plDate(wynik.paidOn)}`, {
          duration: CZAS_COFNIECIA_MS,
          action: { label: 'Cofnij', onClick: () => cofnij(expenseId) },
        });
      }
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`zaplata-${expenseId}`}>Data zapłaty</Label>
        <Input
          id={`zaplata-${expenseId}`}
          type="date"
          value={dzien}
          max={dzis}
          onChange={(e) => setDzien(e.target.value)}
          className={cn('w-40', DOTYK)}
          aria-invalid={zlaData || undefined}
        />
      </div>
      <Button type="button" onClick={oznacz} disabled={pending || zlaData} className={DOTYK}>
        {pending ? <RiLoader4Line className="animate-spin" /> : <RiCheckLine />}
        Oznacz jako zapłacone
      </Button>
      {zlaData ? (
        <p className="text-destructive w-full text-xs">Data zapłaty nie może być z przyszłości ani pusta.</p>
      ) : null}
    </div>
  );
}

export function DanePrzelewu({
  koszt,
  dzis,
  mozeOznaczac,
}: {
  koszt: KosztDoZaplaty;
  dzis: string;
  mozeOznaczac: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {koszt.rachunek ? (
        <KopiujWiersz
          etykieta="Rachunek sprzedawcy"
          wartosc={rachunekDoCzytania(koszt.rachunek)}
          doSchowka={koszt.rachunek}
          opisPrzycisku="Kopiuj numer rachunku"
          mono
        />
      ) : null}
      <KopiujWiersz
        etykieta="Kwota do zapłaty"
        wartosc={`${formatPlMoney(koszt.kwota)} zł`}
        doSchowka={kwotaDoSchowka(koszt.kwota)}
        opisPrzycisku="Kopiuj kwotę"
      />
      {koszt.tytul ? (
        <KopiujWiersz
          etykieta="Tytuł przelewu"
          wartosc={koszt.tytul}
          doSchowka={koszt.tytul}
          opisPrzycisku="Kopiuj tytuł przelewu"
          mono
        />
      ) : null}
      {koszt.mpp === true ? (
        <div className="bg-muted/50 flex flex-col gap-2 p-3">
          <p className="text-sm">
            Faktura z mechanizmem podzielonej płatności (MPP). W komunikacie przelewu MPP podaje się kwotę VAT,
            NIP sprzedawcy i numer KSeF faktury, dlatego tytuł to sam numer KSeF.
          </p>
          <KopiujWiersz
            etykieta="Kwota VAT do komunikatu MPP"
            wartosc={`${formatPlMoney(koszt.vat)} zł`}
            doSchowka={kwotaDoSchowka(koszt.vat)}
            opisPrzycisku="Kopiuj kwotę VAT"
          />
          {koszt.nip ? (
            <KopiujWiersz
              etykieta="NIP sprzedawcy"
              wartosc={koszt.nip}
              doSchowka={koszt.nip.replace(/\D/g, '')}
              opisPrzycisku="Kopiuj NIP sprzedawcy"
              mono
            />
          ) : null}
        </div>
      ) : null}
      {koszt.uwagi.length > 0 ? (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          {koszt.uwagi.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      ) : null}
      {koszt.wymagaBialejListy ? (
        <SprawdzenieBialejListy nip={koszt.nip} rachunek={koszt.rachunek} sankcjaPit={koszt.sankcjaPitBialejListy} />
      ) : null}
      {mozeOznaczac ? <OznaczZaplacone expenseId={koszt.id} dzis={dzis} /> : null}
    </div>
  );
}

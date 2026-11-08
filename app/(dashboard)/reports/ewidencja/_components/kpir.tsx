import { JpkEwpPobierz } from '@/components/ksiegowosc/jpk-ewp-pobierz';
import { UsunWpisPrzycisk, WpisRecznyForm } from '@/components/ksiegowosc/wpis-reczny-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { brakiKpirOkresu, NAZWY_KOLUMN, sumyKpir, wierszeKpirOkresu, type Kpir, type WierszKpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import { NAZWY_RODZAJOW_WPISU, type RodzajWpisu } from '@/lib/ksiegowosc/wpisy-reczne';
import type { WynikKpir } from '@/lib/ksiegowosc/kpir-dane';

/**
 * KPiR w zakładce „Ewidencja” przy skali i liniowym (plan księgowości JDG,
 * K7, sekcja 8): wiersze księgi za miesiąc według wzoru od 2026 r., braki
 * z wyjściem, wpisy ręczne z kolumną KPiR i plik JPK_PKPIR(3) od 1 stycznia.
 * Miesiąc z brakiem nie ma sum, a okres z brakiem nie ma pliku (fail-closed).
 */

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;

/** Kolumna wiersza z kwotą: przychód (7, 8) albo koszt (10-13). */
function kolumnaWiersza(w: WierszKpir): string {
  const k = Object.entries(w.kwoty).find(([, gr]) => gr !== 0)?.[0] as keyof typeof NAZWY_KOLUMN | undefined;
  return k ? NAZWY_KOLUMN[k] : '';
}

const jestPrzychod = (w: WierszKpir) => w.kwoty.k7 !== 0 || w.kwoty.k8 !== 0;

export function KpirModulu({
  wynik,
  od,
  doDnia,
  tytul,
  rok,
  miesiac,
  dzis,
  canEdit,
  mozePobrac,
}: {
  wynik: WynikKpir;
  od: string;
  doDnia: string;
  tytul: string;
  rok: number;
  miesiac: number;
  dzis: string;
  canEdit: boolean;
  mozePobrac: boolean;
}) {
  if (!wynik.ok) {
    return (
      <Alert variant="destructive">
        <AlertTitle>KPiR jest chwilowo niedostępna</AlertTitle>
        <AlertDescription>{wynik.komunikat}</AlertDescription>
      </Alert>
    );
  }
  return (
    <>
      <KpirMiesiaca kpir={wynik.kpir} od={od} doDnia={doDnia} tytul={tytul} />
      <WpisyKpir wpisy={wynik.wpisy.filter((w) => w.data >= od && w.data <= doDnia)} domyslnaData={doDnia < dzis ? doDnia : dzis} canEdit={canEdit} />
      <PlikJpkPkpir kpir={wynik.kpir} rok={rok} miesiac={miesiac} koniecMiesiaca={doDnia} dzis={dzis} mozePobrac={mozePobrac} />
    </>
  );
}

function KpirMiesiaca({ kpir, od, doDnia, tytul }: { kpir: Kpir; od: string; doDnia: string; tytul: string }) {
  const wiersze = wierszeKpirOkresu(kpir, od, doDnia);
  const braki = brakiKpirOkresu(kpir, od, doDnia);
  const pominiete = kpir.pominiete.filter((p) => p.dzien >= od && p.dzien <= doDnia);
  const sumy = braki.length === 0 ? sumyKpir(wiersze) : null;
  // K_1 numeruje się od początku roku; tabela miesiąca pokazuje numer z księgi.
  const lpRoku = new Map(kpir.wiersze.map((w) => [`${w.zrodlo.typ}-${w.zrodlo.id}`, w.lp]));

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {braki.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Braki w KPiR za {tytul}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {braki.map((b) => (
                  <li key={`${b.dzien}-${b.dokument}-${b.komunikat}`}>{b.komunikat}</li>
                ))}
              </ul>
              <p className="mt-2">Dopóki są braki, KPiR nie pokazuje sum za ten miesiąc, zaliczki PIT nie liczymy, a plik JPK_PKPIR nie powstaje.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {pominiete.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Poza księgą: {pominiete.map((p) => p.numer).join(', ')}. {pominiete[0].powod}
          </p>
        ) : null}
        {wiersze.length === 0 ? (
          <p className="text-muted-foreground text-sm">W tym miesiącu KPiR nie ma wpisów.</p>
        ) : (
          <Table aria-label="Wiersze KPiR">
            <TableHeader>
              <TableRow>
                <TableHead>Lp.</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Dowód</TableHead>
                <TableHead>Kontrahent</TableHead>
                <TableHead>Opis</TableHead>
                <TableHead className="text-right">Przychód</TableHead>
                <TableHead className="text-right">Koszt</TableHead>
                <TableHead>Uwagi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wiersze.map((w) => {
                const kwota = Object.values(w.kwoty).reduce((s, gr) => s + gr, 0);
                return (
                  <TableRow key={`${w.zrodlo.typ}-${w.zrodlo.id}`}>
                    <TableCell className="tabular-nums">{lpRoku.get(`${w.zrodlo.typ}-${w.zrodlo.id}`) ?? w.lp}</TableCell>
                    <TableCell>{formatIsoDatePl(w.data)}</TableCell>
                    <TableCell>
                      <span className="block">{w.dowod}</span>
                      {w.numerKsef ? <span className="text-muted-foreground block text-xs">{w.numerKsef}</span> : null}
                    </TableCell>
                    <TableCell>
                      <span className="block">{w.nazwaKontrahenta}</span>
                      {w.idKontrahenta ? <span className="text-muted-foreground block text-xs">{`${w.krajKontrahenta ?? ''} ${w.idKontrahenta}`.trim()}</span> : null}
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">
                      <span className="block">{w.opis}</span>
                      <span className="text-muted-foreground block text-xs">{kolumnaWiersza(w)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{jestPrzychod(w) ? zl(kwota) : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{jestPrzychod(w) ? '' : zl(kwota)}</TableCell>
                    <TableCell className="text-muted-foreground max-w-64 text-xs whitespace-normal">
                      {[w.uwagi, w.br ? `B+R: ${zl(w.br.kwotaGr)}` : null].filter(Boolean).join('; ')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {sumy ? (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5} className="font-medium">
                    Razem w miesiącu
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{zl(sumy.przychodGr)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{zl(sumy.kosztyGr)}</TableCell>
                  <TableCell />
                </TableRow>
                <TableRow>
                  <TableCell colSpan={5}>Dochód w miesiącu (przychód minus koszty)</TableCell>
                  <TableCell colSpan={2} className="text-right tabular-nums">
                    {zl(sumy.przychodGr - sumy.kosztyGr)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        )}
        {sumy && wiersze.length > 0 ? <p className="text-muted-foreground text-xs">Według Twoich danych za {tytul}; spis z natury nie wchodzi do sum.</p> : null}
      </CardContent>
    </Card>
  );
}

function WpisyKpir({ wpisy, domyslnaData, canEdit }: { wpisy: (WpisKpir & { rodzaj: RodzajWpisu })[]; domyslnaData: string; canEdit: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium">Wpisy ręczne w KPiR</h2>
          <p className="text-muted-foreground text-xs">
            Przychody i koszty bez faktury w KSeF ani dokumentu w Kosztach, np. sprzedaż z kasy rejestrującej. Fundusz Pracy i Fundusz
            Solidarnościowy FaktWay dopisuje do KPiR sam (kolumna 13) w dniu zapłaty składek oznaczonej w „Ten miesiąc”, więc nie wpisuje się ich
            ręcznie. Składek społecznych (a przy liniowym także zdrowotnej) KPiR nie zawiera: zaliczka PIT odlicza od dochodu te oznaczone jako
            zapłacone. Poprawka to usunięcie wpisu i dodanie nowego.
          </p>
        </div>
        {wpisy.length > 0 ? (
          <Table aria-label="Wpisy ręczne KPiR w miesiącu">
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Dowód</TableHead>
                <TableHead>Kolumna</TableHead>
                <TableHead className="text-right">Kwota</TableHead>
                <TableHead>Opis</TableHead>
                {canEdit ? <TableHead className="sr-only">Usuń</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {wpisy.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>{formatIsoDatePl(w.data)}</TableCell>
                  <TableCell>
                    <span className="block">{w.dokument}</span>
                    <span className="text-muted-foreground block text-xs">{NAZWY_RODZAJOW_WPISU[w.rodzaj]}</span>
                  </TableCell>
                  <TableCell className="max-w-48 text-xs whitespace-normal">{NAZWY_KOLUMN[w.kolumna]}</TableCell>
                  <TableCell className="text-right tabular-nums">{zl(w.kwotaGr)}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64 text-xs whitespace-normal">{w.opis}</TableCell>
                  {canEdit ? (
                    <TableCell className="text-right">
                      <UsunWpisPrzycisk id={w.id} dokument={w.dokument} ksiega="kpir" />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">W tym miesiącu nie ma wpisów ręcznych.</p>
        )}
        {canEdit ? (
          <WpisRecznyForm domyslnaData={domyslnaData} domyslnaStawkaPb={null} ksiega="kpir" />
        ) : (
          <p className="text-muted-foreground text-xs">Wpisy dodaje i usuwa właściciel albo administrator firmy.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PlikJpkPkpir({
  kpir,
  rok,
  miesiac,
  koniecMiesiaca,
  dzis,
  mozePobrac,
}: {
  kpir: Kpir;
  rok: number;
  miesiac: number;
  koniecMiesiaca: string;
  dzis: string;
  mozePobrac: boolean;
}) {
  const od = `${rok}-01-01`;
  const doDnia = koniecMiesiaca < dzis ? koniecMiesiaca : dzis;
  const okres = `od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}`;

  let tresc: React.ReactNode;
  if (od > dzis) {
    tresc = <p className="text-sm">Plik za {rok} r. powstanie po rozpoczęciu roku.</p>;
  } else {
    const braki = brakiKpirOkresu(kpir, od, doDnia);
    const wiersze = wierszeKpirOkresu(kpir, od, doDnia);
    if (braki.length > 0) {
      const miesiace = [...new Set(braki.map((b) => b.dzien.slice(0, 7)))].map(monthLabel);
      tresc = <p className="text-sm">Plik {okres} powstanie, gdy KPiR nie będzie mieć braków. Braki są w miesiącach: {miesiace.join(', ')}.</p>;
    } else if (wiersze.length === 0) {
      tresc = <p className="text-sm">KPiR {okres} nie ma wpisów, więc plik byłby pusty.</p>;
    } else {
      const sumy = sumyKpir(wiersze);
      tresc = (
        <>
          <p className="text-sm">
            Plik {okres}: wiersze {wiersze.length}, przychód {zl(sumy.przychodGr)}, koszty {zl(sumy.kosztyGr)}. Plik za cały zamknięty rok ma cel
            „złożenie po raz pierwszy”, za część roku „na żądanie urzędu”.
          </p>
          {sumy.kolumny.k10 !== 0 ? (
            <p className="text-muted-foreground text-xs">
              Plik zapisuje spis z natury na początek i koniec roku jako zero. Przy zakupie towarów handlowych spis z natury podaje księgowa.
            </p>
          ) : null}
          {mozePobrac ? (
            <JpkEwpPobierz rok={rok} doMiesiaca={miesiac} plik="JPK_PKPIR" />
          ) : (
            <p className="text-muted-foreground text-xs">Plik pobiera właściciel, administrator albo księgowa firmy.</p>
          )}
        </>
      );
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Plik JPK_PKPIR</h2>
        {tresc}
      </CardContent>
    </Card>
  );
}

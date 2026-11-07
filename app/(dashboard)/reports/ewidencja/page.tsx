import { notFound } from 'next/navigation';

import MonthSelector from '@/components/expenses/finora/month-selector';
import { JpkEwpPobierz } from '@/components/ksiegowosc/jpk-ewp-pobierz';
import { UsunWpisPrzycisk, WpisRecznyForm } from '@/components/ksiegowosc/wpis-reczny-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { brakiOkresu, etykietaStawki, sumyOkresu, type Ewidencja, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje, KOMUNIKAT_ODCZYT } from '@/lib/ksiegowosc/ewidencja-dane';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { czytajWersjeProfilu, PROFIL_OD_MIN, wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { wersjaMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';
import { NAZWY_RODZAJOW_WPISU } from '@/lib/ksiegowosc/wpisy-reczne';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { resolveKpirPeriod } from '@/lib/reports/kpir-data';
import { getPageContext } from '@/lib/supabase/page-context';

import { KpirModulu } from './_components/kpir';

export const dynamic = 'force-dynamic';

/**
 * „Ewidencja” w Księgowości (plan księgowości JDG, K3, sekcja 8): ewidencja
 * przychodów ryczałtu za miesiąc, wpisy ręczne (raport kasy) i plik
 * JPK_EWP(4) od 1 stycznia. Miesiąc ze skalą albo liniowym (K7) pokazuje KPiR
 * (`_components/kpir.tsx`) z plikiem JPK_PKPIR(3).
 *
 * Za wyłącznikiem modułu (obszar `ewidencja`): firma poza pilotażem dostaje
 * 404. Dane czyta klient z sesji (RLS). Miesiąc z brakiem nie ma sum,
 * a okres z brakiem nie ma pliku (fail-closed, sekcja 4 pkt 8).
 */

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;
const wOkresie = (dzien: string, od: string, doDnia: string) => dzien >= od && dzien <= doDnia;
const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

export default async function EwidencjaPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const ctx = await getPageContext();
  const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'ewidencja');
  if (!werdykt.wlaczony) notFound();

  const { month, year, periodStart, periodEnd } = resolveKpirPeriod(await searchParams);
  const dzis = todayInWarsaw();
  const miesiac = `${year}-${String(month).padStart(2, '0')}`;
  const tytul = monthLabel(miesiac);
  // Forma z ustawień na ten miesiąc: skala i liniowy prowadzą KPiR (K7), ryczałt ewidencję.
  // Bez odczytu ustawień formy nie znamy, więc strona pokazuje błąd odczytu, a nie ewidencję.
  const wersje = await czytajWersjeProfilu(ctx.supabase, ctx.tenantId).catch(() => null);
  const forma = wersje ? wersjaMiesiaca(wersje, miesiac)?.forma : undefined;
  const kpir = forma === 'skala' || forma === 'liniowy';

  const naglowek = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{kpir ? `KPiR, ${tytul}` : `Ewidencja przychodów, ${tytul}`}</h2>
          <p className="text-muted-foreground text-xs">
            {kpir
              ? 'Podatkowa księga przychodów i rozchodów według wzoru od 2026 r.: faktury przyjęte w KSeF, koszty i wpisy ręczne.'
              : 'Faktury przyjęte w KSeF i wpisy ręczne przy ryczałcie od przychodów ewidencjonowanych.'}
          </p>
        </div>
        <MonthSelector
          month={miesiac}
          currentMonth={dzis.slice(0, 7)}
          basePath="/reports/ewidencja"
          query="month-year"
          ariaLabel="Miesiąc ewidencji"
        />
      </CardContent>
    </Card>
  );

  if (periodEnd < PROFIL_OD_MIN) {
    return (
      <div className="ff-tab-panel flex flex-1 flex-col gap-6">
        <h1 className="sr-only">Ewidencja przychodów</h1>
        {naglowek}
        <Card>
          <CardContent className="text-sm">Ewidencja przychodów w FaktWay obejmuje przychody od 1 stycznia 2026 r.</CardContent>
        </Card>
      </div>
    );
  }

  const canEdit = ctx.role === 'owner' || ctx.role === 'admin';
  const mozePobrac = canEdit || ctx.role === 'accountant';
  if (kpir) {
    // Globalny stop i flagę firmy sprawdził już obszar `ewidencja`; `kpir` różni się tylko blokadą w kodzie (K7).
    if (!statusObszaru('kpir').wlaczony) {
      return (
        <div className="ff-tab-panel flex flex-1 flex-col gap-6">
          <h1 className="sr-only">KPiR</h1>
          {naglowek}
          <Card>
            <CardContent className="text-sm">
              KPiR w module księgowości jest chwilowo wyłączona. Faktury i koszty są dalej w raporcie w zakładce „KPiR”.
            </CardContent>
          </Card>
        </div>
      );
    }
    return (
      <div className="ff-tab-panel flex flex-1 flex-col gap-6">
        <h1 className="sr-only">KPiR</h1>
        {naglowek}
        <KpirModulu
          wynik={await czytajKpir(ctx.supabase, ctx.tenantId, year, { wersje: wersje ?? undefined })}
          od={periodStart}
          doDnia={periodEnd}
          tytul={tytul}
          rok={year}
          miesiac={month}
          dzis={dzis}
          canEdit={canEdit}
          mozePobrac={mozePobrac}
        />
      </div>
    );
  }

  const wynik = wersje === null ? { ok: false as const, komunikat: KOMUNIKAT_ODCZYT } : await czytajEwidencje(ctx.supabase, ctx.tenantId, year, { wersje });

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Ewidencja przychodów</h1>
      {naglowek}
      {wynik.ok ? (
        <>
          <EwidencjaMiesiaca ewidencja={wynik.ewidencja} od={periodStart} doDnia={periodEnd} tytul={tytul} />
          <WpisyReczne
            wpisy={wynik.wpisy.filter((w) => wOkresie(w.dataPrzychodu, periodStart, periodEnd))}
            wersje={wynik.wersje}
            domyslnaData={periodEnd < dzis ? periodEnd : dzis}
            canEdit={canEdit}
          />
          <PlikJpk ewidencja={wynik.ewidencja} rok={year} miesiac={month} koniecMiesiaca={periodEnd} dzis={dzis} mozePobrac={mozePobrac} />
        </>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>Ewidencja jest chwilowo niedostępna</AlertTitle>
          <AlertDescription>{wynik.komunikat}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function EwidencjaMiesiaca({ ewidencja, od, doDnia, tytul }: { ewidencja: Ewidencja; od: string; doDnia: string; tytul: string }) {
  const wiersze = ewidencja.wiersze.filter((w) => wOkresie(w.dataPrzychodu, od, doDnia));
  const braki = brakiOkresu(ewidencja, od, doDnia);
  const pominiete = ewidencja.pominiete.filter((p) => wOkresie(p.dzien, od, doDnia));
  const sumy = braki.length === 0 ? sumyOkresu(wiersze) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {!ewidencja.ryczaltWRoku ? (
          <p className="text-sm">
            W {ewidencja.rok} r. ustawienia podatkowe nie mają ryczałtu, więc ewidencja przychodów jest pusta. Przy skali
            i podatku liniowym przychody są w KPiR. {PROFIL_TEKST}
          </p>
        ) : null}
        {braki.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Braki w ewidencji za {tytul}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {braki.map((b) => (
                  <li key={`${b.dzien}-${b.dokument}-${b.komunikat}`}>{b.komunikat}</li>
                ))}
              </ul>
              <p className="mt-2">Dopóki są braki, ewidencja nie pokazuje sum za ten miesiąc, a plik JPK_EWP nie powstaje.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {pominiete.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Poza ewidencją: {pominiete.map((p) => p.numer).join(', ')}. {pominiete[0].powod}
          </p>
        ) : null}
        {wiersze.length === 0 ? (
          <p className="text-muted-foreground text-sm">W tym miesiącu ewidencja nie ma przychodów.</p>
        ) : (
          <Table aria-label="Wiersze ewidencji przychodów">
            <TableHeader>
              <TableRow>
                <TableHead>Lp.</TableHead>
                <TableHead>Data przychodu</TableHead>
                <TableHead>Data wpisu</TableHead>
                <TableHead>Dowód</TableHead>
                <TableHead>Kontrahent</TableHead>
                <TableHead className="text-right">Przychód</TableHead>
                <TableHead className="text-right">Stawka</TableHead>
                <TableHead>Uwagi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wiersze.map((w) => (
                <TableRow key={`${w.zrodlo.id}-${w.stawkaPb}`}>
                  <TableCell className="tabular-nums">{w.lp}</TableCell>
                  <TableCell>{formatIsoDatePl(w.dataPrzychodu)}</TableCell>
                  <TableCell>{formatIsoDatePl(w.dataWpisu)}</TableCell>
                  <TableCell>
                    <span className="block">{w.dowod}</span>
                    {w.numerKsef ? <span className="text-muted-foreground block text-xs">{w.numerKsef}</span> : null}
                  </TableCell>
                  <TableCell>{w.idKontrahenta ? `${w.krajKontrahenta ?? ''} ${w.idKontrahenta}`.trim() : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{zl(w.kwotaGr)}</TableCell>
                  <TableCell className="text-right tabular-nums">{etykietaStawki(w.stawkaPb)}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64 text-xs whitespace-normal">{w.uwagi}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {sumy ? (
              <TableFooter>
                {[...sumy.stawki].map(([pb, gr]) => (
                  <TableRow key={pb}>
                    <TableCell colSpan={5}>Przychód ze stawką {etykietaStawki(pb)}</TableCell>
                    <TableCell className="text-right tabular-nums">{zl(gr)}</TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={5} className="font-medium">
                    Razem
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{zl(sumy.razemGr)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        )}
        {sumy && wiersze.length > 0 ? (
          <p className="text-muted-foreground text-xs">Według Twoich danych i stawek ryczałtu na {ewidencja.rok} r.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WpisyReczne({
  wpisy,
  wersje,
  domyslnaData,
  canEdit,
}: {
  wpisy: WpisReczny[];
  wersje: WersjaProfilu[];
  domyslnaData: string;
  canEdit: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium">Raport kasy i inne wpisy ręczne</h2>
          <p className="text-muted-foreground text-xs">
            Przychody bez faktury w KSeF, np. sprzedaż z kasy rejestrującej. Poprawka to usunięcie wpisu i dodanie nowego.
          </p>
        </div>
        {wpisy.length > 0 ? (
          <Table aria-label="Wpisy ręczne w miesiącu">
            <TableHeader>
              <TableRow>
                <TableHead>Data przychodu</TableHead>
                <TableHead>Dowód</TableHead>
                <TableHead className="text-right">Przychód</TableHead>
                <TableHead className="text-right">Stawka</TableHead>
                <TableHead>Uwagi</TableHead>
                {canEdit ? <TableHead className="sr-only">Usuń</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {wpisy.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>{formatIsoDatePl(w.dataPrzychodu)}</TableCell>
                  <TableCell>
                    <span className="block">{w.dokument}</span>
                    <span className="text-muted-foreground block text-xs">
                      {NAZWY_RODZAJOW_WPISU[w.rodzaj]}, wpis z {formatIsoDatePl(w.dataWpisu)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{zl(w.kwotaGr)}</TableCell>
                  <TableCell className="text-right tabular-nums">{etykietaStawki(w.stawkaPb)}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64 text-xs whitespace-normal">{w.opis}</TableCell>
                  {canEdit ? (
                    <TableCell className="text-right">
                      <UsunWpisPrzycisk id={w.id} dokument={w.dokument} />
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
          <WpisRecznyForm domyslnaData={domyslnaData} domyslnaStawkaPb={wersjaNa(wersje, domyslnaData)?.stawkaDomyslna ?? null} />
        ) : (
          <p className="text-muted-foreground text-xs">Wpisy dodaje i usuwa właściciel albo administrator firmy.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PlikJpk({
  ewidencja,
  rok,
  miesiac,
  koniecMiesiaca,
  dzis,
  mozePobrac,
}: {
  ewidencja: Ewidencja;
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
    const braki = brakiOkresu(ewidencja, od, doDnia);
    const wiersze = ewidencja.wiersze.filter((w) => wOkresie(w.dataPrzychodu, od, doDnia));
    const miesiaceBrakow = [...new Set(braki.map((b) => b.dzien.slice(0, 7)))].map(monthLabel);
    if (braki.length > 0) {
      tresc = (
        <p className="text-sm">
          Plik {okres} powstanie, gdy ewidencja nie będzie mieć braków. Braki są w miesiącach: {miesiaceBrakow.join(', ')}.
        </p>
      );
    } else if (wiersze.length === 0) {
      tresc = <p className="text-sm">Ewidencja {okres} nie ma wpisów, więc plik byłby pusty.</p>;
    } else {
      tresc = (
        <>
          <p className="text-sm">
            Plik {okres}: wiersze {wiersze.length}, przychód razem {zl(sumyOkresu(wiersze).razemGr)}. Plik za cały zamknięty
            rok ma cel „złożenie po raz pierwszy”, za część roku „na żądanie urzędu”.
          </p>
          {mozePobrac ? (
            <JpkEwpPobierz rok={rok} doMiesiaca={miesiac} />
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
        <h2 className="text-sm font-medium">Plik JPK_EWP</h2>
        {tresc}
      </CardContent>
    </Card>
  );
}

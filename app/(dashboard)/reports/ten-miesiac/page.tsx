import { notFound } from 'next/navigation';

import MonthSelector from '@/components/expenses/finora/month-selector';
import { ZaplaconeRozliczenie, ZatwierdzMiesiac } from '@/components/ksiegowosc/ten-miesiac-akcje';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl, formatTimestampDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { formatujRachunek, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { wersjaNa } from '@/lib/ksiegowosc/profil';
import { NAZWY_ROZLICZEN, type RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { aktualne, czytajTenMiesiac, type Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { granice } from '@/lib/ksiegowosc/zus';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * „Ten miesiąc” w Księgowości (plan księgowości JDG, K4, sekcja 8): ryczałt,
 * składki społeczne i zdrowotna za miesiąc z terminami i danymi do przelewu,
 * „Zatwierdź miesiąc” (D6), „Zapłacone” i historia wersji.
 *
 * Za wyłącznikiem (obszar `ten_miesiac`): firma poza pilotażem dostaje 404.
 * Bez parametrów potwierdzonych przez księgową, profilu albo z brakami
 * ewidencji strona pokazuje braki zamiast kwot (sekcja 4, pkt 8).
 */

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;

function poprzedniMiesiac(dzis: string): string {
  const [r, m] = dzis.split('-').map(Number);
  const d = new Date(Date.UTC(r, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

function miesiacZParametrow(sp: { month?: string; year?: string }, dzis: string): string {
  const m = Number(sp.month);
  const r = Number(sp.year);
  if (Number.isInteger(m) && m >= 1 && m <= 12 && Number.isInteger(r) && r >= 2026 && r <= 2100) {
    return `${r}-${String(m).padStart(2, '0')}`;
  }
  // Domyślnie poprzedni miesiąc: ten, który właśnie się rozlicza.
  return poprzedniMiesiac(dzis);
}

export default async function TenMiesiacPage({ searchParams }: { searchParams: Promise<{ month?: string; year?: string }> }) {
  const ctx = await getPageContext();
  const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'ten_miesiac');
  if (!werdykt.wlaczony) notFound();

  const dzis = todayInWarsaw();
  const miesiac = miesiacZParametrow(await searchParams, dzis);
  const tytul = monthLabel(miesiac);
  const rok = Number(miesiac.slice(0, 4));
  const zakonczony = granice(miesiac).do < dzis;
  const canEdit = ctx.role === 'owner' || ctx.role === 'admin';

  const [dane, { data: firma }] = await Promise.all([
    czytajTenMiesiac(ctx.supabase, ctx.tenantId, miesiac),
    ctx.supabase.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
  ]);
  const nip = String(firma?.nip ?? '').replace(/\D/g, '');
  const mikro = nip ? mikrorachunekZNip(nip) : null;

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Rozliczenie miesiąca</h1>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Rozliczenie za {tytul}</h2>
            <p className="text-muted-foreground text-xs">Ryczałt, składki społeczne i składka zdrowotna z terminami i danymi do przelewu.</p>
          </div>
          <MonthSelector month={miesiac} currentMonth={dzis.slice(0, 7)} basePath="/reports/ten-miesiac" query="month-year" ariaLabel="Miesiąc rozliczenia" />
        </CardContent>
      </Card>

      {!dane.ok ? (
        <Alert variant="destructive">
          <AlertTitle>Kwot za {tytul} nie liczymy</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {dane.braki.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Kafel nazwa="Przychód w miesiącu" kwotaGr={dane.wynik.przychodGr} />
                <Kafel nazwa="Ryczałt" kwotaGr={dane.wynik.ryczalt.ryczaltGr} />
                <Kafel nazwa="Składki społeczne" kwotaGr={dane.wynik.skladki.razemGr + dane.wynik.skladki.funduszPracyGr} />
                <Kafel nazwa="Składka zdrowotna" kwotaGr={dane.wynik.zdrowotna.skladkaGr} />
              </div>
              <p className="text-muted-foreground text-xs">
                Według Twoich danych i stawek na {rok} r. Od przychodu odliczono {zl(dane.wynik.ryczalt.odliczenia.odliczonoGr)}: składki
                społeczne zapłacone w tym miesiącu {zl(dane.wynik.ryczalt.odliczenia.spoleczneZaplaconeGr)}, połowa zapłaconej składki
                zdrowotnej {zl(dane.wynik.ryczalt.odliczenia.zdrowotna50ProcGr)} i nadwyżka z poprzednich miesięcy{' '}
                {zl(dane.wynik.ryczalt.odliczenia.nadwyzkaZPoprzednichGr)}; na kolejne miesiące zostaje{' '}
                {zl(dane.wynik.ryczalt.odliczenia.nadwyzkaNaKolejneGr)}. Odlicza się składki oznaczone jako zapłacone, z datą zapłaty.
                Składka zdrowotna: próg „{dane.wynik.zdrowotna.prog}”, bo przychód od początku roku po odliczeniu zapłaconych składek
                społecznych to {zl(dane.wynik.zdrowotna.przychodNarastajacoGr)}.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4">
              <h2 className="text-sm font-medium">Do zapłaty</h2>
              <ul className="flex flex-col gap-4" aria-label="Rozliczenia do zapłaty">
                {dane.pozycje.map((p) => {
                  const zatwierdzone = aktualne(dane.rozliczenia).get(p.rodzaj);
                  const aktualneDane = zatwierdzone?.wejsciaHash === p.wejsciaHash;
                  return (
                    <li key={p.rodzaj} className="flex flex-col gap-1 border-b pb-4 last:border-b-0 last:pb-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{NAZWY_ROZLICZEN[p.rodzaj]}</span>
                        <span className="text-sm font-medium tabular-nums">{zl(p.kwotaGr)}</span>
                      </div>
                      {p.termin ? (
                        <p className="text-muted-foreground text-xs">
                          Termin: {formatIsoDatePl(p.termin.faktyczny)}
                          {p.termin.przesuniety ? ` (ustawowo ${formatIsoDatePl(p.termin.nominalny)}, przesunięty na dzień roboczy)` : ''}.
                        </p>
                      ) : null}
                      <p className="text-muted-foreground text-xs">{daneDoPrzelewu(p.rodzaj, miesiac, nip, mikro, wersjaNa(dane.wersje, `${miesiac}-01`)?.nrsZus ?? null)}</p>
                      <StatusRozliczenia
                        rodzaj={p.rodzaj}
                        rozliczenie={zatwierdzone ?? null}
                        aktualneDane={aktualneDane}
                        kwotaGr={p.kwotaGr}
                        canEdit={canEdit}
                        dzis={dzis}
                        miesiac={miesiac}
                      />
                    </li>
                  );
                })}
              </ul>
              {canEdit ? (
                zakonczony ? (
                  dane.pozycje.some((p) => aktualne(dane.rozliczenia).get(p.rodzaj)?.wejsciaHash !== p.wejsciaHash) ? (
                    <div className="flex justify-end">
                      <ZatwierdzMiesiac
                        miesiac={miesiac}
                        etykieta={dane.rozliczenia.length > 0 ? 'Zatwierdź nową wersję' : 'Zatwierdź miesiąc'}
                      />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">Miesiąc jest zatwierdzony i dane się od tego czasu nie zmieniły.</p>
                  )
                ) : (
                  <p className="text-muted-foreground text-xs">Miesiąc zatwierdza się po jego zakończeniu, gdy są już wszystkie przychody.</p>
                )
              ) : (
                <p className="text-muted-foreground text-xs">Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {dane.rozliczenia.length > 0 ? <Historia rozliczenia={dane.rozliczenia} /> : null}
    </div>
  );
}

function Kafel({ nazwa, kwotaGr }: { nazwa: string; kwotaGr: number }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-xs">{nazwa}</p>
      <p className="text-lg font-medium tabular-nums">{zl(kwotaGr)}</p>
    </div>
  );
}

function daneDoPrzelewu(rodzaj: RodzajRozliczenia, miesiac: string, nip: string, mikro: string | null, nrs: string | null): string {
  if (rodzaj === 'ryczalt') {
    if (!mikro) return 'Mikrorachunek podatkowy wylicza się z NIP firmy, a NIP jest w Ustawieniach, w danych firmy.';
    return `Mikrorachunek podatkowy ${formatujRachunek(mikro)}, symbol formularza PPE, okres ${miesiac.slice(2, 4)}M${miesiac.slice(5, 7)}, identyfikator NIP ${nip}.`;
  }
  if (!nrs) return 'Numer rachunku składkowego jest w PUE ZUS; można go zapisać w zakładce „Ustawienia podatkowe”.';
  return `Rachunek składkowy ZUS ${formatujRachunek(nrs)}.`;
}

function StatusRozliczenia({
  rodzaj,
  rozliczenie,
  aktualneDane,
  kwotaGr,
  canEdit,
  dzis,
  miesiac,
}: {
  rodzaj: RodzajRozliczenia;
  rozliczenie: Rozliczenie | null;
  aktualneDane: boolean;
  kwotaGr: number;
  canEdit: boolean;
  dzis: string;
  miesiac: string;
}) {
  if (!rozliczenie) return <p className="text-xs">Niezatwierdzone.</p>;
  const wersja = `wersja ${rozliczenie.wersja}`;
  if (!aktualneDane) {
    const doplata = rozliczenie.status === 'zaplacone' ? kwotaGr - rozliczenie.kwotaGr : null;
    return (
      <p className="text-xs">
        Dane zmieniły się po zatwierdzeniu ({wersja}: {zl(rozliczenie.kwotaGr)}). Nowa wersja czeka na zatwierdzenie
        {doplata !== null && doplata > 0 ? `; po zapłacie poprzedniej wersji dopłata to ${zl(doplata)}` : ''}.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs">
        {rozliczenie.status === 'zaplacone' && rozliczenie.zaplaconeO
          ? `Zapłacono ${formatIsoDatePl(rozliczenie.zaplaconeO)} (${wersja}).`
          : `Zatwierdzone (${wersja}).`}
      </p>
      {canEdit ? (
        <ZaplaconeRozliczenie
          id={rozliczenie.id}
          nazwa={NAZWY_ROZLICZEN[rodzaj]}
          zaplacone={rozliczenie.status === 'zaplacone'}
          dzis={dzis}
          najwczesniej={`${miesiac}-01`}
        />
      ) : null}
    </div>
  );
}

function Historia({ rozliczenia }: { rozliczenia: Rozliczenie[] }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Historia wersji</h2>
        <Table aria-label="Wersje rozliczeń miesiąca">
          <TableHeader>
            <TableRow>
              <TableHead>Rozliczenie</TableHead>
              <TableHead>Wersja</TableHead>
              <TableHead className="text-right">Kwota</TableHead>
              <TableHead>Zatwierdzone</TableHead>
              <TableHead>Zapłata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...rozliczenia].reverse().map((r) => (
              <TableRow key={r.id}>
                <TableCell>{NAZWY_ROZLICZEN[r.rodzaj]}</TableCell>
                <TableCell className="tabular-nums">{r.wersja}</TableCell>
                <TableCell className="text-right tabular-nums">{zl(r.kwotaGr)}</TableCell>
                <TableCell>{formatTimestampDatePl(r.zatwierdzoneO)}</TableCell>
                <TableCell>{r.zaplaconeO ? formatIsoDatePl(r.zaplaconeO) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

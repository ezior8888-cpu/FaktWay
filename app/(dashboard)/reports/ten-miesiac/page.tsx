import { notFound } from 'next/navigation';
import { RiCalculatorLine, RiFileList3Line, RiHeartPulseLine, RiPercentLine, RiScales3Line, RiShieldUserLine, RiShoppingBag3Line } from '@remixicon/react';
import type { ComponentType } from 'react';

import MonthSelector from '@/components/expenses/finora/month-selector';
import { StatCell, StatCellError, StatsCardsFrame } from '@/components/expenses/finora/stats-cards';
import { ZaplaconeRozliczenie, ZaplataReczna, ZatwierdzMiesiac } from '@/components/ksiegowosc/ten-miesiac-akcje';
import { NadwyzkaPoprzednia } from '@/components/ksiegowosc/vat-akcje';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl, formatTimestampDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { miesiacZParametrow } from '@/lib/ksiegowosc/miesiac-strony';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { daneDoPrzelewu, podpisKwot } from '@/lib/ksiegowosc/przelew';
import { rokSkladkowyZdrowotnej } from '@/lib/ksiegowosc/parametry';
import { NAZWY_ROZLICZEN, type RodzajRozliczenia, type VatWyniku } from '@/lib/ksiegowosc/ten-miesiac';
import {
  aktualne,
  czytajTenMiesiac,
  doZatwierdzenia,
  miesiacZakonczony,
  PO_KONCU_MIESIACA,
  zaplacono,
  type DaneMiesiaca,
  type PozycjaZeSkrotem,
  type Rozliczenie,
} from '@/lib/ksiegowosc/ten-miesiac-dane';
import { nadwyzkaZAdresu } from '@/lib/ksiegowosc/vat-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * „Ten miesiąc” w Księgowości (plan księgowości JDG, K4, sekcja 8): ryczałt,
 * składki społeczne i zdrowotna za miesiąc z terminami i danymi do przelewu,
 * „Zatwierdź miesiąc” (D6), „Zapłacone” i historia wersji. Przy czynnym VAT
 * także VAT z terminem 25. (K7.1); nieznaną nadwyżkę z poprzedniej deklaracji
 * klient wpisuje przy pozycji (adres `?nadwyzka=`, jak na ekranie VAT).
 *
 * Za wyłącznikiem (obszar `ten_miesiac`): firma poza pilotażem dostaje 404.
 * Bez parametrów potwierdzonych przez księgową, profilu albo z brakami
 * ewidencji strona pokazuje braki zamiast kwot (sekcja 4, pkt 8); brak jednej
 * pozycji nie zabiera kwot pozostałych.
 */

type DaneOk = Extract<DaneMiesiaca, { ok: true }>;

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;

/** Podpis każdej kwoty (plan, sekcja 8): rok stawek, a dla zdrowotnej rok składkowy, gdy jest inny. Kończy się kropką. */
export default async function TenMiesiacPage({ searchParams }: { searchParams: Promise<{ month?: string; year?: string; nadwyzka?: string }> }) {
  const ctx = await getPageContext();
  const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'ten_miesiac');
  if (!werdykt.wlaczony) notFound();

  const dzis = todayInWarsaw();
  const sp = await searchParams;
  const miesiac = miesiacZParametrow(sp, dzis);
  const nadwyzkaVat = nadwyzkaZAdresu(sp.nadwyzka);
  const tytul = monthLabel(miesiac);
  const rok = Number(miesiac.slice(0, 4));
  const rokSkladkowy = rokSkladkowyZdrowotnej(miesiac);
  const canEdit = ctx.role === 'owner' || ctx.role === 'admin';

  const [dane, firma] = await Promise.all([
    czytajTenMiesiac(ctx.supabase, ctx.tenantId, miesiac, { nadwyzkaVat }),
    ctx.supabase.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
  ]);
  // `null`: NIP-u nie udało się odczytać (inny komunikat niż „brak NIP w ustawieniach”).
  const nip = firma.error ? null : String(firma.data?.nip ?? '').replace(/\D/g, '');
  const mikro = nip ? mikrorachunekZNip(nip) : null;
  const podatek = dane.ok && dane.wynik.profil.forma !== 'ryczalt' ? 'Zaliczka na podatek dochodowy' : 'Ryczałt';

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Rozliczenie miesiąca</h1>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Rozliczenie za {tytul}</h2>
            <p className="text-muted-foreground text-xs">
              {podatek}, składki społeczne{dane.ok && dane.wynik.vat ? ', składka zdrowotna i VAT' : ' i składka zdrowotna'} z terminami i danymi do przelewu.
            </p>
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
          <Kafle dane={dane} podpisKwot={podpisKwot(rok, rokSkladkowy)} />

          <Card>
            <CardContent className="flex flex-col gap-4">
              <div>
                <h2 className="text-sm font-medium">Do zapłaty</h2>
                <p className="text-muted-foreground text-xs">{podpisKwot(rok, rokSkladkowy)}</p>
              </div>
              <ul className="flex flex-col gap-4" aria-label="Rozliczenia do zapłaty">
                {dane.pozycje.map((p) => (
                  <li key={p.rodzaj} className="flex flex-col gap-1 border-b pb-4 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{NAZWY_ROZLICZEN[p.rodzaj]}</span>
                      {p.ok ? <span className="text-sm font-medium tabular-nums">{zl(p.kwotaGr)}</span> : null}
                    </div>
                    {p.ok ? null : <p className="text-xs">{p.brak}</p>}
                    {p.rodzaj === 'vat' && dane.wynik.vat ? <NadwyzkaVat vat={dane.wynik.vat} miesiac={miesiac} /> : null}
                    {p.termin ? (
                      <p className="text-muted-foreground text-xs">
                        Termin: {formatIsoDatePl(p.termin.faktyczny)}
                        {p.termin.przesuniety ? ` (ustawowo ${formatIsoDatePl(p.termin.nominalny)}, przesunięty na dzień roboczy)` : ''}.
                      </p>
                    ) : null}
                    <p className="text-muted-foreground text-xs">{daneDoPrzelewu(p.rodzaj, miesiac, nip, mikro, dane.wynik.profil.nrsZus, dane.wynik.profil.forma)}</p>
                    <StatusRozliczenia pozycja={p} rozliczenia={dane.rozliczenia} canEdit={canEdit} dzis={dzis} miesiac={miesiac} />
                  </li>
                ))}
              </ul>
              <Zatwierdzanie dane={dane} miesiac={miesiac} dzis={dzis} canEdit={canEdit} />
            </CardContent>
          </Card>
        </>
      )}

      {canEdit || dane.zaplatyReczne.length > 0 ? <ZaplatySpozaWyliczenia zaplaty={dane.zaplatyReczne} canEdit={canEdit} dzis={dzis} miesiac={miesiac} /> : null}

      {dane.rozliczenia.length > 0 ? <Historia rozliczenia={dane.rozliczenia} canEdit={canEdit} dzis={dzis} /> : null}
    </div>
  );
}

const IKONY: Readonly<Record<RodzajRozliczenia, ComponentType<{ className?: string }>>> = {
  ryczalt: RiPercentLine,
  pit: RiCalculatorLine,
  zus_spoleczne: RiShieldUserLine,
  zdrowotna: RiHeartPulseLine,
  vat: RiScales3Line,
};

const ETYKIETY: Readonly<Record<RodzajRozliczenia, string>> = {
  ryczalt: 'Ryczałt',
  pit: 'Zaliczka PIT',
  zus_spoleczne: 'Składki społeczne',
  zdrowotna: 'Składka zdrowotna',
  vat: 'VAT do zapłaty',
};

function Kafle({ dane, podpisKwot }: { dane: DaneOk; podpisKwot: string }) {
  const { ryczalt, zdrowotna, przychodGr, kosztyGr, pit, zdrowotnaOdDochodu, vat } = dane.wynik;
  const kpir = dane.wynik.profil.forma !== 'ryczalt';
  const ujemne = ryczalt ? [...ryczalt.ujemneNaKolejneGr.values()].reduce((s, gr) => s - gr, 0) : 0;
  return (
    <StatsCardsFrame
      cells={[
        przychodGr !== null ? (
          <StatCell label="Przychód w miesiącu" value={zl(przychodGr)} icon={RiFileList3Line} />
        ) : (
          <StatCellError
            label="Przychód w miesiącu"
            message={`${kpir ? 'KPiR' : 'Ewidencja'} ma w tym miesiącu braki; lista jest w zakładce „Ewidencja”.`}
          />
        ),
        ...(kpir && kosztyGr !== null ? [<StatCell key="koszty" label="Koszty w miesiącu" value={zl(kosztyGr)} icon={RiShoppingBag3Line} />] : []),
        ...dane.pozycje.map((p) =>
          p.ok ? (
            <StatCell key={p.rodzaj} label={ETYKIETY[p.rodzaj]} value={zl(p.kwotaGr)} icon={IKONY[p.rodzaj]} />
          ) : (
            <StatCellError key={p.rodzaj} label={ETYKIETY[p.rodzaj]} message="Kwoty nie liczymy; powód jest niżej, w „Do zapłaty”." />
          ),
        ),
      ]}
      footer={
        <p className="text-muted-foreground text-xs">
          {podpisKwot}
          {ryczalt
            ? ` Od przychodu odliczono ${zl(ryczalt.odliczenia.odliczonoGr)}: składki społeczne zapłacone w tym miesiącu ` +
              `${zl(ryczalt.odliczenia.spoleczneZaplaconeGr)}, połowa zapłaconej składki zdrowotnej ${zl(ryczalt.odliczenia.zdrowotna50ProcGr)} ` +
              `i nadwyżka z poprzednich miesięcy ${zl(ryczalt.odliczenia.nadwyzkaZPoprzednichGr)}; na kolejne miesiące zostaje ` +
              `${zl(ryczalt.odliczenia.nadwyzkaNaKolejneGr)}. Odlicza się składki oznaczone jako zapłacone, z datą zapłaty.`
            : ''}
          {ujemne > 0 ? ` Korekty większe niż przychód zmniejszą przychód kolejnych miesięcy o ${zl(ujemne)}.` : ''}
          {pit
            ? ` Zaliczka PIT od dochodu od początku roku ${zl(pit.dochodNarastajacoGr)} po odliczeniu zapłaconych składek społecznych ` +
              `${zl(pit.spoleczneNarastajacoGr)}${pit.zdrowotnaNarastajacoGr > 0 ? ` i zapłaconej składki zdrowotnej ${zl(pit.zdrowotnaNarastajacoGr)}` : ''}: ` +
              `podstawa ${zl(pit.podstawaNarastajacoGr)}, podatek od początku roku ${zl(pit.podatekNarastajacoGr)}, minus zaliczki za wcześniejsze miesiące.`
            : ''}
          {zdrowotnaOdDochodu
            ? ` Składka zdrowotna od dochodu z poprzedniego miesiąca (${zl(zdrowotnaOdDochodu.dochodGr)} po odliczeniu zapłaconych składek społecznych)` +
              `${zdrowotnaOdDochodu.minimalna ? ', w kwocie minimalnej' : ''}.`
            : ''}
          {zdrowotna
            ? ` Składka zdrowotna: próg „${zdrowotna.prog}”, bo przychód od początku roku po odliczeniu zapłaconych składek ` +
              `społecznych to ${zl(zdrowotna.przychodNarastajacoGr)}.`
            : ''}
          {vat?.wynik
            ? ` VAT: należny ${zl(vat.wynik.naleznyGr)}, naliczony ${zl(vat.wynik.naliczonyGr)} (w tym nadwyżka ${zl(vat.wynik.nadwyzkaPoprzedniaGr)} ` +
              `z deklaracji za ${monthLabel(shiftMonth(dane.wynik.miesiac, -1))})` +
              `${vat.wynik.nadwyzkaNaNastepnyGr > 0 ? `, nadwyżka na następny miesiąc ${zl(vat.wynik.nadwyzkaNaNastepnyGr)}` : ''}.`
            : ''}
        </p>
      }
    />
  );
}

/** Symbol na przelewie na mikrorachunek według wykazu MF (Dz.U. 2025 poz. 1305, część II i III): PPE przy ryczałcie, PIT (zaliczka miesięczna) przy skali, PPL (stawka 19 %) przy liniowym, JPK-V7M przy VAT. PIT-36 i PIT-36L to zeznania roczne. */
/**
 * Stan ostatniej zatwierdzonej wersji z kontrolką zapłaty. Dopłata liczy się od
 * najwyższej zapłaconej wersji, tak jak odliczenia (`przyrostyZaplat`).
 */
function StatusRozliczenia({
  pozycja: p,
  rozliczenia,
  canEdit,
  dzis,
  miesiac,
}: {
  pozycja: PozycjaZeSkrotem;
  rozliczenia: Rozliczenie[];
  canEdit: boolean;
  dzis: string;
  miesiac: string;
}) {
  const ostatnia = aktualne(rozliczenia).get(p.rodzaj);
  if (!ostatnia) return p.ok ? <p className="text-xs">Niezatwierdzone.</p> : null;
  const zaplaconoGr = zaplacono(rozliczenia, p.rodzaj);
  const wersja = `wersja ${ostatnia.wersja}`;
  const stan =
    ostatnia.status === 'zaplacone' && ostatnia.zaplaconeO
      ? `Zapłacono ${formatIsoDatePl(ostatnia.zaplaconeO)} (${wersja}: ${zl(ostatnia.kwotaGr)}).`
      : zaplaconoGr > 0
        ? `Zatwierdzone (${wersja}: ${zl(ostatnia.kwotaGr)}); wcześniejsza wersja jest zapłacona (${zl(zaplaconoGr)}), ` +
          `więc do dopłaty zostaje ${zl(Math.max(0, ostatnia.kwotaGr - zaplaconoGr))}.`
        : `Zatwierdzone (${wersja}).`;
  const zmiana =
    p.ok && ostatnia.wejsciaHash !== p.wejsciaHash
      ? `Dane zmieniły się po zatwierdzeniu: nowa kwota ${zl(p.kwotaGr)} czeka na zatwierdzenie` +
        (zaplaconoGr > 0 ? `; po zatwierdzeniu do dopłaty zostanie ${zl(Math.max(0, p.kwotaGr - zaplaconoGr))}` : '') +
        '.'
      : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs">{stan}</p>
        {canEdit ? (
          <ZaplaconeRozliczenie
            id={ostatnia.id}
            nazwa={NAZWY_ROZLICZEN[p.rodzaj]}
            zaplacone={ostatnia.status === 'zaplacone'}
            dzis={dzis}
            najwczesniej={`${miesiac}-01`}
          />
        ) : null}
      </div>
      {zmiana ? <p className="text-xs">{zmiana}</p> : null}
    </div>
  );
}

function Zatwierdzanie({ dane, miesiac, dzis, canEdit }: { dane: DaneOk; miesiac: string; dzis: string; canEdit: boolean }) {
  if (!canEdit) return <p className="text-muted-foreground text-xs">Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.</p>;
  if (!miesiacZakonczony(miesiac, dzis)) return <p className="text-muted-foreground text-xs">{PO_KONCU_MIESIACA}</p>;
  if (doZatwierdzenia(dane).length === 0) {
    return dane.pozycje.some((p) => p.ok) ? (
      <p className="text-muted-foreground text-xs">Policzone kwoty są zatwierdzone i dane się od tego czasu nie zmieniły.</p>
    ) : null;
  }
  // Akcja zatwierdzi tylko to, co widać: skróty pozycji z tego widoku.
  const skroty = Object.fromEntries(dane.pozycje.flatMap((p) => (p.ok ? [[p.rodzaj, p.wejsciaHash]] : [])));
  return (
    <div className="flex justify-end">
      <ZatwierdzMiesiac
        miesiac={miesiac}
        skroty={skroty}
        etykieta={dane.rozliczenia.length > 0 ? 'Zatwierdź nową wersję' : 'Zatwierdź miesiąc'}
        // Wpisana na ekranie nadwyżka (K7.1): akcja liczy VAT z tą samą kwotą.
        nadwyzkaVat={dane.wynik.vat?.nadwyzka?.zrodlo === 'klient' ? dane.wynik.vat.nadwyzka.zl : null}
      />
    </div>
  );
}

/**
 * Nadwyżka z poprzedniej deklaracji przy pozycji VAT (K7.1): z MF tylko
 * informacja; w pozostałych przypadkach pole (nieznana nadwyżka albo kwota do
 * poprawienia, gdy deklaracja złożona poza FaktWay miała inną).
 */
function NadwyzkaVat({ vat, miesiac }: { vat: VatWyniku; miesiac: string }) {
  const poprzedni = monthLabel(shiftMonth(miesiac, -1));
  if (vat.nadwyzka?.zrodlo === 'mf') {
    return (
      <p className="text-muted-foreground text-xs">
        Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(vat.nadwyzka.zl * 100)}, z deklaracji przyjętej przez MF.
      </p>
    );
  }
  // Brak z innego powodu niż nadwyżka (np. odczyt albo dokument, którego plik nie wykaże): pole nic tu nie zmieni.
  if (!vat.nadwyzka && !vat.nadwyzkaNieznana) return null;
  return (
    <div className="flex flex-col gap-2 pt-1">
      {vat.nadwyzka?.zrodlo === 'zatwierdzone' ? (
        <p className="text-muted-foreground text-xs">
          Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(vat.nadwyzka.zl * 100)}, z rozliczenia VAT za {poprzedni} zatwierdzonego w „Ten miesiąc”.
        </p>
      ) : null}
      {vat.nadwyzka?.zrodlo === 'ten_miesiac' ? (
        <p className="text-muted-foreground text-xs">
          Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(vat.nadwyzka.zl * 100)}, z zatwierdzonego rozliczenia VAT za {monthLabel(miesiac)}.
        </p>
      ) : null}
      <NadwyzkaPoprzednia
        adres={`/reports/ten-miesiac?month=${Number(miesiac.slice(5, 7))}&year=${miesiac.slice(0, 4)}`}
        poprzedni={poprzedni}
        wartosc={vat.nadwyzka?.zl ?? null}
      />
    </div>
  );
}

/**
 * Zapłaty spoza wyliczenia (K7.2, D15): składki za okres, którego moduł nie
 * liczy, z kwotą z PUE ZUS. Lista pokazuje zapłacone w tym miesiącu i te,
 * którym brakuje daty zapłaty (wtedy datę ustawia się tutaj).
 */
function ZaplatySpozaWyliczenia({ zaplaty, canEdit, dzis, miesiac }: { zaplaty: Rozliczenie[]; canEdit: boolean; dzis: string; miesiac: string }) {
  const koniec = monthRange(miesiac).to;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium">Zapłaty spoza wyliczenia</h2>
          <p className="text-muted-foreground text-xs">
            Składki za okres, którego FaktWay nie liczy (np. za grudzień 2025 r. albo niepełny miesiąc), zapisuje się tutaj z kwotą z PUE ZUS.
            Zapisana zapłata pomniejsza podatek tak samo jak składki z wyliczenia oznaczone jako zapłacone.
          </p>
        </div>
        {zaplaty.length > 0 ? (
          <ul className="flex flex-col gap-3" aria-label="Zapłaty spoza wyliczenia">
            {zaplaty.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {NAZWY_ROZLICZEN[r.rodzaj]} za {monthLabel(r.miesiac)}: {zl(r.kwotaGr)}
                  {r.rodzaj === 'zus_spoleczne' ? `, w tym bez Funduszu Pracy i FS ${zl(r.spoleczneBezFpGr)}` : ''}.{' '}
                  {r.zaplaconeO ? `Zapłacone ${formatIsoDatePl(r.zaplaconeO)}.` : 'Bez daty zapłaty.'}
                </span>
                {canEdit ? (
                  <ZaplaconeRozliczenie
                    id={r.id}
                    nazwa={`${NAZWY_ROZLICZEN[r.rodzaj]} za ${monthLabel(r.miesiac)}`}
                    zaplacone={r.status === 'zaplacone'}
                    dzis={dzis}
                    najwczesniej={`${r.miesiac}-01`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canEdit ? (
          <ZaplataReczna domyslnyMiesiac={shiftMonth(miesiac, -1)} domyslnaData={koniec < dzis ? koniec : dzis} dzis={dzis} />
        ) : (
          <p className="text-muted-foreground text-xs">Zapłaty zapisuje właściciel albo administrator firmy.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Historia({ rozliczenia, canEdit, dzis }: { rozliczenia: Rozliczenie[]; canEdit: boolean; dzis: string }) {
  // Starszą wersję da się oznaczyć albo poprawić tutaj; najnowszą przy rozliczeniu wyżej.
  const najnowsze = new Set([...aktualne(rozliczenia).values()].map((r) => r.id));
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Historia wersji</h2>
          <p className="text-muted-foreground text-xs">Kwoty zatwierdzonych wersji według danych z dnia zatwierdzenia.</p>
        </div>
        <Table aria-label="Wersje rozliczeń miesiąca">
          <TableHeader>
            <TableRow>
              <TableHead>Rozliczenie</TableHead>
              <TableHead>Wersja</TableHead>
              <TableHead className="text-right">Kwota</TableHead>
              <TableHead>Zatwierdzone</TableHead>
              <TableHead>Zapłata</TableHead>
              {canEdit ? (
                <TableHead>
                  <span className="sr-only">Zmiana zapłaty</span>
                </TableHead>
              ) : null}
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
                {canEdit ? (
                  <TableCell>
                    {najnowsze.has(r.id) ? null : (
                      <ZaplaconeRozliczenie
                        id={r.id}
                        nazwa={`${NAZWY_ROZLICZEN[r.rodzaj]}, wersja ${r.wersja}`}
                        zaplacone={r.status === 'zaplacone'}
                        dzis={dzis}
                        najwczesniej={`${r.miesiac}-01`}
                      />
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

import { notFound } from 'next/navigation';
import { RiArrowDownCircleLine, RiArrowUpCircleLine, RiScales3Line } from '@remixicon/react';

import MonthSelector from '@/components/expenses/finora/month-selector';
import { StatCell, StatsCardsFrame } from '@/components/expenses/finora/stats-cards';
import { JpkV7mPobierz, JpkV7mWyslij, NadwyzkaPoprzednia, PobierzUpo, SprawdzStatus } from '@/components/ksiegowosc/vat-akcje';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl, formatTimestampDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { countLabel } from '@/lib/i18n/plural';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { miesiacZParametrow } from '@/lib/ksiegowosc/miesiac-strony';
import { formatujRachunek, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { brakNadwyzki, czytajVat, nadwyzkaZAdresu, type DaneVat } from '@/lib/ksiegowosc/vat-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { srodowiskoMf } from '@/lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { ocenOdmoweInit, ocenStatus } from '@/lib/ksiegowosc/wysylka-jpk/statusy';
import { trwa, type StanZapisu, type Wysylka } from '@/lib/ksiegowosc/wysylka-jpk/zapis';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * VAT w Księgowości (plan księgowości JDG, K6, sekcja 8): część deklaracyjna
 * JPK_V7M za miesiąc z tego samego kodu co plik, termin i dane do przelewu,
 * plik JPK_V7M(3) do pobrania, a przy włączonej wysyłce (obszar
 * `wysylka_jpk`, D9) wysyłka do MF ze statusem i UPO.
 *
 * Za wyłącznikiem (obszar `vat`): firma poza pilotażem dostaje 404. Bez
 * nadwyżki z poprzedniej deklaracji (P_39) kwot nie ma, tylko pole na nią.
 */

type DaneOk = Extract<DaneVat, { ok: true }>;

const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;

const STANY: Readonly<Record<StanZapisu, string>> = {
  wysylanie: 'Wysyłanie',
  w_toku: 'MF sprawdza plik',
  przyjeta: 'Przyjęty, UPO gotowe',
  odrzucona: 'Odrzucony',
  przerwana: 'Przerwana',
};

export default async function VatPage({ searchParams }: { searchParams: Promise<{ month?: string; year?: string; nadwyzka?: string }> }) {
  const ctx = await getPageContext();
  const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'vat');
  if (!werdykt.wlaczony) notFound();

  const sp = await searchParams;
  const dzis = todayInWarsaw();
  const miesiac = miesiacZParametrow(sp, dzis);
  const tytul = monthLabel(miesiac);
  const nadwyzkaKlienta = nadwyzkaZAdresu(sp.nadwyzka);
  const canEdit = ctx.role === 'owner' || ctx.role === 'admin';
  const srodowisko = srodowiskoMf();

  const [dane, firma, wysylka] = await Promise.all([
    czytajVat(ctx.supabase, ctx.tenantId, miesiac, nadwyzkaKlienta),
    ctx.supabase.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
    srodowisko ? czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'wysylka_jpk').catch(() => ({ wlaczony: false })) : { wlaczony: false },
  ]);
  const nip = firma.error ? null : String(firma.data?.nip ?? '').replace(/\D/g, '');
  const termin = terminDla({ rodzaj: 'vatJpk', rok: Number(miesiac.slice(0, 4)), miesiac: Number(miesiac.slice(5, 7)) });
  const zakonczony = monthRange(miesiac).to < dzis;
  const adres = `/reports/vat?month=${Number(miesiac.slice(5, 7))}&year=${miesiac.slice(0, 4)}`;

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">VAT</h1>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">VAT za {tytul}</h2>
            <p className="text-muted-foreground text-xs">Część deklaracyjna JPK_V7M, termin, dane do przelewu i plik dla Ministerstwa Finansów.</p>
          </div>
          <MonthSelector month={miesiac} currentMonth={dzis.slice(0, 7)} basePath="/reports/vat" query="month-year" ariaLabel="Miesiąc rozliczenia VAT" />
        </CardContent>
      </Card>

      {!dane.ok ? (
        <Alert variant="destructive">
          <AlertTitle>Kwot VAT za {tytul} nie liczymy</AlertTitle>
          <AlertDescription>{dane.komunikat}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Nadwyzka dane={dane} adres={adres} />
          {dane.wynik && !dane.wynik.ok ? (
            <Alert variant="destructive">
              <AlertTitle>Kwot VAT za {tytul} nie liczymy</AlertTitle>
              <AlertDescription>{dane.wynik.brak}</AlertDescription>
            </Alert>
          ) : null}
          {dane.wynik?.ok ? <Kafle wynik={dane.wynik} miesiac={miesiac} /> : null}

          <Card>
            <CardContent className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Termin i przelew</h2>
              {termin ? (
                <p className="text-xs">
                  Złożenie JPK_V7M i zapłata VAT za {tytul}: do {formatIsoDatePl(termin.faktyczny)}
                  {termin.przesuniety ? ` (ustawowo ${formatIsoDatePl(termin.nominalny)}, przesunięty na dzień roboczy)` : ''}.
                </p>
              ) : null}
              <p className="text-muted-foreground text-xs">{daneDoPrzelewu(miesiac, nip)}</p>
            </CardContent>
          </Card>

          {dane.wynik?.ok ? (
            <Card>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <h2 className="text-sm font-medium">Plik JPK_V7M</h2>
                  <p className="text-muted-foreground text-xs">
                    {zakonczony
                      ? 'Ewidencja sprzedaży i zakupów z deklaracją VAT-7, zgodna ze schematem JPK_V7M(3) Ministerstwa Finansów.'
                      : `Plik za ${tytul} powstaje po zakończeniu miesiąca.`}
                  </p>
                </div>
                {zakonczony ? <JpkV7mPobierz miesiac={miesiac} nadwyzka={dane.nadwyzka?.zrodlo === 'klient' ? dane.nadwyzka.zl : null} email={ctx.user.email ?? null} /> : null}
              </CardContent>
            </Card>
          ) : null}

          <Wysylki
            dane={dane}
            miesiac={miesiac}
            zakonczony={zakonczony}
            canEdit={canEdit}
            wysylkaWlaczona={wysylka.wlaczony && srodowisko !== null}
            testowe={srodowisko === 'test'}
            email={ctx.user.email ?? null}
          />
        </>
      )}
    </div>
  );
}

function Nadwyzka({ dane, adres }: { dane: DaneOk; adres: string }) {
  const poprzedni = monthLabel(shiftMonth(dane.miesiac, -1));
  if (dane.nadwyzka?.zrodlo === 'mf') {
    return (
      <p className="text-muted-foreground text-xs">
        Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(dane.nadwyzka.zl * 100)}, z deklaracji przyjętej przez MF.
      </p>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {dane.nadwyzka ? null : <p className="text-sm">{brakNadwyzki(dane.miesiac)}</p>}
        {dane.nadwyzka?.zrodlo === 'ten_miesiac' ? (
          <p className="text-muted-foreground text-xs">
            Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(dane.nadwyzka.zl * 100)}, z zatwierdzonego rozliczenia VAT za{' '}
            {monthLabel(dane.miesiac)} w „Ten miesiąc”. Inna kwota z deklaracji złożonej poza FaktWay wpisuje się niżej.
          </p>
        ) : null}
        {dane.nadwyzka?.zrodlo === 'zatwierdzone' ? (
          <p className="text-muted-foreground text-xs">
            Nadwyżka z deklaracji za {poprzedni} (P_39): {zl(dane.nadwyzka.zl * 100)}, z rozliczenia VAT za {poprzedni} zatwierdzonego w „Ten
            miesiąc”. Inna kwota z deklaracji złożonej poza FaktWay wpisuje się niżej.
          </p>
        ) : null}
        <NadwyzkaPoprzednia adres={adres} poprzedni={poprzedni} wartosc={dane.nadwyzka?.zl ?? null} />
      </CardContent>
    </Card>
  );
}

function Kafle({ wynik, miesiac }: { wynik: Extract<NonNullable<DaneOk['wynik']>, { ok: true }>; miesiac: string }) {
  return (
    <StatsCardsFrame
      cells={[
        <StatCell key="p38" label="Podatek należny (P_38)" value={zl(wynik.naleznyGr)} icon={RiArrowUpCircleLine} />,
        <StatCell key="p48" label="Podatek naliczony (P_48)" value={zl(wynik.naliczonyGr)} icon={RiArrowDownCircleLine} />,
        wynik.doZaplatyGr > 0 || wynik.nadwyzkaNaNastepnyGr === 0 ? (
          <StatCell key="p51" label="Do wpłaty (P_51)" value={zl(wynik.doZaplatyGr)} icon={RiScales3Line} />
        ) : (
          <StatCell key="p62" label="Nadwyżka na następny miesiąc (P_62)" value={zl(wynik.nadwyzkaNaNastepnyGr)} icon={RiScales3Line} />
        ),
      ]}
      footer={
        <p className="text-muted-foreground text-xs">
          Według Twoich danych za {monthLabel(miesiac)}: {countLabel(wynik.liczbaSprzedazy, ['faktura', 'faktury', 'faktur'])} sprzedaży i{' '}
          {countLabel(wynik.liczbaZakupow, ['koszt', 'koszty', 'kosztów'])} z VAT do odliczenia.
          Podatek naliczony obejmuje nadwyżkę z poprzedniej deklaracji ({zl(wynik.nadwyzkaPoprzedniaGr)}). Kwoty deklaracji są w pełnych złotych.
        </p>
      }
    />
  );
}

function daneDoPrzelewu(miesiac: string, nip: string | null): string {
  if (nip === null) return 'Nie udało się odczytać NIP firmy, więc mikrorachunku teraz nie pokazujemy; strona spróbuje ponownie przy następnym otwarciu.';
  const mikro = mikrorachunekZNip(nip);
  if (!mikro) return 'Mikrorachunek podatkowy wylicza się z NIP firmy, a NIP jest w Ustawieniach, w danych firmy.';
  return `Mikrorachunek podatkowy ${formatujRachunek(mikro)}, symbol formularza VAT-7, okres ${miesiac.slice(2, 4)}M${miesiac.slice(5, 7)}, identyfikator NIP ${nip}.`;
}

function Wysylki({
  dane,
  miesiac,
  zakonczony,
  canEdit,
  wysylkaWlaczona,
  testowe,
  email,
}: {
  dane: DaneOk;
  miesiac: string;
  zakonczony: boolean;
  canEdit: boolean;
  wysylkaWlaczona: boolean;
  testowe: boolean;
  email: string | null;
}) {
  // „wysylanie” starsze niż 15 minut to przerwana wysyłka: formularz wraca, a akcja zamknie wiersz przed nową.
  const wToku = dane.wysylki.some((w) => trwa(w));
  const korekta = dane.wysylki.some((w) => w.stan === 'przyjeta');
  const moznaWyslac = wysylkaWlaczona && canEdit && zakonczony && dane.wynik?.ok === true && !wToku;
  if (!wysylkaWlaczona && dane.wysylki.length === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium">Wysyłka do Ministerstwa Finansów</h2>
          <p className="text-muted-foreground text-xs">
            {wysylkaWlaczona
              ? 'Plik podpisany danymi autoryzującymi; po przyjęciu MF wydaje urzędowe poświadczenie odbioru (UPO).'
              : 'Wysyłka z FaktWay nie jest jeszcze włączona. Plik można złożyć w e-Urzędzie Skarbowym.'}
          </p>
        </div>
        {moznaWyslac ? (
          <JpkV7mWyslij
            miesiac={miesiac}
            nadwyzka={dane.nadwyzka?.zrodlo === 'klient' ? dane.nadwyzka.zl : null}
            rokKwoty={Number(todayInWarsaw().slice(0, 4)) - 2}
            testowe={testowe}
            korekta={korekta}
            email={email}
          />
        ) : null}
        {dane.wysylki.length > 0 ? <ListaWysylek wysylki={dane.wysylki} canEdit={canEdit} /> : null}
      </CardContent>
    </Card>
  );
}

/** Odmowa z kodem MF: kody poniżej 200 to odmowy InitUploadSigned, reszta to statusy po przyjęciu plików. */
function opisOdmowy(w: Wysylka): string {
  if (w.statusKod === null) return ocenOdmoweInit(null).tresc;
  const ocena = w.statusKod < 200 ? ocenOdmoweInit(w.statusKod) : ocenStatus(w.statusKod);
  return `${ocena.tresc} Kod MF ${w.statusKod}${w.statusOpis ? `: ${w.statusOpis}` : ''}.`;
}

function ListaWysylek({ wysylki, canEdit }: { wysylki: Wysylka[]; canEdit: boolean }) {
  return (
    <Table aria-label="Wysyłki JPK_V7M za miesiąc">
      <TableHeader>
        <TableRow>
          <TableHead>Wysłano</TableHead>
          <TableHead>Stan</TableHead>
          <TableHead>Numer referencyjny</TableHead>
          <TableHead className="text-right">Do wpłaty</TableHead>
          <TableHead>
            <span className="sr-only">Akcje</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {wysylki.map((w) => (
          <TableRow key={w.id}>
            <TableCell>{formatTimestampDatePl(w.utworzonoO)}</TableCell>
            <TableCell>
              <span className="text-sm">
                {STANY[w.stan]}
                {w.srodowisko === 'test' ? ' (środowisko testowe)' : ''}
              </span>
              {w.stan === 'odrzucona' ? <span className="text-muted-foreground block text-xs">{opisOdmowy(w)}</span> : null}
            </TableCell>
            <TableCell className="font-mono text-xs">{w.numerReferencyjny ?? ''}</TableCell>
            <TableCell className="text-right tabular-nums">{zl(w.deklaracja.P_51 * 100)}</TableCell>
            <TableCell className="text-right">
              {w.stan === 'w_toku' && canEdit ? <SprawdzStatus id={w.id} /> : null}
              {w.stan === 'przyjeta' ? <PobierzUpo id={w.id} /> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

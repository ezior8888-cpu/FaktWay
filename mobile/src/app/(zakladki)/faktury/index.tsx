import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS, type Faktura, type RodzajFaktury } from '@/dane-przykladowe';
import { Segmenty } from '@/komponenty/formularz';
import { otworzNaStronie } from '@/komponenty/na-stronie';
import { NotaDanych, StanBledu } from '@/komponenty/stan-danych';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import { Karta } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { KwotaZGroszami } from '@/komponenty/naglowek';
import { Tekst } from '@/komponenty/tekst';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { grosze } from '@/lib/dane/mapowanie';
import { dataKrotka, dniMiedzy, kwota } from '@/lib/format';
import { dni, doZaplaty, ileFaktur, pozostaloDoZaplaty, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { podpisPrzypomnien, useNaleznosci } from '@/stan/naleznosci';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';

/** Widoki jak zakładki strony: Wystawione, Cykliczne, Po terminie. */
const WIDOKI = ['Wystawione', 'Cykliczne', 'Po terminie'] as const;

const STATUSY_KSEF = ['Wszystkie', 'Szkice', 'W toku', 'Przyjęte w KSeF', 'Odrzucone i błędy'] as const;
const PLATNOSCI = ['Wszystkie', 'Opłacone', 'Nieopłacone', 'Po terminie'] as const;
const RODZAJE: { etykieta: string; rodzaj?: RodzajFaktury }[] = [
  { etykieta: 'Wszystkie' },
  { etykieta: 'VAT', rodzaj: 'vat' },
  { etykieta: 'Zaliczkowa', rodzaj: 'zaliczkowa' },
  { etykieta: 'Korygująca', rodzaj: 'korygujaca' },
  { etykieta: 'Końcowa', rodzaj: 'rozliczajaca' },
];

const MIESIACE = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' });

function nazwaMiesiaca(iso: string): string {
  const tekst = MIESIACE.format(new Date(`${iso}T12:00:00`));
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

function grupujPoMiesiacu(faktury: Faktura[]): [string, Faktura[]][] {
  const grupy = new Map<string, Faktura[]>();
  for (const f of faktury) {
    const klucz = nazwaMiesiaca(f.dataWystawienia);
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), f]);
  }
  return [...grupy.entries()];
}

const wZlotych = (f: Faktura) => !f.waluta || f.waluta === 'PLN';

/** Suma w złotych; faktury w walutach obcych (z bazy) nie dodają się do złotówek. */
function suma(faktury: Faktura[]): number {
  return faktury.reduce((s, f) => s + (wZlotych(f) ? f.brutto : 0), 0);
}

/** Ile klienci jeszcze winni w złotych: bez wpłat częściowych. */
function sumaDoZaplaty(faktury: Faktura[]): number {
  return faktury.reduce((s, f) => s + (wZlotych(f) ? pozostaloDoZaplaty(f) : 0), 0);
}

function pasujeStatusKsef(f: Faktura, filtr: (typeof STATUSY_KSEF)[number]): boolean {
  if (filtr === 'Szkice') return f.statusKsef === 'robocza';
  if (filtr === 'W toku') return f.statusKsef === 'wysylanie';
  if (filtr === 'Przyjęte w KSeF') return f.statusKsef === 'przyjeta';
  if (filtr === 'Odrzucone i błędy') return f.statusKsef === 'odrzucona' || f.statusKsef === 'blad';
  return true;
}

function pasujePlatnosc(f: Faktura, filtr: (typeof PLATNOSCI)[number], dzis: string): boolean {
  if (filtr === 'Opłacone') return f.zaplacona;
  if (filtr === 'Nieopłacone') return doZaplaty(f);
  if (filtr === 'Po terminie') return statusFaktury(f, dzis).zalegla;
  return true;
}

function widokZParametru(parametr: string | undefined): number {
  return parametr === 'cykliczne' ? 1 : parametr === 'po-terminie' ? 2 : 0;
}

/**
 * Faktury: odpowiednik sekcji strony `app/(dashboard)/(faktury)` (Wystawione,
 * Cykliczne, Po terminie) z filtrami i wyszukiwaniem, w układzie Revolut
 * Business (D14): karta „Do zapłaty”, pigułki, szkice na górze, miesiące z sumą.
 * D7: „Nowa faktura” jako szeroki bloczek pod sumą, nie plus w pasku.
 */
export default function EkranFaktur() {
  const kolory = useKolory();
  const router = useRouter();
  const { widok: widokParam } = useLocalSearchParams<{ widok?: string }>();
  const { faktury, cykliczne, flagi, dzis, dane } = useStanFaktur();
  // Prawdziwe konto (M7): lista z bazy; cykliczne i przypomnienia jeszcze na stronie (M10).
  const zBazy = dane.zrodlo === 'baza';
  const pierwszeWczytanie = zBazy && dane.stan === 'ladowanie' && faktury.length === 0;
  const bladBezDanych = zBazy && dane.stan === 'blad';
  const [widok, setWidok] = useState(widokZParametru(widokParam));
  // Link „Faktury cykliczne” z innej zakładki trafia na już otwartą listę: nowy parametr przełącza widok.
  const [ostatniParam, setOstatniParam] = useState(widokParam);
  if (widokParam !== ostatniParam) {
    setOstatniParam(widokParam);
    setWidok(widokZParametru(widokParam));
  }
  const [szukaj, setSzukaj] = useState('');
  const [statusKsef, setStatusKsef] = useState<(typeof STATUSY_KSEF)[number]>('Wszystkie');
  const [platnosc, setPlatnosc] = useState<(typeof PLATNOSCI)[number]>('Wszystkie');
  const [rodzaj, setRodzaj] = useState<string>('Wszystkie');
  // Prawdziwe konto (M10a): „Po terminie” z serwera, jak strona (stan przypomnień, limit 100).
  const naleznosci = useNaleznosci(widok === 2);

  const otwarte = faktury.filter(doZaplaty);
  const zalegle = otwarte.filter((f) => statusFaktury(f, dzis).zalegla);
  const filtrowAktywnych = [statusKsef, platnosc, rodzaj].filter((x) => x !== 'Wszystkie').length;

  const widoczne = useMemo(() => {
    const fraza = szukaj.trim().toLocaleLowerCase('pl');
    const wybranyRodzaj = RODZAJE.find((r) => r.etykieta === rodzaj)?.rodzaj;
    return faktury
      .filter((f) => pasujeStatusKsef(f, statusKsef))
      .filter((f) => pasujePlatnosc(f, platnosc, dzis))
      .filter((f) => !wybranyRodzaj || f.rodzaj === wybranyRodzaj)
      .filter((f) => !fraza || f.kontrahent.toLocaleLowerCase('pl').includes(fraza) || f.numer.toLowerCase().includes(fraza));
  }, [faktury, statusKsef, platnosc, rodzaj, szukaj, dzis]);

  // Szkice, odrzucone przez KSeF i z błędem wysyłki na górze listy, jak „Drafts” w Revolut Business (D14).
  const doDokonczenia = widoczne.filter((f) => f.statusKsef === 'robocza' || f.statusKsef === 'odrzucona' || f.statusKsef === 'blad');

  const poTerminie = zalegle
    .filter((f) => !szukaj || f.kontrahent.toLocaleLowerCase('pl').includes(szukaj.toLocaleLowerCase('pl')))
    .sort((a, b) => a.terminPlatnosci.localeCompare(b.terminPlatnosci));
  const wyslanePrzypomnienia = zalegle.reduce((s, f) => s + (f.przypomnienie?.wyslane ?? 0), 0);
  const wstrzymane = zalegle.filter((f) => flagi[`przypomnienia-wstrzymane-${f.id}`]).length;

  return (
    <>
      <Stack.SearchBar placeholder="Numer albo kontrahent" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      {widok === 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={IKONY_PASKA.filtr} iconRenderingMode="template" tintColor={filtrowAktywnych > 0 ? kolory.akcent : kolory.etykieta} title="Filtry">
            <Stack.Toolbar.Menu title="Status KSeF" inline>
              {STATUSY_KSEF.map((s) => (
                <Stack.Toolbar.MenuAction key={s} isOn={statusKsef === s} onPress={() => setStatusKsef(s)}>
                  {s}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu title="Płatność" inline>
              {PLATNOSCI.map((p) => (
                <Stack.Toolbar.MenuAction key={p} isOn={platnosc === p} onPress={() => setPlatnosc(p)}>
                  {p}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu title="Rodzaj" inline>
              {RODZAJE.map((r) => (
                <Stack.Toolbar.MenuAction key={r.etykieta} isOn={rodzaj === r.etykieta} onPress={() => setRodzaj(r.etykieta)}>
                  {r.etykieta}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}

      <EkranListy gradient={!szukaj} keyboardShouldPersistTaps="handled" onOdswiez={widok === 2 && naleznosci ? () => Promise.all([dane.odswiez(), naleznosci.odswiez()]).then(() => undefined) : dane.odswiez}>
        {szukaj ? null : (
          <>
            {/* Bez danych nie pokazujemy „0,00 zł”: przy wczytywaniu szkielet, przy błędzie nic (stan błędu niżej). */}
            {pierwszeWczytanie ? (
              <SzkieletKwoty />
            ) : bladBezDanych ? null : (
              <KartaDoZaplaty otwarte={sumaDoZaplaty(otwarte)} poTerminie={sumaDoZaplaty(zalegle)} ilePoTerminie={zalegle.length} />
            )}
            <NotaDanych dane={dane} />
            {/* D7 (Bartosz, 09.11.2026): „Nowa faktura” jako szeroki bloczek pod sumą, nie plus w pasku. */}
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Nowa faktura" ikona="add-line" onPress={() => router.push('/faktury/nowa')} />
            </View>
          </>
        )}

        <Segmenty
          wartosci={[...WIDOKI]}
          wybrany={widok}
          onZmiana={setWidok}
          etykieta="Rodzaj listy faktur"
          liczniki={[undefined, zBazy ? undefined : cykliczne.length, zalegle.length > 0 ? zalegle.length : undefined]}
        />

        {widok !== 1 && pierwszeWczytanie ? <SzkieletListy /> : null}
        {widok !== 1 && bladBezDanych ? <StanBledu dane={dane} tytul="Nie udało się pobrać faktur" /> : null}

        {widok === 0 && !pierwszeWczytanie && !bladBezDanych ? (
          widoczne.length === 0 ? (
            <StanPusty
              ikona={szukaj || filtrowAktywnych > 0 ? 'search-line' : 'file-text-line'}
              tytul={szukaj || filtrowAktywnych > 0 ? 'Brak faktur dla tych filtrów' : 'Brak faktur wystawionych'}
              opis={szukaj || filtrowAktywnych > 0 ? 'Zmień wyszukiwanie albo filtry w menu u góry.' : 'Wystaw pierwszą fakturę, a pojawi się tutaj.'}
              akcja={
                filtrowAktywnych > 0
                  ? {
                      tytul: 'Wyczyść filtry',
                      onPress: () => {
                        setStatusKsef('Wszystkie');
                        setPlatnosc('Wszystkie');
                        setRodzaj('Wszystkie');
                      },
                    }
                  : szukaj
                    ? undefined
                    : { tytul: 'Nowa faktura', onPress: () => router.push('/faktury/nowa') }
              }
            />
          ) : (
            <>
              {doDokonczenia.length > 0 ? (
                <Sekcja naglowek="Do dokończenia" naglowekWartosc={String(doDokonczenia.length)}>
                  {doDokonczenia.map((f) => (
                    <WierszFaktury key={f.id} faktura={f} />
                  ))}
                </Sekcja>
              ) : null}
              {grupujPoMiesiacu(widoczne.filter((f) => !doDokonczenia.includes(f))).map(([miesiac, lista]) => (
                <Sekcja
                  key={miesiac}
                  naglowek={miesiac}
                  naglowekWartosc={kwota(suma(lista))}
                  stopka={filtrowAktywnych > 0 ? `Filtry: ${[statusKsef, platnosc, rodzaj].filter((x) => x !== 'Wszystkie').join(', ')}.` : undefined}>
                  {lista.map((f) => (
                    <WierszFaktury key={f.id} faktura={f} />
                  ))}
                </Sekcja>
              ))}
              {dane.fakturyPelne ? null : <Sekcja stopka="Pokazujemy 200 ostatnio wystawionych faktur. Starsze znajdziesz na faktway.pl." />}
            </>
          )
        ) : null}

        {widok === 1 && zBazy ? (
          <StanPusty
            ikona="repeat-line"
            tytul="Faktury cykliczne na faktway.pl"
            opis="Ta wersja aplikacji pokazuje faktury wystawione z Twojego konta. Faktury cykliczne zobaczysz i ustawisz na stronie."
            akcja={{ tytul: 'Otwórz faktway.pl', onPress: () => otworzNaStronie('cykliczna') }}
          />
        ) : null}

        {widok === 1 && !zBazy ? (
          <Sekcja naglowek="Faktury cykliczne" stopka="Wystawiamy je według harmonogramu z faktury-wzoru. Wzorem może być tylko przyjęta faktura VAT w złotych.">
            {cykliczne.map((c) => (
              <Wiersz
                key={c.id}
                tytul={c.opis}
                podtytul={`${c.kontrahent} · co ${c.co}, następna ${dataKrotka(c.nastepna)}`}
                wartosc={kwota(c.brutto)}
                wartoscKolor="etykieta"
                wartoscPodpis={c.wstrzymana ? 'Wstrzymana' : c.nastepna <= DZIS ? 'Do wystawienia' : 'Aktywna'}
                wartoscPodpisKolor={c.wstrzymana ? 'etykietaDrugorzedna' : c.nastepna <= DZIS ? 'ostrzezenie' : 'sukces'}
                onPress={() => router.push({ pathname: '/faktury/cykliczna', params: { id: c.id } })}
              />
            ))}
            <Wiersz tytul="Nowa faktura cykliczna" akcja onPress={() => router.push('/faktury/cykliczna')} />
          </Sekcja>
        ) : null}

        {widok === 2 && naleznosci ? <PoTerminieZBazy naleznosci={naleznosci} szukaj={szukaj} /> : null}

        {widok === 2 && !zBazy ? (
          <>
            <Sekcja
              naglowek="Po terminie"
              naglowekWartosc={kwota(sumaDoZaplaty(zalegle))}
              stopka={`Od najdłużej zaległej. Przypomnień w tym miesiącu: ${wyslanePrzypomnienia}, wstrzymanych: ${wstrzymane}. Przypomnienia przygotowujemy do zatwierdzenia; nic nie wychodzi samo.`}>
              {poTerminie.length === 0
                ? [<StanPusty key="pusto" ikona="checkbox-circle-line" tytul="Brak pozycji gotowych do przypomnienia" opis="Żadna faktura nie jest po terminie." />]
                : poTerminie.map((f) => {
                    const wstrzymana = flagi[`przypomnienia-wstrzymane-${f.id}`];
                    const p = f.przypomnienie;
                    return (
                      <Wiersz
                        key={f.id}
                        tytul={f.kontrahent}
                        podtytul={`${f.numer} · ${dni(dniMiedzy(f.terminPlatnosci, dzis))} po terminie`}
                        wartosc={kwota(f.brutto, f.waluta)}
                        wartoscKolor="etykieta"
                        wartoscPodpis={wstrzymana ? 'Wstrzymane' : p ? `Etap ${p.etap} · wysłane ${p.wyslane}/3` : 'Bez przypomnień'}
                        wartoscPodpisKolor={wstrzymana ? 'etykietaDrugorzedna' : p ? 'akcent' : 'etykietaDrugorzedna'}
                        onPress={() => router.push({ pathname: '/faktury/przypomnienie', params: { id: f.id } })}
                      />
                    );
                  })}
              <Wiersz tytul="Ustawienia przypomnień" strzalka onPress={() => router.push('/wiecej/ustawienia/przypomnienia')} />
            </Sekcja>
          </>
        ) : null}
      </EkranListy>
    </>
  );
}

/**
 * „Po terminie” na prawdziwym koncie (M10a): lista strony `/payments/overdue`
 * z serwera, ze stanem przypomnień; zapłacone w tej sesji znikają od razu.
 * Wiersz otwiera przypomnienie (podgląd, zgoda, wstrzymanie, zapłata).
 */
function PoTerminieZBazy({ naleznosci, szukaj }: { naleznosci: NonNullable<ReturnType<typeof useNaleznosci>>; szukaj: string }) {
  const router = useRouter();
  const { faktury } = useStanFaktur();
  const { stan, dane: odp, blad, odswiez } = naleznosci;
  if (stan === 'ladowanie' && !odp) return <SzkieletListy />;
  if (!odp) {
    return <StanPusty ikona="error-warning-line" tytul="Nie udało się pobrać faktur po terminie" opis={blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odswiez() }} />;
  }
  const zaplaconeTeraz = new Set(faktury.filter((f) => f.zaplacona).map((f) => f.id));
  const fraza = szukaj.trim().toLocaleLowerCase('pl');
  const lista = odp.faktury
    .filter((n) => !zaplaconeTeraz.has(n.id))
    .filter((n) => !fraza || n.kontrahent.toLocaleLowerCase('pl').includes(fraza) || n.numer.toLowerCase().includes(fraza));
  const wstrzymanych = lista.filter((n) => n.wstrzymane).length;
  const stopka = odp.blad
    ? undefined
    : [
        'Od najdłużej zaległej.',
        odp.wyslaneWMiesiacu === null ? null : `Przypomnień w tym miesiącu: ${odp.wyslaneWMiesiacu}, wstrzymanych: ${wstrzymanych}.`,
        'Przypomnienia przygotowujemy do zatwierdzenia; nic nie wychodzi samo.',
        odp.limit ? 'To pierwsze 100 faktur po terminie; resztę zobaczysz na faktway.pl.' : null,
      ]
        .filter(Boolean)
        .join(' ');
  return (
    <Sekcja naglowek="Po terminie" naglowekWartosc={odp.blad ? undefined : kwota(lista.reduce((s, n) => s + grosze(n.doZaplaty), 0))} stopka={stopka}>
      {odp.blad
        ? [<StanPusty key="blad" ikona="error-warning-line" tytul="Listy nie da się teraz potwierdzić" opis={`${odp.blad}. Sprawdź ją na faktway.pl albo spróbuj za chwilę.`} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odswiez() }} />]
        : lista.length === 0
          ? [<StanPusty key="pusto" ikona="checkbox-circle-line" tytul="Brak pozycji gotowych do przypomnienia" opis="Żadna faktura nie jest po terminie." />]
          : lista.map((n) => {
              const podpis = podpisPrzypomnien(n);
              return (
                <Wiersz
                  key={n.id}
                  tytul={n.kontrahent}
                  podtytul={`${n.numer} · ${dni(n.dniPoTerminie)} po terminie`}
                  wartosc={kwota(grosze(n.doZaplaty))}
                  wartoscKolor="etykieta"
                  wartoscPodpis={podpis.tekst}
                  wartoscPodpisKolor={podpis.kolor}
                  onPress={() => router.push({ pathname: '/faktury/przypomnienie', params: { id: n.id } })}
                />
              );
            })}
    </Sekcja>
  );
}

/** Karta „Do zapłaty” z paskiem: w terminie i po terminie (makieta z 12.11.2026). */
function KartaDoZaplaty({ otwarte, poTerminie, ilePoTerminie }: { otwarte: number; poTerminie: number; ilePoTerminie: number }) {
  const kolory = useKolory();
  const wTerminie = otwarte - poTerminie;
  return (
    <Karta style={styles.karta}>
      <View
        style={styles.trescKarty}
        accessible
        accessibilityLabel={`Do zapłaty od klientów: ${kwota(otwarte)}. W terminie ${kwota(wTerminie)}. ${ilePoTerminie > 0 ? `${ileFaktur(ilePoTerminie)} po terminie, ${kwota(poTerminie)}` : 'Nic po terminie'}.`}>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
          Do zapłaty od klientów
        </Tekst>
        <KwotaZGroszami wartosc={kwota(otwarte)} styl="title1" />
        <View style={styles.pasek}>
          {wTerminie > 0 ? <View style={[styles.odcinek, { flex: wTerminie, backgroundColor: kolory.akcentWypelnienie }]} /> : null}
          {poTerminie > 0 ? <View style={[styles.odcinek, { flex: poTerminie, backgroundColor: kolory.ostrzezenie }]} /> : null}
          {otwarte === 0 ? <View style={[styles.odcinek, { flex: 1, backgroundColor: kolory.neutralneTlo }]} /> : null}
        </View>
        <View style={styles.legenda}>
          <Tekst styl="footnote" kolor="etykietaDrugorzedna">
            w terminie <Tekst styl="footnote" cyfry>{kwota(wTerminie)}</Tekst>
          </Tekst>
          <Tekst styl="footnote" waga="semibold" kolor={ilePoTerminie > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}>
            {ilePoTerminie > 0 ? `${ilePoTerminie} po terminie ${kwota(poTerminie)}` : 'nic po terminie'}
          </Tekst>
        </View>
      </View>
    </Karta>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  karta: { marginTop: ODSTEP.s },
  trescKarty: { padding: MARGINES, gap: ODSTEP.xxs },
  pasek: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, marginTop: ODSTEP.xs },
  odcinek: { height: 8 },
  legenda: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: ODSTEP.s, rowGap: ODSTEP.linia, marginTop: ODSTEP.xxs },
});

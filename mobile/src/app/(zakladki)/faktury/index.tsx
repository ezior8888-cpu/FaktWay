import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS, type Faktura, type RodzajFaktury } from '@/dane-przykladowe';
import { Segmenty } from '@/komponenty/formularz';
import { Karta } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { KwotaZGroszami } from '@/komponenty/naglowek';
import { Tekst } from '@/komponenty/tekst';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { dataKrotka, dniMiedzy, kwota } from '@/lib/format';
import { dni, doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
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

function suma(faktury: Faktura[]): number {
  return faktury.reduce((s, f) => s + f.brutto, 0);
}

function pasujeStatusKsef(f: Faktura, filtr: (typeof STATUSY_KSEF)[number]): boolean {
  if (filtr === 'Szkice') return f.statusKsef === 'robocza';
  if (filtr === 'W toku') return f.statusKsef === 'wysylanie';
  if (filtr === 'Przyjęte w KSeF') return f.statusKsef === 'przyjeta';
  if (filtr === 'Odrzucone i błędy') return f.statusKsef === 'odrzucona';
  return true;
}

function pasujePlatnosc(f: Faktura, filtr: (typeof PLATNOSCI)[number]): boolean {
  if (filtr === 'Opłacone') return f.zaplacona;
  if (filtr === 'Nieopłacone') return doZaplaty(f);
  if (filtr === 'Po terminie') return statusFaktury(f, DZIS).zalegla;
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
  const { faktury, cykliczne, flagi } = useStanFaktur();
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

  const otwarte = faktury.filter(doZaplaty);
  const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);
  const filtrowAktywnych = [statusKsef, platnosc, rodzaj].filter((x) => x !== 'Wszystkie').length;

  const widoczne = useMemo(() => {
    const fraza = szukaj.trim().toLocaleLowerCase('pl');
    const wybranyRodzaj = RODZAJE.find((r) => r.etykieta === rodzaj)?.rodzaj;
    return faktury
      .filter((f) => pasujeStatusKsef(f, statusKsef))
      .filter((f) => pasujePlatnosc(f, platnosc))
      .filter((f) => !wybranyRodzaj || f.rodzaj === wybranyRodzaj)
      .filter((f) => !fraza || f.kontrahent.toLocaleLowerCase('pl').includes(fraza) || f.numer.toLowerCase().includes(fraza));
  }, [faktury, statusKsef, platnosc, rodzaj, szukaj]);

  // Dane przykładowe: odświeżenie tylko pokazuje kręciołek; z M7 pobiera listę z API.
  const odswiezListe = () => new Promise<void>((gotowe) => setTimeout(gotowe, 800));

  // Szkice i odrzucone przez KSeF na górze listy, jak „Drafts” w Revolut Business (D14).
  const doDokonczenia = widoczne.filter((f) => f.statusKsef === 'robocza' || f.statusKsef === 'odrzucona');

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

      <EkranListy gradient={!szukaj} keyboardShouldPersistTaps="handled" onOdswiez={odswiezListe}>
        {szukaj ? null : (
          <>
            <KartaDoZaplaty otwarte={suma(otwarte)} poTerminie={suma(zalegle)} ilePoTerminie={zalegle.length} />
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
          liczniki={[undefined, cykliczne.length, zalegle.length > 0 ? zalegle.length : undefined]}
        />

        {widok === 0 ? (
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
            </>
          )
        ) : null}

        {widok === 1 ? (
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

        {widok === 2 ? (
          <>
            <Sekcja
              naglowek="Po terminie"
              naglowekWartosc={kwota(suma(zalegle))}
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
                        podtytul={`${f.numer} · ${dni(dniMiedzy(f.terminPlatnosci, DZIS))} po terminie`}
                        wartosc={kwota(f.brutto)}
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

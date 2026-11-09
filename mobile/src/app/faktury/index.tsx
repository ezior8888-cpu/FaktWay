import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS, type Faktura, type RodzajFaktury } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { dataKrotka, dniMiedzy, kwota, kwotaKrotka } from '@/lib/format';
import { dni, doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

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
 * Cykliczne, Po terminie) z kafelkami, filtrami i wyszukiwaniem.
 * D7: „Nowa faktura” jako szeroki bloczek pod sumą, nie plus w pasku.
 */
export default function EkranFaktur() {
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
  const wTymMiesiacu = faktury.filter((f) => f.dataWystawienia.startsWith(DZIS.slice(0, 7)));
  const przyjeteWMiesiacu = wTymMiesiacu.filter((f) => f.statusKsef === 'przyjeta');
  const szkice = faktury.filter((f) => f.statusKsef === 'robocza');
  const oplaconeWMiesiacu = wTymMiesiacu.filter((f) => f.zaplacona);
  const cykliczneDoWystawienia = cykliczne.filter((c) => !c.wstrzymana && c.nastepna <= DZIS);
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
          <Stack.Toolbar.Menu icon={filtrowAktywnych > 0 ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease'} title="Filtry">
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

      <EkranListy keyboardShouldPersistTaps="handled">
        {szukaj ? null : (
          <>
            <NaglowekKwoty
              podpis="Do zapłaty"
              wartosc={kwota(suma(otwarte))}
              styl="title1"
              status={zalegle.length > 0 ? `${ileFaktur(zalegle.length)} po terminie, ${kwota(suma(zalegle))}` : 'Nic po terminie'}
              statusKolor={zalegle.length > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
            />
            {/* D7 (Bartosz, 09.11.2026): „Nowa faktura” jako szeroki bloczek pod sumą, nie plus w pasku. */}
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Nowa faktura" ikona="plus" onPress={() => router.push('/faktury/nowa')} />
            </View>
            <Kafle
              kafle={[
                {
                  klucz: 'miesiac',
                  podpis: 'Faktury w tym miesiącu',
                  wartosc: String(przyjeteWMiesiacu.length),
                  opis: szkice.length > 0 ? `+ ${szkice.length} ${szkice.length === 1 ? 'szkic' : 'szkice'} poza KSeF` : 'Wszystkie w KSeF',
                },
                { klucz: 'oplacone', podpis: 'Opłacone w tym miesiącu', wartosc: kwotaKrotka(suma(oplaconeWMiesiacu)) },
                {
                  klucz: 'kontrahenci',
                  podpis: 'Kontrahenci',
                  wartosc: String(KONTRAHENCI.length),
                  onPress: () => router.push('/wiecej/kontrahenci'),
                },
                {
                  klucz: 'cykliczne',
                  podpis: 'Cykliczne',
                  wartosc: String(cykliczne.length),
                  opis: cykliczneDoWystawienia.length > 0 ? `${cykliczneDoWystawienia.length} czeka na wystawienie` : 'Nic nie czeka',
                  opisKolor: cykliczneDoWystawienia.length > 0 ? 'ostrzezenie' : undefined,
                  onPress: () => setWidok(1),
                },
              ]}
            />
          </>
        )}

        <Segmenty wartosci={[...WIDOKI]} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaj listy faktur" />

        {widok === 0 ? (
          widoczne.length === 0 ? (
            <StanPusty
              ikona={szukaj || filtrowAktywnych > 0 ? 'magnifyingglass' : 'doc.text'}
              tytul={szukaj || filtrowAktywnych > 0 ? 'Brak faktur dla tych filtrów' : 'Brak faktur wystawionych'}
              opis={szukaj || filtrowAktywnych > 0 ? 'Zmień wyszukiwanie albo filtry w menu u góry.' : 'Wystaw pierwszą fakturę przyciskiem „Nowa faktura”.'}
            />
          ) : (
            grupujPoMiesiacu(widoczne).map(([miesiac, lista]) => (
              <Sekcja key={miesiac} naglowek={miesiac} stopka={filtrowAktywnych > 0 ? `Filtry: ${[statusKsef, platnosc, rodzaj].filter((x) => x !== 'Wszystkie').join(', ')}.` : undefined}>
                {lista.map((f) => (
                  <WierszFaktury key={f.id} faktura={f} />
                ))}
              </Sekcja>
            ))
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
            <Wiersz tytul="Nowa faktura cykliczna" ikona="plus.circle.fill" akcja onPress={() => router.push('/faktury/cykliczna')} />
          </Sekcja>
        ) : null}

        {widok === 2 ? (
          <>
            <Kafle
              kafle={[
                { klucz: 'suma', podpis: 'Po terminie', wartosc: kwotaKrotka(suma(zalegle)), opisKolor: 'ostrzezenie' },
                { klucz: 'liczba', podpis: 'Faktur po terminie', wartosc: String(zalegle.length) },
                { klucz: 'wyslane', podpis: 'Przypomnień w miesiącu', wartosc: String(wyslanePrzypomnienia) },
                { klucz: 'wstrzymane', podpis: 'Wstrzymanych', wartosc: String(wstrzymane) },
              ]}
            />
            <Sekcja naglowek="Po terminie" stopka="Od najdłużej zaległej. Przypomnienia przygotowujemy do zatwierdzenia; nic nie wychodzi samo.">
              {poTerminie.length === 0
                ? [<StanPusty key="pusto" ikona="checkmark.circle" tytul="Brak pozycji gotowych do przypomnienia" opis="Żadna faktura nie jest po terminie." />]
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
              <Wiersz tytul="Ustawienia przypomnień" ikona="bell.badge" strzalka onPress={() => router.push('/wiecej/ustawienia/przypomnienia')} />
            </Sekcja>
          </>
        ) : null}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});

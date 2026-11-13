import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { KPIR, type WpisKpir } from '@/dane-przykladowe/ksiegowosc';
import { Segmenty } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Wykres } from '@/komponenty/wykres';
import { dataKrotka, kwota } from '@/lib/format';
import { useKolory, type Kolory } from '@/wyglad/kolory';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';

const MIESIACE = ['Listopad 2026', 'Październik 2026', 'Wrzesień 2026'];
const WIDOKI = ['Wszystko', 'Przychody', 'Koszty'] as const;
const KOLUMNY: { kol: WpisKpir['kolumna']; nazwa: string; kolor: keyof Kolory }[] = [
  { kol: '10', nazwa: 'Towary i materiały', kolor: 'akcent' },
  { kol: '11', nazwa: 'Koszty uboczne zakupu', kolor: 'sukces' },
  { kol: '12', nazwa: 'Wynagrodzenia', kolor: 'ostrzezenie' },
  { kol: '13', nazwa: 'Pozostałe wydatki', kolor: 'blad' },
  { kol: '15', nazwa: 'Koszty B+R', kolor: 'etykietaTrzeciorzedna' },
];

const przychod = (w: WpisKpir) => w.kolumna === '7' || w.kolumna === '8';

/** KPiR: odpowiednik `reports/kpir` (wynik, koszty według kolumn, księga z filtrami). */
export default function EkranKpir() {
  const kolory = useKolory();
  const router = useRouter();
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [widok, setWidok] = useState(0);
  const [kolumna, setKolumna] = useState<WpisKpir['kolumna'] | null>(null);

  const przychody = KPIR.filter(przychod).reduce((s, w) => s + w.kwota, 0);
  const koszty = KPIR.filter((w) => !przychod(w)).reduce((s, w) => s + w.kwota, 0);
  const dochod = przychody - koszty;
  const marza = przychody > 0 ? Math.round((dochod / przychody) * 100) : 0;

  // Narastająco po dniach (kilka faktur jednego dnia to jeden punkt).
  const dni = [...new Set(KPIR.filter(przychod).map((w) => w.data))].sort();
  const wykres = dni.map((d) => {
    const doTejPory = KPIR.filter((w) => przychod(w) && w.data <= d).reduce((s, w) => s + w.kwota, 0);
    return { x: dataKrotka(d), y: doTejPory / 100, opis: kwota(doTejPory) };
  });
  const doSprawdzenia = KPIR.filter((w) => w.doSprawdzenia);

  const wpisy = KPIR.filter((w) => {
    if (kolumna) return w.kolumna === kolumna;
    if (WIDOKI[widok] === 'Przychody') return przychod(w);
    if (WIDOKI[widok] === 'Koszty') return !przychod(w);
    return true;
  });
  const wedlugKolumn = KOLUMNY.map((k) => ({ ...k, suma: KPIR.filter((w) => w.kolumna === k.kol).reduce((s, w) => s + w.kwota, 0) })).filter((k) => k.suma > 0);

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={kolory.etykieta} title="Miesiąc">
          {MIESIACE.map((m) => (
            <Stack.Toolbar.MenuAction key={m} isOn={miesiac === m} onPress={() => setMiesiac(m)}>
              {m}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon={IKONY_PASKA.udostepnij} iconRenderingMode="template" tintColor={kolory.etykieta} accessibilityLabel="Eksport KPiR" onPress={() => router.push('/ksiegowosc/eksport')} />
      </Stack.Toolbar>

      <EkranListy>
        <NaglowekKwoty podpis={`${dochod >= 0 ? 'Dochód' : 'Strata'}, ${miesiac.toLowerCase()}`} wartosc={kwota(dochod)} styl="title1" status={`Marża ${marza}%`} statusKolor="sukces" />

        <Sekcja naglowek="Przychody narastająco" stopka={`Przychody ${kwota(przychody)} (faktury przyjęte w KSeF), koszty ${kwota(koszty)}.`} swobodna>
          <Wykres punkty={wykres} rodzaj="pole" etykieta="Przychody narastająco w miesiącu" />
        </Sekcja>

        <Sekcja naglowek="Koszty według kolumn" stopka="Dotknij kolumny, żeby zobaczyć tylko jej wpisy.">
          {wedlugKolumn.map((k) => (
            <Wiersz
              key={k.kol}
              tytul={`Kol. ${k.kol}: ${k.nazwa}`}
              wartosc={kwota(k.suma)}
              wartoscPodpis={`${Math.round((k.suma / Math.max(1, koszty)) * 100)}%`}
              strzalka
              onPress={() => setKolumna(kolumna === k.kol ? null : k.kol)}
            />
          ))}
        </Sekcja>

        {doSprawdzenia.length > 0 ? (
          <Sekcja naglowek="Do sprawdzenia" stopka="Wydatki z KSeF, które trzeba opisać, zanim trafią do księgi na stałe.">
            {doSprawdzenia.map((w) => (
              <Wiersz key={w.lp} tytul={w.kontrahent} podtytul={`${w.dowod} · ${dataKrotka(w.data)}`} wartosc={kwota(w.kwota)} strzalka onPress={() => router.push('/koszty')} />
            ))}
          </Sekcja>
        ) : null}

        <Segmenty
          wartosci={[...WIDOKI]}
          wybrany={widok}
          onZmiana={(i) => {
            setWidok(i);
            setKolumna(null);
          }}
          etykieta="Wpisy księgi"
        />
        {wpisy.length === 0 ? (
          <StanPusty ikona="book2-line" tytul="Brak wpisów" opis="Brak przychodów i wydatków w tym widoku." />
        ) : (
          <Sekcja linie naglowek={kolumna ? `Księga: kolumna ${kolumna}` : 'Księga'} stopka={kolumna ? 'Dotknij kolumny jeszcze raz, żeby wyłączyć filtr.' : undefined}>
            {wpisy.map((w) => (
              <Wiersz
                key={w.lp}
                tytul={`${w.lp}. ${w.kontrahent}`}
                podtytul={`${w.dowod} · ${dataKrotka(w.data)} · ${przychod(w) ? '7 · Sprzedaż' : `Kol. ${w.kolumna}`}`}
                wartosc={kwota(w.kwota)}
                wartoscKolor={przychod(w) ? 'sukces' : 'etykieta'}
                wartoscPodpis={w.doSprawdzenia ? 'Do sprawdzenia' : w.opis}
                wartoscPodpisKolor={w.doSprawdzenia ? 'ostrzezenie' : 'etykietaDrugorzedna'}
              />
            ))}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

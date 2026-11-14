/**
 * Stan danych z serwera na liście (ZASADY-DESIGNU.md, sekcja 5; WZORCE-MOBBIN.md
 * 8.1 i 8.2): błąd bez danych to pełny stan z „Spróbuj ponownie”; błąd albo
 * brak sieci, gdy mamy dane z poprzedniego otwarcia, to jedno zdanie z datą
 * nad listą. Dane przykładowe nie mają żadnego z tych stanów.
 */
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { kiedyPobrano } from '@/lib/format';
import type { StanDanych } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/** „Bez internetu. Dane z 13 lis, 12:40. Spróbuj ponownie” nad listą, gdy pokazujemy stare dane. */
export function NotaDanych({ dane }: { dane: StanDanych }) {
  const [trwa, setTrwa] = useState(false);
  const kolory = useKolory();
  if (dane.zrodlo !== 'baza' || dane.stan !== 'gotowe' || !dane.blad) return null;
  const kiedy = dane.zapisano ? ` Dane z ${kiedyPobrano(dane.zapisano)}.` : '';
  const zdanie = dane.bezSieci ? `Bez internetu.${kiedy}` : `Nie udało się odświeżyć.${kiedy}`;
  const ponow = async () => {
    setTrwa(true);
    try {
      await dane.odswiez();
    } finally {
      setTrwa(false);
    }
  };
  return (
    <Pressable onPress={trwa ? undefined : () => void ponow()} accessibilityRole="button" accessibilityLabel={`${zdanie} Spróbuj ponownie.`} hitSlop={ODSTEP.xs} android_ripple={{ color: kolory.fala }} style={styles.nota}>
      <Tekst styl="footnote" kolor="etykietaDrugorzedna">
        {`${zdanie} `}
        <Tekst styl="footnote" kolor="akcent" waga="medium">
          {trwa ? 'Sprawdzam…' : 'Spróbuj ponownie'}
        </Tekst>
      </Tekst>
    </Pressable>
  );
}

/** Pierwsze wczytanie się nie udało i nie mamy nic z poprzedniego otwarcia. */
export function StanBledu({ dane, tytul }: { dane: StanDanych; tytul: string }) {
  return (
    <StanPusty
      ikona={dane.bezSieci ? 'global-line' : 'error-warning-line'}
      tytul={tytul}
      opis={dane.blad ?? dane.wydatkiBlad ?? 'Spróbuj ponownie za chwilę.'}
      akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void dane.odswiez() }}
    />
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.s },
});

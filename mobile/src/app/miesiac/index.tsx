import { StyleSheet, View } from 'react-native';

import { DZIS, MIESIAC } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, dniMiedzy, kwota } from '@/lib/format';
import { dni } from '@/lib/status-faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranMiesiaca() {
  const doZaplaty = MIESIAC.platnosci.filter((p) => !p.zaplacona);
  const razem = doZaplaty.reduce((s, p) => s + p.kwota, 0);
  const najblizszy = doZaplaty.map((p) => p.termin).sort()[0];

  return (
    <EkranListy>
      <View
        style={styles.naglowek}
        accessible
        accessibilityLabel={`Do zapłaty ${kwota(razem)}${najblizszy ? `, najbliższy termin ${dataKrotka(najblizszy)}` : ''}`}>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
          Do zapłaty w tym miesiącu
        </Tekst>
        <Tekst styl="largeTitle" cyfry>
          {kwota(razem)}
        </Tekst>
        {najblizszy ? (
          <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
            Najbliższy termin {dataKrotka(najblizszy)}, za {dni(dniMiedzy(DZIS, najblizszy))}
          </Tekst>
        ) : null}
      </View>

      <Sekcja naglowek="Podatki i składki" stopka="Kwoty przykładowe. Prawdziwe wyliczenia podłączy etap M9.">
        {MIESIAC.platnosci.map((p) => (
          <Wiersz
            key={p.id}
            tytul={p.nazwa}
            podtytul={p.opis}
            wartosc={kwota(p.kwota)}
            wartoscPodpis={`do ${dataKrotka(p.termin)}`}
          />
        ))}
      </Sekcja>

      <Sekcja naglowek={MIESIAC.nazwa}>
        <Wiersz tytul="Przychód" wartosc={kwota(MIESIAC.przychod)} />
        <Wiersz tytul="Koszty" wartosc={kwota(MIESIAC.koszty)} />
        <Wiersz tytul="Dochód" wartosc={kwota(MIESIAC.przychod - MIESIAC.koszty)} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.m, gap: ODSTEP.xxs },
});

import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { EKSPORTY, FORMATY, type FormatEksportu } from '@/dane-przykladowe/ksiegowosc';
import { PolePrzelacznik, PoleWyboru, Segmenty } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { dataPelna } from '@/lib/format';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const MIESIACE = ['Październik 2026', 'Wrzesień 2026', 'Sierpień 2026', 'Listopad 2026 (w trakcie)'];
const KWARTALY = ['III kw. 2026', 'II kw. 2026', 'IV kw. 2026 (w trakcie)'];

/** Eksport: odpowiednik `reports/exports` (format, okres, zakres, historia plików). */
export default function EkranEksportu() {
  const [format, setFormat] = useState<FormatEksportu>('kpir');
  const [rodzajOkresu, setRodzajOkresu] = useState(0);
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [kwartal, setKwartal] = useState(KWARTALY[0] ?? '');
  const [wystawione, setWystawione] = useState(true);
  const [otrzymane, setOtrzymane] = useState(true);
  const [korekty, setKorekty] = useState(true);
  const [historia, setHistoria] = useState(EKSPORTY);

  const generuj = () => {
    const id = `e${Date.now()}`;
    const plik = FORMATY.find((f) => f.klucz === format)?.nazwa ?? '';
    const okres = rodzajOkresu === 0 ? miesiac : kwartal;
    setHistoria((h) => [{ id, plik, okres, utworzono: '2026-11-09', status: 'Generowanie' }, ...h]);
    setTimeout(() => {
      setHistoria((h) => h.map((e) => (e.id === id ? { ...e, status: 'Gotowe' } : e)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 1800);
  };

  return (
    <EkranListy>
      <Sekcja naglowek="Format" stopka="Wyłączone na razie: JPK_V7M (jest w zakładce VAT), Optima, Subiekt, Symfonia, Wapro.">
        {FORMATY.map((f) => (
          <Wiersz
            key={f.klucz}
            tytul={f.nazwa}
            podtytul={f.opis}
            zaznaczony={format === f.klucz}
            onPress={() => setFormat(f.klucz)}
            etykietaDostepnosci={`${f.nazwa}${format === f.klucz ? ', wybrany' : ''}`}
          />
        ))}
      </Sekcja>

      <Segmenty wartosci={['Miesiąc', 'Kwartał']} wybrany={rodzajOkresu} onZmiana={setRodzajOkresu} etykieta="Rodzaj okresu" />
      <Sekcja naglowek="Okres">
        {rodzajOkresu === 0 ? (
          <PoleWyboru etykieta="Miesiąc" wartosc={miesiac} opcje={MIESIACE.map((m) => ({ wartosc: m, etykieta: m }))} onZmiana={setMiesiac} />
        ) : (
          <PoleWyboru etykieta="Kwartał" wartosc={kwartal} opcje={KWARTALY.map((k) => ({ wartosc: k, etykieta: k }))} onZmiana={setKwartal} />
        )}
      </Sekcja>

      <Sekcja naglowek="Zakres" stopka={format === 'jpk' ? 'JPK_FA zawiera tylko faktury wystawione.' : format === 'kpir' ? 'KPiR zawiera zawsze sprzedaż, koszty (faktury i paragony) i korekty.' : undefined}>
        {format === 'csv' ? (
          <>
            <PolePrzelacznik etykieta="Faktury wystawione" wartosc={wystawione} onZmiana={setWystawione} />
            <PolePrzelacznik etykieta="Faktury otrzymane" wartosc={otrzymane} onZmiana={setOtrzymane} />
          </>
        ) : null}
        {format !== 'kpir' ? <PolePrzelacznik etykieta="Korekty" wartosc={korekty} onZmiana={setKorekty} /> : null}
        {format === 'kpir' ? <Wiersz tytul="Sprzedaż, koszty i korekty" /> : null}
      </Sekcja>

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Wygeneruj plik" ikona="file-upload-line" onPress={generuj} />
      </View>

      <Sekcja naglowek="Historia" stopka="Pliki są dostępne 30 dni.">
        {historia.map((e) => (
          <Wiersz
            key={e.id}
            tytul={e.plik}
            podtytul={`${e.okres} · utworzono ${dataPelna(e.utworzono)}`}
            wartoscPodpis={e.status === 'Gotowe' ? 'Pobierz' : e.status}
            wartoscPodpisKolor={e.status === 'Gotowe' ? 'akcent' : 'etykietaDrugorzedna'}
            onPress={e.status === 'Gotowe' ? () => void Share.share({ message: `${e.plik}, ${e.okres} (dane przykładowe).` }) : undefined}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
});

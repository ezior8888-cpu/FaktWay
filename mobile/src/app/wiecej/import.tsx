import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';

import { IMPORT } from '@/dane-przykladowe/ustawienia';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataPelna } from '@/lib/format';
import { useFlaga } from '@/stan/faktury';

/**
 * Import danych: odpowiednik `import-danych` (historia z KSeF, przeprowadzka
 * z innego programu przez CSV, historia importów).
 */
export default function EkranImportu() {
  const router = useRouter();
  const [wstrzymane, setWstrzymane] = useFlaga('historia-ksef-wstrzymana', false);
  const [historia, setHistoria] = useState(IMPORT.historia);
  const licznik = useRef(0);
  const s = IMPORT.historiaSprzedaz;
  const z = IMPORT.historiaZakupy;

  const importuj = (zrodlo: string) => {
    licznik.current += 1;
    const id = `nowy-${licznik.current}`;
    setHistoria((h) => [{ id, zrodlo: `${zrodlo} (CSV)`, rozpoczeto: '2026-11-09', wynik: 'Wczytywanie danych', status: 'W toku' }, ...h]);
    setTimeout(() => {
      setHistoria((h) => h.map((x) => (x.id === id ? { ...x, wynik: '41 faktur, 9 kontrahentów', status: 'Gotowe' } : x)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 2200);
  };

  return (
    <EkranListy>
      <Kafle
        kafle={[
          { klucz: 'ksef', ikona: 'shield-check-line', podpis: 'Historia z KSeF', wartosc: `${s.pobrano + z.pobrano}`, opis: 'sprzedaż i zakupy' },
          { klucz: 'pliki', ikona: 'file-upload-line', podpis: 'Z plików', wartosc: String(IMPORT.zPlikow) },
          { klucz: 'kontrahenci', ikona: 'contacts-book3-line', podpis: 'Nowi kontrahenci', wartosc: String(IMPORT.nowiKontrahenci) },
          { klucz: 'pobranie', ikona: 'refresh-line', podpis: 'Ostatnie pobranie z KSeF', wartosc: IMPORT.ostatniePobranie },
        ]}
      />

      <Sekcja naglowek="Historia z KSeF" stopka={wstrzymane ? 'Wstrzymane. Wznów, żeby dociągnąć resztę faktur.' : 'Pobieramy automatycznie wszystkie faktury z KSeF od początku.'}>
        <Wiersz tytul="Sprzedaż" wartosc={`Pobrano ${s.pobrano} z ${s.z}`} wartoscPodpis={s.pobrano === s.z ? 'Gotowe' : 'W toku'} wartoscPodpisKolor="sukces" />
        <Wiersz tytul="Zakupy" wartosc={`Pobrano ${z.pobrano} z ${z.z}`} wartoscPodpis={wstrzymane ? 'Wstrzymane' : 'W toku'} wartoscPodpisKolor={wstrzymane ? 'etykietaDrugorzedna' : 'akcent'} />
        <Wiersz tytul={wstrzymane ? 'Wznów pobieranie' : 'Wstrzymaj pobieranie historii'} akcja onPress={() => setWstrzymane(!wstrzymane)} />
        <Wiersz tytul="Certyfikat KSeF" strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
      </Sekcja>

      <Sekcja naglowek="Przeprowadzka z innego programu" stopka="Plik CSV z eksportu programu, do 1 MB. Faktury i kontrahentów dopiszemy do Twoich danych.">
        {IMPORT.zrodla.map((zr) => (
          <Wiersz key={zr} tytul={zr} wartoscPodpis="Wgraj plik" wartoscPodpisKolor="akcent" onPress={() => importuj(zr)} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Historia importów">
        {historia.map((h) => (
          <Wiersz
            key={h.id}
            tytul={h.zrodlo}
            podtytul={`Rozpoczęto ${dataPelna(h.rozpoczeto)} · ${h.wynik}`}
            wartoscPodpis={h.status}
            wartoscPodpisKolor={h.status === 'Gotowe' ? 'sukces' : 'akcent'}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

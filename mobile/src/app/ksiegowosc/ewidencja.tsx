import { useState } from 'react';
import { Share } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KPIR } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataKrotka, kwota } from '@/lib/format';

const KOLUMNY_RECZNE = [
  { wartosc: '7', etykieta: 'Przychód: sprzedaż (7)' },
  { wartosc: '8', etykieta: 'Przychód: pozostałe (8)' },
  { wartosc: '10', etykieta: 'Zakup towarów i materiałów (10)' },
  { wartosc: '11', etykieta: 'Koszty uboczne zakupu (11)' },
  { wartosc: '12', etykieta: 'Wynagrodzenia (12)' },
  { wartosc: '13', etykieta: 'Pozostałe wydatki (13)' },
];

/**
 * Ewidencja (KPiR przy skali i liniowym): odpowiednik `reports/ewidencja`
 * (księga miesiąca, spis z natury, wpisy ręczne, plik JPK_PKPIR).
 */
export default function EkranEwidencji() {
  const przychody = KPIR.filter((w) => w.kolumna === '7' || w.kolumna === '8').reduce((s, w) => s + w.kwota, 0);
  const koszty = KPIR.filter((w) => w.kolumna !== '7' && w.kolumna !== '8').reduce((s, w) => s + w.kwota, 0);
  const [wpisy, setWpisy] = useState<string[]>([]);
  const [rodzajDowodu, setRodzajDowodu] = useState('inny');
  const [dataZdarzenia, setDataZdarzenia] = useState(DZIS);
  const [numer, setNumer] = useState('');
  const [kwotaWpisu, setKwotaWpisu] = useState('');
  const [kol, setKol] = useState('13');
  const [spisData, setSpisData] = useState('2026-12-31');
  const [spisWartosc, setSpisWartosc] = useState('');
  const [spisZapisany, setSpisZapisany] = useState(false);
  const [imie, setImie] = useState('Jan');
  const [nazwisko, setNazwisko] = useState('Kowalski');
  const [urodzenie, setUrodzenie] = useState('1990-05-14');

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="KPiR, listopad 2026" stopka={`Dochód w miesiącu (przychód minus koszty): ${kwota(przychody - koszty)}.`}>
        {KPIR.map((w) => (
          <Wiersz
            key={w.lp}
            tytul={`${w.lp}. ${w.opis}`}
            podtytul={`${dataKrotka(w.data)} · ${w.dowod} · ${w.kontrahent}`}
            wartosc={kwota(w.kwota)}
            wartoscKolor={w.kolumna === '7' ? 'sukces' : 'etykieta'}
            wartoscPodpis={w.kolumna === '7' ? 'Przychód' : 'Koszt'}
          />
        ))}
        {wpisy.map((t, i) => (
          <Wiersz key={`r${i}`} tytul={t} ikona="edit-circle-line" />
        ))}
      </Sekcja>

      <Sekcja naglowek="Wpisy ręczne w KPiR" stopka="Zwrot zapisuje się kwotą ujemną.">
        <PoleWyboru
          etykieta="Rodzaj dowodu"
          wartosc={rodzajDowodu}
          opcje={[
            { wartosc: 'kasa', etykieta: 'Raport z kasy rejestrującej' },
            { wartosc: 'inny', etykieta: 'Inny dowód' },
          ]}
          onZmiana={setRodzajDowodu}
        />
        <PoleDaty etykieta="Data zdarzenia" wartosc={dataZdarzenia} onZmiana={setDataZdarzenia} />
        <PoleTekstowe etykieta="Numer dowodu" wartosc={numer} onZmiana={setNumer} />
        <PoleTekstowe etykieta="Kwota" wartosc={kwotaWpisu} onZmiana={setKwotaWpisu} podpowiedz="zł" klawiatura="numbers-and-punctuation" />
        <PoleWyboru etykieta="Kolumna KPiR" wartosc={kol} opcje={KOLUMNY_RECZNE} onZmiana={setKol} />
        <Wiersz
          tytul="Dodaj wpis"
          akcja
          onPress={() => {
            if (!numer.trim() || !kwotaWpisu.trim()) return;
            setWpisy((l) => [...l, `${numer.trim()}: ${kwotaWpisu} zł, kol. ${kol}, ${dataKrotka(dataZdarzenia)}`]);
            setNumer('');
            setKwotaWpisu('');
          }}
        />
      </Sekcja>

      <Sekcja naglowek="Spis z natury" stopka={spisZapisany ? 'Spis zapisany.' : 'Na koniec roku albo przy zmianie formy opodatkowania.'}>
        <PoleDaty etykieta="Data spisu" wartosc={spisData} onZmiana={setSpisData} />
        <PoleTekstowe etykieta="Wartość" wartosc={spisWartosc} onZmiana={setSpisWartosc} podpowiedz="zł" klawiatura="decimal-pad" />
        <Wiersz tytul="Zapisz spis" akcja onPress={() => setSpisZapisany(Boolean(spisWartosc.trim()))} />
      </Sekcja>

      <Sekcja naglowek="Plik JPK_PKPIR" stopka="Od 1 stycznia do wybranego miesiąca. Dane osoby trafiają do nagłówka pliku.">
        <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} />
        <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} />
        <PoleDaty etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} />
        <Wiersz tytul="Pobierz JPK_PKPIR" ikona="file-download-line" akcja onPress={() => void Share.share({ message: 'JPK_PKPIR od stycznia do listopada 2026 (dane przykładowe).' })} />
      </Sekcja>
    </EkranListy>
  );
}

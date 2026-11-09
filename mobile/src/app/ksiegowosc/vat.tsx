import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Share } from 'react-native';

import { VAT_MIESIACA } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { dataPelna, kwota, kwotaKrotka } from '@/lib/format';

type Wysylka = { wyslano: string; stan: string; numer: string; doWplaty: number };

/**
 * VAT: odpowiednik `reports/vat` (P_38, P_48, P_51, termin i przelew, plik
 * JPK_V7M, wysyłka do Ministerstwa Finansów z UPO).
 */
export default function EkranVat() {
  const v = VAT_MIESIACA;
  const doWplaty = v.nalezny - v.naliczony;
  const [imie, setImie] = useState('Jan');
  const [nazwisko, setNazwisko] = useState('Kowalski');
  const [urodzenie, setUrodzenie] = useState('1990-05-14');
  const [email, setEmail] = useState('jan@przyklad.pl');
  const [wysylki, setWysylki] = useState<Wysylka[]>(v.wysylki);

  const wyslij = () => {
    const nowa: Wysylka = { wyslano: '2026-11-09', stan: 'Wysyłanie', numer: 'f7e6d5c4b3a2', doWplaty };
    setWysylki((l) => [nowa, ...l]);
    setTimeout(() => setWysylki((l) => l.map((w) => (w.numer === nowa.numer ? { ...w, stan: 'MF sprawdza plik' } : w))), 1200);
    setTimeout(() => {
      setWysylki((l) => l.map((w) => (w.numer === nowa.numer ? { ...w, stan: 'Przyjęty, UPO gotowe' } : w)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 3000);
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <NaglowekKwoty podpis={`VAT za ${v.miesiac}, do wpłaty (P_51)`} wartosc={kwota(doWplaty)} styl="title1" status={`Termin ${dataPelna(v.termin)}`} />
      <Kafle
        kafle={[
          { klucz: 'p38', podpis: 'Podatek należny (P_38)', wartosc: kwotaKrotka(v.nalezny) },
          { klucz: 'p48', podpis: 'Podatek naliczony (P_48)', wartosc: kwotaKrotka(v.naliczony) },
        ]}
      />

      <Sekcja naglowek="Termin i przelew" stopka={`Złożenie JPK_V7M i zapłata VAT za ${v.miesiac}: do ${dataPelna(v.termin)}.`}>
        <Wiersz tytul="Mikrorachunek podatkowy" podtytul={v.mikrorachunek} zaznaczalna />
        <Wiersz tytul="Kwota" wartosc={kwota(doWplaty)} wartoscKolor="etykieta" />
      </Sekcja>

      <Sekcja naglowek="Plik JPK_V7M">
        <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} />
        <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} />
        <PoleDaty etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} />
        <PoleTekstowe etykieta="E-mail w pliku" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
        <Wiersz tytul="Pobierz JPK_V7M" ikona="arrow.down.doc" akcja onPress={() => void Share.share({ message: `JPK_V7M za ${v.miesiac} (dane przykładowe).` })} />
      </Sekcja>

      <Sekcja naglowek="Wysyłka do Ministerstwa Finansów" stopka="Plik podpisujemy danymi autoryzującymi (przychód z zeznania za poprzedni rok).">
        <Wiersz tytul="Wyślij do MF" ikona="paperplane" akcja onPress={wyslij} />
        {wysylki.map((w) => (
          <Wiersz
            key={w.numer}
            tytul={w.stan}
            podtytul={`Wysłano ${dataPelna(w.wyslano)} · nr ${w.numer}`}
            wartosc={kwota(w.doWplaty)}
            wartoscPodpis={w.stan.startsWith('Przyjęty') ? 'Pobierz UPO' : undefined}
            wartoscPodpisKolor="akcent"
            onPress={w.stan.startsWith('Przyjęty') ? () => void Share.share({ message: `UPO dla wysyłki ${w.numer}.` }) : undefined}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

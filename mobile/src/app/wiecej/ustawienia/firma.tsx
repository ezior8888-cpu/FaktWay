import * as Haptics from 'expo-haptics';
import { useState } from 'react';

import { FIRMA, PODSTAWY_ZWOLNIENIA } from '@/dane-przykladowe/ustawienia';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';

/** Firma: odpowiednik karty „Firma” w ustawieniach strony (dane, VAT, metoda kasowa, start działalności). */
export default function EkranFirmy() {
  const [nazwa, setNazwa] = useState(FIRMA.nazwa);
  const [ulica, setUlica] = useState(FIRMA.ulica);
  const [miasto, setMiasto] = useState(FIRMA.miasto);
  const [zwolniona, setZwolniona] = useState(false);
  const [podstawa, setPodstawa] = useState('113-1');
  const [kasowa, setKasowa] = useState(false);
  const [rozpoczecie, setRozpoczecie] = useState(FIRMA.rozpoczecie);
  const [zapisano, setZapisano] = useState<string>();

  const zapisz = (co: string) => {
    setZapisano(co);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const status = zwolniona
    ? `Zwolniona z VAT, ${PODSTAWY_ZWOLNIENIA.find((p) => p.wartosc === podstawa)?.etykieta ?? ''}`
    : kasowa
      ? 'Czynny podatnik VAT, metoda kasowa'
      : 'Czynny podatnik VAT';

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Dane firmy" stopka={zapisano === 'dane' ? 'Zapisano dane firmy.' : 'NIP zmienia się tylko przez pomoc FaktWay.'}>
        <Wiersz tytul="NIP" wartosc={FIRMA.nip} zaznaczalna />
        <PoleTekstowe etykieta="Nazwa firmy" wartosc={nazwa} onZmiana={setNazwa} />
        <PoleTekstowe etykieta="Ulica i numer" wartosc={ulica} onZmiana={setUlica} />
        <PoleTekstowe etykieta="Kod i miejscowość" wartosc={miasto} onZmiana={setMiasto} podpowiedz="00-001 Warszawa" />
        <Wiersz tytul="Zapisz dane firmy" akcja onPress={() => zapisz('dane')} />
      </Sekcja>

      <Sekcja naglowek="Podatek VAT" stopka={status}>
        <PolePrzelacznik etykieta="Moja firma jest zwolniona z VAT" wartosc={zwolniona} onZmiana={setZwolniona} />
        {zwolniona ? <PoleWyboru etykieta="Podstawa prawna" wartosc={podstawa} opcje={PODSTAWY_ZWOLNIENIA} onZmiana={setPodstawa} /> : null}
        {zwolniona ? null : <PolePrzelacznik etykieta="Rozliczam VAT metodą kasową" wartosc={kasowa} onZmiana={setKasowa} />}
        <Wiersz tytul="Zapisz" akcja onPress={() => zapisz('vat')} />
      </Sekcja>

      <Sekcja naglowek="Działalność" stopka={zapisano === 'start' ? 'Zapisano.' : 'Potrzebna do ulgi na start i limitu zwolnienia z VAT.'}>
        <PoleDaty etykieta="Data rozpoczęcia" wartosc={rozpoczecie} onZmiana={setRozpoczecie} />
        <Wiersz tytul="Zapisz" akcja onPress={() => zapisz('start')} />
      </Sekcja>
    </EkranListy>
  );
}

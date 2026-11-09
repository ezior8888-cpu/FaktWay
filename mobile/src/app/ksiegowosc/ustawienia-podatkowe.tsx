import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { NAZWA_FORMY, OPIS_ZUS, PROFIL, STAWKI_RYCZALTU, type FormaOpodatkowania, type RodzajZus } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/** Ustawienia podatkowe: odpowiednik `reports/ustawienia-podatkowe` (forma, stawka, ZUS, historia). */
export default function EkranUstawienPodatkowych() {
  const [od, setOd] = useState(PROFIL.od);
  const [forma, setForma] = useState<FormaOpodatkowania>(PROFIL.forma);
  const [stawka, setStawka] = useState('12');
  const [najem, setNajem] = useState(false);
  const [zus, setZus] = useState<RodzajZus>(PROFIL.zus);
  const [zusOd, setZusOd] = useState(PROFIL.zusOd);
  const [chorobowe, setChorobowe] = useState(PROFIL.chorobowe);
  const [rachunek, setRachunek] = useState(PROFIL.rachunekZus);
  const [zapisano, setZapisano] = useState(false);

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Opodatkowanie" stopka="Formę opodatkowania zmienia się tylko od 1 stycznia.">
        <PoleDaty etykieta="Obowiązują od" wartosc={od} onZmiana={setOd} />
        <PoleWyboru
          etykieta="Forma"
          wartosc={forma}
          opcje={(Object.keys(NAZWA_FORMY) as FormaOpodatkowania[]).map((f) => ({ wartosc: f, etykieta: NAZWA_FORMY[f] }))}
          onZmiana={setForma}
        />
        {forma === 'ryczalt' ? (
          <>
            <PoleWyboru etykieta="Stawka ryczałtu" wartosc={stawka} opcje={STAWKI_RYCZALTU.map((s) => ({ wartosc: s, etykieta: `${s} %` }))} onZmiana={setStawka} />
            <PolePrzelacznik
              etykieta="Przychody 8,5 % to najem"
              opis="Najem, dzierżawa, zakwaterowanie albo B+R. Powyżej 100 000 zł stawka rośnie do 12,5 %."
              wartosc={najem}
              onZmiana={setNajem}
            />
          </>
        ) : null}
        <Wiersz tytul="Status VAT" wartosc={PROFIL.vat} />
      </Sekcja>

      <Sekcja naglowek="Składki ZUS" stopka={OPIS_ZUS[zus].opis}>
        <PoleWyboru
          etykieta="Rodzaj składek"
          wartosc={zus}
          opcje={(Object.keys(OPIS_ZUS) as RodzajZus[]).map((z) => ({ wartosc: z, etykieta: OPIS_ZUS[z].nazwa }))}
          onZmiana={setZus}
        />
        <PoleDaty etykieta="Od kiedy" wartosc={zusOd} onZmiana={setZusOd} />
        {zus === 'preferencyjne' || zus === 'pelne' ? (
          <PolePrzelacznik etykieta="Dobrowolne ubezpieczenie chorobowe" wartosc={chorobowe} onZmiana={setChorobowe} />
        ) : null}
        <PoleTekstowe etykieta="Rachunek ZUS" wartosc={rachunek} onZmiana={setRachunek} podpowiedz="opcjonalnie" klawiatura="number-pad" />
      </Sekcja>

      <View style={styles.akcja}>
        <PrzyciskGlowny
          tytul={zapisano ? 'Zapisano' : 'Zapisz'}
          ikona="checkmark"
          onPress={() => {
            setZapisano(true);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>

      <Sekcja naglowek="Historia ustawień">
        {PROFIL.historia.map((h) => (
          <Wiersz key={h} tytul={h} />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
});

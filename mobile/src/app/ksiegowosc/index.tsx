import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { NAZWA_FORMY, PROFIL, ROZLICZENIE } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { dataPelna, kwota, kwotaKrotka } from '@/lib/format';
import { kiedyTermin } from '@/lib/status-faktury';
import { useFlaga } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';

const MIESIACE = ['październik 2026', 'wrzesień 2026', 'sierpień 2026'];

/**
 * Księgowość, „Ten miesiąc”: odpowiednik `reports/ten-miesiac` (rozliczenie,
 * do zapłaty z danymi przelewu, zatwierdzenie miesiąca, zapłaty, historia
 * wersji) i wejście do pozostałych kart (KPiR, Ewidencja, VAT, Eksport,
 * Ustawienia podatkowe).
 */
export default function EkranKsiegowosci() {
  const kolory = useKolory();
  const router = useRouter();
  const r = ROZLICZENIE;
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [zatwierdzony, setZatwierdzony] = useFlaga('miesiac-zatwierdzony', false);
  const [zaplacone, ustawZaplacone] = useState<Record<string, string>>({});
  const [rodzajZaplaty, setRodzajZaplaty] = useState('spoleczne');
  const [dataZaplaty, setDataZaplaty] = useState(DZIS);
  const [kwotaZaplaty, setKwotaZaplaty] = useState('');
  const [zapisaneZaplaty, setZapisaneZaplaty] = useState<string[]>([]);
  const doZaplaty = r.pozycje.filter((p) => !zaplacone[p.id]).reduce((s, p) => s + p.kwota, 0);
  const kwotaPozycji = (id: string) => r.pozycje.find((p) => p.id === id)?.kwota ?? 0;

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={kolory.etykieta} title="Miesiąc rozliczenia">
          {MIESIACE.map((m) => (
            <Stack.Toolbar.MenuAction key={m} isOn={miesiac === m} onPress={() => setMiesiac(m)}>
              {m}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <EkranListy gradient keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={`Rozliczenie za ${miesiac}`}
          wartosc={kwota(doZaplaty)}
          styl="title1"
          status={doZaplaty === 0 ? 'Wszystko zapłacone' : `Do zapłaty, najbliższy termin ${kiedyTermin(DZIS, '2026-11-20')}`}
          statusKolor={doZaplaty === 0 ? 'sukces' : 'etykietaDrugorzedna'}
        />

        <Kafle
          kafle={[
            { klucz: 'przychod', ikona: 'wallet-line', podpis: 'Przychód w miesiącu', wartosc: kwotaKrotka(r.przychod) },
            { klucz: 'koszty', ikona: 'bank-card-line', podpis: 'Koszty w miesiącu', wartosc: kwotaKrotka(r.koszty) },
            { klucz: 'pit', ikona: 'bank-line', podpis: 'Zaliczka PIT', wartosc: kwota(kwotaPozycji('pit')) },
            { klucz: 'spoleczne', ikona: 'team-line', podpis: 'Składki społeczne', wartosc: kwota(kwotaPozycji('spoleczne')) },
            { klucz: 'zdrowotna', ikona: 'shield-check-line', podpis: 'Składka zdrowotna', wartosc: kwota(kwotaPozycji('zdrowotna')) },
            { klucz: 'vat', ikona: 'percent-line', podpis: 'VAT do zapłaty', wartosc: kwota(kwotaPozycji('vat')), onPress: () => router.push('/ksiegowosc/vat') },
          ]}
        />

        <Sekcja naglowek="Rejestry i pliki" stopka={`${NAZWA_FORMY[PROFIL.forma]}, ${PROFIL.vat.toLowerCase()}.`}>
          <Wiersz tytul="KPiR" podtytul="Księga przychodów i rozchodów" ikona="book2-line" strzalka onPress={() => router.push('/ksiegowosc/kpir')} />
          <Wiersz tytul="Ewidencja" podtytul="Wpisy, spis z natury, JPK_PKPIR" ikona="file-list2-line" strzalka onPress={() => router.push('/ksiegowosc/ewidencja')} />
          <Wiersz tytul="VAT" podtytul="JPK_V7M i wysyłka do Ministerstwa Finansów" ikona="percent-line" strzalka onPress={() => router.push('/ksiegowosc/vat')} />
          <Wiersz tytul="Eksport" podtytul="Pliki dla księgowej i programów" ikona="share-box-line" strzalka onPress={() => router.push('/ksiegowosc/eksport')} />
          <Wiersz tytul="Ustawienia podatkowe" podtytul="Forma opodatkowania, ZUS" ikona="equalizer-line" strzalka onPress={() => router.push('/ksiegowosc/ustawienia-podatkowe')} />
        </Sekcja>

        {zatwierdzony ? null : (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul="Zatwierdź miesiąc"
              ikona="verified-badge-line"
              onPress={() => {
                setZatwierdzony(true);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }}
            />
          </View>
        )}

        {r.pozycje.map((p) => {
          const zaplacono = zaplacone[p.id];
          return (
            <Sekcja
              key={p.id}
              naglowek={p.nazwa}
              stopka={zaplacono ? `Zapłacono ${dataPelna(zaplacono)} (wersja 1: ${kwota(p.kwota)}).` : zatwierdzony ? 'Zatwierdzone (wersja 1).' : 'Niezatwierdzone.'}>
              <Wiersz tytul="Kwota" wartosc={kwota(p.kwota)} wartoscKolor="etykieta" />
              <Wiersz tytul="Termin" wartosc={dataPelna(p.termin)} />
              <Wiersz tytul="Dane do przelewu" podtytul={p.przelew} zaznaczalna />
              <Wiersz
                tytul={zaplacono ? 'Cofnij zapłatę' : 'Oznacz jako zapłacone'}
                akcja={!zaplacono}
                niszczacy={Boolean(zaplacono)}
                onPress={() => {
                  ustawZaplacone((z) => {
                    const nowe = { ...z };
                    if (zaplacono) delete nowe[p.id];
                    else nowe[p.id] = DZIS;
                    return nowe;
                  });
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }}
              />
            </Sekcja>
          );
        })}

        <Sekcja naglowek="Zapłaty spoza wyliczenia" stopka="Np. składki zapłacone w innej kwocie albo za inny miesiąc.">
          {zapisaneZaplaty.map((z, i) => (
            <Wiersz key={i} tytul={z} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          ))}
          <PoleWyboru
            etykieta="Rodzaj składek"
            wartosc={rodzajZaplaty}
            opcje={[
              { wartosc: 'spoleczne', etykieta: 'Składki społeczne' },
              { wartosc: 'zdrowotna', etykieta: 'Składka zdrowotna' },
            ]}
            onZmiana={setRodzajZaplaty}
          />
          <PoleDaty etykieta="Data zapłaty" wartosc={dataZaplaty} onZmiana={setDataZaplaty} />
          <PoleTekstowe etykieta="Zapłacona kwota" wartosc={kwotaZaplaty} onZmiana={setKwotaZaplaty} podpowiedz="zł" klawiatura="decimal-pad" />
          <Wiersz
            tytul="Zapisz zapłatę"
            akcja
            onPress={() => {
              if (!kwotaZaplaty.trim()) return;
              setZapisaneZaplaty((l) => [...l, `${rodzajZaplaty === 'spoleczne' ? 'Składki społeczne' : 'Składka zdrowotna'}: ${kwotaZaplaty} zł, ${dataPelna(dataZaplaty)}`]);
              setKwotaZaplaty('');
            }}
          />
        </Sekcja>

        <Sekcja naglowek="Historia wersji">
          {r.historia.map((h) => (
            <Wiersz
              key={h.rozliczenie}
              tytul={`${h.rozliczenie}, wersja ${h.wersja}`}
              podtytul={`Zatwierdzone ${dataPelna(h.zatwierdzone)}, zapłata ${dataPelna(h.zaplata)}`}
              wartosc={kwota(h.kwota)}
            />
          ))}
        </Sekcja>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});

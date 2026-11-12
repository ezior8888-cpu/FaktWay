import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { NAZWA_FORMY, PROFIL, ROZLICZENIE } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { Karta } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { RzadLiczb } from '@/komponenty/rzad-liczb';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, dataPelna, dniMiedzy, kwota } from '@/lib/format';
import { kiedyTermin } from '@/lib/status-faktury';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';

const MIESIACE = ['październik 2026', 'wrzesień 2026', 'sierpień 2026'];

/**
 * Księgowość, „Ten miesiąc”: odpowiednik `reports/ten-miesiac` (rozliczenie,
 * do zapłaty z danymi przelewu, zatwierdzenie miesiąca, zapłaty, historia
 * wersji) i wejście do pozostałych kart (KPiR, Ewidencja, VAT, Eksport,
 * Ustawienia podatkowe). Terminy na górze, pogrupowane po dniu, jak w Rocket
 * Money (D14; WZORCE-MOBBIN.md 5.1); płatność otwiera arkusz z danymi przelewu.
 */
export default function EkranKsiegowosci() {
  const kolory = useKolory();
  const router = useRouter();
  const r = ROZLICZENIE;
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [zatwierdzony, setZatwierdzony] = useFlaga('miesiac-zatwierdzony', false);
  const { flagi } = useStanFaktur();
  const zaplacona = (id: string) => Boolean(flagi[`zaplacone-${id}`]);
  const [zapisywanieZaplaty, setZapisywanieZaplaty] = useState(false);
  const [rodzajZaplaty, setRodzajZaplaty] = useState('spoleczne');
  const [dataZaplaty, setDataZaplaty] = useState(DZIS);
  const [kwotaZaplaty, setKwotaZaplaty] = useState('');
  const [zapisaneZaplaty, setZapisaneZaplaty] = useState<string[]>([]);
  const doZaplaty = r.pozycje.filter((p) => !zaplacona(p.id)).reduce((s, p) => s + p.kwota, 0);
  const ileZaplaconych = r.pozycje.filter((p) => zaplacona(p.id)).length;
  const najblizszy = r.pozycje.filter((p) => !zaplacona(p.id)).map((p) => p.termin).sort()[0];
  const terminy = new Map<string, typeof r.pozycje>();
  for (const p of r.pozycje) terminy.set(p.termin, [...(terminy.get(p.termin) ?? []), p]);

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
          status={doZaplaty === 0 || !najblizszy ? 'Wszystko zapłacone' : `Do zapłaty, najbliższy termin ${kiedyTermin(DZIS, najblizszy)}`}
          statusKolor={doZaplaty === 0 ? 'sukces' : 'etykietaDrugorzedna'}
        />

        <Sekcja naglowek="Do zapłaty" naglowekWartosc={`Zapłacono ${ileZaplaconych} z ${r.pozycje.length}`}>
          {[...terminy.entries()].flatMap(([termin, lista]) => [
            <Tekst key={`t-${termin}`} styl="caption1" waga="semibold" kolor="etykietaDrugorzedna" accessibilityRole="header" style={styles.termin}>
              {`${dataPelna(termin)}, ${kiedyTermin(DZIS, termin)}`}
            </Tekst>,
            ...lista.map((p) => {
              const zaplacono = zaplacona(p.id);
              const dni = dniMiedzy(DZIS, p.termin);
              return (
                <Wiersz
                  key={p.id}
                  tytul={p.nazwa}
                  wartosc={kwota(p.kwota)}
                  wartoscKolor="etykieta"
                  // Termin stoi w nagłówku dnia; przy wierszu tylko zapłata albo termin za 3 dni i mniej.
                  wartoscPodpis={zaplacono ? `Zapłacone ${dataKrotka(DZIS)}` : dni <= 3 ? kiedyTermin(DZIS, p.termin) : undefined}
                  wartoscPodpisKolor={zaplacono ? 'sukces' : 'ostrzezenie'}
                  strzalka
                  onPress={() => router.push({ pathname: '/ksiegowosc/przelew', params: { id: p.id } })}
                  etykietaDostepnosci={`${p.nazwa}, ${kwota(p.kwota)}, ${zaplacono ? 'zapłacone' : `termin ${dataPelna(p.termin)}`}. Dotknij, żeby zobaczyć dane przelewu.`}
                />
              );
            }),
          ])}
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

        <Karta style={styles.karta}>
          <View style={styles.trescKarty}>
            <RzadLiczb
              liczby={[
                { wartosc: kwota(r.przychod), podpis: 'przychód w miesiącu' },
                { wartosc: kwota(r.koszty), podpis: 'koszty w miesiącu' },
              ]}
            />
          </View>
        </Karta>

        <Sekcja naglowek="Rejestry i pliki" stopka={`${NAZWA_FORMY[PROFIL.forma]}, ${PROFIL.vat.toLowerCase()}.${zatwierdzony ? ' Miesiąc zatwierdzony (wersja 1).' : ''}`}>
          <Wiersz tytul="KPiR" podtytul="Księga przychodów i rozchodów" strzalka onPress={() => router.push('/ksiegowosc/kpir')} />
          <Wiersz tytul="Ewidencja" podtytul="Wpisy, spis z natury, JPK_PKPIR" strzalka onPress={() => router.push('/ksiegowosc/ewidencja')} />
          <Wiersz tytul="VAT" podtytul="JPK_V7M i wysyłka do Ministerstwa Finansów" strzalka onPress={() => router.push('/ksiegowosc/vat')} />
          <Wiersz tytul="Eksport" podtytul="Pliki dla księgowej i programów" strzalka onPress={() => router.push('/ksiegowosc/eksport')} />
          <Wiersz tytul="Ustawienia podatkowe" podtytul="Forma opodatkowania, ZUS" strzalka onPress={() => router.push('/ksiegowosc/ustawienia-podatkowe')} />
        </Sekcja>

        <Sekcja naglowek="Zapłaty spoza wyliczenia" stopka="Np. składki zapłacone w innej kwocie albo za inny miesiąc.">
          {zapisaneZaplaty.map((z, i) => (
            <Wiersz key={i} tytul={z} ikona="checkbox-circle-fill" ikonaKolor="sukces" />
          ))}
          {zapisywanieZaplaty ? (
            <>
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
                  setZapisywanieZaplaty(false);
                }}
              />
            </>
          ) : (
            // Pola dopiero po dotknięciu, żeby ekran przeglądu nie był formularzem (WZORCE-MOBBIN.md 5.3).
            <Wiersz tytul="Dodaj zapłatę" akcja onPress={() => setZapisywanieZaplaty(true)} />
          )}
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
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  karta: { marginTop: ODSTEP.m },
  trescKarty: { paddingVertical: ODSTEP.m, paddingHorizontal: ODSTEP.xs },
  termin: { textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: MARGINES, paddingTop: ODSTEP.s, paddingBottom: ODSTEP.linia },
});

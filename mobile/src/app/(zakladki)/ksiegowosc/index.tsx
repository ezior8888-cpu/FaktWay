import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
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
import { otworzStrone } from '@/komponenty/na-stronie';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import type { PozycjaRozliczeniaTelefonu, ZatwierdzenieMiesiacaOdpowiedz } from '@/lib/api/kontrakt';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { doZaplatyGr, nazwaMiesiaca, useTenMiesiac } from '@/stan/ksiegowosc';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';

const MIESIACE = ['październik 2026', 'wrzesień 2026', 'sierpień 2026'];

export default function EkranKsiegowosci() {
  const konto = useKontoFirmy();
  if (konto) return <EkranKsiegowosciZBazy konto={konto} />;
  return <EkranKsiegowosciPrzyklad />;
}

/** Podpis stanu pozycji jak `StatusRozliczenia` strony, krótko. */
function stanPozycji(p: PozycjaRozliczeniaTelefonu): { tekst: string; kolor: 'sukces' | 'ostrzezenie' | 'etykietaDrugorzedna' } {
  if (p.kwotaGr === null) return { tekst: 'Bez kwoty', kolor: 'ostrzezenie' };
  if (p.zmiana) return { tekst: 'Zmiana do zatwierdzenia', kolor: 'ostrzezenie' };
  if (p.rozliczenie?.status === 'zaplacone' && p.rozliczenie.zaplaconeO) return { tekst: `Zapłacone ${dataKrotka(p.rozliczenie.zaplaconeO)}`, kolor: 'sukces' };
  if (p.rozliczenie) return { tekst: `Zatwierdzone, wersja ${p.rozliczenie.wersja}`, kolor: 'etykietaDrugorzedna' };
  return { tekst: 'Niezatwierdzone', kolor: 'etykietaDrugorzedna' };
}

/**
 * „Ten miesiąc” na prawdziwym koncie (M10b): wyliczenie strony z serwera,
 * terminy pogrupowane po dniu, „Zatwierdź miesiąc” (właściciel, administrator,
 * po końcu miesiąca, ze skrótami z tego widoku) i dane do przelewu z zapłatą.
 * KPiR, ewidencja, VAT, eksport i zapłaty spoza wyliczenia otwierają stronę.
 */
function EkranKsiegowosciZBazy({ konto }: { konto: KontoFirmy }) {
  const kolory = useKolory();
  const router = useRouter();
  const [miesiac, setMiesiac] = useState<string>();
  const ten = useTenMiesiac(miesiac);
  const [trwa, setTrwa] = useState(false);
  const [blad, setBlad] = useState<string>();
  const wToku = useRef(false);
  const [firmaEkranu] = useState(konto.firma?.id ?? null);
  const d = ten?.dane;

  const zatwierdz = async () => {
    if (!d || wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    const w = await konto.zapytaj<ZatwierdzenieMiesiacaOdpowiedz>('ksiegowosc/zatwierdz', { metoda: 'POST', cialo: { miesiac: d.miesiac, skroty: d.skroty }, firmaEkranu });
    wToku.current = false;
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    // Po odmowie („dane zmieniły się od otwarcia”) też od nowa: klient widzi aktualne kwoty.
    void ten?.odswiez();
  };

  const menu = d ? (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={kolory.etykieta} title="Miesiąc rozliczenia">
        {d.miesiace.map((m) => (
          <Stack.Toolbar.MenuAction key={m} isOn={d.miesiac === m} onPress={() => setMiesiac(m)}>
            {nazwaMiesiaca(m)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  ) : null;

  if (!d) {
    return (
      <EkranListy gradient>
        {ten?.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać rozliczenia" opis={ten.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ten.odswiez() }} />
        ) : (
          <>
            <SzkieletKwoty />
            <SzkieletListy wiersze={4} etykieta="Wczytujemy rozliczenie" />
          </>
        )}
      </EkranListy>
    );
  }

  if (!d.wlaczona) {
    return (
      <EkranListy gradient>
        <StanPusty
          ikona="book2-line"
          tytul="Księgowość nie jest jeszcze włączona"
          opis="Dla tej firmy moduł księgowości jest wyłączony. Stan modułu sprawdzisz na faktway.pl w zakładce Księgowość."
          akcja={{ tytul: 'Otwórz faktway.pl', onPress: () => otworzStrone('/reports') }}
        />
      </EkranListy>
    );
  }

  const policzone = d.pozycje.filter((p) => p.kwotaGr !== null);
  const doZaplaty = policzone.reduce((s, p) => s + doZaplatyGr(p), 0);
  const zaplacone = policzone.filter((p) => doZaplatyGr(p) === 0 && p.rozliczenie?.status === 'zaplacone').length;
  const najblizszy = policzone.filter((p) => doZaplatyGr(p) > 0 && p.termin).map((p) => p.termin!.faktyczny).sort()[0];
  const terminy = new Map<string, PozycjaRozliczeniaTelefonu[]>();
  for (const p of d.pozycje) {
    const t = p.termin?.faktyczny ?? '';
    terminy.set(t, [...(terminy.get(t) ?? []), p]);
  }
  const notaZatwierdzenia = !d.mozeEdytowac
    ? 'Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.'
    : !d.miesiacZakonczony
      ? 'Miesiąc zatwierdza się po jego zakończeniu, gdy są już wszystkie przychody.'
      : d.doZatwierdzenia === 0 && policzone.length > 0
        ? 'Policzone kwoty są zatwierdzone i dane się od tego czasu nie zmieniły.'
        : undefined;

  return (
    <>
      {menu}
      <EkranListy gradient keyboardShouldPersistTaps="handled" onOdswiez={ten.odswiez}>
        <NaglowekKwoty
          podpis={`Rozliczenie za ${nazwaMiesiaca(d.miesiac)}`}
          wartosc={kwota(doZaplaty)}
          styl="title1"
          status={d.braki ? 'Kwot nie liczymy' : doZaplaty === 0 || !najblizszy ? 'Nic do zapłaty' : `Do zapłaty, najbliższy termin ${kiedyTermin(d.dzis, najblizszy)}`}
          statusKolor={d.braki ? 'ostrzezenie' : doZaplaty === 0 ? 'sukces' : 'etykietaDrugorzedna'}
        />

        {d.braki ? (
          <Sekcja naglowek={`Kwot za ${nazwaMiesiaca(d.miesiac)} nie liczymy`} stopka="Uzupełnij brakujące dane na faktway.pl, w zakładce Księgowość.">
            {d.braki.map((b) => (
              <Wiersz key={b} tytul={b} ikona="error-warning-line" ikonaKolor="ostrzezenie" />
            ))}
          </Sekcja>
        ) : (
          <Sekcja naglowek="Do zapłaty" naglowekWartosc={`Zapłacono ${zaplacone} z ${policzone.length}`} stopka={d.podpis}>
            {[...terminy.entries()].flatMap(([termin, lista]) => [
              termin ? (
                <Tekst key={`t-${termin}`} styl="caption1" waga="semibold" kolor="etykietaDrugorzedna" accessibilityRole="header" style={styles.termin}>
                  {`${dataPelna(termin)}, ${kiedyTermin(d.dzis, termin)}`}
                </Tekst>
              ) : null,
              ...lista.map((p) => {
                const st = stanPozycji(p);
                return (
                  <Wiersz
                    key={p.rodzaj}
                    tytul={p.nazwa}
                    podtytul={p.brak ?? undefined}
                    wartosc={p.kwotaGr === null ? undefined : kwota(doZaplatyGr(p) > 0 && p.zaplaconoGr > 0 ? doZaplatyGr(p) : p.kwotaGr)}
                    wartoscKolor="etykieta"
                    wartoscPodpis={st.tekst}
                    wartoscPodpisKolor={st.kolor}
                    strzalka={p.kwotaGr !== null}
                    onPress={p.kwotaGr === null ? undefined : () => router.push({ pathname: '/ksiegowosc/przelew', params: { id: p.rodzaj, miesiac: d.miesiac } })}
                    etykietaDostepnosci={`${p.nazwa}, ${p.kwotaGr === null ? 'bez kwoty' : kwota(p.kwotaGr)}, ${st.tekst}.${p.kwotaGr === null ? '' : ' Dotknij, żeby zobaczyć dane przelewu.'}`}
                  />
                );
              }),
            ])}
          </Sekcja>
        )}

        {d.mozeEdytowac && d.miesiacZakonczony && d.doZatwierdzenia > 0 ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul={d.historia.length > 0 ? 'Zatwierdź nową wersję' : 'Zatwierdź miesiąc'} ikona="verified-badge-line" trwa={trwa} onPress={() => void zatwierdz()} />
          </View>
        ) : null}
        {blad || notaZatwierdzenia ? (
          <Tekst styl="footnote" kolor={blad ? 'blad' : 'etykietaDrugorzedna'} style={styles.nota}>
            {blad ?? notaZatwierdzenia}
          </Tekst>
        ) : null}

        <Karta style={styles.karta}>
          <View style={styles.trescKarty}>
            <RzadLiczb
              liczby={[
                { wartosc: d.przychodGr === null ? 'brak' : kwota(d.przychodGr), podpis: 'przychód w miesiącu' },
                ...(d.forma === 'ryczalt' ? [] : [{ wartosc: d.kosztyGr === null ? 'brak' : kwota(d.kosztyGr), podpis: 'koszty w miesiącu' }]),
              ]}
            />
          </View>
        </Karta>

        <Sekcja naglowek="Rejestry i pliki" stopka="KPiR, ewidencję, VAT, eksport i zapłaty spoza wyliczenia prowadzisz na faktway.pl.">
          <Wiersz tytul="KPiR i ewidencja" strzalka onPress={() => otworzStrone(d.forma === 'ryczalt' ? '/reports/ewidencja' : '/reports/kpir')} />
          <Wiersz tytul="VAT i JPK_V7M" strzalka onPress={() => otworzStrone('/reports/vat')} />
          <Wiersz tytul="Ustawienia podatkowe" strzalka onPress={() => otworzStrone('/reports/ustawienia-podatkowe')} />
        </Sekcja>

        {d.historia.length > 0 ? (
          <Sekcja naglowek="Historia wersji">
            {d.historia.map((h) => (
              <Wiersz
                key={`${h.rodzaj}-${h.wersja}`}
                tytul={`${h.nazwa}, wersja ${h.wersja}`}
                podtytul={`Zatwierdzone ${dataPelna(h.zatwierdzoneO.slice(0, 10))}${h.zaplaconeO ? `, zapłata ${dataPelna(h.zaplaconeO)}` : ''}`}
                wartosc={kwota(h.kwotaGr)}
              />
            ))}
          </Sekcja>
        ) : null}
      </EkranListy>
    </>
  );
}

/**
 * Księgowość, „Ten miesiąc”: odpowiednik `reports/ten-miesiac` (rozliczenie,
 * do zapłaty z danymi przelewu, zatwierdzenie miesiąca, zapłaty, historia
 * wersji) i wejście do pozostałych kart (KPiR, Ewidencja, VAT, Eksport,
 * Ustawienia podatkowe). Terminy na górze, pogrupowane po dniu, jak w Rocket
 * Money (D14; WZORCE-MOBBIN.md 5.1); płatność otwiera arkusz z danymi przelewu.
 */
function EkranKsiegowosciPrzyklad() {
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
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
  termin: { textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: MARGINES, paddingTop: ODSTEP.s, paddingBottom: ODSTEP.linia },
});

import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { ROZLICZENIE } from '@/dane-przykladowe/ksiegowosc';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataPelna, kwota } from '@/lib/format';
import { kiedyTermin } from '@/lib/status-faktury';
import { PoleDaty } from '@/komponenty/formularz';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import type { ZaplataRozliczeniaOdpowiedz } from '@/lib/api/kontrakt';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { useFlaga } from '@/stan/faktury';
import { doZaplatyGr, nazwaMiesiaca, useTenMiesiac } from '@/stan/ksiegowosc';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranPrzelewu() {
  const konto = useKontoFirmy();
  if (konto) return <EkranPrzelewuZBazy konto={konto} />;
  return <EkranPrzelewuPrzyklad />;
}

/**
 * „Dane do przelewu” na prawdziwym koncie (M10b): kwota do zapłaty (dopłata
 * po nowej wersji), termin, dane przelewu z serwera (to samo zdanie co strona)
 * i „Oznacz jako zapłacone” z dniem zapłaty (nie później niż dziś, nie przed
 * miesiącem rozliczenia; sprawdza serwer) albo „Cofnij zapłatę”. Zapis tylko
 * zatwierdzonej wersji, przez właściciela albo administratora.
 */
function EkranPrzelewuZBazy({ konto }: { konto: KontoFirmy }) {
  const router = useRouter();
  const { id, miesiac } = useLocalSearchParams<{ id: string; miesiac?: string }>();
  const ten = useTenMiesiac(miesiac);
  const d = ten?.dane;
  const p = d?.pozycje.find((x) => x.rodzaj === id);
  const [dzien, setDzien] = useState<string>();
  const [trwa, setTrwa] = useState(false);
  const [blad, setBlad] = useState<string>();
  const wToku = useRef(false);
  const [firmaEkranu] = useState(konto.firma?.id ?? null);

  if (!d || !p) {
    return (
      <EkranListy>
        {ten?.stan === 'ladowanie' ? (
          <SzkieletListy wiersze={3} etykieta="Wczytujemy dane przelewu" />
        ) : (
          <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej płatności" opis="Wróć do „Ten miesiąc” i wybierz płatność z listy." />
        )}
      </EkranListy>
    );
  }

  const r = p.rozliczenie;
  const zaplacone = r?.status === 'zaplacone';
  const kwotaGr = p.kwotaGr ?? 0;
  const doZaplaty = doZaplatyGr(p);
  const dzienZaplaty = dzien ?? d.dzis;
  const nota = !d.mozeEdytowac
    ? 'Zapłatę oznacza właściciel albo administrator firmy.'
    : !r
      ? 'Najpierw zatwierdź miesiąc w „Ten miesiąc”: zapłatę oznacza się przy zatwierdzonej wersji.'
      : p.zmiana
        ? 'Dane zmieniły się po zatwierdzeniu. Zapłata dotyczy zatwierdzonej wersji; nową kwotę zatwierdź w „Ten miesiąc”.'
        : undefined;

  const zapisz = async (naZaplacone: boolean) => {
    if (!r || wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    const w = await konto.zapytaj<ZaplataRozliczeniaOdpowiedz>(`ksiegowosc/rozliczenia/${r.id}/zaplata`, {
      metoda: 'POST',
      cialo: { zaplacone: naZaplacone, dzien: naZaplacone ? dzienZaplaty : null },
      firmaEkranu,
    });
    wToku.current = false;
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await ten?.odswiez();
    if (naZaplacone) router.back();
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled">
      <NaglowekKwoty
        podpis={`${p.nazwa}, ${nazwaMiesiaca(d.miesiac)}`}
        podpisWyrozniony
        wartosc={kwota(zaplacone ? kwotaGr : doZaplaty)}
        status={zaplacone && r?.zaplaconeO ? `Zapłacone ${dataPelna(r.zaplaconeO)}` : p.termin ? `Termin ${dataPelna(p.termin.faktyczny)}, ${kiedyTermin(d.dzis, p.termin.faktyczny)}` : undefined}
        statusKolor={zaplacone ? 'sukces' : 'etykietaDrugorzedna'}
      />
      <Sekcja naglowek="Dane do przelewu" stopka={p.termin?.przesuniety ? `Termin ustawowy ${dataPelna(p.termin.nominalny)}, przesunięty na dzień roboczy. Przytrzymaj tekst, żeby go zaznaczyć i skopiować.` : 'Przytrzymaj tekst, żeby go zaznaczyć i skopiować.'}>
        <Wiersz tytul="Kwota" wartosc={kwota(doZaplaty > 0 ? doZaplaty : kwotaGr)} wartoscKolor="etykieta" zaznaczalna />
        {p.zaplaconoGr > 0 && doZaplaty > 0 ? <Wiersz tytul="Już zapłacono" wartosc={kwota(p.zaplaconoGr)} /> : null}
        {p.termin ? <Wiersz tytul="Termin" wartosc={dataPelna(p.termin.faktyczny)} /> : null}
        <Wiersz tytul="Rachunek i opis" podtytul={p.przelew} zaznaczalna />
      </Sekcja>
      {d.mozeEdytowac && r && !zaplacone ? (
        <Sekcja naglowek="Zapłata">
          <PoleDaty etykieta="Dzień zapłaty" wartosc={dzienZaplaty} onZmiana={setDzien} najwczesniej={`${d.miesiac}-01`} />
        </Sekcja>
      ) : null}
      {blad || nota ? (
        <Tekst styl="footnote" kolor={blad ? 'blad' : 'etykietaDrugorzedna'} style={styles.nota}>
          {blad ?? nota}
        </Tekst>
      ) : null}
      <View style={styles.akcje}>
        <PrzyciskGlowny
          tytul="Udostępnij dane przelewu"
          ikona="share-forward-line"
          wariant="drugorzedny"
          onPress={() => void Share.share({ message: `${p.nazwa}: ${kwota(doZaplaty > 0 ? doZaplaty : kwotaGr)}${p.termin ? `, termin ${dataPelna(p.termin.faktyczny)}` : ''}. ${p.przelew}` })}
        />
        {d.mozeEdytowac && r ? (
          <PrzyciskGlowny
            tytul={zaplacone ? 'Cofnij zapłatę' : 'Oznacz jako zapłacone'}
            ikona={zaplacone ? 'arrow-go-back-line' : 'check-line'}
            wariant={zaplacone ? 'drugorzedny' : 'glowny'}
            trwa={trwa}
            onPress={() => void zapisz(!zaplacone)}
          />
        ) : null}
      </View>
    </EkranListy>
  );
}

/**
 * Arkusz „Dane do przelewu” jednej płatności z „Ten miesiąc” (WZORCE-MOBBIN.md
 * 5.2; wzór Lightyear i N26): kwota, termin, dane przelewu do zaznaczenia,
 * „Udostępnij dane przelewu” i „Oznacz jako zapłacone” z cofnięciem.
 * Kopiowanie jednym dotknięciem potrzebuje `expo-clipboard` (nowy build
 * natywny): na razie zaznaczanie tekstu i udostępnianie. Mikrorachunku nie
 * liczymy tu z NIP (R1), pokazujemy dane z rozliczenia.
 */
function EkranPrzelewuPrzyklad() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = ROZLICZENIE.pozycje.find((x) => x.id === id);
  const [zaplacone, setZaplacone] = useFlaga(`zaplacone-${id}`, false);
  if (!p) return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej płatności" opis="Wróć do „Ten miesiąc” i wybierz płatność z listy." />;

  return (
    <EkranListy>
      <NaglowekKwoty
        podpis={p.nazwa}
        podpisWyrozniony
        wartosc={kwota(p.kwota)}
        status={zaplacone ? 'Zapłacone' : `Termin ${dataPelna(p.termin)}, ${kiedyTermin(DZIS, p.termin)}`}
        statusKolor={zaplacone ? 'sukces' : 'etykietaDrugorzedna'}
      />
      <Sekcja naglowek="Dane do przelewu" stopka="Przytrzymaj tekst, żeby go zaznaczyć i skopiować.">
        <Wiersz tytul="Kwota" wartosc={kwota(p.kwota)} wartoscKolor="etykieta" zaznaczalna />
        <Wiersz tytul="Termin" wartosc={dataPelna(p.termin)} />
        <Wiersz tytul="Rachunek i opis" podtytul={p.przelew} zaznaczalna />
      </Sekcja>
      <View style={styles.akcje}>
        <PrzyciskGlowny
          tytul="Udostępnij dane przelewu"
          ikona="share-forward-line"
          wariant="drugorzedny"
          onPress={() => void Share.share({ message: `${p.nazwa}: ${kwota(p.kwota)}, termin ${dataPelna(p.termin)}. ${p.przelew}` })}
        />
        <PrzyciskGlowny
          tytul={zaplacone ? 'Cofnij zapłatę' : 'Oznacz jako zapłacone'}
          ikona={zaplacone ? 'arrow-go-back-line' : 'check-line'}
          wariant={zaplacone ? 'drugorzedny' : 'glowny'}
          onPress={() => {
            setZaplacone(!zaplacone);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            if (!zaplacone) router.back();
          }}
        />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcje: { marginHorizontal: MARGINES, marginTop: ODSTEP.l, gap: ODSTEP.s },
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});

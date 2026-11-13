import { useRouter } from 'expo-router';

import {
  FINANSE_PRZYCHOD,
  FINANSE_ZYSK,
  MIESIACE_7,
  NAJLEPIEJ_SPRZEDAJACE,
  NAJWIEKSI_KLIENCI,
  NALEZNOSCI,
  RAPORT_MIESIACA,
  VAT_NALEZNY,
} from '@/dane-przykladowe/pulpit';
import { Kafle } from '@/komponenty/kafle';
import { Kubelki } from '@/komponenty/kubelki';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { Wykres } from '@/komponenty/wykres';
import { kwota, kwotaKrotka } from '@/lib/format';
import { ileFaktur } from '@/lib/status-faktury';

/**
 * Finanse: karty Pulpitu strony (`app/(dashboard)/dashboard`), które na
 * telefonie zeszły z Pulpitu, żeby ten mieścił się na ekranie (plan
 * aplikacji, D14; Bartosz 12.11.2026: „strony są za długie”). Wskaźniki
 * miesiąca, Finanse ze słupkami składanymi, Raport, VAT należny, Należności,
 * Najlepiej sprzedające się, Najwięksi klienci, Analizy.
 */
export default function EkranFinansow() {
  const router = useRouter();
  const r = RAPORT_MIESIACA;
  const zysk = r.przychodNetto - r.koszty;
  const vat7 = VAT_NALEZNY.slice(-MIESIACE_7.length).map((p) => p.y);
  const naleznosciProcent = (kwotaWGroszach: number) => Math.round((kwotaWGroszach / Math.max(1, NALEZNOSCI.razem)) * 100);

  return (
    <EkranListy>
      <Kafle
        kafle={[
          { klucz: 'przychod', podpis: 'Przychód netto', wartosc: kwotaKrotka(r.przychodNetto), zmiana: r.przychodZmiana },
          { klucz: 'koszty', podpis: 'Koszty', wartosc: kwotaKrotka(r.koszty), opis: 'Ten miesiąc', onPress: () => router.push('/koszty') },
          { klucz: 'ksef', podpis: 'Faktury w KSeF', wartosc: String(r.fakturyWKsef), zmiana: r.fakturyZmiana, onPress: () => router.push('/faktury') },
          { klucz: 'srednia', podpis: 'Średnia faktura', wartosc: kwotaKrotka(r.sredniaFaktura), zmiana: r.sredniaZmiana },
        ]}
      />

      <Sekcja naglowek="Finanse" opis="Ostatnie 7 miesięcy: koszty, zysk i VAT" naglowekAkcja={{ tytul: 'Przepływy', onPress: () => router.push('/przeplywy') }} swobodna>
        <Wykres
          punkty={MIESIACE_7.map((m) => ({ x: m, y: 0 }))}
          stos={[
            { nazwa: 'Koszty', kolor: 'wykres4', wartosci: FINANSE_PRZYCHOD.map((p, i) => p - (FINANSE_ZYSK[i] ?? 0)) },
            { nazwa: 'Zysk', kolor: 'wykres2', wartosci: FINANSE_ZYSK },
            { nazwa: 'VAT', kolor: 'wykres1', wartosci: vat7 },
          ]}
          etykieta="Finanse w ostatnich 7 miesiącach: koszty, zysk i VAT"
        />
      </Sekcja>

      <Sekcja naglowek="Raport" opis="Listopad 2026">
        <Wiersz tytul="Zysk" wartosc={kwota(zysk)} wartoscKolor="etykieta" />
        <Wiersz tytul="Przychód netto" wartosc={kwota(r.przychodNetto)} wartoscKolor="etykieta" />
        <Wiersz tytul="Koszty" wartosc={kwota(r.koszty)} wartoscKolor="etykieta" />
      </Sekcja>

      <Sekcja
        naglowek="VAT należny"
        opis={`Ostatni rok. W listopadzie ${kwota((VAT_NALEZNY.at(-1)?.y ?? 0) * 100)}`}
        naglowekAkcja={{ tytul: 'Rozliczenie', onPress: () => router.push('/ksiegowosc/vat') }}
        swobodna>
        <Wykres punkty={VAT_NALEZNY.map((p) => ({ ...p, opis: kwota(p.y * 100) }))} rodzaj="pole" etykieta="VAT należny w ostatnim roku" />
      </Sekcja>

      <Sekcja
        naglowek="Należności"
        opis={`${kwota(NALEZNOSCI.razem)} do zapłaty, ${NALEZNOSCI.zaleglePct}% po terminie`}
        naglowekAkcja={{ tytul: 'Faktury', onPress: () => router.push({ pathname: '/faktury', params: { widok: 'po-terminie' } }) }}
        swobodna>
        <Kubelki
          kubelki={[
            { podpis: 'W terminie', procent: naleznosciProcent(NALEZNOSCI.wTerminie), kwota: kwotaKrotka(NALEZNOSCI.wTerminie), kolor: 'wykres2' },
            { podpis: '1 do 30 dni po terminie', procent: naleznosciProcent(NALEZNOSCI.do30), kwota: kwotaKrotka(NALEZNOSCI.do30), kolor: 'ostrzezenie' },
            { podpis: '31 dni i więcej', procent: naleznosciProcent(NALEZNOSCI.powyzej30), kwota: kwotaKrotka(NALEZNOSCI.powyzej30), kolor: 'blad' },
          ]}
        />
      </Sekcja>

      <Sekcja naglowek="Najlepiej sprzedające się" opis="Netto, ostatnie 12 miesięcy">
        {NAJLEPIEJ_SPRZEDAJACE.map((p) => (
          <Wiersz key={p.nazwa} tytul={p.nazwa} podtytul={`j.m.: ${p.jm}`} wartosc={kwotaKrotka(p.kwota)} wartoscKolor="etykieta" />
        ))}
      </Sekcja>

      <Sekcja naglowek="Najwięksi klienci" naglowekAkcja={{ tytul: 'Kontrahenci', onPress: () => router.push('/wiecej/kontrahenci') }}>
        {NAJWIEKSI_KLIENCI.map((k) => (
          <Wiersz
            key={k.nazwa}
            tytul={k.nazwa}
            podtytul={k.nip ? `NIP ${k.nip}` : 'Sprzedaż bez NIP nabywcy'}
            wartosc={kwotaKrotka(k.kwota)}
            wartoscKolor="etykieta"
            wartoscPodpis={`${k.udzial}% sprzedaży`}
          />
        ))}
      </Sekcja>

      <Sekcja naglowek="Analizy" stopka={`Dane przykładowe: ${ileFaktur(r.fakturyWKsef)} w tym miesiącu.`}>
        <Wiersz tytul="Analiza sprzedaży" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'sprzedaz' } })} />
        <Wiersz tytul="Analiza kosztów" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'koszty' } })} />
        <Wiersz tytul="Przepływy pieniężne" strzalka onPress={() => router.push('/przeplywy')} />
      </Sekcja>
    </EkranListy>
  );
}

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { FAKTURY, KOSZTY } from '@/dane-przykladowe';
import { ANALIZA_KOSZTY, ANALIZA_SPRZEDAZ, kalendarz } from '@/dane-przykladowe/pulpit';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { Kalendarz } from '@/komponenty/kalendarz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { Wykres } from '@/komponenty/wykres';
import { dataKrotka, kwota, kwotaKrotka, zmiana } from '@/lib/format';
import { dni } from '@/lib/status-faktury';
import type { Kolory } from '@/wyglad/kolory';

const MIESIACE = ['Listopad 2026', 'Październik 2026', 'Wrzesień 2026', 'Sierpień 2026', 'Lipiec 2026', 'Czerwiec 2026'];
const KOLORY_KOLA: (keyof Kolory)[] = ['akcent', 'sukces', 'ostrzezenie', 'blad', 'etykietaTrzeciorzedna'];

/**
 * Analizy sprzedaży i kosztów: odpowiednik `app/(dashboard)/analizy/sprzedaz`
 * i `analizy/koszty` (przełącznik Sprzedaż/Koszty, wybór miesiąca).
 */
export default function EkranAnaliz() {
  const router = useRouter();
  const { rodzaj } = useLocalSearchParams<{ rodzaj?: string }>();
  const [widok, setWidok] = useState(rodzaj === 'koszty' ? 1 : 0);
  // Ekran już otwarty, a link prosi o drugi rodzaj analizy: przełącz widok.
  const [ostatniRodzaj, setOstatniRodzaj] = useState(rodzaj);
  if (rodzaj !== ostatniRodzaj) {
    setOstatniRodzaj(rodzaj);
    setWidok(rodzaj === 'koszty' ? 1 : 0);
  }
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const sprzedaz = widok === 0;
  const a = ANALIZA_SPRZEDAZ;
  const k = ANALIZA_KOSZTY;

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="calendar" title="Wybierz miesiąc">
          {MIESIACE.map((m) => (
            <Stack.Toolbar.MenuAction key={m} isOn={miesiac === m} onPress={() => setMiesiac(m)}>
              {m}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <EkranListy>
        <Segmenty wartosci={['Sprzedaż', 'Koszty']} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaj analizy" />

        <Sekcja
          naglowek={sprzedaz ? `Sprzedaż: ${miesiac}` : `Wydatki: ${miesiac}`}
          stopka={sprzedaz ? 'Śledź sprzedaż, należności i stałych klientów miesiąc po miesiącu.' : 'Śledź wydatki, VAT i stałe koszty miesiąc po miesiącu.'}
          swobodna>
          <Kafle
            kafle={
              sprzedaz
                ? [
                    { klucz: 'sprzedano', podpis: 'Sprzedano (netto)', wartosc: kwotaKrotka(a.sprzedanoNetto) },
                    { klucz: 'dziennie', podpis: 'Średnio dziennie', wartosc: kwotaKrotka(a.srednioDziennie) },
                    { klucz: 'zmiana', podpis: 'Wobec poprzedniego miesiąca', wartosc: zmiana(a.zmiana), opisKolor: 'sukces' },
                    { klucz: 'klient', podpis: 'Najlepszy klient', wartosc: a.najlepszyKlient },
                  ]
                : [
                    { klucz: 'dokumenty', podpis: 'Dokumenty (brutto)', wartosc: kwotaKrotka(k.dokumentyBrutto) },
                    { klucz: 'dziennie', podpis: 'Średnio dziennie', wartosc: kwotaKrotka(k.srednioDziennie) },
                    { klucz: 'zmiana', podpis: 'Wobec poprzedniego miesiąca', wartosc: zmiana(k.zmiana) },
                    { klucz: 'kategoria', podpis: 'Największa kategoria', wartosc: k.najwiekszaKategoria },
                  ]
            }
          />
        </Sekcja>

        <Sekcja
          naglowek={sprzedaz ? 'Trend sprzedaży' : 'Trend wydatków'}
          stopka={sprzedaz ? 'Sprzedaż netto w ostatnich 6 miesiącach.' : 'Z KSeF i wydatków, brutto, 6 miesięcy.'}
          swobodna>
          <Wykres punkty={(sprzedaz ? a.trend : k.trend).map((p) => ({ ...p, opis: kwota(p.y * 100) }))} etykieta="Trend w ostatnich 6 miesiącach" />
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Sprzedaż według produktów' : 'Wydatki według kategorii'} swobodna>
          <Wykres
            rodzaj="kolo"
            wysokosc={220}
            punkty={(sprzedaz ? a.produkty : k.kategorie).map((p, i) => ({ ...p, kolor: KOLORY_KOLA[i % KOLORY_KOLA.length], opis: kwota(p.y * 100) }))}
            etykieta={sprzedaz ? 'Udział produktów w sprzedaży' : 'Udział kategorii w wydatkach'}
          />
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Najlepsze produkty i usługi' : 'Największe kategorie'}>
          {(sprzedaz ? a.produkty : k.kategorie)
            .slice()
            .sort((x, y) => y.y - x.y)
            .map((p, i, wszystkie) => {
              const suma = wszystkie.reduce((s, q) => s + q.y, 0);
              return (
                <Wiersz key={p.x} tytul={`${i + 1}. ${p.x}`} wartosc={kwota(p.y * 100)} wartoscKolor="etykieta" wartoscPodpis={`${Math.round((p.y / suma) * 100)}%`} />
              );
            })}
        </Sekcja>

        {sprzedaz ? (
          <>
            <Sekcja naglowek="Ostatnie faktury" stopka="Przyjęte w KSeF w wybranym miesiącu, brutto.">
              {FAKTURY.filter((f) => f.statusKsef === 'przyjeta')
                .slice(0, 4)
                .map((f) => (
                  <Wiersz
                    key={f.id}
                    tytul={f.kontrahent}
                    podtytul={`${f.numer} · ${dataKrotka(f.dataWystawienia)}`}
                    wartosc={kwota(f.brutto)}
                    wartoscKolor="etykieta"
                    strzalka
                    onPress={() => router.push({ pathname: '/faktury/[id]', params: { id: f.id } })}
                  />
                ))}
            </Sekcja>
            <Sekcja naglowek="Należności">
              <Wiersz tytul="Do zapłaty" wartosc={kwota(a.doZaplaty)} />
              <Wiersz tytul="Po terminie" wartosc={kwota(a.poTerminie)} wartoscKolor="ostrzezenie" />
              <Wiersz tytul="Najstarsza zaległość" wartosc={a.najstarszaZaleglosc > 0 ? dni(a.najstarszaZaleglosc) : 'Brak zaległości'} />
            </Sekcja>
          </>
        ) : (
          <>
            <Sekcja naglowek="Ostatnie wydatki">
              {KOSZTY.slice(0, 4).map((x) => (
                <Wiersz
                  key={x.id}
                  tytul={x.dostawca}
                  podtytul={`${x.opis} · ${dataKrotka(x.data)}`}
                  wartosc={kwota(x.brutto)}
                  wartoscKolor="etykieta"
                  strzalka
                  onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: x.id } })}
                />
              ))}
            </Sekcja>
            <Sekcja naglowek="VAT z wydatków">
              <Wiersz tytul="VAT naliczony" wartosc={kwota(k.vatNaliczony)} />
              <Wiersz tytul="VAT do odliczenia" wartosc={kwota(k.vatDoOdliczenia)} />
              <Wiersz tytul="Do opisania" wartosc={`${k.doOpisania} dokumenty`} wartoscKolor="ostrzezenie" strzalka onPress={() => router.push('/koszty')} />
            </Sekcja>
          </>
        )}

        <Sekcja naglowek="Przychody a koszty">
          <Wiersz tytul="Przychody" wartosc={kwota(a.przychody)} />
          <Wiersz tytul="Koszty" wartosc={kwota(a.koszty)} />
          <Wiersz tytul="Wynik (netto)" wartosc={kwota(a.przychody - a.koszty)} wartoscKolor="etykieta" />
        </Sekcja>

        <Sekcja
          naglowek={sprzedaz ? 'Stali klienci' : 'Stałe koszty'}
          stopka={sprzedaz ? 'Klienci z fakturą w 3 z ostatnich 4 miesięcy.' : 'Dostawcy z kosztem w 3 z ostatnich 4 miesięcy.'}>
          {(sprzedaz ? a.staliKlienci : k.staleKoszty).map((s) => (
            <Wiersz
              key={s.nazwa}
              tytul={s.nazwa}
              podtytul={`Zwykle ok. ${s.dzien}. dnia miesiąca`}
              wartosc={kwota(s.srednio)}
              wartoscKolor="etykieta"
              wartoscPodpis="średnio / mies."
            />
          ))}
          {sprzedaz ? (
            <Wiersz tytul="Zrób fakturę cykliczną" akcja strzalka onPress={() => router.navigate({ pathname: '/faktury', params: { widok: 'cykliczne' } })} />
          ) : null}
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Kalendarz sprzedaży' : 'Kalendarz wydatków'} stopka="Ostatnie 180 dni. Im ciemniej, tym więcej dokumentów w dniu." swobodna>
          <Kalendarz dni={kalendarz(sprzedaz ? 3 : 5)} etykieta={sprzedaz ? 'Kalendarz sprzedaży z 180 dni' : 'Kalendarz wydatków z 180 dni'} />
        </Sekcja>
      </EkranListy>
    </>
  );
}

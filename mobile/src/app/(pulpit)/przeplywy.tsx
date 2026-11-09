import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { DZIS, FAKTURY } from '@/dane-przykladowe';
import {
  KOSZTY_MIESIAC,
  ODLOZ_NA_PODATEK,
  OPERACJE,
  PRZEPLYWY,
  WPLYNELO_MIESIAC,
  ZRODLA_PRZEPLYWOW,
  type Okres,
  type Operacja,
} from '@/dane-przykladowe/pulpit';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Wykres } from '@/komponenty/wykres';
import { dataKrotka, kwota, kwotaKrotka, zmiana } from '@/lib/format';
import { doZaplaty, kiedyTermin } from '@/lib/status-faktury';
import type { Kolory } from '@/wyglad/kolory';

const OKRESY: { klucz: Okres; nazwa: string }[] = [
  { klucz: 'tygodniowo', nazwa: 'Tygodniowo' },
  { klucz: 'miesiecznie', nazwa: 'Miesięcznie' },
  { klucz: 'rocznie', nazwa: 'Rocznie' },
];

const KOLOR_STATUSU: Record<Operacja['status'], keyof Kolory> = {
  'Opłacona': 'sukces',
  'Korekta': 'ostrzezenie',
  'Zatwierdzony': 'sukces',
  'Do akceptacji': 'ostrzezenie',
  'Z KSeF': 'etykietaDrugorzedna',
};

const KATEGORIE = ['Wszystkie', 'Sprzedaż', 'Usługi', 'Biuro', 'Paliwo', 'Telefon'] as const;
const STATUSY = ['Wszystkie', 'Opłacona', 'Korekta', 'Zatwierdzony', 'Do akceptacji', 'Z KSeF'] as const;

/** Przepływy pieniężne: odpowiednik `app/(dashboard)/przeplywy`. */
export default function EkranPrzeplywow() {
  const router = useRouter();
  const [okres, setOkres] = useState(1);
  const [kategoria, setKategoria] = useState<(typeof KATEGORIE)[number]>('Wszystkie');
  const [status, setStatus] = useState<(typeof STATUSY)[number]>('Wszystkie');
  const dane = PRZEPLYWY[OKRESY[okres]?.klucz ?? 'miesiecznie'];
  const sumaWplywow = dane.reduce((s, p) => s + p.wplywy, 0);
  const sumaKosztow = dane.reduce((s, p) => s + p.koszty, 0);

  const spodziewane = FAKTURY.filter((f) => doZaplaty(f) && f.terminPlatnosci >= DZIS).sort((a, b) =>
    a.terminPlatnosci.localeCompare(b.terminPlatnosci),
  );
  const operacje = OPERACJE.filter((o) => kategoria === 'Wszystkie' || o.kategoria === kategoria).filter(
    (o) => status === 'Wszystkie' || o.status === status,
  );

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="line.3.horizontal.decrease" title="Filtruj operacje">
          <Stack.Toolbar.Menu title="Kategoria" inline>
            {KATEGORIE.map((k) => (
              <Stack.Toolbar.MenuAction key={k} isOn={kategoria === k} onPress={() => setKategoria(k)}>
                {k}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu title="Status" inline>
            {STATUSY.map((s) => (
              <Stack.Toolbar.MenuAction key={s} isOn={status === s} onPress={() => setStatus(s)}>
                {s}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <EkranListy>
        <Segmenty wartosci={OKRESY.map((o) => o.nazwa)} wybrany={okres} onZmiana={setOkres} etykieta="Okres przepływów" />
        <Kafle
          kafle={[
            { klucz: 'wplywy', podpis: 'Suma wpływów', wartosc: kwotaKrotka(sumaWplywow * 100), ikona: 'arrow.down.circle.fill', ikonaKolor: 'sukces' },
            { klucz: 'koszty', podpis: 'Suma kosztów', wartosc: kwotaKrotka(sumaKosztow * 100), ikona: 'arrow.up.circle.fill', ikonaKolor: 'blad' },
          ]}
        />
        <Sekcja
          naglowek="Saldo okresów"
          stopka="Oznaczone wpłaty minus koszty brutto. Zielony to nadwyżka, czerwony to więcej kosztów niż wpłat."
          swobodna>
          <Wykres
            punkty={dane.map((p) => ({
              x: p.x,
              y: p.wplywy - p.koszty,
              kolor: p.wplywy >= p.koszty ? 'sukces' : 'blad',
              opis: `wpływy ${kwota(p.wplywy * 100)}, koszty ${kwota(p.koszty * 100)}`,
            }))}
            etykieta="Saldo przepływów w okresach"
          />
        </Sekcja>

        <Kafle
          kafle={[
            { klucz: 'wplynelo', podpis: 'Wpłynęło w tym miesiącu', wartosc: kwotaKrotka(WPLYNELO_MIESIAC.kwota), opis: `${zmiana(WPLYNELO_MIESIAC.zmiana)} wobec poprzedniego miesiąca`, opisKolor: WPLYNELO_MIESIAC.zmiana < 0 ? 'blad' : 'sukces' },
            { klucz: 'kosztymies', podpis: 'Koszty w tym miesiącu (brutto)', wartosc: kwotaKrotka(KOSZTY_MIESIAC.kwota), opis: `${zmiana(KOSZTY_MIESIAC.zmiana)} wobec poprzedniego miesiąca`, onPress: () => router.push('/koszty') },
            { klucz: 'podatek', podpis: 'Odłóż na podatek', wartosc: kwotaKrotka(ODLOZ_NA_PODATEK.kwota), opis: `${ODLOZ_NA_PODATEK.procent}%, szacunek: liniowy, bez ZUS`, ikona: 'banknote', onPress: () => router.push('/ksiegowosc') },
          ]}
        />

        <Sekcja naglowek="Spodziewane wpływy" stopka="Następne 30 dni.">
          {spodziewane.length === 0
            ? [<Wiersz key="brak" tytul="Brak faktur z terminem w 30 dni" />]
            : spodziewane.map((f) => (
                <Wiersz
                  key={f.id}
                  tytul={f.kontrahent}
                  podtytul={`Termin ${kiedyTermin(DZIS, f.terminPlatnosci)}`}
                  wartosc={kwota(f.brutto)}
                  wartoscKolor="etykieta"
                  strzalka
                  onPress={() => router.push({ pathname: '/faktury/[id]', params: { id: f.id } })}
                />
              ))}
        </Sekcja>

        <Sekcja naglowek="Największe źródła przepływów" stopka="Ostatnie 12 miesięcy.">
          {ZRODLA_PRZEPLYWOW.map((z) => (
            <Wiersz
              key={z.nazwa}
              tytul={z.nazwa}
              podtytul={z.opis}
              wartosc={`${z.kwota > 0 ? '+' : '−'}${kwotaKrotka(Math.abs(z.kwota))}`}
              wartoscKolor={z.kwota > 0 ? 'sukces' : 'blad'}
              wartoscPodpis={`${z.udzial}%`}
            />
          ))}
        </Sekcja>

        <Sekcja
          naglowek="Wszystkie operacje"
          stopka={kategoria !== 'Wszystkie' || status !== 'Wszystkie' ? `Filtr: ${kategoria}, ${status}.` : undefined}>
          {operacje.length === 0
            ? [<StanPusty key="pusto" ikona="tray" tytul="Brak operacji" opis="Oznacz zapłatę przy fakturze, a pojawi się tutaj." />]
            : operacje.map((o) => (
                <Wiersz
                  key={o.id}
                  tytul={o.kontrahent}
                  podtytul={`${o.kategoria} · ${dataKrotka(o.data)}`}
                  wartosc={`${o.kwota > 0 ? '+' : '−'}${kwota(Math.abs(o.kwota))}`}
                  wartoscKolor={o.kwota > 0 ? 'sukces' : 'etykieta'}
                  wartoscPodpis={o.status}
                  wartoscPodpisKolor={KOLOR_STATUSU[o.status]}
                />
              ))}
        </Sekcja>
      </EkranListy>
    </>
  );
}

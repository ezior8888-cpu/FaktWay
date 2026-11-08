import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import { DZIS, FAKTURY, type Faktura } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataKrotka, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';

type Filtr = 'wszystkie' | 'do-zaplaty';

const MIESIACE = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' });

function nazwaMiesiaca(iso: string): string {
  const tekst = MIESIACE.format(new Date(`${iso}T12:00:00`));
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

function grupujPoMiesiacu(faktury: Faktura[]): [string, Faktura[]][] {
  const grupy = new Map<string, Faktura[]>();
  for (const f of faktury) {
    const klucz = nazwaMiesiaca(f.dataWystawienia);
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), f]);
  }
  return [...grupy.entries()];
}

export default function EkranFaktur() {
  const router = useRouter();
  const [filtr, setFiltr] = useState<Filtr>('wszystkie');
  const [szukaj, setSzukaj] = useState('');

  const widoczne = useMemo(() => {
    const fraza = szukaj.trim().toLocaleLowerCase('pl');
    return FAKTURY.filter((f) => (filtr === 'do-zaplaty' ? doZaplaty(f) : true)).filter(
      (f) => !fraza || f.kontrahent.toLocaleLowerCase('pl').includes(fraza) || f.numer.toLowerCase().includes(fraza),
    );
  }, [filtr, szukaj]);

  const otworz = (f: Faktura) => router.push({ pathname: '/faktura/[id]', params: { id: f.id } });

  const wiersz = (f: Faktura) => {
    const status = statusFaktury(f, DZIS);
    return (
      <Wiersz
        key={f.id}
        tytul={f.kontrahent}
        podtytul={`${f.numer} · ${dataKrotka(f.dataWystawienia)}`}
        wartosc={kwota(f.brutto)}
        wartoscPodpis={status.tekst}
        wartoscPodpisKolor={status.kolor}
        onPress={() => otworz(f)}
        etykietaDostepnosci={`${f.kontrahent}, ${kwota(f.brutto)}, ${status.tekst}`}
      />
    );
  };

  const zalegle = widoczne.filter((f) => statusFaktury(f, DZIS).zalegla);
  const biezace = widoczne.filter((f) => doZaplaty(f) && !statusFaktury(f, DZIS).zalegla);

  return (
    <>
      <Stack.SearchBar placeholder="Kontrahent albo numer" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Menu icon="line.3.horizontal.decrease" title="Pokaż">
          <Stack.Toolbar.MenuAction isOn={filtr === 'wszystkie'} onPress={() => setFiltr('wszystkie')}>
            Wszystkie
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction isOn={filtr === 'do-zaplaty'} onPress={() => setFiltr('do-zaplaty')}>
            Do zapłaty
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="plus" accessibilityLabel="Nowa faktura" onPress={() => router.push('/nowa')} />
      </Stack.Toolbar>

      <EkranListy>
        {widoczne.length === 0 ? (
          <StanPusty
            ikona={szukaj ? 'magnifyingglass' : 'checkmark.circle'}
            tytul={szukaj ? 'Brak wyników' : 'Wszystko zapłacone'}
            opis={szukaj ? `Nie ma faktury pasującej do „${szukaj}”.` : 'Żadna faktura nie czeka na zapłatę.'}
          />
        ) : filtr === 'do-zaplaty' ? (
          <>
            {zalegle.length > 0 ? (
              <Sekcja naglowek="Po terminie" stopka={`Razem ${kwota(zalegle.reduce((s, f) => s + f.brutto, 0))}`}>
                {zalegle.map(wiersz)}
              </Sekcja>
            ) : null}
            {biezace.length > 0 ? (
              <Sekcja naglowek="Przed terminem" stopka={`Razem ${kwota(biezace.reduce((s, f) => s + f.brutto, 0))}`}>
                {biezace.map(wiersz)}
              </Sekcja>
            ) : null}
          </>
        ) : (
          grupujPoMiesiacu(widoczne).map(([miesiac, faktury]) => (
            <Sekcja key={miesiac} naglowek={miesiac}>
              {faktury.map(wiersz)}
            </Sekcja>
          ))
        )}
      </EkranListy>
    </>
  );
}

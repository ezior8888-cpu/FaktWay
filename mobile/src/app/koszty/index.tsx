import { useRouter } from 'expo-router';

import { KOSZTY, type Koszt } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataKrotka, kwota } from '@/lib/format';

export default function EkranKosztow() {
  const router = useRouter();
  const doOpisania = KOSZTY.filter((k) => k.zrodlo === 'ksef' && k.doOpisania);
  const pozostale = KOSZTY.filter((k) => !(k.zrodlo === 'ksef' && k.doOpisania));

  const wiersz = (k: Koszt) => (
    <Wiersz
      key={k.id}
      tytul={k.dostawca}
      podtytul={`${k.opis} · ${dataKrotka(k.data)}`}
      wartosc={kwota(k.brutto)}
      wartoscKolor="etykieta"
      wartoscPodpis={k.zrodlo === 'ksef' ? 'Z KSeF' : 'Ze zdjęcia'}
      onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: k.id } })}
      etykietaDostepnosci={`${k.dostawca}, ${kwota(k.brutto)}`}
    />
  );

  return (
    <EkranListy>
      {doOpisania.length > 0 ? (
        <Sekcja naglowek="Do opisania" stopka="Faktury kosztowe pobrane z KSeF. Opisz je, żeby trafiły do ewidencji.">
          {doOpisania.map(wiersz)}
        </Sekcja>
      ) : null}
      <Sekcja naglowek="Ostatnie">{pozostale.map(wiersz)}</Sekcja>
    </EkranListy>
  );
}

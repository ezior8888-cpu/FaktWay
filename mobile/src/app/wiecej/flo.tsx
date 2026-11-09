import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { FLO_PROPOZYCJE, type PropozycjaFlo } from '@/dane-przykladowe/ustawienia';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';

/**
 * Flo, asystent: propozycje do zatwierdzenia, cofnięcie, historia. Na stronie
 * Flo żyje na Pulpicie (`components/flo/flo-screen.tsx`). Nic nie dzieje się
 * bez zatwierdzenia.
 */
export default function EkranFlo() {
  const router = useRouter();
  const [propozycje, setPropozycje] = useState<PropozycjaFlo[]>(FLO_PROPOZYCJE);
  const [historia, setHistoria] = useState<string[]>(['Wczoraj: przypomnienie dla Zielony Ogród zatwierdzone']);
  const [ostatnia, setOstatnia] = useState<PropozycjaFlo>();

  const zdejmij = (p: PropozycjaFlo, wpis: string) => {
    setPropozycje((l) => l.filter((x) => x.id !== p.id));
    setHistoria((h) => [wpis, ...h]);
    setOstatnia(p);
    void Haptics.selectionAsync();
  };

  const przejdz = (p: PropozycjaFlo) => {
    zdejmij(p, `Zatwierdzone: ${p.tytul}`);
    if (p.id === 'p1') router.push({ pathname: '/faktury/przypomnienie', params: { id: 'f5' } });
    else if (p.id === 'p2') router.push('/koszty');
    else router.push('/ksiegowosc');
  };

  return (
    <EkranListy>
      {ostatnia ? (
        <Sekcja>
          <Wiersz
            tytul={`Cofnij: ${ostatnia.tytul}`}
            ikona="arrow.uturn.backward"
            akcja
            onPress={() => {
              setPropozycje((l) => [ostatnia, ...l]);
              setHistoria((h) => h.slice(1));
              setOstatnia(undefined);
            }}
          />
        </Sekcja>
      ) : null}

      {propozycje.length === 0 ? (
        <StanPusty ikona="sparkles" tytul="Nic do zatwierdzenia" opis="Gdy coś zauważę, zaproponuję tu następny krok." />
      ) : (
        propozycje.map((p) => (
          <Sekcja key={p.id} naglowek={p.tytul} stopka={p.opis}>
            <Wiersz tytul={p.akcja} akcja strzalka onPress={() => przejdz(p)} />
            <Wiersz tytul="Nie teraz" onPress={() => zdejmij(p, `Odłożone: ${p.tytul}`)} />
          </Sekcja>
        ))
      )}

      <Sekcja naglowek="Historia" stopka="Flo proponuje, a decyzja zawsze należy do Ciebie.">
        {historia.map((h, i) => (
          <Wiersz key={i} tytul={h} />
        ))}
        <Wiersz tytul="Ustawienia Flo" strzalka onPress={() => router.push('/wiecej/ustawienia/flo')} />
      </Sekcja>
    </EkranListy>
  );
}

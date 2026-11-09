import { useState } from 'react';

import { PolePrzelacznik, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { useStanFaktur } from '@/stan/faktury';

const GODZINY = Array.from({ length: 24 }, (_, i) => ({ wartosc: String(i), etykieta: `${i}:00` }));

/** Ustawienia Flo: jak się odzywa, cisza nocna, wyciszone sprawy (`flo-settings-form.tsx`). */
export default function EkranUstawienFlo() {
  const { flagi, ustawFlage } = useStanFaktur();
  const [od, setOd] = useState('22');
  const [do_, setDo] = useState('7');
  const [wyciszone, setWyciszone] = useState([{ id: 'w1', nazwa: 'Przypomnienia o fakturach cyklicznych', opis: 'Cały rodzaj, do 30.11.2026' }]);

  return (
    <EkranListy>
      <Sekcja naglowek="Jak mam się odzywać" stopka="W telefonie najwyżej raz dziennie, poza pilnymi alertami. Mailem raz w miesiącu podsumowanie.">
        <PolePrzelacznik etykieta="Powiadomienia w telefonie" wartosc={flagi['flo-push'] ?? true} onZmiana={(v) => ustawFlage('flo-push', v)} />
        <PolePrzelacznik etykieta="Powiadomienia mailem" wartosc={flagi['flo-mail'] ?? false} onZmiana={(v) => ustawFlage('flo-mail', v)} />
      </Sekcja>
      <Sekcja naglowek="Cisza nocna">
        <PoleWyboru etykieta="Od" wartosc={od} opcje={GODZINY} onZmiana={setOd} />
        <PoleWyboru etykieta="Do" wartosc={do_} opcje={GODZINY} onZmiana={setDo} />
      </Sekcja>
      <Sekcja naglowek="Wyciszone sprawy" stopka="Gdy dwa razy odpowiesz „nie”, wyciszam tę sprawę na jakiś czas.">
        {wyciszone.length === 0
          ? [<Wiersz key="nic" tytul="Nic nie jest wyciszone" />]
          : wyciszone.map((w) => (
              <Wiersz key={w.id} tytul={w.nazwa} podtytul={w.opis} wartoscPodpis="Przywróć" wartoscPodpisKolor="akcent" onPress={() => setWyciszone((l) => l.filter((x) => x.id !== w.id))} />
            ))}
      </Sekcja>
    </EkranListy>
  );
}

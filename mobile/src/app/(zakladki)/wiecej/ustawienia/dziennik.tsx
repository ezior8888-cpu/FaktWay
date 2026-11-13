import { DZIENNIK } from '@/dane-przykladowe/ustawienia';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';

/** Dziennik zdarzeń: historia aktywności (`settings/audit`), od najnowszych. */
export default function EkranDziennika() {
  return (
    <EkranListy>
      <Sekcja naglowek="Historia aktywności" stopka={`${DZIENNIK.length} wpisów (najwyżej 200), od najnowszych.`}>
        {DZIENNIK.map((d) => (
          <Wiersz key={d.id} tytul={d.akcja} podtytul={`${d.data} · ${d.zasob} · IP ${d.ip}`} zaznaczalna />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

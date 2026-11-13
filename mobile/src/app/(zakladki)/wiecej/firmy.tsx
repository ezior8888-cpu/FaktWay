import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { useKontoFirmy } from '@/stan/dane';

const NAZWA_ROLI: Record<string, string> = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek zespołu', accountant: 'Księgowa' };

/**
 * Wybór firmy (etap M7): firmy konta z `GET /api/mobile/v1/konto`, najpóźniej
 * dołączona na górze, jak wybór firmy na stronie. Wybór zostaje na tym
 * telefonie; dane nowej firmy pokazują się od razu z pamięci, świeże
 * dociągają się w tle (`stan/dane.tsx`).
 */
export default function EkranFirm() {
  const router = useRouter();
  const kontoFirmy = useKontoFirmy();
  const konto = kontoFirmy?.konto;
  if (!kontoFirmy || !konto || konto.firmy.length === 0) {
    return (
      <EkranListy>
        <StanPusty ikona="building2-line" tytul="Brak firm" opis="Załóż firmę albo przyjmij zaproszenie na faktway.pl." />
      </EkranListy>
    );
  }
  return (
    <EkranListy>
      <Sekcja
        naglowek="Twoje firmy"
        stopka={
          konto.wszystkie
            ? 'Firma, którą wybierzesz, zostaje na tym telefonie. Na komputerze wybierasz ją osobno.'
            : `Pokazujemy ${konto.firmy.length} najnowszych firm z Twojego konta. Pozostałe wybierzesz na faktway.pl.`
        }>
        {konto.firmy.map((f) => {
          const wybrana = f.id === kontoFirmy.firma?.id;
          return (
            <Wiersz
              key={f.id}
              tytul={f.nazwa}
              podtytul={[f.nip ? `NIP ${f.nip}` : undefined, NAZWA_ROLI[f.rola] ?? f.rola].filter(Boolean).join(' · ')}
              zaznaczony={wybrana}
              onPress={() => {
                if (!wybrana) {
                  void Haptics.selectionAsync();
                  kontoFirmy.wybierzFirme(f.id);
                }
                router.back();
              }}
              etykietaDostepnosci={`${f.nazwa}${f.nip ? `, NIP ${f.nip}` : ''}`}
            />
          );
        })}
      </Sekcja>
    </EkranListy>
  );
}

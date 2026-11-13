/**
 * „Sprawdź teraz” pod kartą Kosztów na prawdziwym koncie (M10a): zleca
 * pobranie faktur kosztowych z KSeF na serwerze (`POST /api/mobile/v1/skrzynka/sprawdz`,
 * jak przycisk w skrzynce na stronie, najwyżej raz na 5 minut). Faktury pobiera
 * serwer w tle, więc po chwili lista odświeża się sama. Zdanie z serwera mówi,
 * co się dzieje (sprawdzamy, za wcześnie, brak podłączonego KSeF).
 */
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { Tekst } from '@/komponenty/tekst';
import type { SprawdzenieSkrzynkiOdpowiedz } from '@/lib/api/kontrakt';
import { useKontoFirmy } from '@/stan/dane';
import { useStanFaktur } from '@/stan/faktury';
import { ODSTEP } from '@/wyglad/odstepy';

/** Po zleceniu lista skrzynki odświeża się po tylu sekundach (pobranie z KSeF trwa chwilę). */
const ODSWIEZ_PO_MS = 20_000;

export function SprawdzKsefNaKoncie({ style }: { style?: StyleProp<ViewStyle> }) {
  const konto = useKontoFirmy();
  const { dane } = useStanFaktur();
  const [trwa, setTrwa] = useState(false);
  const [komunikat, setKomunikat] = useState<string>();
  const zegar = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(zegar.current), []);

  const sprawdz = async () => {
    if (!konto || trwa) return;
    setTrwa(true);
    const w = await konto.zapytaj<SprawdzenieSkrzynkiOdpowiedz>('skrzynka/sprawdz', { metoda: 'POST' });
    setTrwa(false);
    if (!w.ok) {
      setKomunikat(w.blad.komunikat);
      return;
    }
    setKomunikat(w.dane.komunikat);
    if (w.dane.stan === 'zlecone' || w.dane.stan === 'w_toku') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      clearTimeout(zegar.current);
      zegar.current = setTimeout(() => void dane.odswiez(), ODSWIEZ_PO_MS);
    }
  };

  const opis = komunikat ?? 'Faktury kosztowe z KSeF pobieramy co 15 minut.';
  return (
    <Pressable
      onPress={trwa ? undefined : () => void sprawdz()}
      accessibilityRole="button"
      accessibilityLabel={`${opis} Sprawdź teraz.`}
      accessibilityState={{ busy: trwa }}
      hitSlop={ODSTEP.xs}
      style={style}>
      <Tekst styl="footnote" kolor="etykietaDrugorzedna">
        {trwa ? 'Sprawdzam KSeF…' : `${opis} `}
        {trwa ? null : (
          <Tekst styl="footnote" kolor="akcent" waga="medium">
            Sprawdź teraz
          </Tekst>
        )}
      </Tekst>
    </Pressable>
  );
}

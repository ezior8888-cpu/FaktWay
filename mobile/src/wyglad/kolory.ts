/**
 * Kolory FaktWay dla komponentów. Wartości leżą w `paleta.ts` (bez React
 * Native, sprawdza je test kontrastu); tu tylko wybór jasnej albo ciemnej
 * palety według trybu telefonu (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 */
import { useColorScheme } from 'react-native';

import { CIEMNE, JASNE, type Kolory } from '@/wyglad/paleta';

export { kolorKategorii, kolorTonu, tonKoloru, type Kolory, type Ton } from '@/wyglad/paleta';

/** Paleta dla trybu: dla miejsc poza komponentami (np. opcje pasków w `_layout.tsx`). */
export function paleta(ciemny: boolean): Kolory {
  return ciemny ? CIEMNE : JASNE;
}

export function useKolory(): Kolory {
  return paleta(useColorScheme() === 'dark');
}

export function useCiemny(): boolean {
  return useColorScheme() === 'dark';
}

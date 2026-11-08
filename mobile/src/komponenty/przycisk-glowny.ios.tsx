/**
 * Główna akcja ekranu w treści (iOS): natywny przycisk SwiftUI w stylu
 * Liquid Glass (`glassProminent`) na całą szerokość treści. Dolny pasek
 * narzędzi odpada, bo w aplikacji z zakładkami chowa się pod paskiem zakładek
 * (sprawdzone w M3).
 */
import { Host } from '@expo/ui';
import { Button, Label } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, frame, tint } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'expo-symbols';

import { useKolory } from '@/wyglad/kolory';

/** „Ile się da”: SwiftUI przytnie do szerokości Hosta (Infinity nie przechodzi przez most). */
const SZEROKO = 10_000;

export type PrzyciskGlownyProps = {
  tytul: string;
  ikona?: SFSymbol;
  /** `drugorzedny`: szkło bez wypełnienia, np. „Cofnij oznaczenie zapłaty”. */
  wariant?: 'glowny' | 'drugorzedny';
  onPress: () => void;
};

export function PrzyciskGlowny({ tytul, ikona, wariant = 'glowny', onPress }: PrzyciskGlownyProps) {
  const kolory = useKolory();
  return (
    <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
      <Button
        onPress={onPress}
        modifiers={[
          buttonStyle(wariant === 'glowny' ? 'glassProminent' : 'glass'),
          controlSize('large'),
          tint(wariant === 'glowny' ? kolory.akcentWypelnienie : kolory.akcent),
        ]}>
        {/* Szerokość ustawia etykieta: SwiftUI rysuje szkło wokół niej. */}
        <Label title={tytul} systemImage={ikona} modifiers={[frame({ maxWidth: SZEROKO })]} />
      </Button>
    </Host>
  );
}

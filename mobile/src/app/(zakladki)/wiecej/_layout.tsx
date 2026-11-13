import { Stack } from 'expo-router';

import { useOpcjeGradientu, useOpcjeStosu } from '@/wyglad/naglowki';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Więcej: kontrahenci, import i wszystkie ustawienia ze strony (bez Flo, plan D13). */
export default function UkladWiecej() {
  const opcje = useOpcjeStosu();
  const gradient = useOpcjeGradientu();
  return (
    <Stack screenOptions={opcje}>
      <Stack.Screen name="index" options={{ title: 'Więcej', ...gradient }} />
      <Stack.Screen name="firmy" options={{ title: 'Zmień firmę' }} />
      <Stack.Screen name="kontrahenci/index" options={{ title: 'Kontrahenci', ...gradient }} />
      <Stack.Screen name="kontrahenci/[id]" options={{ title: '' }} />
      <Stack.Screen name="import" options={{ title: 'Import danych' }} />
      <Stack.Screen name="ustawienia/firma" options={{ title: 'Firma' }} />
      <Stack.Screen name="ustawienia/bezpieczenstwo" options={{ title: 'Bezpieczeństwo' }} />
      <Stack.Screen name="ustawienia/powiadomienia" options={{ title: 'Powiadomienia' }} />
      <Stack.Screen name="ustawienia/ksef" options={{ title: 'KSeF' }} />
      <Stack.Screen name="ustawienia/przypomnienia" options={{ title: 'Przypomnienia' }} />
      <Stack.Screen name="ustawienia/ksiegowa" options={{ title: 'Księgowa' }} />
      <Stack.Screen name="ustawienia/zespol" options={{ title: 'Zespół' }} />
      <Stack.Screen name="ustawienia/abonament" options={{ title: 'Abonament' }} />
      <Stack.Screen name="ustawienia/dziennik" options={{ title: 'Dziennik zdarzeń' }} />
      <Stack.Screen name="ustawienia/konto" options={{ title: 'Konto i dane (RODO)' }} />
    </Stack>
  );
}
